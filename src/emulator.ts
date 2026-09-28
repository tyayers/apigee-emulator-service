import { DeployedProxy, EmulatorStatus } from "./types.ts";
import { redactValue } from "./redact.ts";

export class EmulatorClient {
  public mgmtUrl: string;
  public runtimeUrl: string;
  public kvmSecretProvider?: () => string[];

  constructor(mgmtUrl?: string, runtimeUrl?: string) {
    this.mgmtUrl = (
      mgmtUrl ||
      process.env.EMULATOR_MGMT_URL ||
      "http://127.0.0.1:8080"
    ).replace(/\/$/, "");
    this.runtimeUrl = (
      runtimeUrl ||
      process.env.EMULATOR_RUNTIME_URL ||
      "http://127.0.0.1:8998"
    ).replace(/\/$/, "");
  }

  public async checkHealth(): Promise<EmulatorStatus> {
    const status: EmulatorStatus = {
      online: false,
      version: "2.0.1",
      activeProxies: [],
      availableBundles: [],
      products: [],
      users: [],
      apps: [],
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.mgmtUrl}/v1/emulator/tree`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        status.online = true;
        const tree = await this.getDeploymentTree();
        status.activeProxies = tree;
      }
    } catch {
      status.online = false;
    }

    return status;
  }

  public async reset(): Promise<void> {
    const res = await fetch(`${this.mgmtUrl}/v1/emulator/reset`, {
      method: "POST",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Reset returned status ${res.status}: ${text}`);
    }
  }

  public async setupTestData(zipBytes: Uint8Array | Buffer): Promise<void> {
    const formData = new FormData();
    const blob = new Blob([zipBytes], { type: "application/zip" });
    formData.append("file", blob, "testdata.zip");

    const res = await fetch(`${this.mgmtUrl}/v1/emulator/setup/tests`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Setup test data returned status ${res.status}: ${text}`);
    }
  }

  public async deployBundle(environment: string = "test", zipBytes: Uint8Array | Buffer): Promise<string> {
    const formData = new FormData();
    const blob = new Blob([zipBytes], { type: "application/zip" });
    formData.append("file", blob, "bundle.zip");

    const res = await fetch(`${this.mgmtUrl}/v1/emulator/deploy?environment=${encodeURIComponent(environment)}`, {
      method: "POST",
      body: formData,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Deploy returned status ${res.status}: ${text}`);
    }

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.revision === "string") {
        return parsed.revision;
      }
    } catch {
      // Return raw text if not json
    }
    return text || "1";
  }

  public async getRawDeploymentTree(): Promise<any> {
    try {
      const res = await fetch(`${this.mgmtUrl}/v1/emulator/tree`);
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // ignore
    }
    return [];
  }

  public async getDeploymentTree(): Promise<DeployedProxy[]> {
    try {
      const res = await fetch(`${this.mgmtUrl}/v1/emulator/tree`);
      if (!res.ok) return [];

      const data = await res.json();
      const results: DeployedProxy[] = [];

      // 1. Array format: [{"application":"TestProxy","name":"default","basePath":"testproxy",...}]
      if (Array.isArray(data)) {
        for (const item of data) {
          const appName = item.application || item.name || "";
          let bp = item.basePath || item.basepath || "";
          if (bp && !bp.startsWith("/")) {
            bp = "/" + bp;
          }
          const rev = String(item.revision || "1");
          if (appName) {
            results.push({
              name: appName,
              revision: rev,
              basePath: bp,
            });
          }
        }
        return results;
      }

      // 2. Object format: { organizations: { hybrid: { environments: { test: { proxies: ... } } } } }
      if (data && typeof data === "object") {
        const orgs = data.organizations || {};
        for (const envsObj of Object.values(orgs)) {
          if (!envsObj || typeof envsObj !== "object") continue;
          for (const envObj of Object.values(envsObj)) {
            const envData = envObj as any;
            if (!envData || typeof envData !== "object") continue;
            const proxiesObj = envData.proxies || envData.apiproxies || {};
            for (const [pName, pVal] of Object.entries(proxiesObj)) {
              const pData = pVal as any;
              let rev = "1";
              let basePath = "";
              if (pData && pData.revisions) {
                for (const [rName, rVal] of Object.entries(pData.revisions)) {
                  rev = rName;
                  const rData = rVal as any;
                  if (rData) {
                    basePath = rData.basepath || rData.basePath || "";
                  }
                  break;
                }
              }
              if (basePath && !basePath.startsWith("/")) {
                basePath = "/" + basePath;
              }
              results.push({
                name: pName,
                revision: rev,
                basePath: basePath,
              });
            }
          }
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  public async startTraceSession(proxyName: string): Promise<string> {
    const res = await fetch(
      `${this.mgmtUrl}/v1/emulator/trace?proxyName=${encodeURIComponent(proxyName)}`,
      { method: "POST" },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Trace start returned status ${res.status}: ${text}`);
    }

    const data = (await res.json()) as any;
    return data?.name || data?.sessionId || "";
  }

  public async getTraceTransactions(sessionId: string): Promise<any> {
    const res = await fetch(
      `${this.mgmtUrl}/v1/emulator/trace/transactions?sessionid=${encodeURIComponent(sessionId)}`,
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Trace transactions returned status ${res.status}: ${text}`);
    }

    const data = await res.json();
    return this.redactTrace(data);
  }

  private redactTrace(traceData: any): any {
    if (!traceData || !this.kvmSecretProvider) return traceData;
    const secrets = this.kvmSecretProvider();
    let current = traceData;
    for (const secret of secrets) {
      if (!secret || secret.length < 6) continue;
      current = redactValue(current, secret, "[REDACTED]");
    }
    return current;
  }
}
