import fs from "fs";
import path from "path";
import * as YAML from "yaml";
import { ApigeeConverter } from "./lib/converter.ts";
import { ApigeeTemplaterService } from "./lib/service.ts";
import { Deployment, Parameter } from "./lib/interfaces.ts";
import { EmulatorClient } from "./emulator.ts";
import { BundleManager, DEFAULT_AI_DATA_COLLECTORS } from "./bundle-manager.ts";
import { syncCassandraDeveloperAppKeys } from "./cassandra-sync.ts";
import { DeployedProxy, DeployResponse } from "./types.ts";

export class DeploymentDeployer {
  private converter: ApigeeConverter;
  private service: ApigeeTemplaterService;
  private emulatorClient: EmulatorClient;
  private bundleManager: BundleManager;
  private dataDir: string;

  constructor(
    emulatorClient: EmulatorClient,
    bundleManager: BundleManager,
    dataDir?: string,
  ) {
    this.emulatorClient = emulatorClient;
    this.bundleManager = bundleManager;
    this.converter = new ApigeeConverter();
    this.service = new ApigeeTemplaterService();
    this.dataDir = dataDir || bundleManager.dataDir;

    // Point service paths to data directory
    this.service.templatesPath = path.join(this.dataDir, "templates");
    this.service.proxiesPath = path.join(this.dataDir, "proxies");
    this.service.featuresPath = path.join(this.dataDir, "features");
    this.service.productsPath = path.join(this.dataDir, "products");
    this.service.usersPath = path.join(this.dataDir, "users");
    this.service.deploymentsPath = path.join(this.dataDir, "deployments");
  }

  public substituteEnvVars(content: string): string {
    return content.replace(/\{([A-Za-z0-9_]+)\}/g, (match, varName) => {
      const val = process.env[varName];
      return val !== undefined ? val : match;
    });
  }

