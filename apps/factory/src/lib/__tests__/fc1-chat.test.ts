/**
 * FC1 — Order Spaces substrate contracts, pure (no DB): the cost-blind money
 * rule, ensureOrderSpace's name/membership builders, read-cursor unread math,
 * the windowed-query param grammar, the new permission registrations, and the
 * grain strip provably deleting moneyCents for non-grain callers.
 */
import { describe, expect, it } from "vitest";
import {
  MONEY_IN_BODY_RE,
  bodyCarriesMoney,
  buildOrderSpaceMembers,
  orderSpaceName,
  parseWindow,
  unreadMessageWhere,
} from "../chat/pure";
import { ALL_PERMISSIONS, FEATURES, PAGES, SYSTEM_ROLES, isValidPermission, permissionCatalog } from "../auth/permissions";
import { stripFinancials } from "../auth/strip-financials";
import type { Resolved } from "../auth/rbac";

// ── money-in-body rejection (the cost-blind law) ─────────────────

describe("bodyCarriesMoney", () => {
  it("flags the euro sign anywhere", () => {
    expect(bodyCarriesMoney("Deposit due: 120 €")).toBe(true);
    expect(bodyCarriesMoney("€ arrived")).toBe(true);
  });

  it("flags EUR as a word", () => {
    expect(bodyCarriesMoney("balance is EUR 300")).toBe(true);
    expect(bodyCarriesMoney("send 300 EUR today")).toBe(true);
  });

  it("flags decimal-amount-plus-euro shapes", () => {
    expect(bodyCarriesMoney("Total 1.234,50 €")).toBe(true);
    expect(bodyCarriesMoney("12.50€")).toBe(true);
  });

  it("does not flag money-free production talk", () => {
    expect(bodyCarriesMoney("Cut the AAA hide for ORD-214, stitch by Friday")).toBe(false);
    expect(bodyCarriesMoney("shoulder measures 12,50 cm")).toBe(false); // decimals without € are fine
    expect(bodyCarriesMoney("EUROPE shipment left")).toBe(false); // \bEUR\b does not match inside EUROPE
  });

  it("regex is the spec's exact grammar", () => {
    expect(MONEY_IN_BODY_RE.source).toBe("€|\\bEUR\\b|\\d+[.,]\\d{2}\\s*€");
  });
});

// ── ensureOrderSpace idempotency contract (pure builders) ────────

describe("ensureOrderSpace builders", () => {
  it("system-names the space ORD-n · Party", () => {
    expect(orderSpaceName("ORD-214", "Rossi Leather")).toBe("ORD-214 · Rossi Leather");
  });

  it("members = active owners, deduped, all MANAGER", () => {
    expect(buildOrderSpaceMembers(["u1", "u2", "u1"])).toEqual([
      { userId: "u1", role: "MANAGER" },
      { userId: "u2", role: "MANAGER" },
    ]);
  });

  it("is deterministic — same input, same shape (the idempotency contract)", () => {
    const a = buildOrderSpaceMembers(["a", "b"]);
    const b = buildOrderSpaceMembers(["a", "b"]);
    expect(a).toEqual(b);
    expect(buildOrderSpaceMembers([])).toEqual([]);
  });
});

// ── read-cursor unread math ──────────────────────────────────────

describe("unreadMessageWhere", () => {
  it("no cursor = everything in the space is unread (no createdAt bound)", () => {
    const where = unreadMessageWhere("s1", "me", null);
    expect(where).toEqual({
      spaceId: "s1",
      deletedAt: null,
      threadRootId: null,
      OR: [{ authorId: null }, { authorId: { not: "me" } }],
    });
    expect(where).not.toHaveProperty("createdAt");
  });

  it("FC3 — counts the MAIN stream only (thread replies notify their audience, not the space badge)", () => {
    expect(unreadMessageWhere("s1", "me", null).threadRootId).toBeNull();
  });

  it("with a cursor, only strictly-newer messages count", () => {
    const at = new Date("2026-07-16T10:00:00Z");
    expect(unreadMessageWhere("s1", "me", at).createdAt).toEqual({ gt: at });
  });

  it("excludes own messages but keeps system-authored (authorId null) ones", () => {
    const or = unreadMessageWhere("s1", "me", null).OR;
    expect(or).toContainEqual({ authorId: null });
    expect(or).toContainEqual({ authorId: { not: "me" } });
  });

  it("soft-deleted messages never count as unread", () => {
    expect(unreadMessageWhere("s1", "me", null).deletedAt).toBeNull();
  });
});

