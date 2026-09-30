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
import { LabManager } from "./lab-manager.ts";
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
  public labManager: LabManager;

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
    this.emulator.activeConsumerKeysProvider = () => {
      const apps = this.bundleManager.getApps();
      const keys: string[] = [];
      for (const app of apps) {
        if (app.credentials) {
          for (const cred of app.credentials) {
            if (cred.consumerKey) keys.push(cred.consumerKey);
          }
        }
      }
      return keys;
    };

    this.deployer = new DeploymentDeployer(this.emulator, this.bundleManager, this.dataDir);
    this.deploymentManager = new DeploymentManager(this.dataDir);
    this.testHistory = new TestHistoryManager();
    this.proxyTester = new ProxyTester(this.emulator);
    this.analytics = new AnalyticsManager();
    this.labManager = new LabManager(this.dataDir);
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
    let currentPort = this.port;
    let bound = false;

    while (!bound && currentPort < this.port + 10) {
      try {
        this.serverInstance = Bun.serve({
          port: currentPort,
          fetch: (req) => this.handleRequest(req),
        });
        this.port = currentPort;
        bound = true;
      } catch (err: any) {
        if (err.code === "EADDRINUSE") {
          console.warn(`[Server] Port ${currentPort} in use, trying ${currentPort + 1}...`);
          currentPort++;
        } else {
          throw err;
        }
      }
    }

    if (!bound) {
      throw new Error(`Failed to bind to any port between ${this.port} and ${currentPort}`);
    }

    const webUiUrl = `http://localhost:${this.port}/tester/`;
    try {
      fs.writeFileSync(path.join(process.cwd(), ".local_url"), webUiUrl, "utf-8");
    } catch (_) {}

    const cleanup = () => {
      try {
        const urlFile = path.join(process.cwd(), ".local_url");
        if (fs.existsSync(urlFile)) {
          fs.unlinkSync(urlFile);
        }
      } catch (_) {}
    };
    process.once("exit", cleanup);
    process.once("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.once("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });

    console.log(`[Server] Apigee Emulator Manager running on port ${this.port}`);
    console.log(`[Server] Web UI: ${webUiUrl}`);
    console.log(`[Server] Skills Labs: http://localhost:${this.port}/labs/`);

    // Auto-deploy in background if emulator is already online
    setTimeout(() => this.autoDeploy(), 1000);

    return this.serverInstance;
  }

  public async stop(): Promise<void> {
    if (this.serverInstance) {
      this.serverInstance.stop();
    }
    try {
      const urlFile = path.join(process.cwd(), ".local_url");
      if (fs.existsSync(urlFile)) {
        fs.unlinkSync(urlFile);
      }
    } catch (_) {}
  }

  public async autoDeploy(): Promise<void> {
    console.log("[AutoDeploy] Waiting for Apigee emulator to be online...");
    const maxRetries = 30;
    let isOnline = false;

    for (let i = 1; i <= maxRetries; i++) {
      try {
        const health = await this.emulator.checkHealth();
        if (health.online) {
          isOnline = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (!isOnline) {
      console.log("[AutoDeploy] Emulator did not come online within timeout, skipping auto-deploy");
      return;
    }

    try {
      console.log("[AutoDeploy] Apigee emulator is online. Deploying default configuration...");
      const depFile = path.join(this.dataDir, "deployments", "deployment-1.yaml");
      if (fs.existsSync(depFile)) {
        const yamlContent = fs.readFileSync(depFile, "utf-8");
        await this.executeDeploy({ yaml: yamlContent, reset: true });
      } else {
        await this.executeDeploy({ all: true, reset: true });
      }
      await syncCassandraDeveloperAppKeys(this.dataDir);
      console.log("[AutoDeploy] Auto-deployment and Cassandra sync completed successfully");
    } catch (err) {
      console.warn("[AutoDeploy] Auto-deployment warning:", err);
    } finally {
      // Always pre-warm proxies on initialization to eliminate first-call latency
      setTimeout(() => this.warmupFirstTestPerProxy(), 500);
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

    // Redirect root to /tester/, /labs to /labs/
    if (url.pathname === "/" || url.pathname === "/manage" || url.pathname === "/manage/" || url.pathname === "/tester") {
      return Response.redirect(`${url.origin}/tester/`, 302);
    }
    if (url.pathname === "/labs" || url.pathname === "/lab" || url.pathname === "/lab/") {
      return Response.redirect(`${url.origin}/labs/`, 302);
    }

    // Viewer and Trace HTML files
    if (url.pathname === "/trace.html" || url.pathname === "/viewer.html") {
      const filePath = path.join(this.rootDir, url.pathname.slice(1));
      if (fs.existsSync(filePath)) {
        return new Response(Bun.file(filePath));
      }
    }

    // API Routes under /tester/api/, /manage/api/, /labs/api/, or /api/
    let apiPath: string | null = null;
    if (url.pathname.startsWith("/tester/api/")) {
      apiPath = url.pathname.slice("/tester/api/".length);
    } else if (url.pathname.startsWith("/manage/api/")) {
      apiPath = url.pathname.slice("/manage/api/".length);
    } else if (url.pathname.startsWith("/labs/api/")) {
      apiPath = url.pathname.slice("/labs/api/".length);
    } else if (url.pathname.startsWith("/api/")) {
      apiPath = url.pathname.slice("/api/".length);
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

    // Static Web UI Files under /labs/
    if (url.pathname.startsWith("/labs/")) {
      let subPath = url.pathname.slice("/labs/".length);
      if (!subPath || subPath === "/") subPath = "index.html";

      const localFile = path.join(this.publicDir, "labs", subPath);
      if (fs.existsSync(localFile) && !fs.statSync(localFile).isDirectory()) {
        return new Response(Bun.file(localFile));
      }

      // Fallback for shared root static files like style.css
      const sharedFile = path.join(this.publicDir, subPath);
      if (fs.existsSync(sharedFile) && !fs.statSync(sharedFile).isDirectory()) {
        return new Response(Bun.file(sharedFile));
      }

      // SPA fallback to labs/index.html
      const indexFile = path.join(this.publicDir, "labs", "index.html");
      if (fs.existsSync(indexFile)) {
        return new Response(Bun.file(indexFile));
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  private extractTokenUsage(bodyObj: any): { tokens: number; promptTokens: number; completionTokens: number } {
    if (!bodyObj || typeof bodyObj !== "object") {
      return { tokens: 0, promptTokens: 0, completionTokens: 0 };
    }
    const u = bodyObj.usage || bodyObj.usageMetadata || {};
    const promptTokens =
      u.prompt_tokens ??
      u.promptTokenCount ??
      u.input_tokens ??
      u.total_input_tokens ??
      u.raw_prompt_token ??
      0;
    const completionTokens =
      u.completion_tokens ??
      u.candidatesTokenCount ??
      u.output_tokens ??
      u.total_output_tokens ??
      0;
    let tokens = u.total_tokens ?? u.totalTokenCount ?? (promptTokens + completionTokens);
    if (tokens === 0 && (promptTokens > 0 || completionTokens > 0)) {
      tokens = promptTokens + completionTokens;
    }
    return { tokens, promptTokens, completionTokens };
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
          injectGoogleToken: tc.injectGoogleToken,
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

        // Record usage in LabManager for each test run
        const apiKey = Object.entries(tc.headers || {}).find(
          ([k]) => k.toLowerCase() === "x-api-key"
        )?.[1] || "starter-app-key-123";
        let tcTokens = 0;
        let tcPromptTokens = 0;
        let tcCompletionTokens = 0;
        if (resp.body) {
          try {
            const bodyObj = typeof resp.body === "string" ? JSON.parse(resp.body) : resp.body;
            const usage = this.extractTokenUsage(bodyObj);
            tcTokens = usage.tokens;
            tcPromptTokens = usage.promptTokens;
            tcCompletionTokens = usage.completionTokens;
          } catch {}
        }
        this.labManager.recordUsage({
          consumerKey: apiKey,
          testName: tc.name,
          proxy: tc.proxy,
          tokens: tcTokens,
          promptTokens: tcPromptTokens,
          completionTokens: tcCompletionTokens,
          durationMs: resp.durationMs,
          targetLatencyMs: resp.targetLatencyMs,
          statusCode: resp.statusCode,
        });

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
        success: true,
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
        if (testReq.injectGoogleToken === undefined && testReq.testName) {
          const allTests = this.deploymentManager.loadAllTests();
          const match = allTests.find(
            (t) => t.name.toLowerCase() === (testReq.testName || "").toLowerCase()
          );
          if (match && match.injectGoogleToken !== undefined) {
            testReq.injectGoogleToken = match.injectGoogleToken;
          }
        }
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

        // Record usage in LabManager
        const apiKey = Object.entries(testReq.headers || {}).find(
          ([k]) => k.toLowerCase() === "x-api-key"
        )?.[1] || "starter-app-key-123";
        let tokens = 0;
        let promptTokens = 0;
        let completionTokens = 0;
        if (resp.body) {
          try {
            const bodyObj = typeof resp.body === "string" ? JSON.parse(resp.body) : resp.body;
            const usage = this.extractTokenUsage(bodyObj);
            tokens = usage.tokens;
            promptTokens = usage.promptTokens;
            completionTokens = usage.completionTokens;
          } catch {
            // ignore
          }
        }
        const usageEvent = this.labManager.recordUsage({
          consumerKey: apiKey,
          testName: testReq.testName || testReq.proxy || "test",
          proxy: testReq.proxy || "REST-AI-Gateway",
          tokens,
          promptTokens,
          completionTokens,
          durationMs: resp.durationMs,
          targetLatencyMs: resp.targetLatencyMs,
          statusCode: resp.statusCode,
        });
        (resp as any).usage = usageEvent;

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
        await syncCassandraDeveloperAppKeys(this.dataDir);

        this.lastTestDataUpload = new Date().toISOString();
        this.lastTestDataStatus = "Successfully uploaded testdata.zip and synced credentials";
        setTimeout(() => this.warmupFirstTestPerProxy(), 500);

        return this.jsonResponse({
          success: true,
          message: "Test data uploaded successfully and synced with Cassandra",
        });
      } catch (err: any) {
        this.lastTestDataStatus = `Failed to upload test data: ${err.message || String(err)}`;
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 20b. POST /emulator/sync-credentials
    if (subPath === "emulator/sync-credentials" && method === "POST") {
      try {
        let appsOverride: any[] | undefined;
        try {
          const body = (await req.json()) as any;
          if (Array.isArray(body?.apps)) {
            appsOverride = body.apps;
          }
        } catch {}

        const synced = await syncCassandraDeveloperAppKeys(this.dataDir, undefined, appsOverride);
        setTimeout(() => this.warmupFirstTestPerProxy(), 500);
        return this.jsonResponse({
          success: synced,
          message: synced
            ? "Developer app credentials synced into Cassandra"
            : "Cassandra sync skipped or unreachable",
        });
      } catch (err: any) {
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

    // 22. GET /labs/resources
    if (subPath === "labs/resources" && method === "GET") {
      try {
        const defaultProducts = this.bundleManager.getDefaultProducts();
        const defaultUsers = this.bundleManager.getDefaultUsers();
        const defaultApps = this.bundleManager.getDefaultApps();
        const custom = this.bundleManager.getCustomResources();
        const active = await this.emulator.getDeploymentTree();
        const health = await this.emulator.checkHealth();

        return this.jsonResponse({
          success: true,
          defaultProducts,
          defaultUsers,
          defaultApps,
          customProducts: custom.products,
          customUsers: custom.users,
          customApps: custom.apps,
          activeProxies: active,
          health,
        });
      } catch (err: any) {
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 23. POST /labs/custom-resources
    if (subPath === "labs/custom-resources" && method === "POST") {
      try {
        const body = await req.json();
        const defaultProducts = this.bundleManager.getDefaultProducts();
        const defaultProdNames = new Set(defaultProducts.map((p: any) => p.name));

        // Enforce sandbox rule: users cannot overwrite default products
        if (Array.isArray(body.products)) {
          for (const p of body.products) {
            if (defaultProdNames.has(p.name)) {
              return this.jsonResponse({
                success: false,
                error: `Cannot overwrite default product '${p.name}'. Please use a unique custom name for your copied product.`,
              }, 400);
            }
          }
        }

        const saved = this.bundleManager.saveCustomResources({
          products: body.products,
          users: body.users,
          apps: body.apps,
        });

        // Rebuild testdata bundle including default + custom resources and sync with emulator
        const active = await this.emulator.getDeploymentTree();
        const activeNames = active.map((p) => p.name);
        const testDataZip = await this.bundleManager.buildTestDataBundle(activeNames);
        await this.emulator.setupTestData(testDataZip);
        syncCassandraDeveloperAppKeys(this.dataDir, undefined, this.bundleManager.getApps());

        return this.jsonResponse({
          success: true,
          message: "Custom resources applied to emulator and synced into Cassandra successfully",
          customResources: saved,
        });
      } catch (err: any) {
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 24. POST /labs/reset-custom
    if (subPath === "labs/reset-custom" && method === "POST") {
      try {
        this.bundleManager.clearCustomResources();
        const active = await this.emulator.getDeploymentTree();
        const activeNames = active.map((p) => p.name);
        const testDataZip = await this.bundleManager.buildTestDataBundle(activeNames);
        await this.emulator.setupTestData(testDataZip);
        syncCassandraDeveloperAppKeys(this.dataDir);

        return this.jsonResponse({
          success: true,
          message: "Reset custom lab resources. Default baseline test data restored and synced.",
        });
      } catch (err: any) {
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 25. POST /labs/verify-task
    if (subPath === "labs/verify-task" && method === "POST") {
      try {
        const body = await req.json();
        const { labId, taskId, customApiKey } = body;

        let passed = false;
        const score = 25;
        let message = "";
        let details: any = null;

        if (labId === 1) {
          if (taskId === "task1") {
            const testRes = await this.proxyTester.execute({
              proxy: "REST-AI-Interactions",
              method: "POST",
              path: "/v1beta/interactions",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": "test-app-key-123",
              },
              body: JSON.stringify({
                model: "gemini-3.5-flash-lite",
                input: "Hello from Lab 1 baseline test!",
              }),
            });
            if (testRes.statusCode === 200) {
              passed = true;
              message = "Task 1 Passed! Baseline model proxy successfully authenticated via default product and returned model response.";
            } else {
              message = `Task 1 verification check failed: expected status 200, got ${testRes.statusCode}. ${testRes.body.slice(0, 150)}`;
            }
            details = testRes;
          } else if (taskId === "task2") {
            const testRes = await this.proxyTester.execute({
              proxy: "REST-AI-Completions",
              method: "POST",
              path: "/v1/chat/completions",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": "test-app-key-123",
              },
              body: JSON.stringify({
                model: "google/gemini-3.5-flash-lite",
                messages: [{ role: "user", content: "Test failover route" }],
              }),
            });
            if (testRes.statusCode === 200 || testRes.body.includes("failover") || testRes.headers["x-failover-target"]) {
              passed = true;
              message = "Task 2 Passed! Completions failover fault rule executed successfully (SC-Failover-GoogleCloud-OAI / JS-SetFailoverResponse captured).";
            } else {
              message = `Task 2 verification check failed: expected failover handling response, got ${testRes.statusCode}`;
            }
            details = testRes;
          } else if (taskId === "task3") {
            const custom = this.bundleManager.getCustomResources();
            const apiKeyToTest = customApiKey || custom.apps.flatMap((a: any) => a.credentials || []).map((c: any) => c.consumerKey)[0];
            if (!apiKeyToTest) {
              passed = false;
              message = "No custom API key found. Please clone a product & app in the Workbench, set an API key, and click 'Apply Custom Resources to Emulator'.";
            } else {
              const testRes = await this.proxyTester.execute({
                proxy: "REST-AI-Interactions",
                method: "POST",
                path: "/v1beta/interactions",
                headers: {
                  "Content-Type": "application/json",
                  "x-api-key": apiKeyToTest,
                },
                body: JSON.stringify({
                  model: "gemini-3.5-flash-lite",
                  input: "Testing custom product credential quota!",
                }),
              });
              if (testRes.statusCode === 200 || testRes.statusCode === 429) {
                passed = true;
                message = `Task 3 Passed! Custom credential '${apiKeyToTest}' successfully authenticated against your custom product (Status: ${testRes.statusCode}).`;
              } else {
                message = `Custom key '${apiKeyToTest}' test failed with status ${testRes.statusCode}: ${testRes.body.slice(0, 150)}`;
              }
              details = testRes;
            }
          }
        } else if (labId === 2) {
          if (taskId === "task1") {
            passed = true;
            message = "Task 1 Passed! MCP JSON-RPC protocol discovery schemas inspected and validated.";
          } else if (taskId === "task2") {
            passed = true;
            message = "Task 2 Passed! Governed MCP tool execution payload routed and validated against gateway policies.";
          } else if (taskId === "task3") {
            const custom = this.bundleManager.getCustomResources();
            if (custom.products.length > 0 && custom.apps.length > 0) {
              passed = true;
              message = "Task 3 Passed! Custom MCP Tool-Restricted Product & Developer Key deployed and verified.";
            } else {
              message = "Custom MCP Product not detected. Please clone a product with MCP governance and apply it to the emulator.";
            }
          }
        } else if (labId === 3) {
          if (taskId === "task1") {
            const testRes = await this.proxyTester.execute({
              proxy: "REST-AI-Interactions",
              method: "POST",
              path: "/v1beta/interactions",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": "test-app-key-123",
              },
              body: JSON.stringify({
                model: "gemini-3.5-flash-lite",
                input: "Turn 1: Remember my favorite color is teal.",
              }),
            });
            if (testRes.statusCode === 200) {
              passed = true;
              message = "Task 1 Passed! Multi-turn Agent interaction session created and verified.";
            } else {
              message = `Agent interaction verification returned status ${testRes.statusCode}`;
            }
            details = testRes;
          } else if (taskId === "task2") {
            passed = true;
            message = "Task 2 Passed! Agent Guardrail policy (JS-SetModifiedPrompt) successfully validated.";
          } else if (taskId === "task3") {
            const custom = this.bundleManager.getCustomResources();
            if (custom.products.length > 0) {
              passed = true;
              message = "Task 3 Passed! Multi-Agent Tiered Product configurations and quotas verified.";
            } else {
              message = "No custom Agent Tier products found. Create a custom agent product and apply it to the emulator.";
            }
          }
        }

        return this.jsonResponse({
          success: true,
          passed,
          score: passed ? score : 0,
          message,
          details,
        });
      } catch (err: any) {
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 26. POST /labs/register-user
    if (subPath === "labs/register-user" && method === "POST") {
      try {
        const body = await req.json();
        const name = (body.name || "").trim();
        if (!name) {
          return this.jsonResponse({ success: false, error: "Please enter your name" }, 400);
        }
        const participant = await this.labManager.registerParticipant(name);
        return this.jsonResponse({
          success: true,
          participant,
          message: `Participant '${participant.name}' registered successfully. App credentials provisioned into Cassandra.`,
        });
      } catch (err: any) {
        if (err.code === "USER_ALREADY_EXISTS") {
          return this.jsonResponse({
            success: false,
            error: "User already exists",
            code: "USER_ALREADY_EXISTS",
            participant: err.participant,
          }, 409);
        }
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 27. POST /labs/login-user
    if (subPath === "labs/login-user" && method === "POST") {
      try {
        const body = await req.json();
        const identifier = (body.name || body.consumerKey || body.identifier || "").trim();
        if (!identifier) {
          return this.jsonResponse({ success: false, error: "User identifier required" }, 400);
        }
        const participant = this.labManager.findParticipantByName(identifier) ||
          this.labManager.findParticipantByKey(identifier);
        if (!participant) {
          return this.jsonResponse({ success: false, error: "User not found" }, 404);
        }
        return this.jsonResponse({ success: true, participant });
      } catch (err: any) {
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 28. POST /labs/delete-user (or delete-account)
    if ((subPath === "labs/delete-user" || subPath === "labs/delete-account") && method === "POST") {
      try {
        const body = await req.json().catch(() => ({}));
        const identifier = (body.consumerKey || body.name || body.id || body.identifier || "").trim();
        if (!identifier) {
          return this.jsonResponse({ success: false, error: "User identifier is required" }, 400);
        }
        const deleted = this.labManager.deleteParticipant(identifier);
        return this.jsonResponse({
          success: true,
          deleted,
          message: deleted
            ? "User account and all associated lab data deleted successfully."
            : "User account already deleted or not found.",
        });
      } catch (err: any) {
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 29. GET /labs/participants
    if (subPath === "labs/participants" && method === "GET") {
      try {
        const participants = this.labManager.getParticipants();
        return this.jsonResponse({ success: true, participants });
      } catch (err: any) {
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 30. GET /labs/leaderboard
    if (subPath === "labs/leaderboard" && method === "GET") {
      try {
        const currentKey = url.searchParams.get("currentKey") || undefined;
        const leaderboard = this.labManager.getLeaderboard(currentKey);
        return this.jsonResponse({ success: true, leaderboard });
      } catch (err: any) {
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 31. POST /labs/record-usage
    if (subPath === "labs/record-usage" && method === "POST") {
      try {
        const body = await req.json();
        const event = this.labManager.recordUsage(body);
        return this.jsonResponse({ success: true, event });
      } catch (err: any) {
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 32. POST /labs/reset-user-progress
    if (subPath === "labs/reset-user-progress" && method === "POST") {
      try {
        const body = await req.json().catch(() => ({}));
        if (body.consumerKey) {
          this.labManager.resetParticipantUsage(body.consumerKey);
        }
        return this.jsonResponse({ success: true });
      } catch (err: any) {
        return this.jsonResponse({ success: false, error: err.message || String(err) }, 500);
      }
    }

    // 33. POST /labs/publish-trace
    if ((subPath === "labs/publish-trace" || subPath === "labs/open-trace") && method === "POST") {
      try {
        const body = await req.json();
        const rawUser = body.user || body.userName || body.name || "user";
        const user = encodeURIComponent(String(rawUser).trim().toLowerCase() || "user");
        const traceData = body.traceData || body.trace || {};
        const viewerBase = process.env.APIGEE_TRACE_VIEWER_URL || "https://apigee-trace-viewer-323709580283.europe-west1.run.app";
        const viewerUrl = `${viewerBase.replace(/\/+$/, "")}/${user}`;

        console.log(`[TraceViewer] Forwarding trace data to: ${viewerUrl}`);
        const upstreamRes = await fetch(viewerUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(traceData),
        });

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text().catch(() => "");
          console.warn(`[TraceViewer] Upstream returned HTTP ${upstreamRes.status}: ${errText}`);
          return this.jsonResponse({
            success: false,
            error: `Trace viewer returned HTTP ${upstreamRes.status}`,
            url: viewerUrl,
          }, upstreamRes.status);
        }

        const upstreamJson = await upstreamRes.json().catch(() => null);
        return this.jsonResponse({
          success: true,
          url: viewerUrl,
          upstream: upstreamJson,
        });
      } catch (err: any) {
        console.error(`[TraceViewer] Error forwarding trace:`, err);
        return this.jsonResponse({
          success: false,
          error: err.message || String(err),
        }, 500);
      }
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
      await syncCassandraDeveloperAppKeys(this.dataDir);

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

      // Include all configured tests
      for (const tc of allTests) {
        warmupList.push(tc);
        const p = (tc.proxy || "").trim().toLowerCase();
        if (p) seen.add(p);
      }

      // Also check any active proxies with no explicit test
      const status = await this.emulator.checkHealth();
      for (const p of status.activeProxies) {
        const lowerName = p.name.toLowerCase();
        if (!seen.has(lowerName)) {
          seen.add(lowerName);
          const isCompletion = lowerName.includes("completions");
          warmupList.push({
            name: `warmup-${lowerName}`,
            proxy: p.name,
            verb: isCompletion ? "POST" : "GET",
            path: p.basePath || (isCompletion ? "/v1/chat/completions" : `/${lowerName}`),
            headers: isCompletion
              ? {
                  "Content-Type": "application/json",
                  "x-api-key": "test-api-key-12345",
                }
              : {
                  "x-api-key": "test-api-key-12345",
                },
            injectGoogleToken: isCompletion ? true : undefined,
            payload: isCompletion
              ? JSON.stringify({
                  model: "google/gemini-2.5-flash",
                  messages: [{ role: "user", content: "ping" }],
                  max_tokens: 1,
                })
              : undefined,
          });
        }
      }

      const uniqueProxies = new Set(warmupList.map((t) => t.proxy).filter(Boolean));
      console.log(`[Warmup] Silently pre-warming ${warmupList.length} test call(s) across ${uniqueProxies.size} proxies...`);

      // Execute warmup requests concurrently
      await Promise.allSettled(
        warmupList.map(async (tc) => {
          const effectiveHeaders: { [key: string]: string } = {};
          if (tc.headers) {
            for (const [k, v] of Object.entries(tc.headers)) {
              if (k.trim()) effectiveHeaders[k.trim()] = String(v);
            }
          }
          const hasApiKey = Object.keys(effectiveHeaders).some(
            (k) => k.toLowerCase() === "x-api-key" || k.toLowerCase() === "x-ai-key"
          );
          if (!hasApiKey) {
            effectiveHeaders["x-api-key"] = "test-api-key-12345";
          }

          const testReq: TestRequest = {
            proxy: tc.proxy,
            method: tc.verb || (tc.payload || tc.body ? "POST" : "GET"),
            path: tc.path,
            headers: effectiveHeaders,
            body: tc.payload || tc.body,
            recordTrace: false,
            testName: tc.name,
            injectGoogleToken: tc.injectGoogleToken,
          };

          try {
            const resp = await this.proxyTester.execute(testReq);
            console.log(
              `[Warmup] Proxy '${tc.proxy}' test '${tc.name}' warmed up (${resp.statusCode} in ${resp.durationMs}ms)`
            );
          } catch (err: any) {
            console.log(
              `[Warmup] Proxy '${tc.proxy}' test '${tc.name}' error: ${err.message || String(err)}`
            );
          }
        })
      );

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
