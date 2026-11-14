import type { GuestFileView, GuestInvoiceView, GuestOverviewAnswer, GuestPeriodAnswer } from '@nexus/factory-domain/accounting/guest/contracts'
import { GUEST_REFUSALS } from '@nexus/factory-domain/accounting/guest/files'
import { guestPeriodWords, parseGuestPeriod, type GuestPeriodKind } from '@nexus/factory-domain/accounting/guest/periods'
import type { AccountingPackage } from '@nexus/factory-domain/accounting/packages'
import { issuePath, type ApiIssue } from '../../../lib/api/errors'
import { formatDate, formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'

/**
 * The accountant's room (B-W2b-201, SCR-268; design portal.guest.accountant), the pure part: the address (`?period=`), the
 * period picker, the three lists' rows, what holds a download and the refusals in words (by code: the API's English is
 * never shown). No amount anywhere: the files hold them.
 */

export const NS = 'portal-accountant'
export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

// ── the address ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface AccountantAddress {
  /** `2026-10`, `2026-Q4`, `2026`; null: the newest handed-over month. */
  period: string | null
}

export const addressOf = (params: { get(name: string): string | null } | null): AccountantAddress => ({ period: parseGuestPeriod(params?.get('period') ?? null)?.key ?? null })
export const accountingHref = (prefix: string, period: string | null): string => `${prefix}/accounting${period ? `?period=${encodeURIComponent(period)}` : ''}`

/** The period shown: the address's, else the newest handed-over month, else none. */
export const chosenPeriod = (address: AccountantAddress, overview: Pick<GuestOverviewAnswer, 'latest'> | null): string | null => address.period ?? overview?.latest ?? null

export const kindOf = (period: string | null): GuestPeriodKind => parseGuestPeriod(period)?.kind ?? 'MONTH'

/** A period's words in the page's language (`ottobre 2026`, `4° trimestre 2026`, `2026`). */
export const periodWords = (period: string, locale: Locale): string => {
  const parsed = parseGuestPeriod(period)
  return parsed ? guestPeriodWords(parsed, locale) : period
}

export interface PeriodOption {
  value: string
  label: string
}

/** The picker's choices of one kind, newest first; the period shown is always among them (a typed address). */
export function choicesOf(choices: GuestOverviewAnswer['choices'] | null, kind: GuestPeriodKind, locale: Locale, current: string | null): PeriodOption[] {
  const list = choices ? (kind === 'MONTH' ? choices.months : kind === 'QUARTER' ? choices.quarters : choices.years) : []
  const values = current && kindOf(current) === kind && !list.includes(current) ? [current, ...list] : [...list]
  return values.map((value) => ({ value, label: periodWords(value, locale) }))
}

/** The period of the other kind that holds the one shown (October 2026 → 2026-Q4 → 2026), or the newest of that kind. */
export function periodOfKind(current: string | null, kind: GuestPeriodKind, choices: GuestOverviewAnswer['choices'] | null): string | null {
  const parsed = parseGuestPeriod(current)
  const list = choices ? (kind === 'MONTH' ? choices.months : kind === 'QUARTER' ? choices.quarters : choices.years) : []
  if (!parsed) return list[0] ?? null
  const holding = kind === 'YEAR' ? String(parsed.year) : kind === 'QUARTER' ? `${parsed.year}-Q${Math.floor((Number(parsed.months[0]!.slice(5, 7)) - 1) / 3) + 1}` : null
  if (holding && list.includes(holding)) return holding
  if (kind === 'MONTH') return parsed.months.slice().reverse().find((month) => list.includes(month)) ?? list[0] ?? null
  return list[0] ?? null
}

// ── the lists' rows ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface ExportFileRow {
  /** The file's id (a row is one file of a batch). */
  id: string
  exportId: string
  number: string
  journal: AccountingPackage
  month: string
  exportedAt: string
  amends: string | null
  amendedBy: string | null
  name: string
  format: string
  sizeBytes: number
  rowCount: number
}

export interface InvoiceRow {
  id: string
  side: GuestInvoiceView['side']
  kind: GuestInvoiceView['kind']
  number: string
  date: string
  party: string
  state: string
  xml: GuestFileView | null
  pdf: GuestFileView | null
}

export interface RegisterRow {
  id: string
  register: AccountingPackage
  month: string
  number: string
  exportedAt: string
  current: boolean
  replacedBy: string | null
  name: string
  format: string
  sizeBytes: number
}

/** One row per file of a batch, the newest month first, a month's batches in the order they were made. */
export function exportRowsOf(answer: Pick<GuestPeriodAnswer, 'exports'>): ExportFileRow[] {
  const batches = [...answer.exports].sort((a, b) => b.month.localeCompare(a.month) || a.exportedAt.localeCompare(b.exportedAt))
  return batches.flatMap((batch) =>
    batch.files.map((entry) => ({
      id: entry.file.id,
      exportId: batch.exportId,
      number: batch.number,
      journal: entry.package,
      month: batch.month,
      exportedAt: batch.exportedAt,
      amends: batch.amends,
      amendedBy: batch.amendedBy,
      name: entry.file.name,
      format: entry.format,
      sizeBytes: entry.file.sizeBytes,
      rowCount: entry.rowCount,
    })),
  )
}

