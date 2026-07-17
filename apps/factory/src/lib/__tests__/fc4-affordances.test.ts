/**
 * FC4 — presence & message affordances, pure contracts (no DB, no DOM):
 * reaction grouping + optimistic toggle math, the read-receipt placement
 * rule (who sits under which message) + the 5-avatar stack, the typing
 * state machine (upsert/prune/label) + the ≤1-per-2s publish throttle, the
 * presence-set fold, and the ephemeral-event contract (id 0 → never
 * dupe-skipped, never resumed, scope still honored).
 */
import { describe, expect, it } from "vitest";
import {
  MORE_REACTIONS,
  QUICK_REACTIONS,
  RECEIPT_STACK_MAX,
  TYPING_THROTTLE_MS,
  TYPING_TTL_MS,
  buildReceiptMap,
  foldPresence,
  groupReactions,
  reactionNames,
  receiptStack,
  shouldPublishTyping,
  toggleReaction,
  typingLabel,
  typingPrune,
  typingUpsert,
  type SpaceMember,
  type StreamMessage,
  type Typist,
} from "../chat/ui";
import { ephemeralEvent, shouldDeliver } from "../events";

// ── helpers ──────────────────────────────────────────────────────

const msg = (id: string, createdAt: string, extra?: Partial<StreamMessage>): StreamMessage => ({
  id,
  authorId: "author",
  authorName: "Author",
  kind: "MESSAGE",
  body: `body ${id}`,
  createdAt,
  ...extra,
});

const member = (id: string, name: string, cursor: string | null, at: string | null): SpaceMember => ({
  id,
  displayName: name,
  email: `${id}@x.it`,
  lastReadMessageId: cursor,
  lastReadAt: at,
});

// ── reactions: grouping + toggle math ────────────────────────────

describe("groupReactions", () => {
  it("groups by emoji in first-seen order with counts and mine", () => {
    const groups = groupReactions(
      [
        { userId: "u1", emoji: "👍" },
        { userId: "u2", emoji: "🎉" },
        { userId: "me", emoji: "👍" },
        { userId: "u3", emoji: "👍" },
      ],
      "me",
    );
    expect(groups.map((g) => g.emoji)).toEqual(["👍", "🎉"]); // earliest emoji keeps the leftmost pill
    expect(groups[0]).toMatchObject({ count: 3, mine: true, userIds: ["u1", "me", "u3"] });
    expect(groups[1]).toMatchObject({ count: 1, mine: false });
  });

  it("empty/undefined → no pills; duplicate rows collapse", () => {
    expect(groupReactions(undefined, "me")).toEqual([]);
    expect(groupReactions([], "me")).toEqual([]);
    const dupes = groupReactions(
      [
        { userId: "u1", emoji: "👍" },
        { userId: "u1", emoji: "👍" },
      ],
      null,
    );
    expect(dupes[0].count).toBe(1);
  });

  it("a null viewer never owns a pill", () => {
    const g = groupReactions([{ userId: "me", emoji: "👍" }], null);
    expect(g[0].mine).toBe(false);
  });
});

describe("toggleReaction", () => {
  it("adds when absent, removes when present — a round trip is identity", () => {
    const start = [{ userId: "u1", emoji: "👍" }];
    const on = toggleReaction(start, "me", "👍");
    expect(on.added).toBe(true);
    expect(on.next).toHaveLength(2);
    const off = toggleReaction(on.next, "me", "👍");
    expect(off.added).toBe(false);
    expect(off.next).toEqual(start);
  });

  it("only the viewer's own row toggles; same emoji from others survives", () => {
    const { next } = toggleReaction(
      [
        { userId: "u1", emoji: "❤️" },
        { userId: "me", emoji: "❤️" },
      ],
      "me",
      "❤️",
    );
    expect(next).toEqual([{ userId: "u1", emoji: "❤️" }]);
  });

  it("different emoji from the same viewer coexist", () => {
    const { next, added } = toggleReaction([{ userId: "me", emoji: "👍" }], "me", "🎉");
    expect(added).toBe(true);
    expect(next).toHaveLength(2);
  });
});

