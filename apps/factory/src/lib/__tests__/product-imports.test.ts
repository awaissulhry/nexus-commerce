/** FP2.5 — the pure parse layers of the materials & options CSV imports. */
import { describe, expect, it } from "vitest";
import { materialsTemplateCsv, parseMaterialsCsv } from "../imports/materials";
import { optionsTemplateCsv, parseOptionsCsv } from "../imports/options";

describe("parseMaterialsCsv", () => {
  it("parses the shipped template (euros → cents)", () => {
    const { ops, errors } = parseMaterialsCsv(materialsTemplateCsv());
    expect(errors).toHaveLength(0);
    expect(ops).toHaveLength(3);
    expect(ops[0].costCents).toBe(4000); // €40.00
    expect(ops[1].costCents).toBe(9000);
  });
  it("rejects bad units, negative cost, duplicate names; keeps row numbers", () => {
    const csv = [
      "name,unit,cost_eur",
      "Cowhide,ACRES,40",
      "Kangaroo,SQM,-5",
      ",SQM,10",
      "Thread,PIECE,3",
      "thread,PIECE,4",
    ].join("\n");
    const { ops, errors } = parseMaterialsCsv(csv);
    expect(errors.map((e) => e.row)).toEqual([1, 2, 3, 5]); // dup 'thread' is row 5
    expect(ops).toHaveLength(1);
    expect(ops[0].name).toBe("Thread");
  });
});

describe("parseOptionsCsv", () => {
  it("parses the template with €→cents and %→bp", () => {
    const { ops, errors } = parseOptionsCsv(optionsTemplateCsv());
    expect(errors).toHaveLength(0);
    const kangaroo = ops.find((o) => o.option === "Kangaroo")!;
    expect(kangaroo.priceDelta).toBe(12000); // €120 ABSOLUTE
    expect(kangaroo.costDelta).toBe(8000);
    const perf = ops.find((o) => o.option === "Perforated panels")!;
    expect(perf.priceDelta).toBe(500); // 5% → 500 bp
    expect(perf.priceDeltaMode).toBe("PERCENT");
  });
  it("rejects bad mode, missing group/option, dupes", () => {
    const csv = [
      "group,min,max,option,price_delta,price_mode,cost_delta,cost_mode",
      "Leather,1,1,Cowhide,0,WRONG,0,ABSOLUTE",
      ",1,1,X,0,ABSOLUTE,0,ABSOLUTE",
      "Leather,1,1,,0,ABSOLUTE,0,ABSOLUTE",
      "Leather,1,1,Kangaroo,120,ABSOLUTE,80,ABSOLUTE",
      "Leather,1,1,kangaroo,1,ABSOLUTE,1,ABSOLUTE",
    ].join("\n");
    const { ops, errors } = parseOptionsCsv(csv);
    expect(errors.map((e) => e.row)).toEqual([1, 2, 3, 5]);
    expect(ops).toHaveLength(1);
    expect(ops[0].option).toBe("Kangaroo");
  });
});
