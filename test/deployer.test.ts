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
    expect(resolved.dataCollectors.length).toBe(parsed.dataCollectors?.length || 0);
    expect(resolved.dataCollectors.some((dc: any) => dc.name === "dc_ai_cost_center")).toBe(true);
  });

  test("dataCollectors are converted into datacollectors.json and individual files", async () => {
    const yamlPath = path.join(dataDir, "deployments", "deployment-1.yaml");
    const content = fs.readFileSync(yamlPath, "utf-8");
    const deployment = deployer.substituteEnvVars(content);
    const parsed = require("yaml").parse(deployment);

    const miniDeployment = {
      name: "test-dc-dep",
      dataCollectors: parsed.dataCollectors,
    };

    const tmpDataDir = path.join(process.cwd(), "tests-tmp-dc");
    if (fs.existsSync(tmpDataDir)) fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDataDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDataDir, "bundles"), { recursive: true });
    const { createZip } = await import("../src/zip-util.ts");
    const dummyZip = await createZip([{ path: "apiproxy/dummy.xml", data: "<APIProxy name='dummy'/>" }]);
    fs.writeFileSync(path.join(tmpDataDir, "bundles", "dummy.zip"), dummyZip);

    try {
      const customBundleMgr = new BundleManager(tmpDataDir);
      const customDeployer = new DeploymentDeployer(emulator, customBundleMgr, tmpDataDir);

      // Mock emulator methods
      emulator.reset = async () => {};
      emulator.setupTestData = async () => {};
      emulator.deployBundle = async () => 1;
      emulator.getDeploymentTree = async () => [];

      await customDeployer.convertAndDeploy(miniDeployment, "test", false);

      const dcFile = path.join(tmpDataDir, "datacollectors", "datacollectors.json");
      expect(fs.existsSync(dcFile)).toBe(true);
      const dcs = JSON.parse(fs.readFileSync(dcFile, "utf-8"));
      expect(Array.isArray(dcs)).toBe(true);
      expect(dcs.length).toBe(12);

      const costCenter = dcs.find((d: any) => d.name === "dc_ai_cost_center");
      expect(costCenter).toBeDefined();
      expect(costCenter.type).toBe("STRING");

      const promptTokens = dcs.find((d: any) => d.name === "dc_ai_prompt_token_count");
      expect(promptTokens).toBeDefined();
      expect(promptTokens.type).toBe("INTEGER");

      const singleDcFile = path.join(tmpDataDir, "datacollectors", "dc_ai_cost_center.json");
      expect(fs.existsSync(singleDcFile)).toBe(true);

      // Check that bundleManager includes datacollectors.json in test data bundle
      const collectors = customBundleMgr.getDataCollectors();
      expect(collectors.length).toBe(12);
    } finally {
      if (fs.existsSync(tmpDataDir)) fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  }, 15000);
});

