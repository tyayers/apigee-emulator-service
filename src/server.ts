import path from "path";
import fs from "fs";
import { EmulatorClient } from "./emulator.ts";
import { BundleManager } from "./bundle-manager.ts";
import { DeploymentDeployer } from "./deployer.ts";
import { DeploymentManager } from "./deployments-manager.ts";
import { TestHistoryManager, evaluateAssertions } from "./test-manager.ts";
import { ProxyTester } from "./tester.ts";
import { AnalyticsManager } from "./analytics.ts";
import { syncCassandraDeveloperAppKeys } from "./cassandra-sync.ts";
import {
  DeployRequest,
  DeployResponse,
  EmulatorStateResponse,
  EmulatorStatus,
  ProxyYamlResponse,
  TestCase,
  TestRequest,
  TestResponse,
  TestRunResult,
  TestsRunRequest,
  TestsRunResponse,
  ValidationCheck,
} from "./types.ts";

export class EmulatorServer {
  public port: number;
  public dataDir: string;
  public rootDir: string;
  public publicDir: string;

  public emulator: EmulatorClient;
  public bundleManager: BundleManager;
  public deployer: DeploymentDeployer;
  public deploymentManager: DeploymentManager;
  public testHistory: TestHistoryManager;
  public proxyTester: ProxyTester;
  public analytics: AnalyticsManager;

  private isDeploying: boolean = false;
  private deployMessage: string = "";
  private lastTestDataUpload?: string;
  private lastTestDataStatus?: string;
  private isWarmingUp: boolean = false;

  constructor(options: { port?: number; dataDir?: string } = {}) {
    this.rootDir = process.cwd();
    this.port = options.port || parseInt(process.env.PORT || "8082", 10);
    this.dataDir = options.dataDir || process.env.DATA_DIR || path.join(this.rootDir, "data");
    this.publicDir = path.join(this.rootDir, "public");

    this.emulator = new EmulatorClient();
    this.bundleManager = new BundleManager(this.dataDir);
    this.emulator.kvmSecretProvider = () => this.bundleManager.getKVMSecretValues();

    this.deployer = new DeploymentDeployer(this.emulator, this.bundleManager, this.dataDir);
    this.deploymentManager = new DeploymentManager(this.dataDir);
    this.testHistory = new TestHistoryManager();
    this.proxyTester = new ProxyTester(this.emulator);
    this.analytics = new AnalyticsManager();
  }