/** The e-invoices, sales first, each side by day and number. */
export function invoiceRowsOf(answer: Pick<GuestPeriodAnswer, 'invoices'>): InvoiceRow[] {
  return [...answer.invoices]
    .sort((a, b) => (a.side === b.side ? a.date.localeCompare(b.date) || a.number.localeCompare(b.number) : a.side === 'SALES' ? -1 : 1))
    .map((row) => ({ id: row.id, side: row.side, kind: row.kind, number: row.number, date: row.date, party: row.party, state: row.state, xml: row.xml, pdf: row.pdf }))
}

/** The register files, the newest month first, the current one before the files it replaced. */
export function registerRowsOf(answer: Pick<GuestPeriodAnswer, 'registers'>): RegisterRow[] {
  return [...answer.registers]
    .sort((a, b) => b.month.localeCompare(a.month) || a.package.localeCompare(b.package) || Number(b.current) - Number(a.current) || b.exportedAt.localeCompare(a.exportedAt))
    .map((row) => ({ id: row.file.id, register: row.package, month: row.month, number: row.exportNumber, exportedAt: row.exportedAt, current: row.current, replacedBy: row.replacedBy, name: row.file.name, format: row.format, sizeBytes: row.file.sizeBytes }))
}

/** The files of the chosen invoices (each one's XML and PDF that we keep). */
export const invoiceFileIds = (rows: readonly InvoiceRow[], ids: readonly string[]): string[] =>
  rows.filter((row) => ids.includes(row.id)).flatMap((row) => [row.xml?.id, row.pdf?.id].filter((value): value is string => typeof value === 'string'))

/** An invoice row without any file to download says why; the others may be chosen. */
export const invoiceSelectable = (row: InvoiceRow): string | null => (row.xml || row.pdf ? null : 'einvoices.noFile')

// ── what holds a download ────────────────────────────────────────────────────────────────────────────────────────────
export interface HoldFacts {
  preview: boolean
  offline: boolean
  busy: boolean
}

/** Why nothing may be downloaded now (a key), or null. */
export const downloadHeld = (facts: HoldFacts): string | null => (facts.preview ? 'held.preview' : facts.offline ? 'held.offline' : facts.busy ? 'held.busy' : null)

/** The band's "Download period (zip)": held without a period or a file, or as every download. */
export function periodZipHeld(facts: HoldFacts & { readonly files: number | null }): string | null {
  return downloadHeld(facts) ?? (facts.files === null ? 'held.reading' : facts.files === 0 ? 'held.nothing' : null)
}

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export type RefusalCode = keyof typeof GUEST_REFUSALS
export const REFUSAL_CODES = Object.keys(GUEST_REFUSALS) as RefusalCode[]

/** A refusal of the API as the page says it: `refusal.<CODE>` from the issue `problem/<CODE>`, else by its kind. */
export function refusalKey(error: unknown): string {
  const issues = (error as { issues?: readonly ApiIssue[] } | null)?.issues ?? []
  for (const issue of issues) {
    const code = /^problem\/([A-Z_]+)$/.exec(issuePath(issue))?.[1]
    if (code && (REFUSAL_CODES as string[]).includes(code)) return `refusal.${code}`
  }
  const kind = (error as { kind?: string } | null)?.kind
  if (kind === 'unavailable') return 'refusal.network'
  if (kind === 'forbidden') return 'refusal.NOT_ACCOUNTANT'
  return 'refusal.generic'
}

// ── words ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A file's size ("12 KB", "1,2 MB"). */
export function sizeWords(bytes: number, locale: Locale): string {
  if (bytes < 1024) return `${formatNumber(bytes, locale)} B`
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024), locale)} KB`
  return `${formatNumber(Math.round((bytes / (1024 * 1024)) * 10) / 10, locale)} MB`
}

/** A calendar day in the page's language (written at noon UTC so no zone moves it). */
export const dayWords = (iso: string, locale: Locale): string => formatDate(iso.length <= 10 ? `${iso.slice(0, 10)}T12:00:00Z` : iso, { locale, ...(iso.length <= 10 ? { timeZone: 'UTC' } : {}) })

/** The SDI state's tone (a rejected or failed sale stands out). */
export const stateTone = (state: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' =>
  state === 'REJECTED' || state === 'ERROR' ? 'danger' : state === 'NOT_DELIVERABLE' ? 'warning' : state === 'DELIVERED' || state === 'SDI' ? 'success' : 'neutral'

/** Every package, SDI state, kind and refusal the page names (the words test holds them in both languages). */
export const WORD_KEYS: readonly string[] = [
  ...['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES', 'VAT_REGISTERS', 'INTRASTAT', 'YEAR_END_STOCK'].map((pkg) => `package.${pkg}`),
  ...['ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR', 'SDI', 'EMAIL', 'MANUAL'].map((state) => `state.${state}`),
  ...['INVOICE', 'DEPOSIT', 'CREDIT_NOTE'].map((kind) => `kind.${kind}`),
  ...['SALES', 'PURCHASE'].map((side) => `side.${side}`),
  ...['MONTH', 'QUARTER', 'YEAR'].map((kind) => `period.kind.${kind}`),
  ...[...REFUSAL_CODES, 'generic', 'network'].map((code) => `refusal.${code}`),
]
