/** EPI1 — pure cores of the perfection sweep: patch semantics (the
 * stranded-SNOOZED fix), the shared list WHERE builder (filter-honest tab
 * counts), and forwarded-attachment dedupe. */
import { describe, expect, it } from "vitest";
import { resolveConversationPatch } from "@/lib/inbox/patch";
import { buildListWhere } from "@/lib/inbox/list-where";
import { repeatedAttachmentIds } from "@/lib/inbox/attachments";

describe("resolveConversationPatch", () => {
  it("clearing the wake date while SNOOZED reopens (G2 stranded-SNOOZED fix)", () => {
    const r = resolveConversationPatch("SNOOZED", { snoozeUntil: null });
    expect(r).toEqual({ ok: true, data: { snoozeUntil: null, state: "OPEN" } });
  });

  it("clearing the wake date while OPEN/CLOSED leaves state alone", () => {
    for (const s of ["OPEN", "CLOSED"] as const) {
      const r = resolveConversationPatch(s, { snoozeUntil: null });
      expect(r).toEqual({ ok: true, data: { snoozeUntil: null } });
    }
  });

  it("an explicit state in the same patch wins over the clear-reopen rule", () => {
    const r = resolveConversationPatch("SNOOZED", { snoozeUntil: null, state: "CLOSED" });
    expect(r.ok && r.data.state).toBe("CLOSED");
    expect(r.ok && r.data.snoozeUntil).toBeNull();
  });

  it("setting a wake date forces SNOOZED", () => {
    const r = resolveConversationPatch("OPEN", { snoozeUntil: "2026-08-01T08:00:00.000Z" });
    expect(r.ok && r.data.state).toBe("SNOOZED");
    expect(r.ok && (r.data.snoozeUntil as Date).toISOString()).toBe("2026-08-01T08:00:00.000Z");
  });

  it("SNOOZED without a wake date is refused", () => {
    const r = resolveConversationPatch("OPEN", { state: "SNOOZED" });
    expect(r).toEqual({ ok: false, error: "Snoozing needs a wake date" });
  });

  it("closing nulls any snooze; assignee/follow-up pass through", () => {
    const r = resolveConversationPatch("SNOOZED", { state: "CLOSED", assigneeId: "u1", followUpAt: null });
    expect(r.ok && r.data).toEqual({ state: "CLOSED", snoozeUntil: null, assigneeId: "u1", followUpAt: null });
  });
});

describe("buildListWhere", () => {
  it("base carries every filter except state; where adds state", () => {
    const { base, where } = buildListWhere({ state: "OPEN", mine: true, unmatched: true, q: "Boot", actorId: "me" });
    expect(base).toEqual({
      assigneeId: "me",
      partyId: null,
      OR: [
        { subject: { contains: "Boot" } },
        { party: { name: { contains: "Boot" } } },
        { messages: { some: { fromAddress: { contains: "boot" } } } },
      ],
    });
    expect(where).toEqual({ ...base, state: "OPEN" });
  });

  it("ALL omits the state clause; no filters → empty base", () => {
    const { base, where } = buildListWhere({ state: "ALL", mine: false, unmatched: false, q: "", actorId: "me" });
    expect(base).toEqual({});
    expect(where).toEqual({});
  });
});

describe("repeatedAttachmentIds", () => {
  const att = (id: string, filename: string, sizeBytes: number | null) => ({ id, filename, sizeBytes });

  it("flags same filename+size on a LATER message; first occurrence stays fresh", () => {
    const repeated = repeatedAttachmentIds([
      { attachments: [att("a1", "suit.pdf", 100), att("a2", "photo.jpeg", 200)] },
      { attachments: [att("a3", "suit.pdf", 100), att("a4", "new.pdf", 300)] },
    ]);
    expect(repeated).toEqual(new Set(["a3"]));
  });

  it("same name with a different size is NOT a repeat; null sizes only match null", () => {
    const repeated = repeatedAttachmentIds([
      { attachments: [att("a1", "suit.pdf", 100), att("a2", "scan.pdf", null)] },
      { attachments: [att("a3", "suit.pdf", 999), att("a4", "scan.pdf", null)] },
    ]);
    expect(repeated).toEqual(new Set(["a4"]));
  });

  it("duplicate within one message counts as a repeat of the first", () => {
    const repeated = repeatedAttachmentIds([{ attachments: [att("a1", "x.png", 5), att("a2", "x.png", 5)] }]);
    expect(repeated).toEqual(new Set(["a2"]));
  });
});
