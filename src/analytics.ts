import fs from "fs";
import path from "path";
import { googleAuthService } from "./google-auth.ts";

export interface AnalyticsQueryResult {
  records: any[];
  source: "firestore" | "local" | "hybrid";
  storageType: "memory" | "file";
  storageFile?: string;
}

export class AnalyticsManager {
  private dataDir: string;
  private analyticsFile: string;
  private isCloudRun: boolean;
  private localRecords: any[] = [];
  private maxLocalRecords: number = 5000;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.isCloudRun = Boolean(
      process.env.K_SERVICE ||
      process.env.K_REVISION ||
      process.env.RUN_ON_CLOUDRUN ||
      process.env.ANALYTICS_STORAGE === "memory"
    );
    this.analyticsFile = process.env.ANALYTICS_FILE || path.join(this.dataDir, "analytics.json");
    this.initStorage();
  }

  private initStorage(): void {
    if (this.isCloudRun) {
      console.log("[Analytics] Running in Cloud Run environment - using in-memory analytics storage");
      this.localRecords = [];
      return;
    }

    try {
      if (fs.existsSync(this.analyticsFile)) {
        const raw = fs.readFileSync(this.analyticsFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.localRecords = parsed;
          console.log(`[Analytics] Loaded ${this.localRecords.length} analytics record(s) from local volume file: ${this.analyticsFile}`);
        }
      } else {
        const dir = path.dirname(this.analyticsFile);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.analyticsFile, "[]", "utf-8");
        console.log(`[Analytics] Initialized empty local analytics file volume: ${this.analyticsFile}`);
      }
    } catch (err) {
      console.warn(`[Analytics] Notice initializing local storage file (${this.analyticsFile}):`, err);
    }
  }

  public async detectProjectID(): Promise<string> {
    const fromAuth = await googleAuthService.getProjectId();
    if (fromAuth) return fromAuth;
    return (
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCP_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      "demo-project"
    );
  }

  public async saveRecord(body: any): Promise<any> {
    const record = typeof body === "string" ? JSON.parse(body) : { ...body };
    record.id = record.id || `record_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    record.timestamp = record.timestamp || new Date().toISOString();

    // 1. Always save to local storage volume (or in-memory if in Cloud Run)
    this.saveLocalRecord(record);

    // 2. Best-effort write to Firestore (does not block local persistence on failure)
    await this.trySaveToFirestore(record).catch((err) => {
      console.warn("[Analytics] Best-effort Firestore save error:", err?.message || err);
    });

    return record;
  }

  private saveLocalRecord(record: any): void {
    try {
      const existingIdx = this.localRecords.findIndex((r) => r && r.id === record.id);
      if (existingIdx >= 0) {
        this.localRecords.splice(existingIdx, 1);
      }
      this.localRecords.unshift(record);

      if (this.localRecords.length > this.maxLocalRecords) {
        this.localRecords.length = this.maxLocalRecords;
      }

      if (!this.isCloudRun) {
        const dir = path.dirname(this.analyticsFile);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.analyticsFile, JSON.stringify(this.localRecords, null, 2), "utf-8");
      }
    } catch (err) {
      console.warn(`[Analytics] Warning saving record to local analytics storage:`, err);
    }
  }

  public getLocalRecords(limit: number = 500): any[] {
    const local = [...this.localRecords];
    local.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    return local.slice(0, limit);
  }

  private async trySaveToFirestore(record: any): Promise<boolean> {
    try {
      const projectId = await this.detectProjectID();
      let token = await googleAuthService.getAccessToken();

      if (!token) {
        return false;
      }

      const firestoreDoc = this.toFirestoreFields(record);
      // Use PATCH to upsert the document so creating or updating does not conflict with 409
      const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/apigee_analytics/${encodeURIComponent(record.id)}`;

      let res = await fetch(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: firestoreDoc }),
        signal: AbortSignal.timeout(5000),
      });

      // If 401 occurs, refresh ADC token and retry once
      if (res.status === 401) {
        googleAuthService.invalidateToken();
        token = await googleAuthService.getAccessToken();
        if (token) {
          res = await fetch(url, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ fields: firestoreDoc }),
            signal: AbortSignal.timeout(5000),
          });
        }
      }

      if (res.ok) {
        console.log(`[Analytics] Successfully recorded analytics to Firestore for proxy '${record.proxy || record.general?.proxyName || "unknown"}' (ID: ${record.id})`);
        return true;
      } else {
        const errText = await res.text();
        console.warn(`[Analytics] Best-effort Firestore save warning (${res.status}): ${errText}`);
        return false;
      }
    } catch (err: any) {
      console.warn(`[Analytics] Best-effort Firestore save notice: ${err?.message || err}`);
      return false;
    }
  }

  public async getLastRecords(limit: number = 500, forceLocal: boolean = false): Promise<AnalyticsQueryResult> {
    const storageType: "memory" | "file" = this.isCloudRun ? "memory" : "file";
    const storageFile = this.isCloudRun ? undefined : this.analyticsFile;

    if (forceLocal) {
      const local = this.getLocalRecords(limit);
      return {
        records: local,
        source: "local",
        storageType,
        storageFile,
      };
    }

    // 1. Attempt best-effort query against Firestore
    let firestoreRecords: any[] = [];
    try {
      firestoreRecords = await this.queryFirestoreRecords(limit);
    } catch (err: any) {
      console.warn(`[Analytics] Notice querying Firestore (using local storage): ${err?.message || err}`);
    }

    // 2. If Firestore returned records, merge with local records
    if (firestoreRecords && firestoreRecords.length > 0) {
      const seen = new Set<string>();
      const merged: any[] = [];
      for (const r of firestoreRecords) {
        if (r && r.id && !seen.has(r.id)) {
          seen.add(r.id);
          merged.push(r);
        }
      }
      for (const r of this.localRecords) {
        if (r && r.id && !seen.has(r.id)) {
          seen.add(r.id);
          merged.push(r);
        }
      }
      merged.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
      return {
        records: merged.slice(0, limit),
        source: this.localRecords.length > 0 ? "hybrid" : "firestore",
        storageType,
        storageFile,
      };
    }

    // 3. Fallback: Firestore is unavailable or empty -> return running local records
    const local = [...this.localRecords];
    local.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));

    return {
      records: local.slice(0, limit),
      source: "local",
      storageType,
      storageFile,
    };
  }

  private async queryFirestoreRecords(limit: number): Promise<any[]> {
    const projectId = await this.detectProjectID();
    let token = await googleAuthService.getAccessToken();

    if (!token) {
      return [];
    }

    // Approach 1: Try runQuery with structuredQuery ordering by timestamp descending
    const runQueryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
    const query = {
      structuredQuery: {
        from: [{ collectionId: "apigee_analytics" }],
        orderBy: [{ field: { fieldPath: "timestamp" }, direction: "DESCENDING" }],
        limit,
      },
    };

    try {
      let res = await fetch(runQueryUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(3000),
      });

      if (res.status === 401) {
        googleAuthService.invalidateToken();
        token = await googleAuthService.getAccessToken();
        if (token) {
          res = await fetch(runQueryUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(query),
            signal: AbortSignal.timeout(3000),
          });
        }
      }

      if (res.ok) {
        const data = (await res.json()) as any[];
        const records: any[] = [];
        for (const item of data) {
          if (item.document?.fields) {
            records.push(this.fromFirestoreFields(item.document.fields));
          }
        }
        if (records.length > 0) return records;
      }
    } catch {
      // Fall through to listDocuments
    }

    // Approach 2: Fallback to list documents
    try {
      const listUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/apigee_analytics?pageSize=${limit}`;
      const listRes = await fetch(listUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(3000),
      });

      if (listRes.ok) {
        const listData = (await listRes.json()) as { documents?: any[] };
        const records: any[] = [];
        for (const doc of listData.documents || []) {
          if (doc.fields) {
            records.push(this.fromFirestoreFields(doc.fields));
          }
        }
        records.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
        return records;
      }
    } catch {
      // ignore
    }

    return [];
  }

  public async seedDemoRecords(): Promise<number> {
    const demoRecords = [
      {
        proxy: "REST-AI-Interactions",
        environment: "test",
        statusCode: 200,
        clientIp: "127.0.0.1",
        model: "gemini-3.5-flash-lite",
        durationMs: 145,
        targetLatencyMs: 110,
        general: {
          proxyName: "REST-AI-Interactions",
          clientIp: "127.0.0.1",
          requestVerb: "POST",
          proxyRequestUri: "/v1beta/interactions",
        },
      },
      {
        proxy: "REST-AI-Completions",
        environment: "test",
        statusCode: 200,
        clientIp: "127.0.0.1",
        model: "google/gemini-3.5-flash-lite",
        durationMs: 230,
        targetLatencyMs: 180,
        general: {
          proxyName: "REST-AI-Completions",
          clientIp: "127.0.0.1",
          requestVerb: "POST",
          proxyRequestUri: "/v1/chat/completions",
        },
      },
      {
        proxy: "REST-AI-GenerateContent",
        environment: "test",
        statusCode: 200,
        clientIp: "127.0.0.1",
        model: "gemini-3.5-flash-lite",
        durationMs: 190,
        targetLatencyMs: 150,
        general: {
          proxyName: "REST-AI-GenerateContent",
          clientIp: "127.0.0.1",
          requestVerb: "POST",
          proxyRequestUri: "/v1/projects/demo/locations/global/publishers/google/models/gemini-3.5-flash-lite:generateContent",
        },
      },
    ];

    let count = 0;
    for (const r of demoRecords) {
      await this.saveRecord(r);
      count++;
    }
    return count;
  }

  private toFirestoreFields(obj: any): any {
    const fields: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        fields[k] = { stringValue: v };
      } else if (typeof v === "number") {
        if (Number.isInteger(v)) {
          fields[k] = { integerValue: String(v) };
        } else {
          fields[k] = { doubleValue: v };
        }
      } else if (typeof v === "boolean") {
        fields[k] = { booleanValue: v };
      } else if (v && typeof v === "object") {
        fields[k] = { mapValue: { fields: this.toFirestoreFields(v) } };
      }
    }
    return fields;
  }

  private fromFirestoreFields(fields: any): any {
    const obj: any = {};
    for (const [k, v] of Object.entries(fields)) {
      const valObj = v as any;
      if (valObj.stringValue !== undefined) obj[k] = valObj.stringValue;
      else if (valObj.integerValue !== undefined) obj[k] = parseInt(valObj.integerValue, 10);
      else if (valObj.doubleValue !== undefined) obj[k] = valObj.doubleValue;
      else if (valObj.booleanValue !== undefined) obj[k] = valObj.booleanValue;
      else if (valObj.mapValue?.fields) obj[k] = this.fromFirestoreFields(valObj.mapValue.fields);
    }
    return obj;
  }
}