  public jsonResponse(data: any, status: number = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
      },
    });
  }

  private serverInstance?: any;

  public async start(): Promise<any> {
    this.serverInstance = Bun.serve({
      port: this.port,
      fetch: (req) => this.handleRequest(req),
    });

    console.log(`[Server] Apigee Emulator Manager running on port ${this.port}`);
    console.log(`[Server] Web UI: http://localhost:${this.port}/tester/`);

    // Auto-deploy in background if emulator is already online
    setTimeout(() => this.autoDeploy(), 1000);

    return this.serverInstance;
  }

  public async stop(): Promise<void> {
    if (this.serverInstance) {
      this.serverInstance.stop();
    }
  }

  public async autoDeploy(): Promise<void> {
    try {
      const health = await this.emulator.checkHealth();
      if (!health.online) {
        console.log("[AutoDeploy] Emulator is not online yet, skipping initial auto-deploy");
        return;
      }

      console.log("[AutoDeploy] Apigee emulator is online. Deploying default configuration...");
      const depFile = path.join(this.dataDir, "deployments", "deployment-1.yaml");
      if (fs.existsSync(depFile)) {
        const yamlContent = fs.readFileSync(depFile, "utf-8");
        await this.executeDeploy({ yaml: yamlContent, reset: true });
      } else {
        await this.executeDeploy({ all: true, reset: true });
      }
      console.log("[AutoDeploy] Auto-deployment completed successfully");
    } catch (err) {
      console.warn("[AutoDeploy] Auto-deployment warning:", err);
    }
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
        },
      });
    }

    // Health check
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // Redirect root to /tester/
    if (url.pathname === "/" || url.pathname === "/manage" || url.pathname === "/manage/" || url.pathname === "/tester") {
      return Response.redirect(`${url.origin}/tester/`, 302);
    }

    // Viewer and Trace HTML files
    if (url.pathname === "/trace.html" || url.pathname === "/viewer.html") {
      const filePath = path.join(this.rootDir, url.pathname.slice(1));
      if (fs.existsSync(filePath)) {
        return new Response(Bun.file(filePath));
      }
    }

    // API Routes under /tester/api/ or /manage/api/
    let apiPath: string | null = null;
    if (url.pathname.startsWith("/tester/api/")) {
      apiPath = url.pathname.slice("/tester/api/".length);
    } else if (url.pathname.startsWith("/manage/api/")) {
      apiPath = url.pathname.slice("/manage/api/".length);
    }

    if (apiPath !== null) {
      return await this.handleApi(apiPath, req, url);
    }

    // Static Web UI Files under /tester/ or /manage/
    if (url.pathname.startsWith("/tester/") || url.pathname.startsWith("/manage/")) {
      const prefix = url.pathname.startsWith("/tester/") ? "/tester/" : "/manage/";
      let subPath = url.pathname.slice(prefix.length);
      if (!subPath || subPath === "/") subPath = "index.html";

      const localFile = path.join(this.publicDir, subPath);
      if (fs.existsSync(localFile) && !fs.statSync(localFile).isDirectory()) {
        return new Response(Bun.file(localFile));
      }

      // SPA fallback to index.html
      const indexFile = path.join(this.publicDir, "index.html");
      if (fs.existsSync(indexFile)) {
        return new Response(Bun.file(indexFile));
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleApi(subPath: string, req: Request, url: URL): Promise<Response> {
    const method = req.method.toUpperCase();

    // 1. GET /status
    if (subPath === "status" && method === "GET") {
      const status = await this.emulator.checkHealth();
      status.isDeploying = this.isDeploying;
      status.deployMessage = this.deployMessage;
      status.availableBundles = await this.bundleManager.listBundles();
      status.products = this.bundleManager.getProducts();
      status.users = this.bundleManager.getUsers();
      status.apps = this.bundleManager.getApps();

      // Mark isDeployed for bundles
      const activeNames = new Set(status.activeProxies.map((p) => p.name.toLowerCase()));
      for (const b of status.availableBundles) {
        b.isDeployed = activeNames.has(b.proxyName.toLowerCase());
      }

      return this.jsonResponse(status);
    }

    // 2. GET /bundles
    if (subPath === "bundles" && method === "GET") {
      const bundles = await this.bundleManager.listBundles();
      const active = await this.emulator.getDeploymentTree();
      const activeNames = new Set(active.map((p) => p.name.toLowerCase()));
      for (const b of bundles) {
        b.isDeployed = activeNames.has(b.proxyName.toLowerCase());
      }
      return this.jsonResponse(bundles);
    }

    // 3. GET /products
    if (subPath === "products" && method === "GET") {
      return this.jsonResponse(this.bundleManager.getProducts());
    }

    // 4. GET /users
    if (subPath === "users" && method === "GET") {
      return this.jsonResponse(this.bundleManager.getUsers());
    }

    // 5. GET /apps
    if (subPath === "apps" && method === "GET") {
      return this.jsonResponse(this.bundleManager.getApps());
    }

    // 6. GET /deployments
    if (subPath === "deployments" && method === "GET") {
      return this.jsonResponse(this.deploymentManager.listDeployments());
    }

    // 7. GET /tests
    if (subPath === "tests" && method === "GET") {
      return this.jsonResponse(this.deploymentManager.loadAllTests());
    }

    // 8. POST /tests/run
    if (subPath === "tests/run" && method === "POST") {
      let runReq: TestsRunRequest = {};
      try {
        runReq = (await req.json()) as TestsRunRequest;
      } catch {
        // ignore
      }
      const allTests = this.deploymentManager.loadAllTests();
      const startTime = Date.now();
      const results: TestRunResult[] = [];
      let passedCount = 0;
      let failedCount = 0;

      for (const tc of allTests) {
        if (runReq.proxy && tc.proxy.toLowerCase() !== runReq.proxy.toLowerCase()) {
          continue;
        }
        if (runReq.testName && tc.name.toLowerCase() !== runReq.testName.toLowerCase()) {
          continue;
        }

        const testReq: TestRequest = {
          proxy: tc.proxy,
          method: tc.verb || "GET",
          path: tc.path,
          headers: tc.headers,
          body: tc.payload || tc.body,
          recordTrace: true,
          testName: tc.name,
          assertions: tc.assertions,
        };

        const resp = await this.proxyTester.execute(testReq);
        if (tc.assertions && tc.assertions.length > 0) {
          resp.assertions = evaluateAssertions(tc.assertions, resp);
          resp.passed = resp.assertions.every((a) => a.passed);
        } else {
          resp.passed = resp.statusCode < 400 && !resp.error;
        }

        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        resp.testRunId = runId;

        const runResult: TestRunResult = {
          id: runId,
          testName: tc.name,
          proxy: tc.proxy,
          deployment: tc.deployment,
          timestamp: new Date().toISOString(),
          passed: resp.passed,
          statusCode: resp.statusCode,
          statusText: resp.statusText,
          durationMs: resp.durationMs,
          request: resp.request || testReq,
          response: resp,
          assertions: resp.assertions,
          traceSessionId: resp.traceSessionId,
          traceData: resp.traceData,
          error: resp.error,
        };

        this.testHistory.record(runResult);
        results.push(runResult);

        if (resp.passed) passedCount++;
        else failedCount++;
      }

      const response: TestsRunResponse = {
        total: results.length,
        passed: passedCount,
        failed: failedCount,
        durationMs: Date.now() - startTime,
        results,
      };
      return this.jsonResponse(response);
    }

    // 9. POST /tests/warmup or GET /tests/warmup
    if ((subPath === "tests/warmup" || subPath === "warmup") && (method === "POST" || method === "GET")) {
      setTimeout(() => this.warmupFirstTestPerProxy(), 50);
      return this.jsonResponse({
        status: "warmup_started",
        message: "Silently running first test for each proxy in background thread",
      });
    }

    // 10. GET /tests/history & DELETE /tests/history
    if (subPath === "tests/history") {
      const proxy = url.searchParams.get("proxy") || undefined;
      if (method === "GET") {
        const history = this.testHistory.getHistory(proxy);
        const list = history.map((run) => ({
          id: run.id,
          testName: run.testName,
          proxy: run.proxy,
          deployment: run.deployment,
          timestamp: run.timestamp,
          passed: run.passed,
          statusCode: run.statusCode,
          statusText: run.statusText,
          durationMs: run.durationMs,
          hasTrace: Boolean(run.traceData || run.traceSessionId),
          traceSessionId: run.traceSessionId,
          assertions: run.assertions,
          request: run.request,
          error: run.error,
        }));
        return this.jsonResponse(list);
      }
      if (method === "DELETE") {
        this.testHistory.clear(proxy);
        return this.jsonResponse({ message: "History cleared" });
      }
    }

    // 11. GET /tests/history/:id [ /trace | /result ]
    if (subPath.startsWith("tests/history/")) {
      const rest = subPath.slice("tests/history/".length);
      const parts = rest.split("/").filter(Boolean);
      const runId = parts[0];
      const run = this.testHistory.getRun(runId);
      if (!run) {
        return this.jsonResponse({ error: "Test run not found" }, 404);
      }

      if (parts[1] === "trace") {
        const tracePayload = run.traceData || {
          sessionId: run.traceSessionId,
          proxy: run.proxy,
          message: "No trace captured for this run",
        };
        return new Response(JSON.stringify(tracePayload, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="trace_${run.proxy}_${run.id}.json"`,
          },
        });
      }

      if (parts[1] === "result") {
        return new Response(JSON.stringify(run, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="test_result_${run.proxy}_${run.id}.json"`,
          },
        });
      }

      return this.jsonResponse(run);
    }

    // 12. POST /deploy
    if (subPath === "deploy" && method === "POST") {
      let body: any = {};
      const contentType = req.headers.get("content-type") || "";
      if (contentType.includes("yaml") || contentType.includes("x-yaml")) {
        const text = await req.text();
        body = { yaml: text, reset: true };
      } else {
        try {
          body = await req.json();
        } catch {
          body = { all: true, reset: true };
        }
      }

      try {
        const resp = await this.executeDeploy(body);
        setTimeout(() => this.warmupFirstTestPerProxy(), 500);
        return this.jsonResponse(resp);
      } catch (err: any) {
        return this.jsonResponse(
          { success: false, error: err.message || String(err) },
          500,
        );
      }
    }

    // 13. POST /test
    if (subPath === "test" && method === "POST") {
      try {
        const testReq = (await req.json()) as TestRequest;
        const resp = await this.proxyTester.execute(testReq);

        if (testReq.assertions && testReq.assertions.length > 0) {
          resp.assertions = evaluateAssertions(testReq.assertions, resp);
          resp.passed = resp.assertions.every((a) => a.passed);
        } else {
          resp.passed = resp.statusCode < 400 && !resp.error;
        }

        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        resp.testRunId = runId;

        const runResult: TestRunResult = {
          id: runId,
          testName: testReq.testName || `${testReq.method || "GET"} ${testReq.path}`,
          proxy: testReq.proxy || "General",
          timestamp: new Date().toISOString(),
          passed: resp.passed,
          statusCode: resp.statusCode,
          statusText: resp.statusText,
          durationMs: resp.durationMs,
          request: resp.request || testReq,
          response: resp,
          assertions: resp.assertions,
          traceSessionId: resp.traceSessionId,
          traceData: resp.traceData,
          error: resp.error,
        };

        this.testHistory.record(runResult);
        return this.jsonResponse(resp);
      } catch (err: any) {
        return this.jsonResponse({ error: err.message || String(err) }, 500);
      }
    }

    // 14. POST /reset
    if (subPath === "reset" && method === "POST") {
      try {
        await this.emulator.reset();
        return this.jsonResponse({ message: "Emulator reset successfully" });
      } catch (err: any) {
        return this.jsonResponse({ error: err.message || String(err) }, 500);
      }
    }

    // 15. POST /trace/start
    if (subPath === "trace/start" && method === "POST") {
      const proxy = url.searchParams.get("proxy");
      if (!proxy) {
        return this.jsonResponse({ error: "Query parameter 'proxy' is required" }, 400);
      }
      try {
        const sessionId = await this.emulator.startTraceSession(proxy);
        return this.jsonResponse({ sessionId, proxyName: proxy });
      } catch (err: any) {
        return this.jsonResponse({ error: err.message || String(err) }, 500);
      }
    }

    // 16. GET /trace/transactions
    if (subPath === "trace/transactions" && method === "GET") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        return this.jsonResponse({ error: "Query parameter 'sessionId' is required" }, 400);
      }
      try {
        const txs = await this.emulator.getTraceTransactions(sessionId);
        return this.jsonResponse(txs);
      } catch (err: any) {
        return this.jsonResponse({ error: err.message || String(err) }, 500);
      }
    }

    // 17. GET & POST /analytics
    if (subPath === "analytics") {
      if (method === "POST") {
        try {
          const body = await req.json();
          const record = await this.analytics.saveRecord(body);
          return this.jsonResponse({ success: true, id: record.id, record });
        } catch (err: any) {
          return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
        }
      }
      if (method === "GET") {
        const limitStr = url.searchParams.get("limit");
        const limit = limitStr ? parseInt(limitStr, 10) || 500 : 500;
        try {
          const records = await this.analytics.getLastRecords(limit);
          return this.jsonResponse({
            records,
            count: records.length,
            projectId: this.analytics.detectProjectID(),
            database: "(default)",
          });
        } catch (err: any) {
          return this.jsonResponse({
            records: [],
            count: 0,
            projectId: this.analytics.detectProjectID(),
            database: "(default)",
            error: err.message || String(err),
          }, 500);
        }
      }
    }

    // 18. POST /analytics/seed
    if (subPath === "analytics/seed" && method === "POST") {
      try {
        const count = await this.analytics.seedDemoRecords();
        return this.jsonResponse({
          success: true,
          count,
          message: `Successfully seeded ${count} sample analytics records into Firestore`,
        });
      } catch (err: any) {
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 19. GET /emulator/state
    if (subPath === "emulator/state" && method === "GET") {
      return this.jsonResponse(await this.getEmulatorState());
    }

    // 20. POST /emulator/setup-testdata
    if (subPath === "emulator/setup-testdata" && method === "POST") {
      try {
        const active = await this.emulator.getDeploymentTree();
        const activeNames = active.map((p) => p.name);
        const testDataZip = await this.bundleManager.buildTestDataBundle(activeNames);
        await this.emulator.setupTestData(testDataZip);
        syncCassandraDeveloperAppKeys(this.dataDir);

        this.lastTestDataUpload = new Date().toISOString();
        this.lastTestDataStatus = "Successfully uploaded testdata.zip and synced credentials";

        return this.jsonResponse({
          success: true,
          message: "Test data uploaded successfully and synced with Cassandra",
        });
      } catch (err: any) {
        this.lastTestDataStatus = `Failed to upload test data: ${err.message || String(err)}`;
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 21. GET /proxies/yaml or GET /proxy/yaml
    if ((subPath === "proxies/yaml" || subPath === "proxy/yaml") && method === "GET") {
      const name = url.searchParams.get("name") || "";
      if (!name) {
        return this.jsonResponse({ success: false, error: "Missing required query parameter: name" }, 400);
      }
      const proxyInfo = this.deploymentManager.getProxyYaml(name);
      if (!proxyInfo) {
        return this.jsonResponse({ success: false, error: `Proxy YAML not found for ${name}` }, 404);
      }
      return this.jsonResponse({
        success: true,
        proxy: name,
        displayName: proxyInfo.displayName,
        yaml: proxyInfo.yaml,
        source: proxyInfo.source,
      });
    }

    return this.jsonResponse({ error: "Endpoint not found" }, 404);
  }

  public async executeDeploy(req: DeployRequest): Promise<DeployResponse> {
    this.isDeploying = true;
    this.deployMessage = "Starting deployment...";
    const startTime = Date.now();

    try {
      // 1. If deployment YAML is provided in request:
      if (req.yaml || req.deploymentYaml) {
        this.deployMessage = "Converting deployment YAML...";
        const yamlStr = req.yaml || req.deploymentYaml || "";
        const resp = await this.deployer.convertAndDeploy(yamlStr, {
          reset: req.reset !== false,
        });
        this.lastTestDataUpload = new Date().toISOString();
        this.lastTestDataStatus = "Deployment YAML converted and deployed successfully";
        this.isDeploying = false;
        this.deployMessage = "";
        return resp;
      }

      // 2. If deployment file specified:
      if (req.deploymentFile) {
        const filePath = path.resolve(this.rootDir, req.deploymentFile);
        if (fs.existsSync(filePath)) {
          this.deployMessage = `Converting ${path.basename(filePath)}...`;
          const yamlStr = fs.readFileSync(filePath, "utf-8");
          const resp = await this.deployer.convertAndDeploy(yamlStr, {
            reset: req.reset !== false,
          });
          this.lastTestDataUpload = new Date().toISOString();
          this.lastTestDataStatus = `Deployment file ${path.basename(filePath)} converted and deployed successfully`;
          this.isDeploying = false;
          this.deployMessage = "";
          return resp;
        }
      }

      // 3. Otherwise deploy from bundles:
      if (req.reset) {
        this.deployMessage = "Resetting emulator...";
        try {
          await this.emulator.reset();
        } catch (err) {
          console.warn("[Deploy] Warning resetting emulator:", err);
        }
      }

      this.deployMessage = "Building environment bundle...";
      const { zipBuffer, deployedProxyNames } = await this.bundleManager.buildEnvironmentBundle(
        req.all ? undefined : req.bundles,
      );

      this.deployMessage = "Uploading test data bundle...";
      const testDataZip = await this.bundleManager.buildTestDataBundle(deployedProxyNames);
      await this.emulator.setupTestData(testDataZip);

      this.deployMessage = "Deploying proxy bundle...";
      const revision = await this.emulator.deployBundle("test", zipBuffer);

      this.deployMessage = "Synchronizing credentials with Cassandra...";
      syncCassandraDeveloperAppKeys(this.dataDir);

      this.lastTestDataUpload = new Date().toISOString();
      this.lastTestDataStatus = `Successfully deployed ${deployedProxyNames.length} proxy bundles`;

      const activeProxies = await this.emulator.getDeploymentTree();
      this.isDeploying = false;
      this.deployMessage = "";

      return {
        success: true,
        revision: revision || "1",
        deployed: activeProxies,
        totalDeployed: deployedProxyNames.length,
        deployedCount: deployedProxyNames.length,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      this.isDeploying = false;
      this.deployMessage = "";
      this.lastTestDataStatus = `Deployment failed: ${err.message || String(err)}`;
      throw err;
    }
  }

  public async warmupFirstTestPerProxy(): Promise<void> {
    if (this.isWarmingUp) return;
    this.isWarmingUp = true;

    try {
      // Small pause to let emulator settle
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const allTests = this.deploymentManager.loadAllTests();

      const seen = new Set<string>();
      const warmupList: TestCase[] = [];

      for (const tc of allTests) {
        const p = (tc.proxy || "").trim();
        if (p && !seen.has(p.toLowerCase())) {
          seen.add(p.toLowerCase());
          warmupList.push(tc);
        }
      }

      // Also check any active proxies with no test
      const status = await this.emulator.checkHealth();
      for (const p of status.activeProxies) {
        if (!seen.has(p.name.toLowerCase())) {
          seen.add(p.name.toLowerCase());
          warmupList.push({
            name: `warmup-${p.name.toLowerCase()}`,
            proxy: p.name,
            verb: "GET",
            path: p.basePath || `/${p.name.toLowerCase()}`,
          });
        }
      }

      console.log(`[Warmup] Silently warming up ${warmupList.length} proxies...`);
      for (const tc of warmupList) {
        const testReq: TestRequest = {
          proxy: tc.proxy,
          method: tc.verb || "GET",
          path: tc.path,
          headers: tc.headers,
          body: tc.payload || tc.body,
          recordTrace: false,
          testName: tc.name,
        };
        try {
          const resp = await this.proxyTester.execute(testReq);
          console.log(`[Warmup] Proxy '${tc.proxy}' warmed up (${resp.statusCode} in ${resp.durationMs}ms)`);
        } catch {
          // ignore warmup errors
        }
      }
      console.log("[Warmup] Completed silent warmup");
    } finally {
      this.isWarmingUp = false;
    }
  }

  public async getEmulatorState(): Promise<EmulatorStateResponse> {
    const health = await this.emulator.checkHealth();
    const treeRaw = await this.emulator.getRawDeploymentTree();
    const deployedProxies = health.activeProxies;
    const bundles = await this.bundleManager.listBundles();
    const products = this.bundleManager.getProducts();
    const users = this.bundleManager.getUsers();
    const apps = this.bundleManager.getApps();
    const maps = this.bundleManager.getMaps();
    const datacollectors = this.bundleManager.getDataCollectors();

    const checks: ValidationCheck[] = [];

    // Check 1: Emulator connectivity
    if (health.online) {
      checks.push({
        category: "Connectivity",
        title: "Emulator Management API (Port 8080)",
        status: "PASS",
        message: `Connected successfully to emulator management endpoint at ${this.emulator.mgmtUrl}.`,
      });
    } else {
      checks.push({
        category: "Connectivity",
        title: "Emulator Management API (Port 8080)",
        status: "FAIL",
        message: `Unable to connect to emulator management API at ${this.emulator.mgmtUrl}.`,
      });
    }

    // Check 2: Active Proxies
    if (deployedProxies.length > 0) {
      const names = deployedProxies.map((p) => p.name).join(", ");
      checks.push({
        category: "Proxies",
        title: "Deployed API Proxies",
        status: "PASS",
        message: `${deployedProxies.length} proxy bundle(s) active in runtime: ${names}`,
      });
    } else {
      checks.push({
        category: "Proxies",
        title: "Deployed API Proxies",
        status: "WARN",
        message: "No proxies are currently deployed. Click 'Deploy All Bundles' to deploy.",
      });
    }

    // Check 3: Products
    if (products.length > 0) {
      const pNames = products.map((p: any) => p.name).join(", ");
      checks.push({
        category: "Products",
        title: "API Products Configuration",
        status: "PASS",
        message: `${products.length} API Product(s) defined: ${pNames}`,
      });
    } else {
      checks.push({
        category: "Products",
        title: "API Products Configuration",
        status: "FAIL",
        message: "No products found in data/products/products.json.",
      });
    }

    // Check 4: Apps & Consumer keys
    const appKeys = new Set<string>();
    let totalCreds = 0;
    for (const app of apps) {
      if (app.credentials && Array.isArray(app.credentials)) {
        for (const c of app.credentials) {
          if (c.consumerKey) {
            appKeys.add(c.consumerKey);
            totalCreds++;
          }
        }
      }
    }
    if (apps.length > 0 && totalCreds > 0) {
      checks.push({
        category: "Apps",
        title: "Developer Apps & Consumer Keys",
        status: "PASS",
        message: `${apps.length} app(s) registered with ${totalCreds} active consumer key(s): ${Array.from(appKeys).join(", ")}`,
      });
    } else {
      checks.push({
        category: "Apps",
        title: "Developer Apps & Consumer Keys",
        status: "FAIL",
        message: "No developer apps or credentials found in data/developerapps/developerapps.json.",
      });
    }

    // Check 5: Test Suite Key Authorization
    const allTests = this.deploymentManager.loadAllTests();
    const missingKeys = new Set<string>();
    const usedKeys = new Set<string>();
    for (const t of allTests) {
      if (t.headers) {
        for (const [k, v] of Object.entries(t.headers)) {
          if (["x-api-key", "apikey", "x-ai-key"].includes(k.toLowerCase())) {
            usedKeys.add(v);
            if (!appKeys.has(v)) {
              missingKeys.add(v);
            }
          }
        }
      }
    }
    if (missingKeys.size === 0 && usedKeys.size > 0) {
      checks.push({
        category: "Tests",
        title: "Test Suite Key Authorization",
        status: "PASS",
        message: `All test API keys (${Array.from(usedKeys).join(", ")}) match authorized developer app credentials in the emulator.`,
      });
    } else if (missingKeys.size > 0) {
      checks.push({
        category: "Tests",
        title: "Test Suite Key Authorization",
        status: "WARN",
        message: `Some tests use API key(s) not registered in developer apps: ${Array.from(missingKeys).join(", ")}`,
      });
    }

    // Check 6: Datastore upload status
    if (this.lastTestDataStatus) {
      const isFail = this.lastTestDataStatus.toLowerCase().includes("fail") || this.lastTestDataStatus.toLowerCase().includes("error");
      checks.push({
        category: "Datastore",
        title: "Emulator Datastore (Cassandra) Test Data",
        status: isFail ? "FAIL" : "PASS",
        message: `Status: ${this.lastTestDataStatus} (Last upload: ${this.lastTestDataUpload || "N/A"})`,
      });
    } else {
      checks.push({
        category: "Datastore",
        title: "Emulator Datastore (Cassandra) Test Data",
        status: "WARN",
        message: "Test data has not yet been pushed in this session. Click 'Deploy All Bundles' or 'Re-upload Test Data' to populate.",
      });
    }

    return {
      online: health.online,
      mgmtUrl: this.emulator.mgmtUrl,
      runtimeUrl: this.emulator.runtimeUrl,
      deploymentTree: treeRaw,
      activeProxies: deployedProxies,
      packagedBundles: bundles,
      products,
      users,
      apps,
      maps,
      dataCollectors: datacollectors,
      testDataLoaded: Boolean(this.lastTestDataStatus && !this.lastTestDataStatus.toLowerCase().includes("fail")),
      lastTestDataUpload: this.lastTestDataUpload,
      lastTestDataStatus: this.lastTestDataStatus,
      validationChecks: checks,
      totalActiveProxies: deployedProxies.length,
      totalProducts: products.length,
      totalUsers: users.length,
      totalApps: apps.length,
    };
  }
}
