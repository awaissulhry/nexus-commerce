/**
 * EPO.3 — the connected one-timeline: every kind carries its hop where a
 * target exists, transitions name their driver + cancel reason, invoices and
 * promise changes join the thread, stage completions stay readable (per-stage
 * for small orders, per-WO roll-ups past STAGE_DETAIL_MAX_WOS).
 */
import { describe, expect, it } from "vitest";
import { buildTimeline, STAGE_DETAIL_MAX_WOS, type TimelineOrder } from "@/lib/orders/timeline";

const base: TimelineOrder = {
  number: "ORD-9",
  createdAt: "2026-07-01T10:00:00Z",
  party: { id: "p1" },
  payments: [],
  workOrders: [],
};

describe("hop-links (E2)", () => {
  it("workorder rows link to /production?wo=", () => {
    const ev = buildTimeline({ ...base, workOrders: [{ id: "w1", number: "ORD-9/1", createdAt: "2026-07-02T10:00:00Z", state: "READY", blockedReason: null }] });
    expect(ev.find((e) => e.kind === "workorder")?.href).toBe("/production?wo=w1");
  });
  it("payments/invoices/shipments hop page-level; reviews hop to the party", () => {
    const ev = buildTimeline({
      ...base,
      payments: [{ kind: "DEPOSIT", amountCents: 100, receivedAt: "2026-07-02T10:00:00Z" }],
      shipments: [{ id: "s1", createdAt: "2026-07-03T10:00:00Z" }],
      invoices: [{ id: "i1", number: "INV-1", amountCents: 500, createdAt: "2026-07-04T10:00:00Z" }],
      reviews: [{ id: "r1", createdAt: "2026-07-05T10:00:00Z" }],
    });
    expect(ev.find((e) => e.kind === "payment")?.href).toBe("/financials");
    expect(ev.find((e) => e.kind === "shipment")?.href).toBe("/shipping");
    expect(ev.find((e) => e.kind === "invoice")?.href).toBe("/financials");
    expect(ev.find((e) => e.kind === "review")?.href).toBe("/contacts?c=p1");
  });
});

describe("invoices join the thread", () => {
  it("issued and paid are separate moments", () => {
    const ev = buildTimeline({ ...base, invoices: [{ id: "i1", number: "INV-1", amountCents: 500, createdAt: "2026-07-04T10:00:00Z", paidAt: "2026-07-08T10:00:00Z" }] });
    const inv = ev.filter((e) => e.kind === "invoice");
    expect(inv.map((e) => e.label)).toEqual(["Invoice INV-1 issued", "Invoice INV-1 paid"]);
  });
});

describe("transitions carry driver + reason; promise changes render", () => {
  it("cancel reason survives to the label; via names the driver; reopen shows", () => {
    const ev = buildTimeline(base, [
      { entityType: "order", action: "state-changed", after: { to: "CANCELLED", via: "cancel", reason: "customer withdrew" }, createdAt: "2026-07-06T10:00:00Z" },
      { entityType: "order", action: "state-changed", after: { to: "CONFIRMED", via: "reopen" }, createdAt: "2026-07-07T10:00:00Z" },
      { entityType: "order", action: "state-changed", after: { to: "DELIVERED", via: "tracking" }, createdAt: "2026-07-08T10:00:00Z" },
    ]);
    const t = ev.filter((e) => e.kind === "transition").map((e) => e.label);
    expect(t).toContain("→ Cancelled — customer withdrew");
    expect(t).toContain("→ Reopened");
    expect(t).toContain("→ Delivered · carrier tracking");
  });
  it("plain CONFIRMED audit rows (pre-EPO.1, no via) stay hidden", () => {
    const ev = buildTimeline(base, [{ entityType: "order", action: "state-changed", after: { to: "CONFIRMED" }, createdAt: "2026-07-07T10:00:00Z" }]);
    expect(ev.filter((e) => e.kind === "transition")).toHaveLength(0);
  });
  it("promise-changed rows render with a fixed-locale date, cleared handled", () => {
    const ev = buildTimeline(base, [
      { entityType: "order", action: "promise-changed", after: { promiseDateAt: "2026-08-12T12:00:00Z" }, createdAt: "2026-07-06T10:00:00Z" },
      { entityType: "order", action: "promise-changed", after: { promiseDateAt: null }, createdAt: "2026-07-07T10:00:00Z" },
    ]);
    const p = ev.filter((e) => e.kind === "promise").map((e) => e.label);
    expect(p).toEqual(["Promise date → 12/08/2026", "Promise date cleared"]);
  });
});

describe("stage completions stay readable", () => {
  const wo = (n: number, done: boolean) => ({
    id: `w${n}`,
    number: `ORD-9/${n}`,
    createdAt: "2026-07-02T10:00:00Z",
    state: done ? "DONE" : "IN_PROGRESS",
    blockedReason: null,
    stages: [
      { stage: "CUTTING", finishedAt: `2026-07-0${(n % 5) + 3}T10:00:00Z` },
      { stage: "QC", finishedAt: done ? `2026-07-0${(n % 5) + 4}T10:00:00Z` : null },
    ],
  });
  it("small orders get per-stage rows", () => {
    const ev = buildTimeline({ ...base, workOrders: [wo(1, false)] });
    const s = ev.filter((e) => e.kind === "stage");
    expect(s).toHaveLength(1);
    expect(s[0].label).toBe("ORD-9/1 · Cutting finished");
  });
  it(`size-runs past ${STAGE_DETAIL_MAX_WOS} WOs roll up to per-WO completions`, () => {
    const many = Array.from({ length: STAGE_DETAIL_MAX_WOS + 2 }, (_, i) => wo(i + 1, i === 0));
    const ev = buildTimeline({ ...base, workOrders: many });
    const s = ev.filter((e) => e.kind === "stage");
    expect(s).toHaveLength(1); // only the DONE one rolls up
    expect(s[0].label).toBe("Work order ORD-9/1 completed");
  });
});
