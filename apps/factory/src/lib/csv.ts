/**
 * F1 — minimal quote-aware CSV core (the eBay-ads idiom's parse layer,
 * reimplemented): comma separator, double-quote escaping, CRLF tolerant.
 * Pure functions — unit-tested.
 */

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCsv(csv: string): { headers: string[]; rows: string[][] } {
  const lines = csv
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  return { headers, rows: lines.slice(1).map(splitCsvLine) };
}

export function rowsToObjects(csv: string): Record<string, string>[] {
  const { headers, rows } = parseCsv(csv);
  return rows.map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = cells[i] ?? ""));
    return obj;
  });
}

const escapeCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.join(","), ...rows.map((r) => r.map(escapeCell).join(","))].join("\n");
}

/**
 * FS5 — CSV body chunk for STREAMED exports: `toCsv([], rows)` yields "\n" +
 * the joined rows, and that leading newline is exactly the separator from the
 * previous chunk (the header chunk carries none) — so header + chunks
 * concatenate into one valid CSV byte-identical to a single toCsv() call.
 * Empty batches contribute nothing. (exports/orders carries a pre-FS5 local
 * copy of this — EPO-owned file; adopting csvChunk there is a recorded
 * cosmetic handoff.)
 */
export function csvChunk(rows: unknown[][]): string {
  return rows.length === 0 ? "" : toCsv([], rows);
}
