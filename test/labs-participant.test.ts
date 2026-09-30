import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { EmulatorServer } from "../src/server.ts";

describe("Labs Participant uniqueness and account deletion", () => {
  let server: EmulatorServer;
  const testPort = 18089;
  const testUser = "TylerUniqueTester";

  beforeAll(async () => {
    server = new EmulatorServer({ port: testPort });
    await server.start();
  });

  afterAll(async () => {
    // Clean up test user if still present
    await fetch(`http://127.0.0.1:${testPort}/api/labs/delete-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: testUser }),
    }).catch(() => {});

    await server.stop();
  });

  test("Registering a new participant succeeds and returns a key", async () => {
    // Ensure clean state first
    await fetch(`http://127.0.0.1:${testPort}/api/labs/delete-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: testUser }),
    }).catch(() => {});

    const res = await fetch(`http://127.0.0.1:${testPort}/api/labs/register-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: testUser }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.participant).toBeDefined();
    expect(data.participant.name).toBe(testUser);
    expect(data.participant.consumerKey).toBeDefined();
  });

  test("Registering duplicate participant (case-insensitive) is rejected with 409 Conflict", async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/labs/register-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: testUser.toLowerCase() }),
    });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe("User already exists");
    expect(data.code).toBe("USER_ALREADY_EXISTS");
    expect(data.participant).toBeDefined();
    expect(data.participant.name).toBe(testUser);
  });

  test("Deleting participant removes account and usage data", async () => {
    const delRes = await fetch(`http://127.0.0.1:${testPort}/api/labs/delete-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: testUser }),
    });

    expect(delRes.status).toBe(200);
    const delData = await delRes.json();
    expect(delData.success).toBe(true);

    // After deletion, registering again should succeed
    const reRegRes = await fetch(`http://127.0.0.1:${testPort}/api/labs/register-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: testUser }),
    });

    expect(reRegRes.status).toBe(200);
    const reRegData = await reRegRes.json();
    expect(reRegData.success).toBe(true);
    expect(reRegData.participant.name).toBe(testUser);

    // Clean up
    await fetch(`http://127.0.0.1:${testPort}/api/labs/delete-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: testUser }),
    });
  }, 15000);

  test("GET /api/labs/leaderboard reflects registered participant and usage", async () => {
    const lbUser = "Leaderboard Runner " + Math.random().toString(36).slice(2, 6);
    const regRes = await fetch(`http://127.0.0.1:${testPort}/api/labs/register-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: lbUser }),
    });
    const regData = await regRes.json();
    expect(regData.success).toBe(true);
    const key = regData.participant.consumerKey;

    const res = await fetch(`http://127.0.0.1:${testPort}/api/labs/leaderboard?currentKey=${key}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.leaderboard)).toBe(true);

    const me = data.leaderboard.find((e: any) => e.consumerKey === key);
    expect(me).toBeDefined();
    expect(me.name).toBe(lbUser);
    expect(me.isCurrent).toBe(true);
    expect(me.rank).toBe(1);

    // Clean up
    await fetch(`http://127.0.0.1:${testPort}/api/labs/delete-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: lbUser }),
    });
  }, 15000);
});