// ── windowed-query param grammar ─────────────────────────────────

describe("parseWindow", () => {
  it("defaults to the newest window of 100", () => {
    expect(parseWindow({})).toEqual({ before: null, take: 100 });
    expect(parseWindow({ before: null, take: null })).toEqual({ before: null, take: 100 });
  });

  it("clamps take to [1, 100]", () => {
    expect(parseWindow({ take: "500" }).take).toBe(100);
    expect(parseWindow({ take: "0" }).take).toBe(1);
    expect(parseWindow({ take: "-5" }).take).toBe(1);
    expect(parseWindow({ take: "37" }).take).toBe(37);
    expect(parseWindow({ take: "37.9" }).take).toBe(37);
  });

  it("non-numeric take falls back to the default", () => {
    expect(parseWindow({ take: "abc" }).take).toBe(100);
    expect(parseWindow({ take: "" }).take).toBe(100);
  });

  it("before is a trimmed message-id anchor or null", () => {
    expect(parseWindow({ before: " msg1 " }).before).toBe("msg1");
    expect(parseWindow({ before: "" }).before).toBeNull();
    expect(parseWindow({ before: "   " }).before).toBeNull();
  });
});

// ── permission registrations ─────────────────────────────────────

describe("FC1 permissions", () => {
  it("registers the chat page and the three chat features", () => {
    expect(PAGES.chat).toBe("pages.chat");
    expect(FEATURES.chatPost).toBe("chat.post");
    expect(FEATURES.chatSpacesCreate).toBe("chat.spaces.create");
    expect(FEATURES.chatSpacesManage).toBe("chat.spaces.manage");
    for (const p of ["pages.chat", "chat.post", "chat.spaces.create", "chat.spaces.manage"]) {
      expect(isValidPermission(p)).toBe(true);
    }
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length); // still no duplicates
  });

  it("WORKER gains pages.chat + chat.post and nothing more (substrate Q4)", () => {
    const worker = SYSTEM_ROLES.WORKER.permissions;
    expect(worker).toContain(PAGES.chat);
    expect(worker).toContain(FEATURES.chatPost);
    expect(worker).not.toContain(FEATURES.chatSpacesCreate);
    expect(worker).not.toContain(FEATURES.chatSpacesManage);
  });

  it("permissionCatalog picks the new keys up automatically", () => {
    const catalog = permissionCatalog();
    const pages = catalog.find((g) => g.module === "pages")!.items.map((i) => i.key);
    const features = catalog.find((g) => g.module === "features")!.items.map((i) => i.key);
    expect(pages).toContain("pages.chat");
    expect(features).toEqual(expect.arrayContaining(["chat.post", "chat.spaces.create", "chat.spaces.manage"]));
  });
});

// ── grain rule: moneyCents strips for non-grain callers ──────────

describe("chat message grain strip", () => {
  const OWNER: Resolved = { isOwner: true, permissions: new Set() };
  const WORKER: Resolved = { isOwner: false, permissions: new Set(["pages.chat", "chat.post"]) };
  const message = {
    id: "m1",
    kind: "SYSTEM",
    body: "Deposit received for ORD-214",
    moneyCents: 45000,
    moneyLabel: "Deposit",
    meta: { entityType: "order", entityId: "o1", event: "payment.recorded" },
  };

  it("deletes moneyCents (not nulls it) for a Worker; words and label survive", () => {
    const out = stripFinancials({ items: [message] }, WORKER) as { items: Record<string, unknown>[] };
    expect(out.items[0]).not.toHaveProperty("moneyCents");
    expect(out.items[0].body).toBe("Deposit received for ORD-214");
    expect(out.items[0].moneyLabel).toBe("Deposit");
    expect(out.items[0].meta).toEqual(message.meta);
  });

  it("keeps moneyCents for the Owner (client formats it AFTER the strip)", () => {
    const out = stripFinancials({ items: [message] }, OWNER) as { items: Record<string, unknown>[] };
    expect(out.items[0].moneyCents).toBe(45000);
  });
});
