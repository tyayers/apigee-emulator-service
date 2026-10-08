import { describe, expect, test, mock } from "bun:test";
import { ProxyTester } from "../src/tester.ts";
import { EmulatorClient } from "../src/emulator.ts";

describe("ProxyTester - configurable Google Bearer Token and placeholders", () => {
  const fakeEmulator = {
    runtimeUrl: "http://127.0.0.1:8888",
    startTraceSession: async () => "trace-123",
    listDeployments: async () => ({}),
  } as unknown as EmulatorClient;

  test("does not inject Google Bearer token when injectGoogleToken is false", async () => {
    let capturedHeaders: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        capturedHeaders = Object.fromEntries(req.headers.entries());
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const emulator = {
      runtimeUrl: `http://127.0.0.1:${server.port}`,
      startTraceSession: async () => "trace-123",
      listDeployments: async () => ({}),
    } as unknown as EmulatorClient;

    try {
      const tester = new ProxyTester(emulator);
      const res = await tester.execute({
        proxy: "REST-AI-Interactions",
        path: "/v1beta/interactions",
        method: "POST",
        headers: {
          "x-api-key": "test-key-123",
          "x-goog-api-key": "fake-gemini-key",
        },
        body: JSON.stringify({ input: "hello" }),
        injectGoogleToken: false,
      });

      expect(res.statusCode).toBe(200);
      expect(capturedHeaders["authorization"]).toBeUndefined();
      expect(capturedHeaders["x-goog-api-key"]).toBe("fake-gemini-key");
      expect(capturedHeaders["x-api-key"]).toBe("test-key-123");
    } finally {
      server.stop(true);
    }
  });

  test("replaces {GoogleAccessCode} in headers when present", async () => {
    let capturedHeaders: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        capturedHeaders = Object.fromEntries(req.headers.entries());
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const emulator = {
      runtimeUrl: `http://127.0.0.1:${server.port}`,
      startTraceSession: async () => "trace-123",
      listDeployments: async () => ({}),
    } as unknown as EmulatorClient;

    try {
      const tester = new ProxyTester(emulator);
      const res = await tester.execute({
        proxy: "REST-AI-Completions",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "x-api-key": "starter-app-key-123",
          Authorization: "Bearer {GoogleAccessCode}",
        },
        body: JSON.stringify({ input: "hello" }),
      });

      expect(res.statusCode).toBe(200);
      expect(capturedHeaders["authorization"]).toBeDefined();
      expect(capturedHeaders["authorization"]).not.toContain("{GoogleAccessCode}");
      expect(capturedHeaders["authorization"]).toMatch(/^Bearer /);
    } finally {
      server.stop(true);
    }
  });

  test("skips Bearer token for Interactions even without explicit injectGoogleToken: false", async () => {
    let capturedHeaders: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        capturedHeaders = Object.fromEntries(req.headers.entries());
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const emulator = {
      runtimeUrl: `http://127.0.0.1:${server.port}`,
      startTraceSession: async () => "trace-123",
      listDeployments: async () => ({}),
    } as unknown as EmulatorClient;

    try {
      const tester = new ProxyTester(emulator);
      const res = await tester.execute({
        proxy: "REST-AI-Interactions",
        path: "/v1beta/interactions",
        method: "POST",
        headers: {
          "x-api-key": "starter-app-key-123",
        },
        body: JSON.stringify({ input: "hello" }),
      });

      expect(res.statusCode).toBe(200);
      expect(capturedHeaders["authorization"]).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("injects Google Bearer token when injectGoogleToken is true without Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        capturedHeaders = Object.fromEntries(req.headers.entries());
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const emulator = {
      runtimeUrl: `http://127.0.0.1:${server.port}`,
      startTraceSession: async () => "trace-123",
      listDeployments: async () => ({}),
    } as unknown as EmulatorClient;

    try {
      const tester = new ProxyTester(emulator);
      const res = await tester.execute({
        proxy: "REST-AI-Completions",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "starter-app-key-123",
          // Note: NO Authorization header!
        },
        body: JSON.stringify({ input: "hello" }),
        injectGoogleToken: true,
      });

      expect(res.statusCode).toBe(200);
      expect(capturedHeaders["authorization"]).toBeDefined();
      expect(capturedHeaders["authorization"]).toMatch(/^Bearer /);
      expect(capturedHeaders["authorization"]).not.toContain("{");
    } finally {
      server.stop(true);
    }
  });
});
