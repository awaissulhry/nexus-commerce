/**
 * CX.0 (S9) — Shopify signature verification must run over the RAW bytes.
 *
 * The fixture is chosen so that JSON.parse → JSON.stringify changes the bytes
 * (float formatting, unicode escapes, insignificant whitespace, key order is
 * preserved but spacing is not). The old implementation signed the
 * re-serialised object and therefore failed on exactly this kind of legitimate
 * delivery; the new one signs the buffer Shopify sent.
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import Fastify from "fastify";
import { WebhookValidator, registerRawJsonParser, type RawBodyRequest } from "./webhook.js";

const SECRET = "shpss_test_secret_0123456789";
// 1.0 → "1", é → "é", and pretty-printing all change under a round trip.
const RAW = Buffer.from('{\n  "id": 1.0,\n  "note": "caf\\u00e9",\n  "z": 1, "a": 2\n}', "utf8");
const sign = (buf: Buffer | string) => crypto.createHmac("sha256", SECRET).update(buf).digest("base64");

describe("WebhookValidator.validateShopifySignature (raw body)", () => {
  it("accepts a signature computed over the raw bytes", () => {
    const r = WebhookValidator.validateShopifySignature(RAW, sign(RAW), SECRET);
    expect(r.isValid).toBe(true);
  });

  it("proves the round-tripped body would NOT verify (the pre-CX.0 defect)", () => {
    const roundTripped = JSON.stringify(JSON.parse(RAW.toString("utf8")));
    expect(roundTripped).not.toBe(RAW.toString("utf8"));
    const r = WebhookValidator.validateShopifySignature(roundTripped, sign(RAW), SECRET);
    expect(r.isValid).toBe(false);
  });

  it("rejects a missing header without throwing", () => {
    expect(WebhookValidator.validateShopifySignature(RAW, undefined, SECRET).isValid).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    expect(WebhookValidator.validateShopifySignature(RAW, "AAAA", SECRET).isValid).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(WebhookValidator.validateShopifySignature(RAW, sign(RAW), "other").isValid).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(WebhookValidator.validateShopifySignature(undefined, sign(RAW), SECRET).isValid).toBe(false);
  });
});

describe("registerRawJsonParser", () => {
  it("exposes the exact bytes as request.rawBody and still parses JSON, scoped to the plugin", async () => {
    const app = Fastify();
    let seen: { raw?: string; parsed?: unknown } = {};
    await app.register(async (plugin) => {
      registerRawJsonParser(plugin);
      plugin.post("/hook", async (req) => {
        seen = { raw: (req as RawBodyRequest).rawBody?.toString("utf8"), parsed: req.body };
        return { ok: true };
      });
    });
    // A sibling route outside the plugin keeps Fastify's default parser.
    app.post("/plain", async (req) => ({ hasRaw: (req as RawBodyRequest).rawBody !== undefined }));

    const res = await app.inject({
      method: "POST",
      url: "/hook",
      headers: { "content-type": "application/json" },
      payload: RAW,
    });
    expect(res.statusCode).toBe(200);
    expect(seen.raw).toBe(RAW.toString("utf8"));
    expect(seen.parsed).toEqual({ id: 1, note: "café", z: 1, a: 2 });

    const plain = await app.inject({
      method: "POST",
      url: "/plain",
      headers: { "content-type": "application/json" },
      payload: { a: 1 },
    });
    expect(plain.json()).toEqual({ hasRaw: false });

    const bad = await app.inject({
      method: "POST",
      url: "/hook",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
