import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { AnalyticsManager } from "../src/analytics.ts";
import { EmulatorServer } from "../src/server.ts";

describe("AnalyticsManager - Local File Volume & Memory Storage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-test-"));
    delete process.env.K_SERVICE;
    delete process.env.K_REVISION;
    delete process.env.RUN_ON_CLOUDRUN;
    delete process.env.ANALYTICS_STORAGE;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("writes records to local file volume and returns them on local query", async () => {
    const manager = new AnalyticsManager(tmpDir);
    const analyticsFile = path.join(tmpDir, "analytics.json");

    expect(fs.existsSync(analyticsFile)).toBe(true);

    const record = await manager.saveRecord({
      proxy: "REST-AI-Interactions",
      statusCode: 200,
      model: "gemini-3.5-flash-lite",
      durationMs: 120,
    });

    expect(record.id).toBeDefined();
    expect(record.timestamp).toBeDefined();

    // Verify file content on disk
    const fileContent = JSON.parse(fs.readFileSync(analyticsFile, "utf-8"));
    expect(Array.isArray(fileContent)).toBe(true);
    expect(fileContent.length).toBe(1);
    expect(fileContent[0].id).toBe(record.id);
    expect(fileContent[0].proxy).toBe("REST-AI-Interactions");

    // Query local records
    const local = manager.getLocalRecords(10);
    expect(local.length).toBe(1);
    expect(local[0].id).toBe(record.id);

    // Query with forceLocal = true
    const res = await manager.getLastRecords(10, true);
    expect(res.records.length).toBe(1);
    expect(res.records[0].id).toBe(record.id);
    expect(res.source).toBe("local");
    expect(res.storageType).toBe("file");
    expect(res.storageFile).toBe(analyticsFile);
  });

  test("runs in memory mode when Cloud Run environment is detected", async () => {
    process.env.K_SERVICE = "apigee-emulator-manager";
    const manager = new AnalyticsManager(tmpDir);
    const analyticsFile = path.join(tmpDir, "analytics.json");

    // In memory mode, analytics.json should not be initialized
    expect(fs.existsSync(analyticsFile)).toBe(false);

    const record = await manager.saveRecord({
      proxy: "REST-AI-Completions",
      statusCode: 200,
      model: "google/gemini-3.5-flash-lite",
    });

    expect(fs.existsSync(analyticsFile)).toBe(false);

    const local = manager.getLocalRecords(10);
    expect(local.length).toBe(1);
    expect(local[0].id).toBe(record.id);

    const res = await manager.getLastRecords(10, true);
    expect(res.records.length).toBe(1);
    expect(res.records[0].id).toBe(record.id);
    expect(res.source).toBe("local");
    expect(res.storageType).toBe("memory");
    expect(res.storageFile).toBeUndefined();
  });

  test("deduplicates records with the same id and orders by timestamp descending", async () => {
    const manager = new AnalyticsManager(tmpDir);

    await manager.saveRecord({
      id: "rec-1",
      timestamp: "2026-10-01T10:00:00Z",
      proxy: "Proxy1",
    });

    await manager.saveRecord({
      id: "rec-2",
      timestamp: "2026-10-01T12:00:00Z",
      proxy: "Proxy2",
    });

    // Update rec-1 with newer timestamp
    await manager.saveRecord({
      id: "rec-1",
      timestamp: "2026-10-01T13:00:00Z",
      proxy: "Proxy1-Updated",
    });

    const res = await manager.getLastRecords(10, true);
    expect(res.records.length).toBe(2);
    // rec-1 should now be first because 13:00 > 12:00
    expect(res.records[0].id).toBe("rec-1");
    expect(res.records[0].proxy).toBe("Proxy1-Updated");
    expect(res.records[1].id).toBe("rec-2");
  });

  test("falls back cleanly to local file storage when Firestore query fails or returns empty", async () => {
    const manager = new AnalyticsManager(tmpDir);

    await manager.saveRecord({
      proxy: "REST-AI-GenerateContent",
      statusCode: 200,
    });

    // Mock Firestore query to throw error (simulating Firestore offline / unreachable)
    (manager as any).queryFirestoreRecords = async () => {
      throw new Error("Firestore connection timed out");
    };

    const res = await manager.getLastRecords(10);
    expect(res.records.length).toBe(1);
    expect(res.source).toBe("local");
    expect(res.records[0].proxy).toBe("REST-AI-GenerateContent");
  });

  test("seedDemoRecords populates local storage and returns count", async () => {
    const manager = new AnalyticsManager(tmpDir);
    const count = await manager.seedDemoRecords();
    expect(count).toBeGreaterThanOrEqual(3);

    const local = manager.getLocalRecords(10);
    expect(local.length).toBe(count);
  });

  test("server /tester/api/analytics endpoints save and retrieve local records", async () => {
    const port = 18096;
    const server = new EmulatorServer({ port, dataDir: tmpDir });
    await server.start();

    try {
      // POST record
      const postRes = await fetch(`http://127.0.0.1:${port}/tester/api/analytics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proxy: "MCP-CustomerService",
          statusCode: 200,
          model: "claude-sonnet-5",
        }),
      });

      expect(postRes.status).toBe(200);
      const postData = await postRes.json();
      expect(postData.success).toBe(true);
      expect(postData.id).toBeDefined();

      // GET records with source=local
      const getRes = await fetch(`http://127.0.0.1:${port}/tester/api/analytics?source=local`);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.records).toBeDefined();
      expect(getData.records.length).toBe(1);
      expect(getData.records[0].proxy).toBe("MCP-CustomerService");
      expect(getData.source).toBe("local");
      expect(getData.storageType).toBe("file");
    } finally {
      await server.stop();
    }
  });
});