describe("reactionNames + curated lists", () => {
  const members = [member("u1", "Marco Rossi", null, null), member("me", "Awais S", null, null)];

  it("You leads when the viewer reacted; unknowns degrade to Someone", () => {
    expect(reactionNames(["u1", "me", "ghost"], "me", members)).toEqual(["You", "Marco Rossi", "Someone"]);
    expect(reactionNames(["u1"], "me", members)).toEqual(["Marco Rossi"]);
  });

  it("quick row is 8, more grid is 24, disjoint, all unique", () => {
    expect(QUICK_REACTIONS).toHaveLength(8);
    expect(MORE_REACTIONS).toHaveLength(24);
    const all = [...QUICK_REACTIONS, ...MORE_REACTIONS];
    expect(new Set(all).size).toBe(all.length);
  });
});

// ── read receipts: who sits under which message ──────────────────

describe("buildReceiptMap", () => {
  const stream = [
    msg("m1", "2026-07-17T10:00:00.000Z"),
    msg("m2", "2026-07-17T10:05:00.000Z"),
    msg("m3", "2026-07-17T10:10:00.000Z"),
  ];

  it("an in-window cursor seats the reader under that exact message", () => {
    const map = buildReceiptMap(stream, [member("u1", "Marco", "m2", "2026-07-17T10:05:00.000Z")], "me");
    expect(map.get("m2")).toEqual([{ id: "u1", name: "Marco" }]);
    expect(map.size).toBe(1);
  });

  it("a cursor on a thread reply (off-stream) seats under the newest message at-or-before its time", () => {
    const map = buildReceiptMap(stream, [member("u1", "Marco", "reply-x", "2026-07-17T10:07:00.000Z")], "me");
    expect(map.get("m2")).toEqual([{ id: "u1", name: "Marco" }]); // m3 is later than the cursor
  });

  it("a cursor newer than everything seats under the newest message", () => {
    const map = buildReceiptMap(stream, [member("u1", "Marco", "reply-x", "2026-07-17T11:00:00.000Z")], "me");
    expect(map.get("m3")).toEqual([{ id: "u1", name: "Marco" }]);
  });

  it("own avatar never shows to self; no cursor renders nothing", () => {
    const map = buildReceiptMap(
      stream,
      [member("me", "Me", "m3", "2026-07-17T10:10:00.000Z"), member("u2", "Anna", null, null)],
      "me",
    );
    expect(map.size).toBe(0);
  });

  it("a cursor older than the loaded window renders nothing (reader is off-screen)", () => {
    const map = buildReceiptMap(stream, [member("u1", "Marco", "ancient", "2026-07-17T09:00:00.000Z")], "me");
    expect(map.size).toBe(0);
  });

  it("pending optimistic rows are never placement targets", () => {
    const withPending = [...stream, msg("tmp-1", "2026-07-17T10:20:00.000Z", { pending: true })];
    const map = buildReceiptMap(withPending, [member("u1", "Marco", "x", "2026-07-17T10:30:00.000Z")], "me");
    expect(map.get("m3")).toBeDefined();
    expect(map.get("tmp-1")).toBeUndefined();
  });

  it("several readers stack under the same message", () => {
    const map = buildReceiptMap(
      stream,
      [
        member("u1", "Marco", "m3", "2026-07-17T10:10:00.000Z"),
        member("u2", "Anna", "m3", "2026-07-17T10:10:00.000Z"),
      ],
      "me",
    );
    expect(map.get("m3")).toHaveLength(2);
  });

  it("an empty stream renders nothing", () => {
    expect(buildReceiptMap([], [member("u1", "Marco", "m1", "2026-07-17T10:00:00.000Z")], "me").size).toBe(0);
  });
});

describe("receiptStack", () => {
  const readers = Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, name: `User ${i}` }));

  it("caps at 5 + extra count", () => {
    const { shown, extra } = receiptStack(readers);
    expect(shown).toHaveLength(RECEIPT_STACK_MAX);
    expect(extra).toBe(3);
  });

  it("at or under the cap shows everyone, no extra", () => {
    expect(receiptStack(readers.slice(0, 5))).toEqual({ shown: readers.slice(0, 5), extra: 0 });
    expect(receiptStack([])).toEqual({ shown: [], extra: 0 });
  });
});

// ── typing: the ephemeral state machine + throttle ───────────────

