/** F1 — CSV core: quoting, CRLF, round-trip. */
import { describe, expect, it } from "vitest";
import { parseCsv, rowsToObjects, splitCsvLine, toCsv } from "../csv";

describe("splitCsvLine", () => {
  it("handles quoted commas and escaped quotes", () => {
    expect(splitCsvLine('a,"b, with comma","say ""hi"""')).toEqual(["a", "b, with comma", 'say "hi"']);
  });
  it("trims cells", () => {
    expect(splitCsvLine(" a , b ")).toEqual(["a", "b"]);
  });
});

describe("parseCsv / rowsToObjects", () => {
  it("lowercases headers and maps rows", () => {
    const objs = rowsToObjects("Name,Email\r\nMario,mario@example.com\n");
    expect(objs).toEqual([{ name: "Mario", email: "mario@example.com" }]);
  });
  it("skips blank lines", () => {
    expect(parseCsv("a,b\n\n1,2\n\n").rows).toHaveLength(1);
  });
});

describe("toCsv", () => {
  it("escapes and round-trips", () => {
    const csv = toCsv(["name", "notes"], [["Rossi, Mario", 'said "ciao"']]);
    const back = rowsToObjects(csv);
    expect(back[0]).toEqual({ name: "Rossi, Mario", notes: 'said "ciao"' });
  });
});
