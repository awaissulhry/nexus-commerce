/** F1 — field-level stripping: a Worker never sees money; an Owner sees all. */
import { describe, expect, it } from "vitest";
import { stripFinancials } from "../auth/strip-financials";
import type { Resolved } from "../auth/rbac";

const OWNER: Resolved = { isOwner: true, permissions: new Set() };
const WORKER: Resolved = { isOwner: false, permissions: new Set(["pages.production"]) };

const quote = {
  number: "Q-1",
  netPriceCents: 48000,
  costCents: 21000,
  marginCents: 27000,
  marginPct: 56.25,
  depositPct: 30,
  party: { name: "Mario", paymentTerms: "30 days" },
  lines: [{ description: "Suit", listPriceCents: 50000, adjustmentCents: -2000, adjustmentReason: "repeat customer" }],
};

describe("stripFinancials", () => {
  it("keeps everything for owners", () => {
    expect(stripFinancials(quote, OWNER)).toEqual(quote);
  });

  it("deletes (not nulls) money fields for a Worker, recursively", () => {
    const out = stripFinancials(quote, WORKER) as Record<string, unknown>;
    expect(out.number).toBe("Q-1");
    expect(out).not.toHaveProperty("netPriceCents");
    expect(out).not.toHaveProperty("costCents");
    expect(out).not.toHaveProperty("marginCents");
    expect(out).not.toHaveProperty("marginPct");
    expect(out).not.toHaveProperty("depositPct");
    const party = out.party as Record<string, unknown>;
    expect(party.name).toBe("Mario");
    expect(party).not.toHaveProperty("paymentTerms");
    const line = (out.lines as Record<string, unknown>[])[0];
    expect(line.description).toBe("Suit");
    expect(line).not.toHaveProperty("listPriceCents");
    expect(line).not.toHaveProperty("adjustmentCents");
    expect(line).not.toHaveProperty("adjustmentReason");
  });

  it("grants reveal exactly their grain", () => {
    const finance: Resolved = { isOwner: false, permissions: new Set(["financials.prices.view"]) };
    const out = stripFinancials(quote, finance) as Record<string, unknown>;
    expect(out).toHaveProperty("netPriceCents");
    expect(out).not.toHaveProperty("costCents");
    expect(out).not.toHaveProperty("marginPct");
  });

  it("null resolved (public callers) strips everything financial", () => {
    const out = stripFinancials(quote, null) as Record<string, unknown>;
    expect(out).not.toHaveProperty("netPriceCents");
  });

  it("Dates survive as Dates (regression: FP1 'Invalid Date' — a Date is an object with no enumerable keys)", () => {
    const when = new Date("2026-07-05T10:00:00Z");
    const out = stripFinancials({ sentAt: when, nested: { at: when }, list: [{ at: when }] }, WORKER) as {
      sentAt: Date;
      nested: { at: Date };
      list: { at: Date }[];
    };
    expect(out.sentAt).toBeInstanceOf(Date);
    expect(out.nested.at.getTime()).toBe(when.getTime());
    expect(out.list[0].at).toBeInstanceOf(Date);
  });
});
