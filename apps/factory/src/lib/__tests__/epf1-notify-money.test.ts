/**
 * EPF1 (D-18 partial, M3) — money bells: targets/links/wording are pinned
 * here; the recipient set (every active OWNER) rides EPQ's shipped
 * `notifyOwners` broadcast, which these payloads are spread into.
 */
import { describe, expect, it } from "vitest";
import { paymentRecordedNotice, invoicePaidNotice } from "../financials/notify-money";

describe("paymentRecordedNotice", () => {
  it("deep-links the order and carries the amount", () => {
    const n = paymentRecordedNotice({ orderId: "o1", orderNumber: "ORD-7", paymentId: "p1", amountCents: 123450, kind: "DEPOSIT" });
    expect(n.href).toBe("/orders?o=o1");
    expect(n.title).toBe("Payment €1234.50 recorded on ORD-7");
    expect(n.entityType).toBe("payment");
    expect(n.entityId).toBe("p1");
    expect(n.kind).toBe("STATE_CHANGE");
  });
  it("refunds read as refunds (negative amount rendered absolute)", () => {
    const n = paymentRecordedNotice({ orderId: "o1", orderNumber: "ORD-7", paymentId: "p2", amountCents: -5000, kind: "REFUND" });
    expect(n.title).toBe("Refund €50.00 recorded on ORD-7");
    expect(n.body).toContain("REFUND");
  });
  it("bank-import provenance lands in the body", () => {
    const n = paymentRecordedNotice({ orderId: "o1", orderNumber: "ORD-7", paymentId: "p3", amountCents: 100, kind: "BALANCE", via: "bank-import" });
    expect(n.body).toBe("BALANCE · bank import");
  });
});

describe("invoicePaidNotice", () => {
  it("names the Fattura, links the order", () => {
    const n = invoicePaidNotice({ orderId: "o9", invoiceId: "i1", invoiceNumber: "INV-2026-003", amountCents: 80000 });
    expect(n.title).toBe("Fattura INV-2026-003 marked paid — €800.00");
    expect(n.href).toBe("/orders?o=o9");
    expect(n.entityType).toBe("invoice");
    expect(n.entityId).toBe("i1");
  });
});
