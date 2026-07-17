/**
 * EPF1 (D-01/D-12) — the export builders: VAT must be displayed on INVOICED
 * amounts (never on quoted net — the D-01 defect), invoice rows date/window by
 * issue date in Rome, and every financial column is dropped by its EXPLICIT
 * grain (prices vs margins) — the strip-by-column-grain matrix.
 */
import { describe, expect, it } from "vitest";
import { buildRows, invoiceColumns, orderColumns, visibleColumns, type InvoiceExportRow } from "../financials/export-rows";
import { orderFinancials, type FinOrder } from "../financials/rollup";

const inv: InvoiceExportRow = {
  number: "INV-2026-001",
  issuedAtISO: "2026-12-31T23:30:00.000Z", // Rome: 2027-01-01
  orderNumber: "ORD-9",
  partyName: "Alfa",
  amountCents: 70000, // a PARTIAL invoice — order net is larger
  sentAt: null,
  paidAt: null,
};

const fin = orderFinancials({
  id: "o", number: "ORD-9", partyId: "p", partyName: "Alfa", state: "DELIVERED", createdAtISO: "2026-07-01T10:00:00.000Z",
  lines: [{ netPriceCents: 100000, costCents: 40000, qty: 1 }],
  payments: [{ kind: "BALANCE", amountCents: 70000, receivedAtISO: "2026-07-02T10:00:00.000Z" }],
  invoices: [{ amountCents: 70000, paidAt: null, issuedAtISO: "2026-12-31T23:30:00.000Z", number: "INV-2026-001" }],
  actualCostCents: 45000,
  actualComplete: true,
} satisfies FinOrder);

const both = { prices: true, margins: true };

describe("invoice rows (VAT basis = invoiced)", () => {
  it("computes VAT on the INVOICED amount, not the order net", () => {
    const { headers, rows } = buildRows(invoiceColumns(22), [inv], both);
    const r = Object.fromEntries(headers.map((h, i) => [h, rows[0][i]]));
    expect(r["net (invoiced)"]).toBe("700.00");
    expect(r["vat (on invoiced)"]).toBe("154.00"); // 22% of 700 — NOT 22% of the 1000 order net
    expect(r["gross (invoiced)"]).toBe("854.00");
    expect(r["vat_rate"]).toBe("22%");
  });
  it("dates + months come from the ISSUE date in Rome (31 Dec 23:30Z → January)", () => {
    const { headers, rows } = buildRows(invoiceColumns(22), [inv], both);
    const r = Object.fromEntries(headers.map((h, i) => [h, rows[0][i]]));
    expect(r["issued (Rome date)"]).toBe("2027-01-01");
    expect(r["month (issue date · Rome)"]).toBe("2027-01");
    expect(r["status"]).toBe("draft");
  });
});

describe("strip-by-grain matrix (D-12)", () => {
  it("both grains → all columns; prices only → margins gone; margins only → money gone; none → identity only", () => {
    const all = visibleColumns(orderColumns(), both).map((c) => c.label);
    expect(all).toContain("quoted_net (order total)");
    expect(all).toContain("est_margin");

    const prices = visibleColumns(orderColumns(), { prices: true, margins: false }).map((c) => c.label);
    expect(prices).toContain("quoted_net (order total)");
    expect(prices.some((l) => l.includes("margin"))).toBe(false);

    const margins = visibleColumns(orderColumns(), { prices: false, margins: true }).map((c) => c.label);
    expect(margins).toContain("est_margin");
    expect(margins.some((l) => l.includes("quoted_net") || l.includes("paid") || l.includes("balance"))).toBe(false);

    const none = visibleColumns(orderColumns(), { prices: false, margins: false }).map((c) => c.label);
    expect(none).toEqual(["order", "customer", "month (order created · Rome)", "state"]);
  });
  it("the invoice section obeys the prices grain the same way", () => {
    const none = visibleColumns(invoiceColumns(22), { prices: false, margins: false }).map((c) => c.label);
    expect(none.some((l) => l.includes("net") || l.includes("vat") || l.includes("gross"))).toBe(false);
    expect(none).toContain("invoice");
  });
});

describe("per-order rollup rows", () => {
  it("labels each money column's basis and states the margin basis honestly", () => {
    const { headers, rows } = buildRows(orderColumns(), [fin], both);
    const r = Object.fromEntries(headers.map((h, i) => [h, rows[0][i]]));
    expect(r["quoted_net (order total)"]).toBe("1000.00");
    expect(r["invoiced (all invoices for the order)"]).toBe("700.00");
    expect(r["paid (all payments for the order)"]).toBe("700.00");
    expect(r["balance (net − paid)"]).toBe("300.00");
    expect(r["actual_margin"]).toBe("550.00"); // 1000 − 450
    expect(r["margin_basis"]).toBe("actual (all WOs done)");
  });
});
