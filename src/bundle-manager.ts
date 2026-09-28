import fs from "fs";
import path from "path";
import { BundleInfo } from "./types.ts";
import { createZip, readZip, ZipEntry } from "./zip-util.ts";

const routeRuleRegex = /<RouteRule\b[^>]*>[\s\S]*?<\/RouteRule>/g;
const targetEndpointRegex = /<TargetEndpoint>\s*([^<]+?)\s*<\/TargetEndpoint>/;
const authRegex = /<Authentication\b[^>]*>[\s\S]*?<\/Authentication>/g;
const envVarRegex = /env\.([a-zA-Z0-9_]+)/g;
const envBracesRegex = /\{([a-zA-Z0-9_]+)\}/g;

export class BundleManager {
  public dataDir: string;
  public rootDir: string;

  constructor(dataDir?: string) {
    this.rootDir = process.cwd();
    this.dataDir = dataDir || process.env.DATA_DIR || path.join(this.rootDir, "data");
  }

  public findDataFile(category: string, filename: string): string {
    const candidates = [
      path.join(this.dataDir, category, filename),
      path.join(this.dataDir, filename),
      path.join(this.rootDir, "data", category, filename),
      path.join(this.rootDir, "data", filename),
      path.join(this.rootDir, filename),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return "";
  }

  public resolveEnvVarPlaceholders(text: string): { text: string; changed: boolean } {
    let changed = false;
    let res = text;

    res = res.replace(envVarRegex, (match, varName) => {
      const val = process.env[varName];
      if (val !== undefined) {
        changed = true;
        return val;
      }
      return match;
    });

    res = res.replace(envBracesRegex, (match, varName) => {
      const val = process.env[varName];
      if (val !== undefined) {
        changed = true;
        return val;
      }
      return match;
    });

    return { text: res, changed };
  }

  public resolveKVMValue(v: any): { value: any; changed: boolean } {
    if (typeof v === "string") {
      const { text, changed } = this.resolveEnvVarPlaceholders(v);
      return { value: text, changed };
    }
    if (Array.isArray(v)) {
      let anyChanged = false;
      const list = v.map((item) => {
        const { value, changed } = this.resolveKVMValue(item);
        if (changed) anyChanged = true;
        return value;
      });
      return { value: list, changed: anyChanged };
    }
    if (v && typeof v === "object") {
      let anyChanged = false;
      const copy: any = { ...v };
      if (typeof copy.scope === "string" && copy.scope.toLowerCase() === "environment") {
        if (!copy.environment) {
          copy.environment = "test";
          copy.environments = ["test"];
          copy.env = "test";
          anyChanged = true;
        }
      }
      for (const [key, val] of Object.entries(copy)) {
        const { value, changed } = this.resolveKVMValue(val);
        if (changed) anyChanged = true;
        copy[key] = value;
      }
      return { value: copy, changed: anyChanged };
    }
    return { value: v, changed: false };
  }

  public resolveKVMEnvVars(): string | null {
    const p = this.findDataFile("maps", "maps.json");
    if (!p || !fs.existsSync(p)) return null;

    try {
      const content = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(content);
      const { value, changed } = this.resolveKVMValue(parsed);
      const modifiedJson = JSON.stringify(value, null, 2);

      if (changed) {
        fs.writeFileSync(p, modifiedJson, "utf-8");
      }
      return modifiedJson;
    } catch (err) {
      console.warn(`[KVM] Error resolving KVM vars in ${p}:`, err);
      return null;
    }
  }

  public getMaps(): any[] {
    this.resolveKVMEnvVars();
    const p = this.findDataFile("maps", "maps.json");
    if (!p || !fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return [];
    }
  }

  public getProducts(): any[] {
    const p = this.findDataFile("products", "products.json");
    if (!p || !fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return [];
    }
  }

  public getUsers(): any[] {
    const p = this.findDataFile("developers", "developers.json");
    if (!p || !fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return [];
    }
  }

  public getApps(): any[] {
    const p = this.findDataFile("developerapps", "developerapps.json");
    if (!p || !fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return [];
    }
  }

  public getDataCollectors(): any[] {
    const p = this.findDataFile("datacollectors", "datacollectors.json");
    if (!p || !fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return [];
    }
  }

  public getKVMSecretValues(): string[] {
    const maps = this.getMaps();
    const secrets: string[] = [];
    const extract = (entries: any) => {
      if (!entries) return;
      if (Array.isArray(entries)) {
        for (const item of entries) {
          if (typeof item === "string" && item.length >= 6) {
            secrets.push(item);
          } else if (item && typeof item === "object") {
            if (typeof item.value === "string" && item.value.length >= 6) {
              secrets.push(item.value);
            }
            for (const [k, v] of Object.entries(item)) {
              if (["name", "scope", "env", "environment"].includes(k)) continue;
              if (typeof v === "string" && v.length >= 6) {
                secrets.push(v);
              }
            }
          }
        }
      }
    };

    for (const m of maps) {
      if (m && m.entries) extract(m.entries);
    }
    return Array.from(new Set(secrets));
  }

  public async listBundles(): Promise<BundleInfo[]> {
    const bundlesDir = path.join(this.dataDir, "bundles");
    if (!fs.existsSync(bundlesDir)) return [];

    const files = fs.readdirSync(bundlesDir);
    const results: BundleInfo[] = [];

    for (const file of files) {
      if (!file.endsWith(".zip")) continue;
      const filePath = path.join(bundlesDir, file);
      const stat = fs.statSync(filePath);
      try {
        const info = await this.inspectBundle(filePath);
        info.fileName = file;
        info.sizeBytes = stat.size;
        results.push(info);
      } catch {
        const proxyName = file.replace(/\.zip$/, "");
        results.push({
          fileName: file,
          filePath,
          proxyName,
          basePaths: ["/" + proxyName.toLowerCase()],
          sizeBytes: stat.size,
          policies: [],
          targetRoutes: [],
        });
      }
    }

    return results;
  }

  public async inspectBundle(zipPath: string): Promise<BundleInfo> {
    const proxyName = path.basename(zipPath, ".zip");
    const buffer = fs.readFileSync(zipPath);
    const files = await readZip(buffer);

    const basePaths: string[] = [];
    const policies: string[] = [];
    const targetRoutes: string[] = [];

    for (const [fileName, contentBuf] of Object.entries(files)) {
      const clean = fileName.replace(/\\/g, "/");

      // Check Proxy Endpoint XML for BasePath
      if (clean.includes("apiproxy/proxies/") && clean.endsWith(".xml")) {
        const xml = contentBuf.toString("utf-8");
        const bpMatch = xml.match(/<BasePath>\s*([^<]+?)\s*<\/BasePath>/);
        if (bpMatch && bpMatch[1]) {
          basePaths.push(bpMatch[1].trim());
        }
      }

      // Check Policies
      if (clean.includes("apiproxy/policies/") && clean.endsWith(".xml")) {
        const polName = path.basename(clean, ".xml");
        policies.push(polName);
      }

      // Check Target Endpoints
      if (clean.includes("apiproxy/targets/") && clean.endsWith(".xml")) {
        const targetName = path.basename(clean, ".xml");
        targetRoutes.push(targetName);
      }
    }

    if (basePaths.length === 0) {
      basePaths.push("/" + proxyName.toLowerCase());
    }

    return {
      fileName: path.basename(zipPath),
      filePath: zipPath,
      proxyName,
      basePaths,
      policies,
      targetRoutes,
      sizeBytes: buffer.length,
    };
  }

  public sanitizeRouteRules(xmlStr: string, availableTargets: Set<string>): string {
    let preferredTarget = "";
    if (availableTargets.has("googlecloud")) {
      preferredTarget = "googlecloud";
    } else if (availableTargets.has("googlecloud-projects")) {
      preferredTarget = "googlecloud-projects";
    } else if (availableTargets.has("googlecloud-oai")) {
      preferredTarget = "googlecloud-oai";
    } else if (availableTargets.size > 0) {
      preferredTarget = Array.from(availableTargets)[0];
    }

    return xmlStr.replace(routeRuleRegex, (chunk) => {
      const match = chunk.match(targetEndpointRegex);
      if (match && match[1]) {
        const targetName = match[1].trim();
        if (!availableTargets.has(targetName)) {
          if (preferredTarget) {
            return chunk.replace(
              targetEndpointRegex,
              `<TargetEndpoint>${preferredTarget}</TargetEndpoint>`,
            );
          }
          // Remove TargetEndpoint to make it a no-target route
          return chunk.replace(targetEndpointRegex, "");
        }
      }
      return chunk;
    });
  }

  public async buildEnvironmentBundle(
    bundleFileNames?: string[],
  ): Promise<{ zipBuffer: Buffer; deployedProxyNames: string[] }> {
    const bundlesDir = path.join(this.dataDir, "bundles");
    let selectedPaths: string[] = [];

    if (!bundleFileNames || bundleFileNames.length === 0) {
      if (fs.existsSync(bundlesDir)) {
        for (const f of fs.readdirSync(bundlesDir)) {
          if (f.endsWith(".zip")) {
            selectedPaths.push(path.join(bundlesDir, f));
          }
        }
      }
    } else {
      for (let name of bundleFileNames) {
        if (!name.endsWith(".zip")) name += ".zip";
        const p = path.join(bundlesDir, name);
        if (fs.existsSync(p)) {
          selectedPaths.push(p);
        }
      }
    }

    if (selectedPaths.length === 0) {
      throw new Error("No proxy bundles found to deploy");
    }

    const zipEntries: ZipEntry[] = [];
    const deployedProxyNames: string[] = [];

    for (const zipPath of selectedPaths) {
      const proxyName = path.basename(zipPath, ".zip");
      deployedProxyNames.push(proxyName);

      const buf = fs.readFileSync(zipPath);
      const files = await readZip(buf);

      // Collect available targets
      const targets = new Set<string>();
      for (const fileName of Object.keys(files)) {
        const clean = fileName.replace(/\\/g, "/");
        if (clean.includes("apiproxy/targets/") && clean.endsWith(".xml")) {
          targets.add(path.basename(clean, ".xml"));
        }
      }

      for (const [fileName, fileData] of Object.entries(files)) {
        const clean = fileName.replace(/\\/g, "/");
        let relativePath = clean;
        if (clean.startsWith("apiproxy/")) {
          relativePath = clean;
        } else if (clean.includes("/apiproxy/")) {
          const idx = clean.indexOf("/apiproxy/");
          relativePath = clean.slice(idx + 1);
        } else {
          relativePath = path.posix.join("apiproxy", clean);
        }

        const destPath = `src/main/apigee/apiproxies/${proxyName}/${relativePath}`;
        let content = fileData;

        // If proxy endpoint XML, sanitize RouteRule targets
        if (clean.includes("apiproxy/proxies/") && clean.endsWith(".xml")) {
          const sanitized = this.sanitizeRouteRules(content.toString("utf-8"), targets);
          content = Buffer.from(sanitized, "utf-8");
        }

        // If policy XML, strip Authentication elements that require service accounts
        if (clean.includes("apiproxy/policies/") && clean.endsWith(".xml")) {
          const stripped = content.toString("utf-8").replace(authRegex, "");
          content = Buffer.from(stripped, "utf-8");
        }

        zipEntries.push({ path: destPath, data: content });
      }
    }

    // Add env.json
    zipEntries.push({
      path: "src/main/apigee/environments/test/env.json",
      data: JSON.stringify({ name: "test" }),
    });

    // Add deployments.json
    zipEntries.push({
      path: "src/main/apigee/environments/test/deployments.json",
      data: JSON.stringify({ proxies: deployedProxyNames }, null, 2),
    });

    // Add datacollectors.json if present
    const dcPath = this.findDataFile("datacollectors", "datacollectors.json");
    if (dcPath && fs.existsSync(dcPath)) {
      zipEntries.push({
        path: "src/main/apigee/environments/test/datacollectors.json",
        data: fs.readFileSync(dcPath),
      });
    }

    const zipBuffer = await createZip(zipEntries);
    return { zipBuffer, deployedProxyNames };
  }

  public normalizeProductForEmulator(prod: any, proxyNames: string[] = []): any {
  const p = JSON.parse(JSON.stringify(prod));

  const envs: string[] = Array.isArray(p.environments) ? [...p.environments] : [];
  if (!envs.includes("test")) envs.push("test");
  p.environments = envs;

  const opGroup = p.operationGroup || { operationConfigType: "proxy", operationConfigs: [] };
  const llmGroup = p.llmOperationGroup || { operationConfigType: "proxy", operationConfigs: [] };

  const opConfigs = Array.isArray(opGroup.operationConfigs) ? opGroup.operationConfigs : [];
  const llmConfigs = Array.isArray(llmGroup.operationConfigs) ? llmGroup.operationConfigs : [];

  // 1. Split regular operation configs so each config has only 1 operation
  const splitOps: any[] = [];
  const existingOps = new Set<string>();

  for (const cfg of opConfigs) {
    const src = cfg.apiSource || "";
    if (src) existingOps.add(src);
    const quota = cfg.quota || {};
    const rawOps = Array.isArray(cfg.operations) ? cfg.operations : [];
    if (rawOps.length > 1) {
      for (const op of rawOps) {
        splitOps.push({
          apiSource: src,
          operations: [op],
          quota,
        });
      }
    } else {
      splitOps.push(cfg);
    }
  }

  for (const pr of proxyNames) {
    if (!existingOps.has(pr)) {
      splitOps.push({
        apiSource: pr,
        operations: [{ resource: "/" }],
        quota: {},
      });
      existingOps.add(pr);
    }
  }
  opGroup.operationConfigs = splitOps;

  // 2. Normalize LLM operation configs: exactly ONE entity per operationConfig
  const normalizedLLMConfigs: any[] = [];
  const seenLLMOps = new Set<string>();

  for (const cfg of llmConfigs) {
    const src = cfg.apiSource || "";
    const quota = cfg.llmTokenQuota || {
      limit: "50000",
      interval: "1",
      timeUnit: "minute",
    };
    const rawOps = Array.isArray(cfg.llmOperations) ? cfg.llmOperations : [];
    for (const op of rawOps) {
      const m = op.model || "";
      const r = op.resource || "/";
      const k = `${src}:${m}:${r}`;
      if (!seenLLMOps.has(k)) {
        normalizedLLMConfigs.push({
          apiSource: src,
          llmOperations: [op],
          llmTokenQuota: quota,
        });
        seenLLMOps.add(k);
      }
    }
  }

  // Ensure root resource "/" is authorized for each (apiSource, model)
  for (const cfg of [...normalizedLLMConfigs]) {
    const src = cfg.apiSource || "";
    const quota = cfg.llmTokenQuota;
    const op = cfg.llmOperations?.[0];
    if (op) {
      const m = op.model || "";
      const kRoot = `${src}:${m}:/`;
      if (!seenLLMOps.has(kRoot)) {
        normalizedLLMConfigs.push({
          apiSource: src,
          llmOperations: [
            {
              resource: "/",
              methods: ["POST"],
              model: m,
            },
          ],
          llmTokenQuota: quota,
        });
        seenLLMOps.add(kRoot);
      }
    }
  }
  llmGroup.operationConfigs = normalizedLLMConfigs;

  p.operationGroup = opGroup;
  p.llmOperationGroup = llmGroup;

  // In Apigee Emulator, if operationGroup or llmOperationGroup is present,
  // proxies and apiResources must NOT be set
  if (splitOps.length > 0 || normalizedLLMConfigs.length > 0) {
    delete p.proxies;
    delete p.apiResources;
  } else {
    const prodProxies: string[] = Array.isArray(p.proxies) ? [...p.proxies] : [];
    for (const pr of proxyNames) {
      if (!prodProxies.includes(pr)) prodProxies.push(pr);
    }
    p.proxies = prodProxies;

    const apiRes: string[] = Array.isArray(p.apiResources) ? [...p.apiResources] : [];
    for (const r of ["/", "/*", "/**"]) {
      if (!apiRes.includes(r)) apiRes.push(r);
    }
    p.apiResources = apiRes;
  }

  return p;
}

  public async buildTestDataBundle(proxyNames: string[]): Promise<Buffer> {
    const zipEntries: ZipEntry[] = [];

    // 1. Products: sanitize and normalize for emulator
    const rawProducts = this.getProducts();
    const products = rawProducts.map((p) => this.normalizeProductForEmulator(p, proxyNames));

    zipEntries.push({
      path: "products.json",
      data: JSON.stringify(products, null, 2),
    });

    // 2. Developer apps
    const apps = this.getApps();
    for (const app of apps) {
      if (!app.credentials) app.credentials = [];
      const hasKey = app.credentials.some(
        (c: any) => c.consumerKey === "test-api-key-12345" || c.consumerKey === "test-app-key-123",
      );
      if (!hasKey) {
        app.credentials.push({
          consumerKey: "test-api-key-12345",
          consumerSecret: "test-api-secret-12345",
          status: "approved",
          apiProducts: [{ apiproduct: "test-product", status: "approved" }],
        });
      }
    }
    zipEntries.push({
      path: "developerapps.json",
      data: JSON.stringify(apps, null, 2),
    });

    // 3. Developers
    const users = this.getUsers();
    zipEntries.push({
      path: "developers.json",
      data: JSON.stringify(users, null, 2),
    });

    // 4. Maps (KVMs)
    const resolvedKvm = this.resolveKVMEnvVars();
    if (resolvedKvm) {
      zipEntries.push({ path: "maps.json", data: resolvedKvm });
    } else {
      const maps = this.getMaps();
      zipEntries.push({ path: "maps.json", data: JSON.stringify(maps, null, 2) });
    }

    // 5. Data Collectors
    const collectors = this.getDataCollectors();
    if (collectors.length > 0) {
      zipEntries.push({ path: "datacollectors.json", data: JSON.stringify(collectors, null, 2) });
    }

    return await createZip(zipEntries);
  }
}
