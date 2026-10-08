import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { DeploymentConfig, TestCase } from "./types.ts";

export class DeploymentManager {
  public dataDir: string;
  public rootDir: string;
  private metaFilePath: string;

  constructor(dataDir?: string) {
    this.rootDir = process.cwd();
    this.dataDir = dataDir || process.env.DATA_DIR || path.join(this.rootDir, "data");
    this.metaFilePath = path.join(this.dataDir, "deployments-meta.json");
  }

  public detectProjectID(): string {
    return (
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCP_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      "demo-project"
    );
  }

  public substituteVars(text: string): string {
    if (!text) return "";
    let res = text;
    res = res.replace(/\{GOOGLE_CLOUD_PROJECT\}/g, this.detectProjectID());
    res = res.replace(/\{GOOGLE_CLOUD_LOCATION\}/g, process.env.GOOGLE_CLOUD_LOCATION || "global");
    res = res.replace(/\{([A-Za-z0-9_]+)\}/g, (match, varName) => {
      const val = process.env[varName];
      return val !== undefined ? val : match;
    });
    return res;
  }

  private readMetadata(): Record<string, any> {
    try {
      if (fs.existsSync(this.metaFilePath)) {
        return JSON.parse(fs.readFileSync(this.metaFilePath, "utf-8"));
      }
    } catch {}
    return {};
  }

  private writeMetadata(meta: Record<string, any>): void {
    try {
      fs.writeFileSync(this.metaFilePath, JSON.stringify(meta, null, 2), "utf-8");
    } catch (err) {
      console.warn("[DeploymentManager] Failed to write metadata:", err);
    }
  }

