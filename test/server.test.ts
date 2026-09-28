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
});
