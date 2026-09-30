import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { EmulatorClient } from "./emulator.ts";
import { BundleManager } from "./bundle-manager.ts";
import { DeploymentDeployer } from "./deployer.ts";
import { DeploymentManager } from "./deployments-manager.ts";
import { ProxyTester } from "./tester.ts";
import { evaluateAssertions } from "./test-manager.ts";
import { EmulatorServer } from "./server.ts";
import { TestRequest } from "./types.ts";

export async function ensureEmulatorStarted(emulator: EmulatorClient): Promise<boolean> {
  const health = await emulator.checkHealth();
  if (health.online) {
    return true;
  }

  console.log("[CLI] Emulator is offline. Attempting to start Docker container 'apigee'...");
  try {
    const res = spawnSync("docker", ["start", "apigee"], { encoding: "utf-8" });
    if (res.status === 0) {
      console.log("[CLI] Container 'apigee' started. Waiting for management API to be ready...");
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const check = await emulator.checkHealth();
        if (check.online) {
          console.log("[CLI] Emulator is online!");
          return true;
        }
      }
    } else {
      console.warn("[CLI] Warning starting docker container:", res.stderr || res.stdout);
    }
  } catch (err) {
    console.warn("[CLI] Docker command failed:", err);
  }

  return false;
}

export async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");

  const emulator = new EmulatorClient();
  const bundleManager = new BundleManager(dataDir);
  emulator.kvmSecretProvider = () => bundleManager.getKVMSecretValues();
  emulator.activeConsumerKeysProvider = () => {
    const apps = bundleManager.getApps();
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

  const deployer = new DeploymentDeployer(emulator, bundleManager, dataDir);
  const deploymentManager = new DeploymentManager(dataDir);
  const proxyTester = new ProxyTester(emulator);

  let deployTarget: string | null = null;
  let runTests = false;
  let filterProxy = "";
  let noServer = false;
  let customPort: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--deploy" || arg === "-d") {
      deployTarget = args[i + 1] && !args[i + 1].startsWith("-") ? args[++i] : "data/deployments/deployment-1.yaml";
    } else if (arg === "--test" || arg === "-t") {
      runTests = true;
      noServer = true;
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        filterProxy = args[++i];
      }
    } else if (arg === "--no-server") {
      noServer = true;
    } else if (arg === "--port" || arg === "-p") {
      customPort = parseInt(args[++i], 10);
    } else if (!arg.startsWith("-") && (arg.endsWith(".yaml") || arg.endsWith(".yml"))) {
      deployTarget = arg;
    }
  }

  // If a deploy target was provided or tests requested
  if (deployTarget || runTests) {
    await ensureEmulatorStarted(emulator);

    if (deployTarget) {
      const targetPath = path.resolve(process.cwd(), deployTarget);
      if (!fs.existsSync(targetPath)) {
        console.error(`[CLI] Error: Deployment file not found: ${targetPath}`);
        process.exit(1);
      }

      console.log(`[CLI] Converting and deploying ${path.basename(targetPath)}...`);
      const yamlContent = fs.readFileSync(targetPath, "utf-8");
      const resp = await deployer.convertAndDeploy(yamlContent, { reset: true });
      console.log(`[CLI] Deployed ${resp.totalDeployed} proxies in ${resp.durationMs}ms (revision ${resp.revision})`);
      runTests = true; // Automatically run tests on deploy
    }

    if (runTests) {
      console.log("[CLI] Running test suite...");
      const allTests = deployTarget
        ? deploymentManager.getDeploymentTests(path.basename(deployTarget))
        : deploymentManager.loadAllTests();
      let passed = 0;
      let failed = 0;

      for (const tc of allTests) {
        if (filterProxy && tc.proxy.toLowerCase() !== filterProxy.toLowerCase()) continue;

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

        const resp = await proxyTester.execute(testReq);
        let testPassed = resp.statusCode < 400 && !resp.error;
        let assertionMsg = "";

        if (tc.assertions && tc.assertions.length > 0) {
          resp.assertions = evaluateAssertions(tc.assertions, resp);
          testPassed = resp.assertions.every((a) => a.passed);
          const failedAssert = resp.assertions.find((a) => !a.passed);
          if (failedAssert) {
            assertionMsg = ` (Assertion failed: ${failedAssert.assertion} - expected: ${failedAssert.expected}, actual: ${failedAssert.actual})`;
          }
        }

        if (testPassed) {
          passed++;
          console.log(`  ✓ [PASS] [${tc.proxy}] ${tc.name} (${resp.statusCode} in ${resp.durationMs}ms)`);
        } else {
          failed++;
          console.log(`  ✗ [FAIL] [${tc.proxy}] ${tc.name} (${resp.statusCode} in ${resp.durationMs}ms)${assertionMsg}`);
        }
      }

      console.log(`[CLI] Test results: ${passed} passed, ${failed} failed out of ${passed + failed} total`);
      if (noServer) {
        process.exit(failed > 0 ? 1 : 0);
      }
    }

    if (noServer) {
      process.exit(0);
    }
  }

  // Start the HTTP server
  const server = new EmulatorServer({ port: customPort });
  await server.start();
}
