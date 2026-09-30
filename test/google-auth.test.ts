import { describe, expect, test } from "bun:test";
import {
  hasAuthorizationBearerToken,
  injectGoogleAccessToken,
  googleAuthService,
  containsGoogleTokenPlaceholder,
  hasGoogleTokenPlaceholder,
  replacePlaceholdersInString,
} from "../src/google-auth.ts";

describe("google-auth", () => {
  test("hasAuthorizationBearerToken detects bearer token and rejects placeholders", () => {
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer xyz" })).toBe(true);
    expect(hasAuthorizationBearerToken({ authorization: "bearer valid-adc-token-123" })).toBe(true);
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer <token>" })).toBe(false);
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer $token" })).toBe(false);
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer auto" })).toBe(false);
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer " })).toBe(false);
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer {GoogleAccessCode}" })).toBe(false);
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer {GoogleAccessToken}" })).toBe(false);
    expect(hasAuthorizationBearerToken({ "x-api-key": "123" })).toBe(false);
    expect(hasAuthorizationBearerToken({})).toBe(false);
  });

  test("containsGoogleTokenPlaceholder detects various token placeholders", () => {
    expect(containsGoogleTokenPlaceholder("{GoogleAccessCode}")).toBe(true);
    expect(containsGoogleTokenPlaceholder("Bearer {GoogleAccessCode}")).toBe(true);
    expect(containsGoogleTokenPlaceholder("{GoogleAccessToken}")).toBe(true);
    expect(containsGoogleTokenPlaceholder("${GoogleAccessToken}")).toBe(true);
    expect(containsGoogleTokenPlaceholder("{GOOGLE_ACCESS_TOKEN}")).toBe(true);
    expect(containsGoogleTokenPlaceholder("Bearer sample-token-12345")).toBe(false);
    expect(containsGoogleTokenPlaceholder("")).toBe(false);
  });

  test("hasGoogleTokenPlaceholder checks header values", () => {
    expect(hasGoogleTokenPlaceholder({ Authorization: "Bearer {GoogleAccessCode}" })).toBe(true);
    expect(hasGoogleTokenPlaceholder({ "x-api-key": "123", Authorization: "Bearer sample-token-12345" })).toBe(false);
  });

  test("replacePlaceholdersInString replaces tokens, api keys, and project IDs", () => {
    const text = "Bearer {GoogleAccessCode} for {GoogleCloudProject} with {GeminiApiKey}";
    const replaced = replacePlaceholdersInString(text, {
      googleToken: "token-abc-123",
      geminiApiKey: "AIzaSyTestKey",
      projectId: "my-test-proj",
    });
    expect(replaced).toBe("Bearer token-abc-123 for my-test-proj with AIzaSyTestKey");
  });

  test("injectGoogleAccessToken adds Authorization header if missing", () => {
    const headers = injectGoogleAccessToken({ "x-api-key": "123" }, "test-token");
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(headers["x-api-key"]).toBe("123");
  });

  test("injectGoogleAccessToken normalizes and replaces existing Authorization header", () => {
    const headers = injectGoogleAccessToken({ authorization: "Basic 123" }, "test-token");
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(headers["authorization"]).toBeUndefined();
  });

  test("googleAuthService provides ADC token", async () => {
    const token = await googleAuthService.getAccessToken();
    expect(typeof token).toBe("string");
    if (token) {
      expect(token.length).toBeGreaterThan(10);
    }
  });
});

