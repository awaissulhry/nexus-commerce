import { parse } from 'csv-parse/sync'

/**
 * One rule for reading an uploaded catalog CSV, because the operator's spreadsheet decides the file's
 * dialect and we do not: Excel writes `;` (or a tab) as the separator in most European locales, and in
 * some versions leads the file with a `sep=` line. Both shapes parse as a ONE-COLUMN header under the
 * comma default, so the first value that contains a comma fails the whole upload with csv-parse's
 * `Invalid Record Length: expect 1, got 2 on line 2` — a message about the parser, not about the file.
 *
 * Detection reads the HEADER RECORD, not the raw bytes: a quoted header cell may legitimately contain
 * any separator, and only a real parse can tell a separator from a character inside a value.
 */
const DELIMITERS = [',', ';', '\t', '|']
/** Excel's dialect line. It precedes the header and is not data. */
const SEP_LINE = /^﻿?sep=(.)\r?\n/i

export function readCsvDialect(input: Buffer): { body: Buffer; delimiter: string } {
  // A 200-column header stays well inside this slice; body bytes are never copied.
  const head = input.subarray(0, 512 * 1024).toString('utf8')
  const sep = SEP_LINE.exec(head)
  if (sep && !['"', '\r', '\n'].includes(sep[1])) return { body: input.subarray(Buffer.byteLength(sep[0], 'utf8')), delimiter: sep[1] }
  let delimiter = ',', columns = 0
  for (const candidate of DELIMITERS) {
    let header: string[] | undefined
    // A candidate that is not the real separator usually fails on quoting; that is itself the signal.
    try { header = (parse(head, { bom: true, delimiter: candidate, skip_empty_lines: true, relax_column_count: true, to: 1 }) as string[][])[0] } catch { continue }
    if (header && header.length > columns) { delimiter = candidate; columns = header.length }
  }
  return { body: input, delimiter }
}

/** Parses an uploaded CSV in its own dialect. The grid's shape stays the caller's check. */
export function parseCatalogCsv(input: Buffer | string, maxRecordSize?: number): { grid: string[][]; delimiter: string } {
  const { body, delimiter } = readCsvDialect(typeof input === 'string' ? Buffer.from(input) : input)
  const options = { bom: true, delimiter, skip_empty_lines: true, relax_column_count: true, ...(maxRecordSize ? { max_record_size: maxRecordSize } : {}) }
  return { grid: parse(body, options) as string[][], delimiter }
}

/** Restores the rectangle csv-parse enforced before the separator was read from the file. */
export function assertCsvRectangle(grid: string[][], delimiter: string) {
  const columns = grid[0]?.length ?? 0
  for (const [index, line] of grid.entries()) if (line.length !== columns) throw csvRowShapeError(index + 1, line.length, columns, delimiter)
}

/**
 * The rectangle csv-parse used to enforce, kept as a message the operator can act on. It names the row,
 * both counts and the separator actually used, because "expect 1, got 2" names none of them.
 */
export function csvRowShapeError(line: number, cells: number, columns: number, delimiter: string) {
  const named = delimiter === '\t' ? 'a tab' : `"${delimiter}"`
  const fix = cells > columns
    ? `Remove any title line above the header row, and quote values that contain ${named}.`
    : `Give the row every column, or leave the missing cells empty between separators.`
  return new Error(`Row ${line} has ${cells} ${cells === 1 ? 'cell' : 'cells'} where the header has ${columns}. This file is separated by ${named}. ${fix} Uploading the XLSX avoids the question.`)
}
