import fs from "fs";
import path from "path";
import { BundleInfo } from "./types.ts";
import { createZip, readZip, ZipEntry } from "./zip-util.ts";

const routeRuleRegex = /<RouteRule\b[^>]*>[\s\S]*?<\/RouteRule>/g;
const targetEndpointRegex = /<TargetEndpoint>\s*([^<]+?)\s*<\/TargetEndpoint>/;
const authRegex = /<Authentication\b[^>]*>[\s\S]*?<\/Authentication>/g;
const envVarRegex = /env\.([a-zA-Z0-9_]+)/g;
const envBracesRegex = /\{([a-zA-Z0-9_]+)\}/g;

export const DEFAULT_AI_DATA_COLLECTORS = [
  { name: "dc_ai_model", type: "STRING" },
  { name: "dc_ai_user", type: "STRING" },
  { name: "dc_ai_provider", type: "STRING" },
  { name: "dc_ai_cost_center", type: "STRING" },
  { name: "dc_ai_response_type", type: "STRING" },
  { name: "dc_ai_total_token_count", type: "INTEGER" },
  { name: "dc_ai_prompt_token_count", type: "INTEGER" },
  { name: "dc_ai_response_token_count", type: "INTEGER" },
  { name: "dc_ai_time_first_token", type: "INTEGER" },
  { name: "dc_ai_request_cost", type: "FLOAT" },
  { name: "dc_ai_response_cost", type: "FLOAT" },
  { name: "dc_ai_total_cost", type: "FLOAT" },
];

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

  public getCustomResources(): { products: any[]; users: any[]; apps: any[] } {
    const p = path.join(this.dataDir, "labs-custom-resources.json");
    if (!fs.existsSync(p)) {
      return { products: [], users: [], apps: [] };
    }
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      return {
        products: Array.isArray(data.products) ? data.products : [],
        users: Array.isArray(data.users) ? data.users : [],
        apps: Array.isArray(data.apps) ? data.apps : [],
      };
    } catch {
      return { products: [], users: [], apps: [] };
    }
  }

  public saveCustomResources(res: { products?: any[]; users?: any[]; apps?: any[] }): { products: any[]; users: any[]; apps: any[] } {
    const p = path.join(this.dataDir, "labs-custom-resources.json");
    const existing = this.getCustomResources();
    const updated = {
      products: res.products !== undefined ? res.products : existing.products,
      users: res.users !== undefined ? res.users : existing.users,
      apps: res.apps !== undefined ? res.apps : existing.apps,
    };
    fs.writeFileSync(p, JSON.stringify(updated, null, 2), "utf-8");
    return updated;
  }

  public clearCustomResources(): void {
    const p = path.join(this.dataDir, "labs-custom-resources.json");
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  }

  public getDefaultProducts(): any[] {
    const p = this.findDataFile("products", "products.json");
    if (!p || !fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return [];
    }
  }

  public getDefaultUsers(): any[] {
    const p = this.findDataFile("developers", "developers.json");
    if (!p || !fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return [];
    }
  }

  public getDefaultApps(): any[] {
    const p = this.findDataFile("developerapps", "developerapps.json");
    if (!p || !fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return [];
    }
  }

  public getProducts(): any[] {
    const def = this.getDefaultProducts();
    const custom = this.getCustomResources().products;
    return [...def, ...custom];
  }

  public getUsers(): any[] {
    const def = this.getDefaultUsers();
    const custom = this.getCustomResources().users;
    return [...def, ...custom];
  }

  public getApps(): any[] {
    const def = this.getDefaultApps();
    const custom = this.getCustomResources().apps;
    return [...def, ...custom];
  }

  public getDataCollectors(): any[] {
    const p = this.findDataFile("datacollectors", "datacollectors.json");
    if (p && fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {
        // fallback to defaults
      }
    }
    return DEFAULT_AI_DATA_COLLECTORS;
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
  opGroup.operationConfigType = "proxy";
  llmGroup.operationConfigType = "proxy";

  const opConfigs = Array.isArray(opGroup.operationConfigs) ? opGroup.operationConfigs : [];
  const llmConfigs = Array.isArray(llmGroup.operationConfigs) ? llmGroup.operationConfigs : [];

  // 1. Split regular operation configs so each config has only 1 operation
  const splitOps: any[] = [];
  const existingOps = new Set<string>();
  const ALL_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

  for (const cfg of opConfigs) {
    const src = cfg.apiSource || "";
    if (src) existingOps.add(src);
    const quota = cfg.quota || {};
    const rawOps = Array.isArray(cfg.operations) ? cfg.operations : [];
    if (rawOps.length > 1) {
      for (const op of rawOps) {
        const methods = Array.isArray(op.methods) && op.methods.length > 0 ? op.methods : ALL_METHODS;
        const resource = op.resource || op.name || "/";
        splitOps.push({
          apiSource: src,
          operations: [{ ...op, resource, methods }],
          quota,
        });
      }
    } else if (rawOps.length === 1) {
      const op = rawOps[0];
      const methods = Array.isArray(op.methods) && op.methods.length > 0 ? op.methods : ALL_METHODS;
      const resource = op.resource || op.name || "/";
      splitOps.push({
        apiSource: src,
        operations: [{ ...op, resource, methods }],
        quota,
      });
    } else {
      splitOps.push(cfg);
    }
  }

  // Helper to determine basePaths for a proxy
  const getBasePathsForProxy = (proxyName: string): string[] => {
    const known: Record<string, string[]> = {
      "REST-AI-Completions": ["/v1/chat/completions"],
      "REST-AI-Completions-Anonymized": ["/v1/chat/completions/sdp"],
      "REST-AI-Completions-Screened": ["/v1/chat/completions/modelarmor"],
      "REST-AI-Interactions": ["/v1beta/interactions"],
      "REST-AI-Messages": ["/v1/messages"],
      "REST-AI-GenerateContent": ["/v1/projects"],
      "REST-AI-Embeddings": ["/v1/embeddings"],
      "MCP-CustomerService": ["/customerservice"],
      "TestProxy": ["/testproxy"],
    };
    if (known[proxyName]) return known[proxyName];
    try {
      const pFile = path.join(process.cwd(), "data", "proxies", `${proxyName}.yaml`);
      if (fs.existsSync(pFile)) {
        const content = fs.readFileSync(pFile, "utf-8");
        const m = content.match(/basePath:\s*([^\s\n]+)/);
        if (m && m[1]) return [m[1].trim()];
      }
    } catch (_) {}
    return ["/" + proxyName.toLowerCase()];
  };

  const hasPayloadOps = Boolean(
    (p.payloadOperationGroup && p.payloadOperationGroup.operationConfigs?.length > 0) ||
    (Array.isArray(p.payloadOperations) && p.payloadOperations.length > 0)
  );

  if (!hasPayloadOps) {
    // Standard operations should ONLY include standard REST proxies:
    // 1. Proxies explicitly referenced in standard operations (existingOps)
    // 2. Or, if NO standard operations and NO LLM operations are defined, fallback to product proxies
    const standardTargetProxies = new Set<string>();
    for (const pr of existingOps) {
      if (!pr.toLowerCase().includes("mcp")) standardTargetProxies.add(pr);
    }
    if (standardTargetProxies.size === 0 && llmConfigs.length === 0) {
      const fallbackList = Array.isArray(p.proxies) && p.proxies.length > 0 ? p.proxies : proxyNames;
      for (const pr of fallbackList) {
        if (!pr.toLowerCase().includes("mcp")) standardTargetProxies.add(pr);
      }
    }

    for (const pr of standardTargetProxies) {
      const existingForProxy = splitOps.filter((o) => o.apiSource === pr);
      const existingResources = new Set(existingForProxy.map((o) => o.operations?.[0]?.resource));

      const candidateResources = ["/", "/**"];
      const basePaths = getBasePathsForProxy(pr);
      for (const bp of basePaths) {
        if (bp && bp !== "/") {
          candidateResources.push(bp);
          candidateResources.push(bp.endsWith("/") ? `${bp}**` : `${bp}/**`);
        }
      }

      for (const res of candidateResources) {
        if (!existingResources.has(res)) {
          splitOps.push({
            apiSource: pr,
            operations: [{ resource: res, methods: ALL_METHODS }],
            quota: {},
          });
          existingResources.add(res);
        }
      }
    }
    opGroup.operationConfigs = splitOps;
    p.operationGroup = opGroup;
  } else {
    delete p.operationGroup;
  }

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
      const rawRes = op.resource || op.name || "/";
      const candidatePaths = (!rawRes || rawRes === "/" || rawRes === "/**")
        ? ["/", "/**"]
        : [rawRes];
      const methods = Array.isArray(op.methods) && op.methods.length > 0 ? op.methods : ["POST"];
      for (const r of candidatePaths) {
        const k = `${src}:${m}:${r}`;
        if (!seenLLMOps.has(k) && normalizedLLMConfigs.length < 48) {
          normalizedLLMConfigs.push({
            apiSource: src,
            llmOperations: [{ ...op, resource: r, methods }],
            llmTokenQuota: quota,
          });
          seenLLMOps.add(k);
        }
      }
    }
  }

  // If product lists AI proxies in p.proxies but has no explicit llmOperations for them,
  // ensure they are included in normalizedLLMConfigs so requests to them are authorized.
  const existingLLMSources = new Set(normalizedLLMConfigs.map((c) => c.apiSource));
  const productProxies = Array.isArray(p.proxies) ? p.proxies : [];
  for (const pr of productProxies) {
    if (pr.startsWith("REST-AI-") && !existingLLMSources.has(pr)) {
      const defaultModel = "gemini-3.5-flash-lite";
      for (const r of ["/", "/**"]) {
        const k = `${pr}:${defaultModel}:${r}`;
        if (!seenLLMOps.has(k) && normalizedLLMConfigs.length < 48) {
          normalizedLLMConfigs.push({
            apiSource: pr,
            llmOperations: [
              {
                resource: r,
                methods: ["POST"],
                model: defaultModel,
              },
            ],
            llmTokenQuota: {
              limit: "50000",
              interval: "1",
              timeUnit: "minute",
            },
          });
          seenLLMOps.add(k);
        }
      }
      existingLLMSources.add(pr);
    }
  }

  llmGroup.operationConfigs = normalizedLLMConfigs;

  if (hasPayloadOps) {
    // Pure payload/MCP product: keep payloadOperationGroup and remove REST/LLM groups, proxies, apiResources
    delete p.operationGroup;
    delete p.llmOperationGroup;
    delete p.proxies;
    delete p.apiResources;
  } else {
    p.operationGroup = opGroup;
    p.llmOperationGroup = llmGroup;

    // In Apigee Emulator: if operationGroup or llmOperationGroup is present,
    // API resources or proxies should NOT be set
    if (splitOps.length > 0 || normalizedLLMConfigs.length > 0) {
      delete p.proxies;
      delete p.apiResources;
    } else {
      const prodProxies: string[] = Array.isArray(p.proxies) ? [...p.proxies] : [];
      for (const pr of proxyNames) {
        if (!prodProxies.includes(pr) && !pr.toLowerCase().includes("mcp") && !pr.toLowerCase().includes("customerservice")) {
          prodProxies.push(pr);
        }
      }
      p.proxies = prodProxies;

      const apiRes: string[] = Array.isArray(p.apiResources) ? [...p.apiResources] : [];
      for (const r of ["/", "/*", "/**"]) {
        if (!apiRes.includes(r)) apiRes.push(r);
      }
      p.apiResources = apiRes;
    }
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

    // 2. Developer apps and Developers
    const rawUsers = this.getUsers();
    const userEmails = new Set(rawUsers.map((u: any) => u.email));

    const apps = this.getApps().map((app: any) => {
      const email = app.developerEmail || app.developerId || "test@example.com";
      if (!userEmails.has(email)) {
        rawUsers.push({
          email: email,
          userName: email,
          firstName: "Lab",
          lastName: "Developer",
          attributes: [],
        });
        userEmails.add(email);
      }

      const creds = Array.isArray(app.credentials) ? app.credentials : [];
      const prodNames: string[] = Array.isArray(app.apiProducts)
        ? app.apiProducts
        : creds.flatMap((c: any) => (c.apiProducts || []).map((p: any) => typeof p === "string" ? p : p.apiproduct)).filter(Boolean);

      const appId = app.appId || app.id || undefined;
      return {
        ...(appId ? { appId } : {}),
        name: app.name,
        displayName: app.displayName || app.name,
        developerEmail: email,
        callbackUrl: app.callbackUrl || "",
        expiryType: app.expiryType || "never",
        apiProducts: prodNames.length > 0 ? prodNames : ["ai-starter-package", "mcp-package"],
        credentials: creds.map((c: any) => {
          const credProds = Array.isArray(c.apiProducts) && c.apiProducts.length > 0
            ? c.apiProducts.map((p: any) => ({
                apiproduct: typeof p === "string" ? p : p.apiproduct,
                status: "approved",
              }))
            : (prodNames.length > 0 ? prodNames : ["ai-starter-package", "mcp-package"]).map((pn) => ({
                apiproduct: pn,
                status: "approved",
              }));

          return {
            consumerKey: c.consumerKey,
            consumerSecret: c.consumerSecret || "custom-secret-123",
            status: c.status || "approved",
            apiProducts: credProds,
          };
        }),
        attributes: Array.isArray(app.attributes) ? app.attributes : [],
      };
    });

    zipEntries.push({
      path: "developerapps.json",
      data: JSON.stringify(apps, null, 2),
    });

    // 3. Developers
    const users = rawUsers.map((u: any) => ({
      email: u.email || "test@example.com",
      userName: u.userName || u.email || "test@example.com",
      firstName: u.firstName || "Developer",
      lastName: u.lastName || "User",
      attributes: Array.isArray(u.attributes) ? u.attributes : [],
    }));

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
