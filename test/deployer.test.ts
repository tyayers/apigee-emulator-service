import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { DeploymentDeployer } from "../src/deployer.ts";
import { EmulatorClient } from "../src/emulator.ts";
import { BundleManager } from "../src/bundle-manager.ts";

describe("deployer & templater conversion", () => {
  const dataDir = path.join(process.cwd(), "data");
  const emulator = new EmulatorClient();
  const bundleManager = new BundleManager(dataDir);
  const deployer = new DeploymentDeployer(emulator, bundleManager, dataDir);

  test("substituteEnvVars substitutes known variables", () => {
    process.env.TEST_VAR = "hello-world";
    const result = deployer.substituteEnvVars("Test {TEST_VAR}");
    expect(result).toBe("Test hello-world");
  });

  test("deploymentResolveAssets resolves templates from deployment-1.yaml", async () => {
    const yamlPath = path.join(dataDir, "deployments", "deployment-1.yaml");
    const content = fs.readFileSync(yamlPath, "utf-8");
    const deployment = deployer.substituteEnvVars(content);
    const parsed = require("yaml").parse(deployment);

    const resolved = await deployer["service"].deploymentResolveAssets(parsed);
    expect(resolved.templates.length).toBe(parsed.templates?.length || 0);
    expect(resolved.products.length).toBe(parsed.products?.length || 0);
  });
});
