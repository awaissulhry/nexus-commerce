/**
 * FP9.3 — bank matching is the risky bit (it moves money into orders), so it's
 * pure and tested: reference beats amount, ambiguity stays unmatched, and the
 * neutral CSV parses Italian-style amounts.
 */
import { describe, expect, it } from "vitest";
import { matchBankRow, matchBankRows, parseBankCsv, type MatchTarget } from "../financials/bank-match";

const targets: MatchTarget[] = [
  { orderId: "o1", number: "ORD-5", partyName: "Alfa", balanceCents: 50000, invoiceNumbers: ["INV-3"] },
  { orderId: "o2", number: "ORD-6", partyName: "Beta", balanceCents: 50000, invoiceNumbers: [] }, // same balance → amount is ambiguous
  { orderId: "o3", number: "ORD-7", partyName: "Gamma", balanceCents: 32000, invoiceNumbers: [] },
];

describe("matchBankRow", () => {
  it("an ORD/INV reference in the description is a high-confidence match", () => {
    expect(matchBankRow({ date: "d", amountCents: 50000, description: "Bonifico ORD-5 saldo" }, targets)).toMatchObject({ orderId: "o1", confidence: "high" });
    expect(matchBankRow({ date: "d", amountCents: 12345, description: "pagamento INV-3" }, targets)).toMatchObject({ orderId: "o1", confidence: "high" });
  });
  it("an exact amount to a single open balance is medium", () => {
    expect(matchBankRow({ date: "d", amountCents: 32000, description: "bonifico cliente" }, targets)).toMatchObject({ orderId: "o3", confidence: "medium" });
  });
  it("ambiguous or unknown amounts stay unmatched", () => {
    expect(matchBankRow({ date: "d", amountCents: 50000, description: "no ref" }, targets)).toMatchObject({ orderId: null, confidence: "none" });
    expect(matchBankRow({ date: "d", amountCents: 99999, description: "random" }, targets).confidence).toBe("none");
  });
  it("maps over rows", () => {
    expect(matchBankRows([{ date: "d", amountCents: 32000, description: "x" }], targets)).toHaveLength(1);
  });
  it("EPF1 (D-10): a reference to a settled order is flagged zeroBalance, not silently re-proposed", () => {
    const ts: MatchTarget[] = [{ orderId: "s", number: "ORD-8", partyName: "Set", balanceCents: 0, invoiceNumbers: ["INV-2026-002"] }];
    const m = matchBankRow({ date: "d", amountCents: 12000, description: "Bonifico INV-2026-002" }, ts);
    expect(m).toMatchObject({ orderId: "s", confidence: "high", zeroBalance: true });
    expect(m.reason).toContain("no open balance");
    // an open-balance reference stays un-flagged
    expect(matchBankRow({ date: "d", amountCents: 500, description: "ORD-5" }, targets).zeroBalance).toBeUndefined();
  });
  it("token-matches any numbering scheme and respects boundaries (ORD-1 ≠ ORD-12)", () => {
    const ts: MatchTarget[] = [
      { orderId: "z", number: "ZZ-BANK-1", partyName: "Z", balanceCents: 40000, invoiceNumbers: [] },
      { orderId: "a", number: "ORD-1", partyName: "A", balanceCents: 11100, invoiceNumbers: [] },
      { orderId: "b", number: "ORD-12", partyName: "B", balanceCents: 22200, invoiceNumbers: [] },
    ];
    expect(matchBankRow({ date: "d", amountCents: 40000, description: "Bonifico ZZ-BANK-1 saldo" }, ts)).toMatchObject({ orderId: "z", confidence: "high" });
    expect(matchBankRow({ date: "d", amountCents: 500, description: "pagamento ORD-12" }, ts)).toMatchObject({ orderId: "b", confidence: "high" });
  });
});

describe("parseBankCsv", () => {
  it("parses Italian-style amounts (comma decimal, € and thousands)", () => {
    const rows = parseBankCsv('date,amount,description\n2026-07-01,"500,00","ORD-5 saldo"\n2026-07-02,"€ 1.234,56",causale');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: "2026-07-01", amountCents: 50000, description: "ORD-5 saldo" });
    expect(rows[1].amountCents).toBe(123456);
  });
  it("skips zero/blank rows and tolerates header synonyms", () => {
    const rows = parseBankCsv("Data,Importo,Causale\n2026-07-01,32.00,ORD-7\n2026-07-02,0,ignored");
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("ORD-7");
  });
});
