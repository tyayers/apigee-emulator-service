import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { EmulatorServer } from "../src/server.ts";

describe("HTTP server endpoints", () => {
  let server: EmulatorServer;
  const testPort = 18083;

  beforeAll(async () => {
    server = new EmulatorServer({ port: testPort });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test("GET /tester/api/status returns online and status info", async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/tester/api/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("online");
  });

  test("GET /tester/api/deployments returns deployment list", async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/tester/api/deployments`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].name).toContain("deployment-1");
  });

  test("GET /tester/api/bundles returns bundle list", async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/tester/api/bundles`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("GET /tester/ serves index.html UI", async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/tester/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<html");
  });

  test("POST /api/labs/publish-trace forwards trace data and returns URL", async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/labs/publish-trace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: "testuser",
        traceData: { testTrace: true, timestamp: Date.now() },
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.url).toBe("https://apigee-trace-viewer-323709580283.europe-west1.run.app/testuser");
  });

  test("POST /api/labs/publish-trace prioritizes traceId over user name", async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/labs/publish-trace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        traceId: "tx-session-12345",
        user: "john-doe",
        traceData: { testTrace: true, timestamp: Date.now() },
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.url).toBe("https://apigee-trace-viewer-323709580283.europe-west1.run.app/tx-session-12345");
  });

  test("POST /tester/api/tests/warmup triggers proxy warmup", async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/tester/api/tests/warmup`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.status).toBe("warmup_started");
  });

  test("GET /tester/api/config/host and status return host configuration", async () => {
    const statusRes = await fetch(`http://127.0.0.1:${testPort}/tester/api/status`);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData).toHaveProperty("targetHostConfig");
    expect(statusData.targetHostConfig.mode).toBe("local");
    expect(statusData.targetHostConfig.defaultRemoteHost).toBe("https://34-8-196-4.nip.io");

    const configRes = await fetch(`http://127.0.0.1:${testPort}/tester/api/config/host`);
    expect(configRes.status).toBe(200);
    const configData = await configRes.json();
    expect(configData.mode).toBe("local");
    expect(configData.remoteHost).toBe("https://34-8-196-4.nip.io");
  });

  test("POST /tester/api/config/host switches host mode and remote host", async () => {
    const postRes = await fetch(`http://127.0.0.1:${testPort}/tester/api/config/host`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "remote",
        remoteHost: "https://custom-apigee.nip.io",
      }),
    });
    expect(postRes.status).toBe(200);
    const postData = await postRes.json();
    expect(postData.mode).toBe("remote");
    expect(postData.remoteHost).toBe("https://custom-apigee.nip.io");

    // Verify it changed
    const verifyRes = await fetch(`http://127.0.0.1:${testPort}/tester/api/config/host`);
    const verifyData = await verifyRes.json();
    expect(verifyData.mode).toBe("remote");
    expect(verifyData.remoteHost).toBe("https://custom-apigee.nip.io");

    // Reset back to local
    await fetch(`http://127.0.0.1:${testPort}/tester/api/config/host`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "local",
        remoteHost: "https://34-8-196-4.nip.io",
      }),
    });
  });
});
