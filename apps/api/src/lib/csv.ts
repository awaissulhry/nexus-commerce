/**
 * O.23b — minimal CSV writer.
 *
 * One-call helper that takes a header row + an array of plain
 * objects and returns a UTF-8 CSV string with proper escaping.
 * Avoids pulling in csv-stringify or papaparse for the two
 * export endpoints (orders + customers) we need today.
 *
 * Escaping: any value containing comma, double-quote, CR, or LF
 * gets wrapped in double-quotes with internal double-quotes
 * doubled (RFC 4180). null/undefined → empty cell. Date → ISO
 * string. number/bigint → string.
 *
 * Caller decides headers explicitly so column order is stable
 * across export runs (operators paste these into Excel and rely
 * on column position).
 */

export function csvCell(v: unknown): string {
  if (v == null) return ''
  let s: string
  if (v instanceof Date) s = v.toISOString()
  else if (typeof v === 'bigint') s = v.toString()
  else if (typeof v === 'object') s = JSON.stringify(v)
  else s = String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',')
}

export function csvDocument(headers: string[], rows: unknown[][]): string {
  const lines: string[] = [csvRow(headers)]
  for (const r of rows) lines.push(csvRow(r))
  // \r\n per RFC 4180; Excel-on-mac handles \n too but \r\n is safest.
  return lines.join('\r\n') + '\r\n'
}
