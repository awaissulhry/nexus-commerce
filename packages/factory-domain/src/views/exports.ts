import type { Grain } from '../auth/grains/grains'
import { defineMachine } from '../state/machine'

/**
 * The export of a list (B-W2a-23; PLT-179; design shell.lists toolbar "Export ▾ ('This view (CSV)', 'This view
 * (Excel)', 'Full file for re-import (XLSX)')", pop:export-job "Exporting 18,400 rows": JobProgress, "you can close this
 * window", the columns left out by rights). An export is a job the worker runs (apps/factory-api platform/exports): it
 * reads the list as the person who asked, with their live rights, writes the file and keeps it as a StoredFile of the
 * job for EXPORT_LIMITS.keepDays days.
 *
 *   QUEUED → RUNNING → DONE → EXPIRED (the file deleted after its days), or → FAILED with why, in words;
 *   RUNNING → QUEUED is a retry of a worker that stopped half way (the job starts again from its first row).
 *
 * Field security (design: "Export leaves out columns the person cannot see and says so in the file header"): a column
 * of a money grain the person does not hold is never read into the file; the job names it (`omittedColumns`) and the
 * file says so above its header. Pure: the cells' words and the CSV text; the API writes XLSX with the same cells.
 */

export const EXPORT_FORMATS = ['CSV', 'XLSX', 'XLSX_REIMPORT'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]
export const EXPORT_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED'] as const
export type ExportStatus = (typeof EXPORT_STATUSES)[number]
export const EXPORT_LOCALES = ['it', 'en'] as const
export type ExportLocale = (typeof EXPORT_LOCALES)[number]

export const exportMachine = defineMachine({
  name: 'export',
  states: EXPORT_STATUSES,
  transitions: { QUEUED: ['RUNNING', 'FAILED'], RUNNING: ['QUEUED', 'DONE', 'FAILED'], DONE: ['EXPIRED'] },
})

export const EXPORT_LIMITS = Object.freeze({
  /** Rows in one file: a larger view is refused in words (narrow it first). */
  maxRows: 50_000,
  /** Rows read per page of the list. */
  pageSize: 200,
  /** Days a finished file is kept; then it is deleted and the job EXPIRED. */
  keepDays: 7,
  /** Columns one export may name, and the length of a column's heading. */
  columns: 60,
  label: 120,
  /** The file's title (the list's name, from the screen). */
  title: 80,
  /** A person's recent exports shown with a list. */
  recent: 10,
  /** The progress written while it runs, at most this often. */
  progressEveryMs: 3_000,
  /** A RUNNING job no worker touched for this long is failed by the sweep. */
  stuckMinutes: 30,
})

export const isActiveExport = (status: ExportStatus): boolean => status === 'QUEUED' || status === 'RUNNING'

/**
 * One cell of a list, as a source gives it: words, a whole number, a decimal (a quantity, as its decimal string), an
 * amount in minor units with its currency, a calendar day, an instant, or nothing.
 */
export type ExportCell =
  | string
  | number
  | null
  | { readonly decimal: string }
  | { readonly minor: number; readonly currency: string | null }
  | { readonly day: string }
  | { readonly at: string }

/** The decimal separator of a language. */
const decimalMark = (locale: ExportLocale): string => (locale === 'it' ? ',' : '.')

/** `12.5000` → `12,5` (it) / `12.5` (en): trailing zeros off, no float. */
export function decimalText(value: string, locale: ExportLocale): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!match) return value
  const fraction = (match[3] ?? '').replace(/0+$/, '')
  return `${match[1]}${match[2]}${fraction ? `${decimalMark(locale)}${fraction}` : ''}`
}

/** 123450 → `1234,50` (it) / `1234.50` (en): two decimals, no grouping (a spreadsheet reads it back as a number), no float. */
export function minorText(minor: number, locale: ExportLocale, decimals = 2): string {
  const negative = minor < 0
  const digits = String(Math.abs(Math.trunc(minor))).padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals)
  return `${negative ? '-' : ''}${whole}${decimals > 0 ? `${decimalMark(locale)}${fraction}` : ''}`
}

