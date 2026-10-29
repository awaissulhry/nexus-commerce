import { formatNumber, MAX_FISCAL_NUMBER_LENGTH, MAX_PATTERN_LENGTH, parsePattern, type Pattern } from '@nexus/factory-domain/numbering/format'
import { defaultPattern, isFiscalKind, MAX_NUMBER, NUMBER_KINDS, SERIES_CODE } from '@nexus/factory-domain/numbering/kinds'
import { legalProblems } from '@nexus/factory-domain/documents/legal'
import type { CompanyLegal } from '@nexus/factory-domain/documents/model'
import type { Company } from '../shared/api'
import type { Loaded, Notice, StepUpModel } from '../shared/model'
import type { Allocation, NumberKind, NumberReset, Series, SeriesProof } from './api'

/**
 * SCR-014 Documents & numbering (design 02 admin.documents; PLT-122, PLT-123, PLT-124): one page, two lists in W0 —
 * Numbers (every number series of the companies, the next number as it will print, the pattern as chips, the fiscal
 * lock, and the Fiscal check: proof that invoices and DDTs have no gaps) and Documents (the fixed layouts, previewed
 * with the company's legal data in a new tab). E-mail and label templates, branding and required documents come in
 * later waves (W1, W2b). Pure: the container maps the API's answers here, the view draws them, the tests hold every
 * rule. Pattern words are this web's (the API's English refusal is never shown).
 */

export const DOCUMENT_VIEWS = ['numbers', 'documents'] as const
export type DocumentsView = (typeof DOCUMENT_VIEWS)[number]

export interface CompanyOption {
  id: string
  code: string
  legalName: string
  status: string
  /** Its legal data is complete for a document (factory-domain documents/legal.ts): its previews can be printed. */
  legalReady: boolean
  /** How many legal facts its documents miss. */
  legalMissing: number
}

/** The gap proof of one fiscal series, read separately (one call per series). */
export type ProofRead = { state: 'checking' } | { state: 'ok'; proof: SeriesProof } | { state: 'failed'; problem: string }

export type DocumentsDialog =
  | { kind: 'new'; draft?: SeriesDraft | null; tried?: boolean }
  | { kind: 'series'; seriesId: string; section?: 'start' | 'advance' | null }
  | { kind: 'close'; seriesId: string }
  | { kind: 'numbers'; seriesId: string }

export interface DocumentsViewModel {
  /** `/w/<company>`. */
  prefix: string
  view: DocumentsView
  companies: Loaded<CompanyOption>
  /** The company the lists show; 'all' for every company the person reaches. */
  companyId: string
  series: Loaded<Series>
  proofs: Readonly<Record<string, ProofRead>>
  asOf: string | null
  can: {
    /** numbering.manage: create, start, move past, close. */
    manage: boolean
    /** documents.view: the sample documents. */
    documents: boolean
  }
  dialog?: DocumentsDialog | null
  /** The numbers of the series the "numbers issued" dialog shows. */
  numbers?: { seriesId: string; read: Loaded<Allocation>; proof: SeriesProof | null } | null
  notice?: Notice | null
  busy?: boolean
  dialogProblem?: string | null
  stepUp?: StepUpModel
}

// ---- words ----

export const kindKey = (kind: NumberKind) => `docs.kind.${kind}`

/** "2026", or the words for a series that never starts again. */
export const periodOf = (series: Pick<Series, 'scopeKey' | 'year'>) => (series.year === null ? null : String(series.year))

// ---- the pattern, as chips ----

export type PatternChip = { kind: 'text'; text: string } | { kind: 'number'; digits: number } | { kind: 'year'; digits: 4 | 2 }

/** A pattern's parts as chips (fixed text, the year, the counter with its digits); null for one this web cannot read. */
export function patternChips(source: string): PatternChip[] | null {
  let pattern: Pattern
  try {
    pattern = parsePattern(source)
  } catch {
    return null
  }
  return pattern.parts.map((part) =>
    'text' in part ? { kind: 'text', text: part.text } : part.token === 'N' ? { kind: 'number', digits: part.pad } : { kind: 'year', digits: part.token === 'YYYY' ? 4 : 2 },
  )
}

const LITERAL = /^[A-Za-z0-9/._-]*$/

/**
 * What is wrong with a pattern, as a message key of `admin-documents` (null: fine). The same rules as factory-domain's
 * patternProblem (numbering/format.ts), said in this web's words.
 */
