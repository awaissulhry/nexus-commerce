/**
 * CX.0 (S20) — logger redaction: credential-looking keys never reach stdout,
 * metadata about credentials (expiry, presence) still does.
 */
import { describe, it, expect } from "vitest";
import { redact } from "./logger.js";

describe("redact", () => {
  it("replaces token/secret material at any depth", () => {
    const out = redact({
      connection: {
        id: "c1",
        accessToken: "v^1.1#i^1#…",
        refreshToken: "v^1.1#r^1#…",
        ebayAccessToken: "x",
        credentialsEncrypted: "v1:abc",
        nested: { client_secret: "s", code_verifier: "v", apiKey: "k", api_key: "k2" },
      },
      authorization: "Bearer abc",
      password: "p",
    }) as Record<string, any>;
    expect(out.connection.accessToken).toBe("[redacted]");
    expect(out.connection.refreshToken).toBe("[redacted]");
    expect(out.connection.ebayAccessToken).toBe("[redacted]");
    expect(out.connection.credentialsEncrypted).toBe("[redacted]");
    expect(out.connection.nested).toEqual({
      client_secret: "[redacted]",
      code_verifier: "[redacted]",
      apiKey: "[redacted]",
      api_key: "[redacted]",
    });
    expect(out.authorization).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect(out.connection.id).toBe("c1");
  });

  it("keeps metadata about credentials", () => {
    const out = redact({
      tokenExpiresAt: "2026-08-29T00:00:00Z",
      hasRefreshToken: true,
      refreshTokenPresent: true,
      tokenOk: false,
      secretConfigured: true,
      apiKeyPrefix: "abcd",
    }) as Record<string, any>;
    expect(out.tokenExpiresAt).toBe("2026-08-29T00:00:00Z");
    expect(out.hasRefreshToken).toBe(true);
    expect(out.refreshTokenPresent).toBe(true);
    expect(out.tokenOk).toBe(false);
    expect(out.secretConfigured).toBe(true);
    expect(out.apiKeyPrefix).toBe("abcd");
  });

  it("serialises Errors instead of dropping them, and leaves arrays/primitives alone", () => {
    const out = redact({ error: new Error("boom"), list: [{ token: "t" }, 1, "s"] }) as Record<string, any>;
    expect(out.error.message).toBe("boom");
    expect(out.list[0]).toEqual({ token: "[redacted]" });
    expect(out.list[1]).toBe(1);
    expect(redact("plain")).toBe("plain");
    expect(redact(null)).toBe(null);
  });
});