  public getProxyDisplayName(proxyName: string): string {
    const candidates = [
      path.join(this.dataDir, "proxies", `${proxyName}.yaml`),
      path.join(this.dataDir, "proxies", `${proxyName}.yml`),
      path.join(this.rootDir, "proxies", `${proxyName}.yaml`),
      path.join(this.rootDir, "proxies", `${proxyName}.yml`),
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, "utf-8");
          const parsed = YAML.parse(content);
          if (parsed?.displayName) return parsed.displayName;
          if (parsed?.name) return parsed.name;
        } catch {
          // ignore
        }
      }
    }

    return proxyName;
  }

  public getProxyYaml(proxyName: string): { yaml: string; source: string; displayName: string } | null {
    const candidates = [
      path.join(this.dataDir, "proxies", `${proxyName}.yaml`),
      path.join(this.dataDir, "proxies", `${proxyName}.yml`),
      path.join(this.rootDir, "proxies", `${proxyName}.yaml`),
      path.join(this.rootDir, "proxies", `${proxyName}.yml`),
      path.join(this.rootDir, `${proxyName}.yaml`),
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, "utf-8");
          const parsed = YAML.parse(raw);
          const displayName = parsed?.displayName || parsed?.name || proxyName;
          return { yaml: raw, source: p, displayName };
        } catch {
          // ignore
        }
      }
    }

    return null;
  }

  public extractProxyNames(parsed: any): string[] {
    const proxiesSet = new Set<string>();

    if (Array.isArray(parsed?.templates)) {
      for (const t of parsed.templates) {
        if (typeof t === "string") {
          const stem = path.basename(t, path.extname(t));
          if (stem) proxiesSet.add(stem);
        } else if (t && typeof t === "object" && t.name) {
          proxiesSet.add(t.name);
        }
      }
    }

    if (Array.isArray(parsed?.proxies)) {
      for (const p of parsed.proxies) {
        if (typeof p === "string") {
          const stem = path.basename(p, path.extname(p));
          if (stem) proxiesSet.add(stem);
        } else if (p && typeof p === "object" && p.name) {
          proxiesSet.add(p.name);
        }
      }
    }

    if (Array.isArray(parsed?.features)) {
      for (const f of parsed.features) {
        if (typeof f === "string") {
          const stem = path.basename(f, path.extname(f));
          if (stem) proxiesSet.add(stem);
        } else if (f && typeof f === "object" && f.name) {
          proxiesSet.add(f.name);
        }
      }
    }

    if (Array.isArray(parsed?.tests)) {
      for (const tc of parsed.tests) {
        if (tc?.proxy) proxiesSet.add(tc.proxy);
      }
    }

    return Array.from(proxiesSet);
  }

  public listDeployments(activeProxyNames?: string[]): DeploymentConfig[] {
    const depDir = path.join(this.dataDir, "deployments");
    if (!fs.existsSync(depDir)) return [];

    const files = fs.readdirSync(depDir);
    const results: DeploymentConfig[] = [];
    const meta = this.readMetadata();
    const activeLower = activeProxyNames ? new Set(activeProxyNames.map((p) => p.toLowerCase())) : null;

    for (const file of files) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const filePath = path.join(depDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed = YAML.parse(content);
        if (parsed) {
          const id = path.basename(file, path.extname(file));
          const name = parsed.name || id;
          const proxies = this.extractProxyNames(parsed);
          const fileMeta = meta[id] || {};

          let activeProxyCount = 0;
          if (activeLower) {
            activeProxyCount = proxies.filter((p) => activeLower.has(p.toLowerCase())).length;
          }

          results.push({
            id,
            name,
            displayName: parsed.displayName || name,
            filePath,
            sourceType: fileMeta.sourceType || "file",
            sourceUrl: fileMeta.sourceUrl,
            description: parsed.description || fileMeta.description || "",
            proxies,
            templates: parsed.templates || [],
            features: parsed.features || [],
            products: parsed.products || [],
            users: parsed.users || [],
            tests: (parsed.tests || []).map((t: any) => ({
              ...t,
              deployment: id,
              proxyDisplayName: this.getProxyDisplayName(t.proxy),
            })),
            testsCount: (parsed.tests || []).length,
            deployed: activeLower ? (proxies.length > 0 ? activeProxyCount > 0 : false) : undefined,
            activeProxyCount,
            totalProxyCount: proxies.length,
            createdAt: fileMeta.createdAt || fs.statSync(filePath).birthtime.toISOString(),
            lastTestRun: fileMeta.lastTestRun,
          });
        }
      } catch {
        // ignore
      }
    }

    return results;
  }

  public getDeployment(idOrName: string, activeProxyNames?: string[]): DeploymentConfig | null {
    const list = this.listDeployments(activeProxyNames);
    const target = idOrName.toLowerCase().trim();
    return (
      list.find(
        (d) =>
          d.id.toLowerCase() === target ||
          d.name.toLowerCase() === target ||
          path.basename(d.filePath, path.extname(d.filePath)).toLowerCase() === target
      ) || null
    );
  }

  public getDeploymentYaml(idOrName: string): string | null {
    const dep = this.getDeployment(idOrName);
    if (!dep || !fs.existsSync(dep.filePath)) return null;
    return fs.readFileSync(dep.filePath, "utf-8");
  }

  public saveDeployment(
    filename: string,
    yamlContent: string,
    meta?: { sourceUrl?: string; sourceType?: "file" | "url" | "upload" | "paste"; description?: string }
  ): DeploymentConfig {
    const depDir = path.join(this.dataDir, "deployments");
    if (!fs.existsSync(depDir)) {
      fs.mkdirSync(depDir, { recursive: true });
    }

    let cleanFilename = filename.trim();
    if (!cleanFilename.endsWith(".yaml") && !cleanFilename.endsWith(".yml")) {
      cleanFilename += ".yaml";
    }

    const filePath = path.join(depDir, cleanFilename);
    fs.writeFileSync(filePath, yamlContent, "utf-8");

    const id = path.basename(cleanFilename, path.extname(cleanFilename));
    const allMeta = this.readMetadata();
    allMeta[id] = {
      ...(allMeta[id] || {}),
      sourceType: meta?.sourceType || "upload",
      sourceUrl: meta?.sourceUrl,
      description: meta?.description,
      createdAt: allMeta[id]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.writeMetadata(allMeta);

    const dep = this.getDeployment(id);
    if (!dep) {
      throw new Error(`Failed to load saved deployment '${id}'`);
    }
    return dep;
  }

  public deleteDeployment(idOrName: string): boolean {
    const dep = this.getDeployment(idOrName);
    if (!dep) return false;

    if (fs.existsSync(dep.filePath)) {
      fs.unlinkSync(dep.filePath);
    }

    const meta = this.readMetadata();
    if (meta[dep.id]) {
      delete meta[dep.id];
      this.writeMetadata(meta);
    }
    return true;
  }

  public recordTestRun(
    deploymentId: string,
    summary: { total: number; passed: number; failed: number; timestamp: string }
  ): void {
    const meta = this.readMetadata();
    const existing = meta[deploymentId] || {};
    existing.lastTestRun = summary;
    meta[deploymentId] = existing;
    this.writeMetadata(meta);
  }

  public loadAllTests(deploymentId?: string): TestCase[] {
    const allTests: TestCase[] = [];
    const depConfigs = this.listDeployments();

    for (const dep of depConfigs) {
      if (
        deploymentId &&
        dep.id.toLowerCase() !== deploymentId.toLowerCase() &&
        dep.name.toLowerCase() !== deploymentId.toLowerCase()
      ) {
        continue;
      }

      if (dep.tests && Array.isArray(dep.tests)) {
        for (const t of dep.tests) {
          const copy: TestCase = {
            ...t,
            deployment: dep.id,
            verb: t.verb || (t as any).method || "GET",
            path: this.substituteVars(t.path),
            body: this.substituteVars(t.body || t.payload || ""),
            payload: this.substituteVars(t.payload || t.body || ""),
            proxyDisplayName: this.getProxyDisplayName(t.proxy),
          };
          allTests.push(copy);
        }
      }
    }

    // Also check tests.json only if not filtering by a deployment
    if (!deploymentId) {
      const testsJsonPath = path.join(this.dataDir, "tests.json");
      if (fs.existsSync(testsJsonPath)) {
        try {
          const content = fs.readFileSync(testsJsonPath, "utf-8");
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            for (const t of parsed) {
              allTests.push({
                ...t,
                verb: t.verb || t.method || "GET",
                path: this.substituteVars(t.path),
                body: this.substituteVars(t.body || t.payload || ""),
                payload: this.substituteVars(t.payload || t.body || ""),
                proxyDisplayName: this.getProxyDisplayName(t.proxy),
              });
            }
          }
        } catch {
          // ignore
        }
      }
    }
    return allTests;
  }

  public getDeploymentTests(nameOrPath: string): TestCase[] {
    return this.loadAllTests(nameOrPath);
  }

  public getDeploymentCredentials(
    deploymentId?: string
  ): { consumerKey: string; consumerSecret?: string; appName: string; products: string[] }[] {
    const results: { consumerKey: string; consumerSecret?: string; appName: string; products: string[] }[] = [];
    const depConfigs = this.listDeployments();

    for (const dep of depConfigs) {
      if (
        deploymentId &&
        dep.id.toLowerCase() !== deploymentId.toLowerCase() &&
        dep.name.toLowerCase() !== deploymentId.toLowerCase()
      ) {
        continue;
      }

      if (dep.users && Array.isArray(dep.users)) {
        for (const user of dep.users) {
          if (user.apps && Array.isArray(user.apps)) {
            for (const app of user.apps) {
              if (app.credentials && Array.isArray(app.credentials)) {
                for (const cred of app.credentials) {
                  if (cred.consumerKey && !results.some((r) => r.consumerKey === cred.consumerKey)) {
                    results.push({
                      consumerKey: cred.consumerKey,
                      consumerSecret: cred.consumerSecret,
                      appName: app.name || "Deployment App",
                      products: cred.products || app.products || [],
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    // Also include any keys explicitly found in test definitions
    const tests = this.loadAllTests(deploymentId);
    for (const t of tests) {
      const apiKey = Object.entries(t.headers || {}).find(
        ([k]) => k.toLowerCase() === "x-api-key" || k.toLowerCase() === "x-ai-key"
      )?.[1];
      if (apiKey && !results.some((r) => r.consumerKey === apiKey)) {
        results.push({
          consumerKey: apiKey,
          appName: "Test Definition Key",
          products: t.product ? [t.product] : [],
        });
      }
    }
    return results;
  }

  public getDeploymentConsumerKeys(deploymentId?: string): string[] {
    return Array.from(new Set(this.getDeploymentCredentials(deploymentId).map((c) => c.consumerKey)));
  }
}
