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

  it("a preview payload loses ALL money for a no-grains caller but keeps structure (FP2.4)", () => {
    const preview = {
      resolvedBaseCents: 40000,
      listPriceCents: 52000,
      costCents: 29000,
      netPriceCents: 52000,
      marginCents: 23000,
      marginPct: 44.2,
      lines: [{ label: "Base", priceCents: 40000, costCents: 21000, source: "template-base" }],
      materials: [{ materialId: "m1", name: "Kangaroo hide", qty: 2.5, unit: "SQM" }],
      violations: [{ kind: "EXCLUDES", severity: "BLOCK", message: "x" }],
    };
    const out = stripFinancials(preview, WORKER) as Record<string, unknown>;
    for (const k of ["resolvedBaseCents", "listPriceCents", "costCents", "netPriceCents", "marginCents", "marginPct"]) {
      expect(out).not.toHaveProperty(k);
    }
    const line = (out.lines as Record<string, unknown>[])[0];
    expect(line).not.toHaveProperty("priceCents");
    expect(line).not.toHaveProperty("costCents");
    expect(line.source).toBe("template-base"); // structure survives
    expect((out.materials as { name: string }[])[0].name).toBe("Kangaroo hide"); // no money → kept
    expect((out.violations as { message: string }[])[0].message).toBe("x");
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
