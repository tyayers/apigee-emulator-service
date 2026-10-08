import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { DeploymentConfig, TestCase } from "./types.ts";

export class DeploymentManager {
  public dataDir: string;
  public rootDir: string;

  constructor(dataDir?: string) {
    this.rootDir = process.cwd();
    this.dataDir = dataDir || process.env.DATA_DIR || path.join(this.rootDir, "data");
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

  public listDeployments(): DeploymentConfig[] {
    const depDir = path.join(this.dataDir, "deployments");
    if (!fs.existsSync(depDir)) return [];

    const files = fs.readdirSync(depDir);
    const results: DeploymentConfig[] = [];

    for (const file of files) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const filePath = path.join(depDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed = YAML.parse(content);
        if (parsed) {
          results.push({
            name: parsed.name || path.basename(file, path.extname(file)),
            filePath,
            templates: parsed.templates || [],
            products: parsed.products || [],
            users: parsed.users || [],
            tests: (parsed.tests || []).map((t: any) => ({
              ...t,
              proxyDisplayName: this.getProxyDisplayName(t.proxy),
            })),
          });
        }
      } catch {
        // ignore
      }
    }

    return results;
  }

  public loadAllTests(): TestCase[] {
    const allTests: TestCase[] = [];
    const depConfigs = this.listDeployments();

    for (const dep of depConfigs) {
      if (dep.tests && Array.isArray(dep.tests)) {
        for (const t of dep.tests) {
          const copy: TestCase = {
            ...t,
            deployment: dep.name,
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

    // Also check tests.json
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
    return allTests;
  }

  public getDeploymentTests(nameOrPath: string): TestCase[] {
    const base = path.basename(nameOrPath);
    const baseWithoutExt = path.basename(nameOrPath, path.extname(nameOrPath));
    const all = this.loadAllTests();
    return all.filter(
      (t) =>
        t.deployment === base ||
        t.deployment === baseWithoutExt ||
        t.deployment === nameOrPath ||
        t.deployment === `${baseWithoutExt}.yaml` ||
        t.deployment === `${baseWithoutExt}.yml`
    );
  }

  public getDeploymentCredentials(): { consumerKey: string; consumerSecret?: string; appName: string; products: string[] }[] {
    const results: { consumerKey: string; consumerSecret?: string; appName: string; products: string[] }[] = [];
    const depConfigs = this.listDeployments();
    for (const dep of depConfigs) {
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
    const tests = this.loadAllTests();
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

  public getDeploymentConsumerKeys(): string[] {
    return Array.from(new Set(this.getDeploymentCredentials().map((c) => c.consumerKey)));
  }
}
