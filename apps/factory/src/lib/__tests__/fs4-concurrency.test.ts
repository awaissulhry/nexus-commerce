/** FS4 — the shared optimistic-concurrency guard (stale-stamp semantics + EPO.1 wording). */
import { describe, expect, it } from "vitest";
import { assertNotStale, staleMessage, stampMatches } from "@/lib/concurrency";

describe("stampMatches", () => {
  const d = new Date("2026-07-17T10:00:00.000Z");

  it("matches identical stamps across representations", () => {
    expect(stampMatches(d, d.toISOString())).toBe(true);
    expect(stampMatches(d.toISOString(), d)).toBe(true);
    expect(stampMatches(d.getTime(), d.toISOString())).toBe(true);
  });

  it("differs on any millisecond drift", () => {
    expect(stampMatches(d, new Date(d.getTime() + 1))).toBe(false);
  });

  it("is null-aware: null only matches null", () => {
    expect(stampMatches(null, null)).toBe(true);
    expect(stampMatches(d, null)).toBe(false);
    expect(stampMatches(null, d)).toBe(false);
  });

  it("fails closed on an unparseable expected stamp", () => {
    expect(stampMatches(d, "not-a-date")).toBe(false);
    expect(stampMatches("not-a-date", "not-a-date")).toBe(false); // NaN never matches, even itself
  });
});

describe("staleMessage", () => {
  it("uses the EPO.1 wording so every 409 reads identically", () => {
    expect(staleMessage("quote")).toBe("The quote changed elsewhere — refresh and retry");
    expect(staleMessage("order")).toBe("The order changed elsewhere — refresh and retry");
  });
});

describe("assertNotStale", () => {
  const row = (updatedAt: Date) => ({
    findUnique: async () => ({ updatedAt }),
  });
  const missing = { findUnique: async () => null };
  const d = new Date("2026-07-17T10:00:00.000Z");

  it("passes on a matching stamp", async () => {
    expect(await assertNotStale(row(d), "x", d.toISOString(), "quote")).toEqual({ ok: true });
  });

  it("409s with the entity-specific wording on a moved row", async () => {
    const res = await assertNotStale(row(new Date(d.getTime() + 5)), "x", d.toISOString(), "contact");
    expect(res).toEqual({ ok: false, status: 409, error: "The contact changed elsewhere — refresh and retry" });
  });

  it("opts out when the caller sent no stamp", async () => {
    expect(await assertNotStale(row(d), "x", undefined)).toEqual({ ok: true });
    expect(await assertNotStale(row(d), "x", null)).toEqual({ ok: true });
  });

  it("lets a missing row fall through to the route's own 404", async () => {
    expect(await assertNotStale(missing, "x", d.toISOString())).toEqual({ ok: true });
  });
});