  public async convertAndDeploy(
    yamlOrObj: string | Deployment,
    options: {
      reset?: boolean;
      environment?: string;
      substituteVars?: boolean;
      merge?: boolean;
      deployAllExisting?: boolean;
    } = {},
  ): Promise<DeployResponse> {
    const startTime = Date.now();
    const environment = options.environment || "test";
    const reset = options.reset !== false; // default true

    let deployment: Deployment;
    if (typeof yamlOrObj === "string") {
      let content = yamlOrObj;
      if (options.substituteVars !== false) {
        content = this.substituteEnvVars(content);
      }
      deployment = YAML.parse(content) as Deployment;
    } else {
      deployment = yamlOrObj;
    }

    if (!deployment) {
      throw new Error("Invalid or empty deployment YAML");
    }

    // Set up parameters dictionary
    const paramDict: { [key: string]: string } = {};
    if (deployment.parameters && Array.isArray(deployment.parameters)) {
      for (const p of deployment.parameters) {
        if (p.name) {
          const raw = p.default !== undefined ? String(p.default) : (p as any).value !== undefined ? String((p as any).value) : "";
          paramDict[p.name] = this.substituteEnvVars(raw);
        }
      }
    }
    if (process.env.GOOGLE_CLOUD_PROJECT) {
      paramDict["GoogleCloudProject"] = process.env.GOOGLE_CLOUD_PROJECT;
      paramDict["GOOGLE_CLOUD_PROJECT"] = process.env.GOOGLE_CLOUD_PROJECT;
    }
    if (process.env.GEMINI_API_KEY) {
      paramDict["GeminiApiKey"] = process.env.GEMINI_API_KEY;
      paramDict["GEMINI_API_KEY"] = process.env.GEMINI_API_KEY;
    }

    this.converter.deploymentUpdateParameters(deployment, paramDict);

    // Resolve assets
    const resolved = await this.service.deploymentResolveAssets(deployment);

    // Collect all proxy names
    const allProxyNames: string[] = [];
    for (const t of resolved.templates) {
      if (t.name && !allProxyNames.includes(t.name)) allProxyNames.push(t.name);
    }
    for (const p of resolved.proxies) {
      if (p.name && !allProxyNames.includes(p.name)) allProxyNames.push(p.name);
    }
    for (const f of resolved.features) {
      if (f.name && !allProxyNames.includes(f.name)) allProxyNames.push(f.name);
    }

    // Ensure output directories exist in dataDir
    const bundlesDir = path.join(this.dataDir, "bundles");
    const proxiesDir = path.join(this.dataDir, "proxies");
    const productsDir = path.join(this.dataDir, "products");
    const devDir = path.join(this.dataDir, "developers");
    const devAppsDir = path.join(this.dataDir, "developerapps");
    const mapsDir = path.join(this.dataDir, "maps");
    const dcDir = path.join(this.dataDir, "datacollectors");

    for (const dir of [bundlesDir, proxiesDir, productsDir, devDir, devAppsDir, mapsDir, dcDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    const dcFile = path.join(dcDir, "datacollectors.json");
    if (!fs.existsSync(dcFile)) {
      fs.writeFileSync(dcFile, JSON.stringify(DEFAULT_AI_DATA_COLLECTORS, null, 2), "utf-8");
    }

    console.log(`[Deployer] Converting ${resolved.templates.length} templates, ${resolved.proxies.length} proxies, ${resolved.features.length} features...`);

    // 1. Convert templates to proxies and generate zips
    for (const t of resolved.templates) {
      const tProxy = await this.service.templateObjectToProxy(
        t,
        this.converter,
        paramDict,
      );
      if (tProxy) {
        // Save proxy yaml for tester UI
        const proxyYamlPath = path.join(proxiesDir, `${tProxy.name}.yaml`);
        fs.writeFileSync(proxyYamlPath, YAML.stringify(tProxy), "utf-8");

        const zipPath = await this.converter.proxyToApigeeZip(tProxy);
        const destZip = path.join(bundlesDir, `${tProxy.name}.zip`);
        if (path.resolve(zipPath) !== path.resolve(destZip) && fs.existsSync(zipPath)) {
          fs.copyFileSync(zipPath, destZip);
          if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
        }
      }
    }

    // 2. Convert raw proxies and generate zips
    for (const p of resolved.proxies) {
      this.converter.proxyUpdateParameters(p, paramDict);
      const proxyYamlPath = path.join(proxiesDir, `${p.name}.yaml`);
      fs.writeFileSync(proxyYamlPath, YAML.stringify(p), "utf-8");

      const zipPath = await this.converter.proxyToApigeeZip(p);
      const destZip = path.join(bundlesDir, `${p.name}.zip`);
      if (path.resolve(zipPath) !== path.resolve(destZip) && fs.existsSync(zipPath)) {
        fs.copyFileSync(zipPath, destZip);
        if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
      }
    }

    // 3. Convert features to proxies and generate zips
    for (const f of resolved.features) {
      const fProxy = this.converter.featureToProxy(f, paramDict);
      if (fProxy) {
        const proxyYamlPath = path.join(proxiesDir, `${fProxy.name}.yaml`);
        fs.writeFileSync(proxyYamlPath, YAML.stringify(fProxy), "utf-8");

        const zipPath = await this.converter.proxyToApigeeZip(fProxy);
        const destZip = path.join(bundlesDir, `${fProxy.name}.zip`);
        if (path.resolve(zipPath) !== path.resolve(destZip) && fs.existsSync(zipPath)) {
          fs.copyFileSync(zipPath, destZip);
          if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
        }
      }
    }

    // 4. Convert and export products in emulator JSON format
    const emulatorProducts: any[] = [];
    const companionMcpProducts: Record<string, string> = {};

    for (const prod of resolved.products) {
      this.converter.productUpdateParameters(prod, paramDict);
      const emProd = this.converter.productToApigeeEmulatorProduct(
        prod,
        allProxyNames,
        deployment.environments || [environment],
      );

      // Check if product mixes payloadOperationGroup with operations or llmOperations
      const hasPayload =
        (emProd.payloadOperationGroup?.operationConfigs?.length > 0) ||
        ((prod as any).payloadOperations?.length > 0);
      const hasRestOrLlm =
        (emProd.operationGroup?.operationConfigs?.length > 0) ||
        (emProd.llmOperationGroup?.operationConfigs?.length > 0) ||
        ((prod as any).operations?.length > 0) ||
        ((prod as any).llmOperations?.length > 0);

      if (hasPayload && hasRestOrLlm) {
        console.log(
          `[Deployer] Product '${emProd.name}' combines MCP payload operations with REST/LLM operations. Apigee runtime requires payload operations in a separate product; splitting into companion product '${emProd.name}-mcp'.`,
        );
        const mcpName = `${emProd.name}-mcp`;
        companionMcpProducts[emProd.name] = mcpName;

        const mcpProd = {
          ...emProd,
          name: mcpName,
          displayName: `${emProd.displayName || emProd.name} (MCP)`,
          proxies: Array.isArray(emProd.proxies)
            ? emProd.proxies.filter((pr: string) => pr.toLowerCase().includes("mcp"))
            : [],
          operationGroup: undefined,
          llmOperationGroup: undefined,
          operations: undefined,
          llmOperations: undefined,
        };
        delete emProd.payloadOperationGroup;
        delete (emProd as any).payloadOperations;
        if (Array.isArray(emProd.proxies)) {
          emProd.proxies = emProd.proxies.filter((pr: string) => !pr.toLowerCase().includes("mcp"));
        }

        const normMain = this.bundleManager.normalizeProductForEmulator(emProd, allProxyNames);
        const normMcp = this.bundleManager.normalizeProductForEmulator(mcpProd, allProxyNames);
        emulatorProducts.push(normMain, normMcp);
      } else {
        const normalized = this.bundleManager.normalizeProductForEmulator(emProd, allProxyNames);
        emulatorProducts.push(normalized);
      }
    }
    if (emulatorProducts.length > 0) {
      let finalProducts = emulatorProducts;
      const productsFile = path.join(productsDir, "products.json");
      if (options.merge !== false && fs.existsSync(productsFile)) {
        try {
          const existing = JSON.parse(fs.readFileSync(productsFile, "utf-8"));
          const map = new Map<string, any>();
          for (const ep of existing) {
            if (ep?.name) map.set(ep.name.toLowerCase(), ep);
          }
          for (const np of emulatorProducts) {
            if (np?.name) map.set(np.name.toLowerCase(), np);
          }
          finalProducts = Array.from(map.values());
        } catch {}
      }
      fs.writeFileSync(
        productsFile,
        JSON.stringify(finalProducts, null, 2),
        "utf-8",
      );
    }

    // 5. Convert and export users & developer apps
    const emulatorDevelopers: any[] = [];
    const emulatorApps: any[] = [];
    for (const u of resolved.users) {
      this.converter.userUpdateParameters(u, paramDict);
      const dev = this.converter.userToApigeeDeveloper(u);
      emulatorDevelopers.push(dev);

      const apps = this.converter.userToApigeeEmulatorApps(u);
      // Auto-attach companion MCP products to apps if needed
      for (const app of apps) {
        const extraProducts: string[] = [];
        const appProds = app.apiProducts || [];
        for (const p of appProds) {
          const pName = typeof p === "string" ? p : p.apiproduct || p.name;
          if (companionMcpProducts[pName]) {
            extraProducts.push(companionMcpProducts[pName]);
          }
          if (pName) {
            extraProducts.push(pName);
          }
        }
        for (const cred of app.credentials || []) {
          for (const cp of cred.apiProducts || []) {
            const cpName = typeof cp === "string" ? cp : cp.apiproduct || cp.name;
            if (companionMcpProducts[cpName] && !extraProducts.includes(companionMcpProducts[cpName])) {
              extraProducts.push(companionMcpProducts[cpName]);
            }
          }
        }
        if (extraProducts.length > 0) {
          for (const ep of extraProducts) {
            if (!app.apiProducts.includes(ep)) {
              app.apiProducts.push(ep);
            }
            for (const cred of app.credentials || []) {
              const credProds = (cred.apiProducts || []).map((c: any) =>
                typeof c === "string" ? c : c.apiproduct,
              );
              if (!credProds.includes(ep)) {
                cred.apiProducts.push({ apiproduct: ep, status: "approved" });
              }
            }
          }
        }
      }
      emulatorApps.push(...apps);
    }
    if (emulatorDevelopers.length > 0) {
      let finalDevs = emulatorDevelopers;
      const devsFile = path.join(devDir, "developers.json");
      if (options.merge !== false && fs.existsSync(devsFile)) {
        try {
          const existing = JSON.parse(fs.readFileSync(devsFile, "utf-8"));
          const map = new Map<string, any>();
          for (const ed of existing) {
            const key = (ed.email || ed.userName || "").toLowerCase();
            if (key) map.set(key, ed);
          }
          for (const nd of emulatorDevelopers) {
            const key = (nd.email || nd.userName || "").toLowerCase();
            if (key) map.set(key, nd);
          }
          finalDevs = Array.from(map.values());
        } catch {}
      }
      fs.writeFileSync(
        devsFile,
        JSON.stringify(finalDevs, null, 2),
        "utf-8",
      );
    }
    if (emulatorApps.length > 0) {
      let finalApps = emulatorApps;
      const appsFile = path.join(devAppsDir, "developerapps.json");
      if (options.merge !== false && fs.existsSync(appsFile)) {
        try {
          const existing = JSON.parse(fs.readFileSync(appsFile, "utf-8"));
          const map = new Map<string, any>();
          for (const ea of existing) {
            if (ea?.name) map.set(ea.name.toLowerCase(), ea);
          }
          for (const na of emulatorApps) {
            if (na?.name) map.set(na.name.toLowerCase(), na);
          }
          finalApps = Array.from(map.values());
        } catch {}
      }
      fs.writeFileSync(
        appsFile,
        JSON.stringify(finalApps, null, 2),
        "utf-8",
      );
    }

    // 6. Convert KVMs (default to empty array if none defined)
    const emulatorMaps: any[] = [];
    if (deployment.kvms && Array.isArray(deployment.kvms)) {
      for (const k of deployment.kvms) {
        const m = this.converter.kvmToApigeeEmulatorMap(k, environment);
        emulatorMaps.push(m);
      }
    }
    const mapsFile = path.join(mapsDir, "maps.json");
    let finalMaps = emulatorMaps;
    if (options.merge !== false && fs.existsSync(mapsFile) && emulatorMaps.length > 0) {
      try {
        const existing = JSON.parse(fs.readFileSync(mapsFile, "utf-8"));
        const map = new Map<string, any>();
        for (const em of existing) {
          if (em?.name) map.set(em.name.toLowerCase(), em);
        }
        for (const nm of emulatorMaps) {
          if (nm?.name) map.set(nm.name.toLowerCase(), nm);
        }
        finalMaps = Array.from(map.values());
      } catch {}
    }
    fs.writeFileSync(
      mapsFile,
      JSON.stringify(finalMaps, null, 2),
      "utf-8",
    );

    // 7. Convert and export data collectors
    const rawDataCollectors =
      (resolved as any).dataCollectors || deployment.dataCollectors || (deployment as any).datacollectors || [];
    if (rawDataCollectors && rawDataCollectors.length > 0) {
      const emulatorDataCollectors: any[] = [];
      for (const dc of rawDataCollectors) {
        this.converter.dataCollectorUpdateParameters(dc, paramDict);
        const emDc = this.converter.dataCollectorToApigeeDataCollector(dc);
        emulatorDataCollectors.push(emDc);
        fs.writeFileSync(
          path.join(dcDir, `${dc.name}.json`),
          JSON.stringify(emDc, null, 2),
          "utf-8",
        );
      }
      fs.writeFileSync(
        dcFile,
        JSON.stringify(emulatorDataCollectors, null, 2),
        "utf-8",
      );
    }

    // 8. Reset emulator if requested
    if (reset) {
      try {
        console.log("[Deployer] Resetting emulator state...");
        await this.emulatorClient.reset();
      } catch (err) {
        console.warn("[Deployer] Warning during emulator reset:", err);
      }
    }

    // Determine target proxies for bundling:
    // If deployAllExisting is true, deploy all available bundles in data/bundles
    let targetProxyNames = allProxyNames;
    if (options.deployAllExisting) {
      const availableBundles = await this.bundleManager.listBundles();
      targetProxyNames = Array.from(
        new Set([...allProxyNames, ...availableBundles.map((b) => b.proxyName)])
      );
    }

    // 9. Build testdata.zip and upload to emulator
    console.log("[Deployer] Uploading test data bundle to emulator...");
    const testDataZip = await this.bundleManager.buildTestDataBundle(targetProxyNames);
    await this.emulatorClient.setupTestData(testDataZip);

    // 10. Build environment bundle zip and deploy
    console.log(`[Deployer] Deploying ${targetProxyNames.length} proxies to environment '${environment}'...`);
    const { zipBuffer, deployedProxyNames } = await this.bundleManager.buildEnvironmentBundle(targetProxyNames);
    const revision = await this.emulatorClient.deployBundle(environment, zipBuffer);

    // 11. Sync Cassandra keys
    await syncCassandraDeveloperAppKeys(this.dataDir);

    const activeProxies = await this.emulatorClient.getDeploymentTree();
    const durationMs = Date.now() - startTime;

    return {
      success: true,
      revision: revision || "1",
      deployed: activeProxies,
      totalDeployed: deployedProxyNames.length,
      deployedCount: deployedProxyNames.length,
      durationMs,
    };
  }

  public async convertAndDeployAll(
    options: {
      reset?: boolean;
      environment?: string;
    } = {},
  ): Promise<DeployResponse> {
    const startTime = Date.now();
    const depDir = path.join(this.dataDir, "deployments");
    if (!fs.existsSync(depDir)) {
      throw new Error("No deployments directory found");
    }

    const files = fs.readdirSync(depDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    if (files.length === 0) {
      throw new Error("No deployment YAML files found in deployments directory");
    }

    console.log(`[Deployer] Converting all ${files.length} deployment(s)...`);

    // Reset emulator before conversion if requested
    if (options.reset !== false) {
      try {
        console.log("[Deployer] Resetting emulator before deploying all...");
        await this.emulatorClient.reset();
      } catch (err) {
        console.warn("[Deployer] Warning during emulator reset:", err);
      }
    }

    // Convert each deployment (with reset=false, merge=true)
    for (const file of files) {
      const filePath = path.join(depDir, file);
      try {
        console.log(`[Deployer] Processing deployment file: ${file}`);
        const content = fs.readFileSync(filePath, "utf-8");
        await this.convertAndDeploy(content, {
          reset: false,
          merge: true,
          deployAllExisting: false,
          environment: options.environment,
        });
      } catch (err) {
        console.error(`[Deployer] Error processing deployment ${file}:`, err);
      }
    }

    // Now gather all bundles in data/bundles to deploy them all together
    const availableBundles = await this.bundleManager.listBundles();
    const allDeployedNames = availableBundles.map((b) => b.proxyName);
    console.log(`[Deployer] Packaging and deploying all ${allDeployedNames.length} proxies together...`);

    const testDataZip = await this.bundleManager.buildTestDataBundle(allDeployedNames);
    await this.emulatorClient.setupTestData(testDataZip);

    const environment = options.environment || "test";
    const { zipBuffer, deployedProxyNames } = await this.bundleManager.buildEnvironmentBundle(allDeployedNames);
    const revision = await this.emulatorClient.deployBundle(environment, zipBuffer);

    await syncCassandraDeveloperAppKeys(this.dataDir);

    const activeProxies = await this.emulatorClient.getDeploymentTree();
    const durationMs = Date.now() - startTime;

    return {
      success: true,
      revision: revision || "1",
      deployed: activeProxies,
      totalDeployed: deployedProxyNames.length,
      deployedCount: deployedProxyNames.length,
      durationMs,
    };
  }
}
