/**
 * EPO.2 — the ONE payment badge per row: coarse status vocabulary derived from
 * the same fold numbers the grain strip governs (stripped caller ⇒ no badge).
 */
import { describe, expect, it } from "vitest";
import { paymentBadge } from "@/lib/orders/money";

const base = { netCents: 100_00, balanceCents: 100_00, invoicedCents: 0, depositRequiredCents: 0, depositPaidCents: 0 };

describe("paymentBadge", () => {
  it("stripped or empty ⇒ no badge", () => {
    expect(paymentBadge({})).toBeNull();
    expect(paymentBadge({ netCents: undefined, balanceCents: 5 })).toBeNull();
    expect(paymentBadge({ ...base, netCents: 0, balanceCents: 0 })).toBeNull();
  });
  it("settled ⇒ paid (overpayment too)", () => {
    expect(paymentBadge({ ...base, balanceCents: 0 })).toBe("paid");
    expect(paymentBadge({ ...base, balanceCents: -5_00 })).toBe("paid");
  });
  it("deposit due beats invoiced (the gate is the actionable fact)", () => {
    expect(paymentBadge({ ...base, depositRequiredCents: 30_00, depositPaidCents: 0, invoicedCents: 50_00 })).toBe("deposit-due");
    expect(paymentBadge({ ...base, depositRequiredCents: 30_00, depositPaidCents: 10_00 })).toBe("deposit-due");
  });
  it("invoiced once the deposit is satisfied", () => {
    expect(paymentBadge({ ...base, balanceCents: 70_00, depositRequiredCents: 30_00, depositPaidCents: 30_00, invoicedCents: 100_00 })).toBe("invoiced");
  });
  it("deposit paid, nothing invoiced yet", () => {
    expect(paymentBadge({ ...base, balanceCents: 70_00, depositRequiredCents: 30_00, depositPaidCents: 30_00 })).toBe("deposit-paid");
  });
  it("no deposit terms, nothing invoiced, balance open ⇒ unpaid", () => {
    expect(paymentBadge(base)).toBe("unpaid");
  });
});
