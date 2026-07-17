/**
 * FS5 — stream-chunk CSV math: header + csvChunk(batch) concatenation must be
 * byte-identical to one toCsv() call over the same data, at any batch split.
 * (The invariant both streamed archival exports — ledger + audit — rely on.)
 */
import { describe, expect, it } from "vitest";
import { csvChunk, parseCsv, toCsv } from "../csv";

const HEADERS = ["id", "date", "note"];
const ROWS: unknown[][] = [
  ["a1", "2026-07-17", "plain"],
  ["a2", "2026-07-17", 'quote " inside'],
  ["a3", "2026-07-17", "comma, inside"],
  ["a4", "2026-07-17", "line\nbreak"],
  ["a5", "2026-07-17", ""],
];

const streamed = (batchSize: number): string => {
  let out = HEADERS.join(",");
  for (let i = 0; i < ROWS.length; i += batchSize) out += csvChunk(ROWS.slice(i, i + batchSize));
  return out;
};

describe("csvChunk streaming math", () => {
  it("chunked assembly is byte-identical to a single toCsv() at every batch size", () => {
    const whole = toCsv(HEADERS, ROWS);
    for (const size of [1, 2, 3, 5, 100]) expect(streamed(size)).toBe(whole);
  });

  it("empty batches contribute nothing (the tail-batch case)", () => {
    expect(csvChunk([])).toBe("");
    expect(streamed(2) + csvChunk([])).toBe(toCsv(HEADERS, ROWS));
  });

  it("chunk boundaries never split a quoted cell (round-trips through parseCsv)", () => {
    // parseCsv is the house IMPORT parser — line-based, so it cannot read
    // quoted newlines back (the byte-identity test above already covers that
    // row); round-trip the newline-free rows across a chunk boundary.
    const simple = ROWS.filter((r) => !String(r[2]).includes("\n"));
    let assembled = HEADERS.join(",");
    for (let i = 0; i < simple.length; i += 2) assembled += csvChunk(simple.slice(i, i + 2));
    const { headers, rows } = parseCsv(assembled);
    expect(headers).toEqual(HEADERS);
    expect(rows).toHaveLength(simple.length);
    expect(rows[1][2]).toBe('quote " inside');
    expect(rows[2][2]).toBe("comma, inside");
  });

  it("a header-only stream (zero rows) is just the header line", () => {
    expect(HEADERS.join(",") + csvChunk([])).toBe(toCsv(HEADERS, []));
  });

  it("JSON cells (audit before/after) survive quoting intact", () => {
    const jsonCell = JSON.stringify({ state: "OPEN", note: 'said "ciao", left' });
    const assembled = "h" + csvChunk([[jsonCell]]);
    const { rows } = parseCsv(assembled);
    expect(rows[0][0]).toBe(jsonCell);
  });
});