/** An instant as the site's wall clock, `YYYY-MM-DD HH:MM`. */
export function instantText(iso: string, timeZone = 'Europe/Rome'): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/** A cell as text in the file's language: days ISO (`2026-10-30`, every spreadsheet reads it), amounts with their currency apart. */
export function cellText(cell: ExportCell, locale: ExportLocale, timeZone = 'Europe/Rome'): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'string') return cell
  if (typeof cell === 'number') return Number.isInteger(cell) ? String(cell) : String(cell).replace('.', decimalMark(locale))
  if ('decimal' in cell) return decimalText(cell.decimal, locale)
  if ('minor' in cell) return minorText(cell.minor, locale)
  if ('day' in cell) return cell.day
  return instantText(cell.at, timeZone)
}

/** A column as the screen asked for it: its id and its heading in the person's language. */
export interface AskedColumn {
  readonly key: string
  readonly label: string
}

export interface PickedColumns {
  /** The columns written, in the screen's order. */
  readonly columns: readonly (AskedColumn & { readonly grain: Grain | null })[]
  /** Left out by the person's rights (a money grain they do not hold): named in the job and the file. */
  readonly omitted: readonly AskedColumn[]
  /** Columns the list's export does not know (a column of buttons, a picture): not part of a file. */
  readonly unknown: readonly string[]
}

/** The columns of an export: the screen's, kept when the list's export knows them and the person holds their grain. */
export function pickColumns(known: Readonly<Record<string, { readonly grain?: Grain | undefined }>>, asked: readonly AskedColumn[], grains: ReadonlySet<Grain>): PickedColumns {
  const columns: (AskedColumn & { grain: Grain | null })[] = []
  const omitted: AskedColumn[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const column of asked) {
    if (seen.has(column.key)) continue
    seen.add(column.key)
    const spec = Object.hasOwn(known, column.key) ? known[column.key] : undefined
    if (!spec) unknown.push(column.key)
    else if (spec.grain && !grains.has(spec.grain)) omitted.push({ key: column.key, label: column.label })
    else columns.push({ key: column.key, label: column.label, grain: spec.grain ?? null })
  }
  return { columns, omitted, unknown }
}

/** The line above the header that names the columns left out by the person's rights (null: none was). */
export function omittedNote(labels: readonly string[], locale: ExportLocale): string | null {
  if (labels.length === 0) return null
  return locale === 'it' ? `Colonne escluse dai tuoi permessi: ${labels.join(', ')}` : `Columns left out by your rights: ${labels.join(', ')}`
}

const SLUG_FROM = 'àáâäãåèéêëìíîïòóôöõùúûüçñ'
const SLUG_TO = 'aaaaaaeeeeiiiiooooouuuucn'

/** The file's name: the list's title as a slug, the day, the format's extension (`ordini-di-vendita-2026-10-30.csv`). */
export function exportFileName(title: string, format: ExportFormat, day: string): string {
  const slug = [...title.toLowerCase()]
    .map((char) => {
      const at = SLUG_FROM.indexOf(char)
      return at >= 0 ? SLUG_TO[at] : char
    })
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'export'}${format === 'XLSX_REIMPORT' ? '-reimport' : ''}-${day}.${format === 'CSV' ? 'csv' : 'xlsx'}`
}

export const EXPORT_CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = Object.freeze({
  CSV: 'text/csv',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  XLSX_REIMPORT: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
})

/** A CSV field (RFC 4180): quoted when it holds the separator, a quote or a line break. */
function csvField(text: string, separator: string): string {
  return text.includes(separator) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The CSV text: a UTF-8 BOM (a spreadsheet then reads accented names right), `;` between fields in Italian and `,` in
 * English (the separator each language's spreadsheet expects, with its decimal mark), CRLF line ends; the note line
 * (columns left out) above the header when there is one.
 */
export function csvText(input: { readonly locale: ExportLocale; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly note?: string | null }): string {
  const separator = input.locale === 'it' ? ';' : ','
  const line = (values: readonly string[]) => values.map((value) => csvField(value, separator)).join(separator)
  const lines = [...(input.note ? [line([input.note])] : []), line(input.header), ...input.rows.map(line)]
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
