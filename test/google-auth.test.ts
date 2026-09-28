import { describe, expect, test } from "bun:test";
import { hasAuthorizationBearerToken, injectGoogleAccessToken, googleAuthService } from "../src/google-auth.ts";

describe("google-auth", () => {
  test("hasAuthorizationBearerToken detects bearer token and rejects placeholders", () => {
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer xyz" })).toBe(true);
    expect(hasAuthorizationBearerToken({ authorization: "bearer valid-adc-token-123" })).toBe(true);
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer <token>" })).toBe(false);
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer $token" })).toBe(false);
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer auto" })).toBe(false);
    expect(hasAuthorizationBearerToken({ Authorization: "Bearer " })).toBe(false);
    expect(hasAuthorizationBearerToken({ "x-api-key": "123" })).toBe(false);
    expect(hasAuthorizationBearerToken({})).toBe(false);
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
    // If environment has credentials, verify it returns a non-empty token
    if (token) {
      expect(token.length).toBeGreaterThan(10);
    }
  });
});
