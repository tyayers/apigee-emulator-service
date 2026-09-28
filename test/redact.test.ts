import { describe, expect, test } from "bun:test";
import { redactKVMValue, extractKVMSecretValues, redactValue } from "../src/redact.ts";

describe("redact", () => {
  test("redactKVMValue masks middle characters", () => {
    expect(redactKVMValue("short")).toBe("short");
    expect(redactKVMValue("1234567")).toBe("12***");
    expect(redactKVMValue("my-secret-token-12345")).toBe("my-s***");
  });

  test("extractKVMSecretValues extracts secret values from JSON maps", () => {
    const maps = [
      {
        name: "test-map",
        entries: [
          { name: "api_key", value: "secret123" },
          { name: "normal", value: "hello" }, // < 6 chars should be skipped
        ],
      },
    ];
    const secrets = extractKVMSecretValues(maps);
    expect(secrets).toContain("secret123");
    expect(secrets).not.toContain("hello");
  });

  test("redactValue masks secrets in string and object recursively", () => {
    const text = "Bearer secret123 in payload";
    const redacted = redactValue(text, "secret123", "*****");
    expect(redacted).toBe("Bearer ***** in payload");

    const obj = {
      header: "secret123",
      nested: {
        value: "my secret123 token",
      },
      list: ["secret123", "normal"],
    };
    const redactedObj = redactValue(obj, "secret123", "*****");
    expect(redactedObj.header).toBe("*****");
    expect(redactedObj.nested.value).toBe("my ***** token");
    expect(redactedObj.list[0]).toBe("*****");
    expect(redactedObj.list[1]).toBe("normal");
  });
});