describe("typing state machine", () => {
  const t0 = 1_000_000;

  it("upsert replaces the same user's entry and prunes stale peers in one pass", () => {
    let list: Typist[] = [];
    list = typingUpsert(list, { userId: "u1", name: "Marco" }, t0);
    list = typingUpsert(list, { userId: "u2", name: "Anna" }, t0 + 1000);
    list = typingUpsert(list, { userId: "u1", name: "Marco" }, t0 + 2000);
    expect(list).toHaveLength(2);
    expect(list.find((t) => t.userId === "u1")?.at).toBe(t0 + 2000);
    // u2 went quiet: TTL later their entry evaporates on the next upsert
    list = typingUpsert(list, { userId: "u3", name: "Pia" }, t0 + 1000 + TYPING_TTL_MS);
    expect(list.map((t) => t.userId).sort()).toEqual(["u1", "u3"]);
  });

  it("prune drops expired entries and keeps the SAME reference when nothing expired", () => {
    const list = typingUpsert([], { userId: "u1", name: "Marco" }, t0);
    expect(typingPrune(list, t0 + TYPING_TTL_MS - 1)).toBe(list); // render stability
    expect(typingPrune(list, t0 + TYPING_TTL_MS)).toEqual([]); // fades after 4s
  });

  it("label: one, two, many — self excluded, first names only", () => {
    const at = t0;
    const one: Typist[] = [{ userId: "u1", name: "Marco Rossi", at }];
    const two: Typist[] = [...one, { userId: "u2", name: "Anna B", at }];
    const many: Typist[] = [...two, { userId: "u3", name: "Pia", at }, { userId: "u4", name: "Gio", at }];
    expect(typingLabel(one, "me")).toBe("Marco is typing…");
    expect(typingLabel(two, "me")).toBe("Marco and Anna are typing…");
    expect(typingLabel(many, "me")).toBe("Marco, Anna and 2 more are typing…");
    expect(typingLabel(one, "u1")).toBeNull(); // never announce yourself
    expect(typingLabel([], "me")).toBeNull();
  });

  it("throttle gate: at most one publish per window", () => {
    expect(shouldPublishTyping(0, t0)).toBe(true);
    expect(shouldPublishTyping(t0, t0 + TYPING_THROTTLE_MS - 1)).toBe(false);
    expect(shouldPublishTyping(t0, t0 + TYPING_THROTTLE_MS)).toBe(true);
  });
});

// ── presence: the online-set fold ────────────────────────────────

describe("foldPresence", () => {
  it("valid payload replaces the set, deduped and sorted", () => {
    expect(foldPresence(["z"], { online: ["b", "a", "b"] })).toEqual(["a", "b"]);
    expect(foldPresence(["a"], { online: [] })).toEqual([]); // everyone left
  });

  it("junk never blanks the dots — the current set survives", () => {
    const current = ["u1"];
    expect(foldPresence(current, undefined)).toBe(current);
    expect(foldPresence(current, null)).toBe(current);
    expect(foldPresence(current, { online: "nope" })).toBe(current);
    expect(foldPresence(current, "junk")).toBe(current);
  });

  it("non-string entries are dropped, not fatal", () => {
    expect(foldPresence([], { online: ["a", 42, "", null, "b"] })).toEqual(["a", "b"]);
  });
});

// ── the ephemeral-event contract (events.ts FC4 amendment) ───────

describe("ephemeralEvent contract", () => {
  it("carries id 0 — never a resume cursor, never dupe-skipped", () => {
    const e = ephemeralEvent("chat.typing", { spaceId: "s1" });
    expect(e.id).toBe(0);
    expect(e.type).toBe("chat.typing");
    // a connection far ahead in the outbox still receives it
    expect(shouldDeliver({ userId: "u1", lastId: 999_999 }, e)).toBe("send");
  });

  it("scope still targets delivery", () => {
    const scoped = ephemeralEvent("chat.presence", { online: [] }, { userId: "u1" });
    expect(shouldDeliver({ userId: "u1", lastId: 0 }, scoped)).toBe("send");
    expect(shouldDeliver({ userId: "other", lastId: 0 }, scoped)).toBe("skip-scope");
  });
});
