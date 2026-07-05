/** F1 — the import framework's pure parse layer. */
import { describe, expect, it } from "vitest";
import { parsePartiesCsv, partiesTemplateCsv } from "../imports/parties";

describe("parsePartiesCsv", () => {
  it("parses the shipped template cleanly", () => {
    const { ops, errors } = parsePartiesCsv(partiesTemplateCsv());
    expect(errors).toHaveLength(0);
    expect(ops).toHaveLength(3);
    expect(ops[0].kind).toBe("CUSTOMER");
  });
  it("rejects bad kinds, bad emails, duplicates; keeps row numbers", () => {
    const csv = [
      "kind,name,email",
      "WIZARD,Gandalf,g@example.com",
      "CUSTOMER,,x@example.com",
      "CUSTOMER,Mario,not-an-email",
      "CUSTOMER,Mario,mario@example.com",
      "BRAND,Duplicato,mario@example.com",
    ].join("\n");
    const { ops, errors } = parsePartiesCsv(csv);
    expect(errors.map((e) => e.row)).toEqual([1, 2, 3, 5]);
    expect(ops).toHaveLength(1);
    expect(ops[0].row).toBe(4);
  });
  it("defaults currency to EUR and uppercases it", () => {
    const { ops } = parsePartiesCsv("kind,name,email,currency\nCUSTOMER,Mario,m@example.com,usd");
    expect(ops[0].currency).toBe("USD");
    const { ops: ops2 } = parsePartiesCsv("kind,name,email\nCUSTOMER,Luigi,l@example.com");
    expect(ops2[0].currency).toBe("EUR");
  });
});
