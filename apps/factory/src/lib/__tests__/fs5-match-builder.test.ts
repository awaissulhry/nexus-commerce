/** FS5 — MATCH escaping / prefix builder (the ⌘K input → FTS5 grammar fold). */
import { describe, expect, it } from "vitest";
import { buildMatchQuery, sortByIdOrder } from "../search-fts";

describe("buildMatchQuery", () => {
  it("wraps a single token as a quoted phrase-prefix", () => {
    expect(buildMatchQuery("gale")).toBe('"gale"*');
  });

  it("joins multiple tokens with implicit AND, each prefixed", () => {
    expect(buildMatchQuery("tuta canguro")).toBe('"tuta"* "canguro"*');
  });

  it("collapses arbitrary whitespace (tabs, newlines, runs)", () => {
    expect(buildMatchQuery("  tuta\t\ncanguro   pelle ")).toBe('"tuta"* "canguro"* "pelle"*');
  });

  it("escapes embedded double quotes by doubling them", () => {
    expect(buildMatchQuery('a"b')).toBe('"a""b"*');
  });

  it("neutralizes FTS5 operator words by quoting (literal match, not syntax)", () => {
    expect(buildMatchQuery("AND")).toBe('"AND"*');
    expect(buildMatchQuery("cat OR dog")).toBe('"cat"* "OR"* "dog"*');
    expect(buildMatchQuery("NOT NEAR")).toBe('"NOT"* "NEAR"*');
  });

  it("keeps operator punctuation harmless inside quotes", () => {
    expect(buildMatchQuery("col:val")).toBe('"col:val"*');
    expect(buildMatchQuery("(paren)")).toBe('"(paren)"*');
    expect(buildMatchQuery("star*")).toBe('"star*"*');
    expect(buildMatchQuery("^caret")).toBe('"^caret"*');
  });

  it("drops tokens with no letter/number content (empty phrases are FTS5 syntax errors)", () => {
    expect(buildMatchQuery('"')).toBeNull();
    expect(buildMatchQuery("- — * ( ) : ^")).toBeNull();
    expect(buildMatchQuery('gale "')).toBe('"gale"*');
  });

  it("returns null for empty / whitespace-only input", () => {
    expect(buildMatchQuery("")).toBeNull();
    expect(buildMatchQuery("   \t ")).toBeNull();
  });

  it("preserves diacritics (the tokenizer folds them, not the builder)", () => {
    expect(buildMatchQuery("Modà")).toBe('"Modà"*');
  });

  it("strips NUL bytes as separators", () => {
    expect(buildMatchQuery("ga\u0000le")).toBe('"ga"* "le"*');
  });

  it("caps token count at 8", () => {
    const out = buildMatchQuery("a1 a2 a3 a4 a5 a6 a7 a8 a9 a10")!;
    expect(out.split(" ")).toHaveLength(8);
    expect(out.endsWith('"a8"*')).toBe(true);
  });

  it("caps token length at 64 chars", () => {
    const long = "x".repeat(200);
    expect(buildMatchQuery(long)).toBe(`"${"x".repeat(64)}"*`);
  });
});

describe("sortByIdOrder", () => {
  it("re-sorts hydrated rows into the FTS rank order", () => {
    const rows = [{ id: "c" }, { id: "a" }, { id: "b" }];
    expect(sortByIdOrder(rows, ["b", "c", "a"]).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("pushes rows missing from the id list to the end, preserving their order", () => {
    const rows = [{ id: "x" }, { id: "a" }, { id: "y" }];
    expect(sortByIdOrder(rows, ["a"]).map((r) => r.id)).toEqual(["a", "x", "y"]);
  });

  it("does not mutate the input array", () => {
    const rows = [{ id: "b" }, { id: "a" }];
    sortByIdOrder(rows, ["a", "b"]);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
