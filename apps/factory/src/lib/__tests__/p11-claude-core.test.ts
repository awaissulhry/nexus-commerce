/**
 * P11 — Claude's connection to the factory, the pure rules (src/lib/claude/core.ts): the token and its hash, its
 * lifetime, what makes one unusable, what the stdio server refuses to start without, the per-minute rate and the
 * daily cap of drafts.
 */
import { describe, expect, it } from "vitest";
import {
  DAILY_DRAFT_CAP,
  MAX_TOKEN_DAYS,
  MinuteRate,
  TOKEN_PREFIX,
  draftCapRefusal,
  expiryFor,
  hashToken,
  looksLikeToken,
  newRawToken,
  parseScopes,
  startOfLocalDay,
  startRefusal,
  tokenRefusal,
} from "../claude/core";

const NOW = new Date("2026-10-01T10:00:00.000Z");
const DAY = 86_400_000;

describe("the token", () => {
  it("is the prefix and 43 base64url characters; only its sha256 is kept", () => {
    const raw = newRawToken(Buffer.alloc(32, 7));
    expect(raw.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(looksLikeToken(raw)).toBe(true);
    expect(hashToken(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(raw)).not.toContain(raw.slice(4, 20));
    expect(newRawToken()).not.toBe(newRawToken());
    for (const bad of [undefined, "", "fct_short", `xyz_${raw.slice(4)}`, `${raw}!`]) expect(looksLikeToken(bad)).toBe(false);
  });

  it("lives 1 to 90 days, 30 by default", () => {
    expect(expiryFor(undefined, NOW).getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect(expiryFor(7, NOW).getTime()).toBe(NOW.getTime() + 7 * DAY);
    expect(expiryFor(365, NOW).getTime()).toBe(NOW.getTime() + MAX_TOKEN_DAYS * DAY);
    expect(expiryFor(0, NOW).getTime()).toBe(NOW.getTime() + DAY);
  });

  it("grants read, or read and draft; drafting never comes without reading", () => {
    expect([...parseScopes("read")]).toEqual(["read"]);
    expect([...parseScopes("read,draft")].sort()).toEqual(["draft", "read"]);
    expect([...parseScopes("draft")]).toEqual([]);
    expect([...parseScopes("admin,read")]).toEqual(["read"]);
  });

  it("is refused when unknown, revoked, expired, or its person is no longer active", () => {
    const row = { revokedAt: null, expiresAt: new Date(NOW.getTime() + DAY) };
    const active = { status: "active" };
    expect(tokenRefusal(row, active, NOW)).toBeNull();
    expect(tokenRefusal(null, active, NOW)).toMatch(/unknown/);
    expect(tokenRefusal({ ...row, revokedAt: NOW }, active, NOW)).toMatch(/revoked/);
    expect(tokenRefusal({ ...row, expiresAt: NOW }, active, NOW)).toMatch(/expired/);
    expect(tokenRefusal(row, { status: "deactivated" }, NOW)).toMatch(/no longer active/);
  });
});

describe("the server refuses to start", () => {
  const token = newRawToken();
  it("unless RBAC is enforced, the database is in WAL mode, and a token is given", () => {
    expect(startRefusal({ rbacMode: "enforce", journalMode: "wal", token })).toBeNull();
    expect(startRefusal({ rbacMode: undefined, journalMode: "wal", token })).toMatch(/FACTORY_RBAC_MODE/);
    expect(startRefusal({ rbacMode: "shadow", journalMode: "wal", token })).toMatch(/shadow mode/);
    expect(startRefusal({ rbacMode: "enforce", journalMode: "delete", token })).toMatch(/journal_mode=delete/);
    expect(startRefusal({ rbacMode: "enforce", journalMode: null, token })).toMatch(/journal_mode=unknown/);
    expect(startRefusal({ rbacMode: "enforce", journalMode: "wal", token: undefined })).toMatch(/FACTORY_MCP_TOKEN/);
  });
});

describe("limits", () => {
  it("at most 100 drafts a day", () => {
    expect(draftCapRefusal(DAILY_DRAFT_CAP - 1)).toBeNull();
    expect(draftCapRefusal(DAILY_DRAFT_CAP)).toMatch(/100 drafts today/);
    expect(startOfLocalDay(new Date(2026, 9, 1, 15, 30))).toEqual(new Date(2026, 9, 1));
  });

  it("at most N calls a minute per token, the window sliding", () => {
    const rate = new MinuteRate(2);
    expect(rate.take("t1", 0)).toBe(true);
    expect(rate.take("t1", 1_000)).toBe(true);
    expect(rate.take("t1", 2_000)).toBe(false);
    expect(rate.take("t2", 2_000)).toBe(true);
    expect(rate.take("t1", 60_001)).toBe(true);
  });
});
