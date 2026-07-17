/** FS4 — session-cache key semantics and the pure store (S-9). */
import { describe, expect, it } from "vitest";
import { SessionCache, cachedSessionUsable, sessionCacheKey } from "@/lib/auth/session-cache";

const NOW = Date.parse("2026-07-17T10:00:00.000Z");
const entry = (over: Partial<{ idleExpiryMs: number; absoluteExpiryMs: number; userId: string }> = {}) => ({
  user: { id: over.userId ?? "u1" },
  sessionId: "s1",
  idleExpiryMs: over.idleExpiryMs ?? NOW + 60_000,
  absoluteExpiryMs: over.absoluteExpiryMs ?? NOW + 120_000,
});

describe("sessionCacheKey", () => {
  it("is tokenHash:permissionsVersion — the rbac cache pattern one layer down", () => {
    expect(sessionCacheKey("abc123", 4)).toBe("abc123:4");
  });
});

describe("cachedSessionUsable", () => {
  it("usable only while BOTH expiries are in the future", () => {
    expect(cachedSessionUsable(entry(), NOW)).toBe(true);
    expect(cachedSessionUsable(entry({ idleExpiryMs: NOW }), NOW)).toBe(false);
    expect(cachedSessionUsable(entry({ absoluteExpiryMs: NOW }), NOW)).toBe(false);
  });
});

describe("SessionCache", () => {
  it("round-trips by token hash", () => {
    const c = new SessionCache<{ id: string }>();
    c.set("hashA", "u1", 1, entry());
    expect(c.get("hashA", NOW)?.user.id).toBe("u1");
    expect(c.get("hashB", NOW)).toBeUndefined();
  });

  it("an expired entry stops answering even inside the TTL window", () => {
    const c = new SessionCache<{ id: string }>();
    c.set("hashA", "u1", 1, entry({ idleExpiryMs: NOW - 1 }));
    expect(c.get("hashA", NOW)).toBeUndefined();
  });

  it("dropToken evicts one session (logout)", () => {
    const c = new SessionCache<{ id: string }>();
    c.set("hashA", "u1", 1, entry());
    c.dropToken("hashA");
    expect(c.get("hashA", NOW)).toBeUndefined();
  });

  it("dropUser evicts EVERY session of that user, nobody else's (revoke-all / role change)", () => {
    const c = new SessionCache<{ id: string }>();
    c.set("hashA", "u1", 1, entry());
    c.set("hashB", "u1", 1, entry());
    c.set("hashC", "u2", 1, entry({ userId: "u2" }));
    c.dropUser("u1");
    expect(c.get("hashA", NOW)).toBeUndefined();
    expect(c.get("hashB", NOW)).toBeUndefined();
    expect(c.get("hashC", NOW)?.user.id).toBe("u2");
  });

  it("a version bump re-keys the same token (old generation dropped)", () => {
    const c = new SessionCache<{ id: string }>();
    c.set("hashA", "u1", 1, entry());
    c.set("hashA", "u1", 2, entry());
    expect(c.get("hashA", NOW)?.user.id).toBe("u1"); // resolves through the NEW key
    expect(c.size).toBe(1); // the v1 generation did not linger
  });

  it("clear empties everything", () => {
    const c = new SessionCache<{ id: string }>();
    c.set("hashA", "u1", 1, entry());
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get("hashA", NOW)).toBeUndefined();
  });
});
