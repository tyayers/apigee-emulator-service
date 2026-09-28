import { googleAuthService } from "./google-auth.ts";

export class AnalyticsManager {
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
    const projectId = await this.detectProjectID();
    let token = await googleAuthService.getAccessToken();

    const record = typeof body === "string" ? JSON.parse(body) : body;
    record.id = record.id || `record_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    record.timestamp = record.timestamp || new Date().toISOString();

    if (!token) {
      console.warn("[Analytics] Warning: no Google access token available, skipping Firestore save");
      return record;
    }

    const firestoreDoc = this.toFirestoreFields(record);
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/apigee_analytics?documentId=${encodeURIComponent(record.id)}`;

    let res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: firestoreDoc }),
    });

    // If 401 occurs, refresh ADC token and retry once
    if (res.status === 401) {
      googleAuthService.invalidateToken();
      token = await googleAuthService.getAccessToken();
      if (token) {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ fields: firestoreDoc }),
        });
      }
    }

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[Analytics] Firestore save warning (${res.status}): ${errText}`);
    } else {
      console.log(`[Analytics] Successfully recorded analytics to Firestore for proxy '${record.proxy || record.general?.proxyName || "unknown"}' (ID: ${record.id})`);
    }

    return record;
  }

  public async getLastRecords(limit: number = 500): Promise<any[]> {
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
      });

      if (listRes.ok) {
        const listData = (await listRes.json()) as { documents?: any[] };
        const records: any[] = [];
        for (const doc of listData.documents || []) {
          if (doc.fields) {
            records.push(this.fromFirestoreFields(doc.fields));
          }
        }
        records.sort((a, b) => {
          const t1 = String(a.timestamp || "");
          const t2 = String(b.timestamp || "");
          return t2.localeCompare(t1);
        });
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
      },
      {
        proxy: "REST-AI-Completions",
        environment: "test",
        statusCode: 200,
        clientIp: "127.0.0.1",
        model: "google/gemini-3.5-flash-lite",
        durationMs: 230,
        targetLatencyMs: 180,
      },
      {
        proxy: "REST-AI-GenerateContent",
        environment: "test",
        statusCode: 200,
        clientIp: "127.0.0.1",
        model: "gemini-3.5-flash-lite",
        durationMs: 190,
        targetLatencyMs: 150,
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