export function patternIssue(source: string, reset: NumberReset, fiscal: boolean): string | null {
  const text = source.trim()
  if (text === '') return 'docs.pattern.issue.empty'
  if (text.length > MAX_PATTERN_LENGTH) return 'docs.pattern.issue.tooLong'
  const tokens = [...text.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '')
  if (tokens.some((token) => !/^(N|N:\d{1,2}|YYYY|YY)$/.test(token))) return 'docs.pattern.issue.badToken'
  const numbers = tokens.filter((token) => token === 'N' || token.startsWith('N:'))
  if (numbers.length === 0) return 'docs.pattern.issue.noNumber'
  if (numbers.length > 1) return 'docs.pattern.issue.twoNumbers'
  const width = numbers[0]!.startsWith('N:') ? Number.parseInt(numbers[0]!.slice(2), 10) : 1
  if (width < 1 || width > 12) return 'docs.pattern.issue.digits'
  if (!LITERAL.test(text.replace(/\{[^{}]*\}/g, ''))) return 'docs.pattern.issue.badText'
  if (tokens.some((token) => token === 'YYYY' || token === 'YY') && reset !== 'YEARLY') return 'docs.pattern.issue.yearNeedsYearly'
  if (fiscal) {
    try {
      if (formatNumber(text, { value: 1, year: 2026 }).length > MAX_FISCAL_NUMBER_LENGTH) return 'docs.pattern.issue.fiscalTooLong'
    } catch {
      return 'docs.pattern.issue.badText'
    }
  }
  try {
    parsePattern(text)
  } catch {
    return 'docs.pattern.issue.badText'
  }
  return null
}

/** The number a pattern prints for a value (null when the pattern or the value cannot be printed). */
export function preview(pattern: string, value: number, year: number | null): string | null {
  try {
    return formatNumber(pattern, { value, year })
  } catch {
    return null
  }
}

// ---- the new-series form ----

export const YEAR_TOKENS = ['YYYY', 'YY', 'none'] as const
export type YearToken = (typeof YEAR_TOKENS)[number]
export const SEPARATORS = ['-', '/', '.', ''] as const

export interface SeriesDraft {
  companyId: string
  kind: NumberKind
  code: string
  reset: NumberReset
  /** A yearly series' first period, as typed. */
  year: string
  /** The chips: prefix, separator, year, digits; or the pattern typed by hand. */
  prefix: string
  separator: string
  yearToken: YearToken
  digits: string
  typed: boolean
  pattern: string
  start: string
}

const DEFAULT_PREFIX = (kind: NumberKind) => (defaultPattern(kind, 'NEVER').split('-')[0] ?? 'N')

export function newDraft(companyId: string, kind: NumberKind = 'INVOICE', year = 2026): SeriesDraft {
  const reset: NumberReset = kind === 'LOT' || kind === 'BATCH' ? 'NEVER' : 'YEARLY'
  return {
    companyId,
    kind,
    code: 'MAIN',
    reset,
    year: String(year),
    prefix: DEFAULT_PREFIX(kind),
    separator: '-',
    yearToken: reset === 'YEARLY' ? 'YYYY' : 'none',
    digits: reset === 'YEARLY' ? '5' : '6',
    typed: false,
    pattern: defaultPattern(kind, reset),
    start: '1',
  }
}

/** A draft for another document kind: the prefix and the reset follow the kind, the rest stays. */
export function withKind(draft: SeriesDraft, kind: NumberKind, year: number): SeriesDraft {
  const fresh = newDraft(draft.companyId, kind, Number.parseInt(draft.year, 10) || year)
  return { ...fresh, code: draft.code }
}

/** The pattern the chips build: prefix · year · counter, joined by the separator. */
export function chipsPattern(draft: Pick<SeriesDraft, 'prefix' | 'separator' | 'yearToken' | 'digits' | 'reset'>): string {
  const digits = Math.max(1, Math.min(12, Number.parseInt(draft.digits, 10) || 1))
  const parts = [draft.prefix.trim(), draft.reset === 'YEARLY' && draft.yearToken !== 'none' ? `{${draft.yearToken}}` : '', digits === 1 ? '{N}' : `{N:${digits}}`].filter((part) => part !== '')
  return parts.join(draft.separator)
}

export const draftPattern = (draft: SeriesDraft) => (draft.typed ? draft.pattern.trim() : chipsPattern(draft))

const wholeNumber = (text: string) => (/^\d{1,10}$/.test(text.trim()) ? Number.parseInt(text.trim(), 10) : null)

/** The draft's problems by field, as message keys of `admin-documents`. */
export function draftProblems(draft: SeriesDraft): Partial<Record<'companyId' | 'code' | 'year' | 'pattern' | 'start' | 'digits', string>> {
  const problems: Partial<Record<'companyId' | 'code' | 'year' | 'pattern' | 'start' | 'digits', string>> = {}
  if (!draft.companyId) problems.companyId = 'docs.form.required'
  if (!SERIES_CODE.test(draft.code.trim())) problems.code = 'docs.form.code'
  if (draft.reset === 'YEARLY') {
    const year = wholeNumber(draft.year)
    if (year === null || year < 2000 || year > 2999) problems.year = 'docs.form.year'
  }
  if (!draft.typed) {
    const digits = wholeNumber(draft.digits)
    if (digits === null || digits < 1 || digits > 12) problems.digits = 'docs.form.digits'
  }
  const issue = patternIssue(draftPattern(draft), draft.reset, isFiscalKind(draft.kind))
  if (issue) problems.pattern = issue
  const start = wholeNumber(draft.start)
  if (start === null || start < 1 || start > MAX_NUMBER) problems.start = 'docs.form.start'
  return problems
}

