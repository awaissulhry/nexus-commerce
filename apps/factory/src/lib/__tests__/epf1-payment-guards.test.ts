/**
 * EPF1 (D-02/D-03/D-11) — the payment guards: deposit-aware invoice default +
 * Σ invoices ≤ net cap, the Σ payments ≤ net overpay arithmetic, and the
 * REFUND rules (negative amount ONLY for REFUND, note mandatory).
 */
import { describe, expect, it } from "vitest";
import { resolveInvoiceAmount } from "../financials/invoice-policy";
import { overpayCents } from "../orders/money";
import { PaymentBody } from "../orders/payment-schema";

describe("resolveInvoiceAmount (D-02/D-03)", () => {
  it("defaults deposit-aware: net − paid", () => {
    expect(resolveInvoiceAmount(50000, 15000, 0)).toEqual({ ok: true, amountCents: 35000 });
  });
  it("no payments → full net", () => {
    expect(resolveInvoiceAmount(50000, 0, 0)).toEqual({ ok: true, amountCents: 50000 });
  });
  it("fully paid → nothing invoiceable (400), floored at 0 even when overpaid", () => {
    expect(resolveInvoiceAmount(50000, 50000, 0)).toMatchObject({ ok: false, reason: "nothing-invoiceable" });
    expect(resolveInvoiceAmount(50000, 60000, 0)).toMatchObject({ ok: false, reason: "nothing-invoiceable" });
  });
  it("explicit amount capped: Σ invoices ≤ net, with the remaining amount in the refusal", () => {
    expect(resolveInvoiceAmount(50000, 0, 30000, 30000)).toEqual({ ok: false, reason: "exceeds-net", remainingInvoiceableCents: 20000 });
    expect(resolveInvoiceAmount(50000, 0, 30000, 20000)).toEqual({ ok: true, amountCents: 20000 });
  });
  it("the DEFAULT is capped too: unpaid but fully invoiced order can't be re-invoiced", () => {
    expect(resolveInvoiceAmount(50000, 0, 50000)).toEqual({ ok: false, reason: "exceeds-net", remainingInvoiceableCents: 0 });
  });
});

describe("overpayCents (D-02/D-03)", () => {
  it("positive exactly when Σ payments would exceed net", () => {
    expect(overpayCents(80000, 10000, 70000)).toBe(0); // lands exactly on net
    expect(overpayCents(80000, 10000, 80000)).toBe(10000); // deposit double-count — the D-02 bug shape
    expect(overpayCents(80000, 0, 50000)).toBe(-30000);
  });
  it("refunds (negative amounts) can never overpay", () => {
    expect(overpayCents(80000, 80000, -20000)).toBeLessThan(0);
  });
});

describe("PaymentBody (D-11 REFUND rules)", () => {
  it("REFUND: negative amount + note = valid", () => {
    const r = PaymentBody.safeParse({ kind: "REFUND", amountCents: -5000, notes: "double payment returned" });
    expect(r.success).toBe(true);
  });
  it("REFUND: positive or zero amount rejected", () => {
    expect(PaymentBody.safeParse({ kind: "REFUND", amountCents: 5000, notes: "x" }).success).toBe(false);
    expect(PaymentBody.safeParse({ kind: "REFUND", amountCents: 0, notes: "x" }).success).toBe(false);
  });
  it("REFUND: missing note rejected (refunds must say why)", () => {
    const r = PaymentBody.safeParse({ kind: "REFUND", amountCents: -5000 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === "notes")).toBe(true);
  });
  it("non-refund kinds stay strictly positive", () => {
    expect(PaymentBody.safeParse({ kind: "DEPOSIT", amountCents: -100 }).success).toBe(false);
    expect(PaymentBody.safeParse({ kind: "BALANCE", amountCents: 0 }).success).toBe(false);
    expect(PaymentBody.safeParse({ kind: "DEPOSIT", amountCents: 100 }).success).toBe(true);
  });
  it("allowOverpay + idempotencyKey pass through", () => {
    const r = PaymentBody.safeParse({ kind: "BALANCE", amountCents: 100, allowOverpay: true, idempotencyKey: "abcdefgh" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.allowOverpay).toBe(true);
  });
});
