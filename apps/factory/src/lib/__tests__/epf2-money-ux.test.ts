/**
 * EPF2.1 — money-page UX folds: the EU-safe amount parse (the defect was a
 * first-comma-only replace that turned `1.234,56` into garbage), the FD13
 * context-sensitive kind default, the last-12-months Rome window default, the
 * by-month drill window, and the by-order cursor codec.
 */
import { describe, expect, it } from "vitest";
import {
  parseAmountToCents,
  defaultPaymentKind,
  defaultWindowFrom,
  monthDayWindow,
  encodeOrderCursor,
  parseOrderCursor,
} from "../financials/money-ux";

describe("parseAmountToCents (EU-safe matrix)", () => {
  it("both separators: the LAST one is the decimal — IT and EN both correct", () => {
    expect(parseAmountToCents("1.234,56")).toBe(123456);
    expect(parseAmountToCents("1,234.56")).toBe(123456);
    expect(parseAmountToCents("1.234.567,89")).toBe(123456789);
    expect(parseAmountToCents("1,234,567.89")).toBe(123456789);
  });
  it("sole separator with 1–2 digits is the decimal", () => {
    expect(parseAmountToCents("1234,56")).toBe(123456);
    expect(parseAmountToCents("1234.56")).toBe(123456);
    expect(parseAmountToCents("1,5")).toBe(150);
    expect(parseAmountToCents("0.5")).toBe(50);
    expect(parseAmountToCents(",5")).toBe(50);
  });
  it("sole separator with a 3-digit tail is thousands grouping", () => {
    expect(parseAmountToCents("1.234")).toBe(123400);
    expect(parseAmountToCents("1,234")).toBe(123400);
    expect(parseAmountToCents("12.345.678")).toBe(1234567800);
  });
  it("plain integers, currency signs and spaces", () => {
    expect(parseAmountToCents("12")).toBe(1200);
    expect(parseAmountToCents("€ 12")).toBe(1200);
    expect(parseAmountToCents(" 1 234,56 ")).toBe(123456);
    expect(parseAmountToCents("0")).toBe(0);
  });
  it("sign is preserved (refund magnitudes are negated by the caller)", () => {
    expect(parseAmountToCents("-25,50")).toBe(-2550);
    expect(parseAmountToCents("+10")).toBe(1000);
  });
  it("garbage ⇒ null, never NaN", () => {
    for (const bad of ["", "   ", "abc", "12,3456", "1.234,5678", "12.34.56,7,8x", "€", "1e5", "--5"]) {
      expect(parseAmountToCents(bad)).toBeNull();
    }
  });
});

describe("defaultPaymentKind (FD13 context-sensitive)", () => {
  it("DEPOSIT while the gate is open", () => {
    expect(defaultPaymentKind({ depositRequiredCents: 30000, depositMet: false })).toBe("DEPOSIT");
  });
  it("BALANCE once the deposit is met or none is required", () => {
    expect(defaultPaymentKind({ depositRequiredCents: 30000, depositMet: true })).toBe("BALANCE");
    expect(defaultPaymentKind({ depositRequiredCents: 0, depositMet: false })).toBe("BALANCE");
  });
  it("grain-stripped caller (no deposit figures) falls back to BALANCE", () => {
    expect(defaultPaymentKind({ depositMet: false })).toBe("BALANCE");
  });
});

describe("defaultWindowFrom (last 12 Rome months)", () => {
  it("current month + 11 before it, from the 1st", () => {
    expect(defaultWindowFrom("2026-07-17T10:00:00.000Z")).toBe("2025-08-01");
    expect(defaultWindowFrom("2026-01-15T12:00:00.000Z")).toBe("2025-02-01");
  });
  it("Rome year boundary: 31 Dec 23:30Z is already January in Rome", () => {
    expect(defaultWindowFrom("2026-12-31T23:30:00.000Z")).toBe("2026-02-01");
    expect(defaultWindowFrom("2026-12-31T22:30:00.000Z")).toBe("2026-01-01");
  });
});

describe("monthDayWindow (by-month drill-through)", () => {
  it("first/last day incl. leap February and 30-day months", () => {
    expect(monthDayWindow("2026-07")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(monthDayWindow("2026-06")).toEqual({ from: "2026-06-01", to: "2026-06-30" });
    expect(monthDayWindow("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthDayWindow("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
  it("malformed ⇒ null", () => {
    expect(monthDayWindow("2026-13")).toBeNull();
    expect(monthDayWindow("garbage")).toBeNull();
  });
});

describe("order cursor codec", () => {
  it("round-trips", () => {
    const c = { createdAtISO: "2026-07-01T10:00:00.000Z", orderId: "ord~weird-id" };
    expect(parseOrderCursor(encodeOrderCursor(c))).toEqual({ createdAtISO: c.createdAtISO, orderId: c.orderId });
  });
  it("rejects malformed cursors", () => {
    expect(parseOrderCursor(null)).toBeNull();
    expect(parseOrderCursor("")).toBeNull();
    expect(parseOrderCursor("no-tilde")).toBeNull();
    expect(parseOrderCursor("not-a-date~id")).toBeNull();
    expect(parseOrderCursor("2026-07-01T10:00:00.000Z~")).toBeNull();
  });
});