/** The first number the draft will print, or null while it has a problem. */
export function draftPreview(draft: SeriesDraft): string | null {
  const start = wholeNumber(draft.start)
  const year = draft.reset === 'YEARLY' ? wholeNumber(draft.year) : null
  if (start === null || start < 1) return null
  if (patternIssue(draftPattern(draft), draft.reset, isFiscalKind(draft.kind))) return null
  return preview(draftPattern(draft), start, year)
}

/** The body of POST /numbering/series for a draft without problems. */
export function draftBody(draft: SeriesDraft) {
  return {
    companyId: draft.companyId,
    kind: draft.kind,
    code: draft.code.trim(),
    reset: draft.reset,
    ...(draft.reset === 'YEARLY' ? { year: Number.parseInt(draft.year, 10) } : {}),
    pattern: draftPattern(draft),
    startValue: Number.parseInt(draft.start, 10),
  }
}

// ---- the lists ----

const KIND_ORDER = new Map<string, number>(NUMBER_KINDS.map((kind, index) => [kind, index]))

/** The series a list shows: the chosen company's (or all), by company, document, code and newest period. */
export function seriesRows(series: readonly Series[], companyId: string, companies: readonly CompanyOption[]): Series[] {
  const companyOrder = new Map(companies.map((company, index) => [company.id, index]))
  return series
    .filter((row) => companyId === 'all' || row.companyId === companyId)
    .sort(
      (a, b) =>
        (companyOrder.get(a.companyId) ?? 99) - (companyOrder.get(b.companyId) ?? 99) ||
        (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) ||
        a.code.localeCompare(b.code) ||
        b.scopeKey.localeCompare(a.scopeKey),
    )
}

/** Has the series issued a number (its start and pattern are then fixed)? */
export const hasIssued = (series: Pick<Series, 'nextValue' | 'startValue'>) => series.nextValue !== series.startValue

/** The start can still change: active and nothing issued. */
export const startEditable = (series: Series) => series.status === 'ACTIVE' && !hasIssued(series)

/** The fiscal series the Fiscal check proves: active fiscal series that issued a number, newest period first. */
export function fiscalRows(rows: readonly Series[]): Series[] {
  return rows.filter((row) => row.fiscal && row.status === 'ACTIVE')
}

/** The proof of one fiscal series in words: a key of `admin-documents` and its values. */
export function proofWords(series: Series, read: ProofRead | undefined): { key: string; params?: Record<string, string | number>; tone: 'success' | 'warning' | 'neutral' | 'danger' } {
  if (!hasIssued(series)) return { key: 'docs.fiscal.none', tone: 'neutral' }
  if (!read || read.state === 'checking') return { key: 'docs.fiscal.checking', tone: 'neutral' }
  if (read.state === 'failed') return { key: 'docs.fiscal.failed', tone: 'danger' }
  const proof = read.proof
  if (proof.count === 0) return { key: 'docs.fiscal.none', tone: 'neutral' }
  const params = { first: proof.firstFormatted ?? String(proof.first), last: proof.lastFormatted ?? String(proof.last), count: proof.count }
  if (proof.skipped.length > 0) return { key: 'docs.fiscal.skipped', params: { ...params, ranges: skippedWords(proof) }, tone: 'warning' }
  return { key: 'docs.fiscal.noGaps', params, tone: 'success' }
}

/** "3–9, 14" (the numbers this series did not issue between its first and its last). */
export function skippedWords(proof: Pick<SeriesProof, 'skipped' | 'moreSkipped'>): string {
  const ranges = proof.skipped.map((range) => (range.from === range.to ? String(range.from) : `${range.from}–${range.to}`))
  return proof.moreSkipped ? `${ranges.join(', ')}, …` : ranges.join(', ')
}

/** Another active series of the same company and document exists (a new document still gets a number after a close). */
export function hasOtherActive(series: Series, all: readonly Series[]): boolean {
  return all.some((row) => row.id !== series.id && row.companyId === series.companyId && row.kind === series.kind && row.status === 'ACTIVE')
}

/** Why "New series" is held, or null. */
export function newSeriesHeld(model: Pick<DocumentsViewModel, 'can' | 'companies'>): string | null {
  if (!model.can.manage) return 'docs.held.manage'
  if (model.companies.items !== null && model.companies.items.filter((company) => company.status === 'ACTIVE').length === 0) return 'docs.held.noCompany'
  return null
}

/** The company whose data the sample documents show: the chosen one, else the first active one. */
export function sampleCompany(model: Pick<DocumentsViewModel, 'companyId' | 'companies'>): CompanyOption | null {
  const companies = (model.companies.items ?? []).filter((company) => company.status === 'ACTIVE')
  return companies.find((company) => company.id === model.companyId) ?? companies[0] ?? null
}

/**
 * Can the company print its documents? The same rule the API applies before a document (factory-domain
 * documents/legal.ts `legalProblems`, c.c. art. 2250: registered office, VAT number, codice fiscale, REA), so a preview
 * link is offered only when the server will answer it with a PDF.
 */
export function legalOf(company: Company): { legalReady: boolean; legalMissing: number } {
  const missing = legalProblems(company as unknown as CompanyLegal).length
  return { legalReady: missing === 0, legalMissing: missing }
}
