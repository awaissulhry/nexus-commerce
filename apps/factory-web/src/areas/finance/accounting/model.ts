import { lockPhrases, monthLabel, phraseMatches } from '@nexus/factory-domain/accounting/periods'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import {
  ACCOUNTING_PACKAGES,
  CHECK_CODES,
  EXPORT_STATUSES,
  MAX_EXPLANATION,
  PACKAGE_RULES,
  type AccountingPackage,
  type Check,
  type CheckCode,
  type CreateExportBody,
  type ExportFile,
  type ExportRow,
  type ExportStatus,
  type LockLevel,
  type MonthView,
  type PackageContent,
  type PeriodAnswer,
  type PeriodLock,
  type Periods,
} from './api'

/**
 * Finance › Close › Accounting export (SCR-156): the pure rules — who may do what (read: accounting.view; a batch:
 * accounting.export and each package's grain; a lock: accounting.lock; lifting a hard one: accounting.unlock), the page's
 * address (the history, or the wizard on a month and a step), the wizard's steps and what holds Continue (in words, with
 * the count), the packages a person may put in (W2a, the right month, their grain), the checks the chosen packages
 * carry and their explanations, the body of an export, the lock state of a month, the typed phrase of the final close,
 * a history row's actions, the API's refusals as this page's words, and which live events concern it. No fetching, no
 * React: the tests hold them. Nothing is sent to the accountant or to any authority: a person hands the files over.
 */

/** A message key and its values, translated by the view (`finance-accounting` catalogue). */
export interface Phrase {
  readonly key: string
  readonly params?: Record<string, string | number>
}
const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface AccountingCan {
  readonly view: boolean
  readonly export: boolean
  readonly lock: boolean
  /** Lifting a hard lock (with a fresh step-up): the owner, by default. */
  readonly unlock: boolean
  readonly price: boolean
  readonly cost: boolean
}

export function accountingCanOf(permissions: readonly string[]): AccountingCan {
  const held = new Set(permissions)
  return {
    view: held.has('accounting.view'),
    export: held.has('accounting.export'),
    lock: held.has('accounting.lock'),
    unlock: held.has('accounting.unlock'),
    price: held.has('money.price'),
    cost: held.has('money.cost'),
  }
}

const grainHeld = (grain: 'price' | 'cost', can: Pick<AccountingCan, 'price' | 'cost'>): boolean => (grain === 'price' ? can.price : can.cost)

// ---- months and the address ------------------------------------------------------------------------------------------------

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/
export const isMonth = (value: string | null | undefined): value is string => typeof value === 'string' && MONTH.test(value)

/** `October 2026` / `ottobre 2026` (the month's own words). */
export const monthWords = (month: string, locale: Locale): string => monthLabel(month, locale === 'it' ? 'it' : 'en')

/** Today in Rome, YYYY-MM-DD. */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** The month `delta` months from this one (`2026-01`, −1 → `2025-12`). */
export function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4))
  const index = year * 12 + Number(month.slice(5, 7)) - 1 + delta
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

export const WIZARD_STEPS = ['period', 'checks', 'contents', 'intrastat', 'review', 'export'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

/** The wizard's steps for these packages: "Intrastat rows" only when Intrastat goes in. */
export const stepsFor = (chosen: readonly AccountingPackage[] | null): WizardStep[] => WIZARD_STEPS.filter((step) => step !== 'intrastat' || !!chosen?.includes('INTRASTAT'))

export interface AccountingAddress {
  /** The wizard (`?new=1`, or `?month=`), else the history. */
  readonly wizard: boolean
  readonly month: string | null
  readonly step: WizardStep
  /** The history's filters (the API's own). */
  readonly status: ExportStatus | null
  readonly year: number | null
  /** The lock dialog on a month (`?lock=YYYY-MM`, or `?lock=1` to choose one). */
  readonly lock: string | null
}

export function addressOf(params: { get(name: string): string | null } | null): AccountingAddress {
  const month = params?.get('month') ?? null
  const step = params?.get('step') ?? null
  const status = params?.get('status') ?? null
  const year = Number(params?.get('year') ?? '')
  const lock = params?.get('lock') ?? null
  const wizard = params?.get('new') === '1' || isMonth(month)
  return {
    wizard,
    month: isMonth(month) ? month : null,
    step: (WIZARD_STEPS as readonly string[]).includes(step ?? '') ? (step as WizardStep) : isMonth(month) ? 'checks' : 'period',
    status: (EXPORT_STATUSES as readonly string[]).includes(status ?? '') ? (status as ExportStatus) : null,
    year: Number.isInteger(year) && year >= 2000 && year <= 2999 ? year : null,
    lock: lock === '1' || isMonth(lock) ? lock : null,
  }
}

export const accountingHref = (prefix: string, query: Readonly<Record<string, string | null | undefined>> = {}): string => {
  const qs = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')).toString()
  return `${prefix}/finance/accounting${qs ? `?${qs}` : ''}`
}

/** The wizard on a month and step (no month: `?new=1`, step 1). */
export const wizardHref = (prefix: string, month: string | null, step: WizardStep = month ? 'checks' : 'period'): string => (month ? accountingHref(prefix, { month, step }) : accountingHref(prefix, { new: '1' }))

/** The files of one batch or several, in a new tab (design tab:files). */
export const filesHref = (prefix: string, exportIds: readonly string[]): string =>
  exportIds.length === 1 ? `${prefix}/finance/accounting/files?export=${encodeURIComponent(exportIds[0]!)}` : `${prefix}/finance/accounting/files?exports=${exportIds.map(encodeURIComponent).join(',')}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The batches the files tab shows (`?export=` or `?exports=a,b`), at most 20. */
export function filesAddressOf(params: { get(name: string): string | null } | null): string[] {
  const one = params?.get('export')
  const many = params?.get('exports')
  const ids = [...(one ? [one] : []), ...(many ? many.split(',') : [])].map((id) => id.trim()).filter((id) => UUID.test(id))
  return [...new Set(ids)].slice(0, 20)
}

// ---- packages --------------------------------------------------------------------------------------------------------------

/** Why a package cannot go in this export (null: it can): a later wave, not the year end, the person's grain. */
export function packageHeld(pkg: AccountingPackage, facts: { readonly yearEnd: boolean }, can: Pick<AccountingCan, 'price' | 'cost'>): Phrase | null {
  const rule = PACKAGE_RULES[pkg]
  if (rule.wave !== 'W2a') return phrase('contents.held.w2b')
  if (pkg === 'YEAR_END_STOCK' && !facts.yearEnd) return phrase('contents.held.yearEnd')
  if (!grainHeld(rule.grain, can)) return phrase(`contents.held.grain.${rule.grain}`)
  return null
}

/** The packages the API is asked for on this month: every one the person may put in. */
export const askablePackages = (yearEnd: boolean, can: Pick<AccountingCan, 'price' | 'cost'>): AccountingPackage[] => ACCOUNTING_PACKAGES.filter((pkg) => packageHeld(pkg, { yearEnd }, can) === null)

/**
 * The packages ticked when the month is first read: the three journals, the year-end stock pack at the year end, and
 * Intrastat when the month has EU sale rows (whether the company files Intrastat at all is to confirm with the
 * accountant: the person may untick it) — each only when the person may put it in.
 */
export function defaultPackages(answer: Pick<PeriodAnswer, 'yearEnd' | 'intrastat'>, can: Pick<AccountingCan, 'price' | 'cost'>): AccountingPackage[] {
  const wanted: AccountingPackage[] = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', ...(answer.yearEnd ? (['YEAR_END_STOCK'] as const) : []), ...((answer.intrastat?.rows ?? 0) > 0 ? (['INTRASTAT'] as const) : [])]
  return ACCOUNTING_PACKAGES.filter((pkg) => wanted.includes(pkg) && packageHeld(pkg, { yearEnd: answer.yearEnd }, can) === null)
}

export const togglePackage = (chosen: readonly AccountingPackage[], pkg: AccountingPackage): AccountingPackage[] =>
  ACCOUNTING_PACKAGES.filter((entry) => (entry === pkg ? !chosen.includes(pkg) : chosen.includes(entry)))

/** The checks an export of these packages carries (factory-domain accounting/checks checksFor), in order. */
export function checksFor(packages: readonly AccountingPackage[]): CheckCode[] {
  const wanted = new Set(packages)
  return CHECK_CODES.filter((code) => {
    if (code === 'INTRASTAT_COMPLETE') return wanted.has('INTRASTAT')
    if (code === 'YEAR_END_SIGNED_OFF' || code === 'STOCK_VALUED') return wanted.has('YEAR_END_STOCK')
    return true
  })
}

/** The month's checks the chosen packages carry. */
export const checksOf = (answer: Pick<PeriodAnswer, 'checks'>, chosen: readonly AccountingPackage[]): Check[] => {
  const codes = new Set(checksFor(chosen))
  return answer.checks.filter((check) => codes.has(check.code))
}

export type Explanations = Readonly<Partial<Record<CheckCode, string>>>

const explained = (explanations: Explanations, code: CheckCode): boolean => {
  const text = explanations[code]?.trim() ?? ''
  return text.length > 0 && text.length <= MAX_EXPLANATION
}

/** The failing checks with no explanation yet (they hold Continue and Export). */
export const unexplainedOf = (checks: readonly Check[], explanations: Explanations): Check[] => checks.filter((check) => !check.passed && !explained(explanations, check.code))

/** The explanations an export sends: one per failing check of the chosen packages. */
export const explanationsBody = (checks: readonly Check[], explanations: Explanations): CreateExportBody['explanations'] =>
  checks.filter((check) => !check.passed && explained(explanations, check.code)).map((check) => ({ code: check.code, explanation: explanations[check.code]!.trim() }))

/** A package's content in this export: its documents against the batches before, its rows, its sums. */
export const contentOf = (answer: Pick<PeriodAnswer, 'contents'>, pkg: AccountingPackage): PackageContent | null => answer.contents.find((entry) => entry.package === pkg) ?? null

/** The documents of a package that would go in a re-export (new, changed, removed). */
export const changesOf = (content: Pick<PackageContent, 'documents'> | null): number => (content ? content.documents.new + content.documents.changed + content.documents.removed : 0)

/**
 * What the batch will carry: a first export carries every chosen package; a re-export only the packages where something
 * changed (a journal: its new, changed and removed documents; Intrastat and the year-end pack: the whole file again).
 */
export function batchPackages(answer: Pick<PeriodAnswer, 'contents' | 'reExportOf'>, chosen: readonly AccountingPackage[]): AccountingPackage[] {
  if (!answer.reExportOf) return [...chosen]
  return chosen.filter((pkg) => changesOf(contentOf(answer, pkg)) > 0)
}

// ---- the wizard: what holds each step ------------------------------------------------------------------------------------------

export interface WizardFacts {
  readonly month: string | null
  readonly answer: PeriodAnswer | null
  readonly problem: string | null
  readonly chosen: readonly AccountingPackage[] | null
  readonly explanations: Explanations
  readonly can: AccountingCan
}

/** Why the step's Continue is held (null: it may go on). A held Continue says why, never greys out. */
export function continueHeld(step: WizardStep, facts: WizardFacts): Phrase | null {
  if (!facts.month) return phrase('held.chooseMonth')
  if (step === 'export') return null
  if (facts.problem) return phrase('held.readFailed')
  if (!facts.answer || !facts.chosen) return phrase('held.reading')
  const checks = checksOf(facts.answer, facts.chosen)
  const unexplained = unexplainedOf(checks, facts.explanations)
  if (step === 'checks' && unexplained.length > 0) return phrase('held.checks', { count: unexplained.length })
  if (step === 'contents' && facts.chosen.length === 0) return phrase('held.noPackage')
  if (step === 'intrastat' && unexplained.some((check) => check.code === 'INTRASTAT_COMPLETE')) return phrase('held.intrastat')
  if (step === 'review') {
    if (facts.chosen.length === 0) return phrase('held.noPackage')
    if (unexplained.length > 0) return phrase('held.checks', { count: unexplained.length })
    if (facts.answer.reExportOf && batchPackages(facts.answer, facts.chosen).length === 0) return phrase('held.nothingChanged', { number: facts.answer.reExportOf.number ?? '' })
  }
  return null
}

/** The step "Show me" opens for a held Continue: the first failing check without its explanation lives on 2 · Checks. */
export function showMeStep(step: WizardStep, facts: WizardFacts): WizardStep | null {
  if (!facts.answer || !facts.chosen) return null
  const unexplained = unexplainedOf(checksOf(facts.answer, facts.chosen), facts.explanations)
  if (unexplained.length === 0) return facts.chosen.length === 0 && step !== 'contents' ? 'contents' : null
  return step === 'checks' ? null : 'checks'
}

/** Why Export is held (null: it may be made). */
export function exportHeld(facts: WizardFacts & { readonly busy: boolean }): Phrase | null {
  if (!facts.can.export) return phrase('held.noExport')
  if (facts.busy) return phrase('held.busy')
  const earlier = continueHeld('review', facts)
  if (earlier) return earlier
  for (const pkg of facts.chosen ?? []) {
    const held = packageHeld(pkg, { yearEnd: facts.answer?.yearEnd ?? false }, facts.can)
    if (held) return held
  }
  return null
}

/** The export's body: the month, the chosen packages, the failing checks' explanations, a re-export's batch, the files' language. */
export function exportBody(input: { readonly companyId: string; readonly month: string; readonly answer: PeriodAnswer; readonly chosen: readonly AccountingPackage[]; readonly explanations: Explanations; readonly note: string; readonly language: 'it' | 'en' }): CreateExportBody {
  const checks = checksOf(input.answer, input.chosen)
  const note = input.note.trim()
  return {
    companyId: input.companyId,
    month: input.month,
    packages: batchPackages(input.answer, input.chosen),
    explanations: explanationsBody(checks, input.explanations),
    ...(input.answer.reExportOf ? { supersedesId: input.answer.reExportOf.id } : {}),
    ...(note ? { note: note.slice(0, 1000) } : {}),
    language: input.language,
  }
}

/** The checks that failed when the month was read and pass in a newer read ("2 checks fixed since you opened this"). */
export function fixedSince(before: Pick<PeriodAnswer, 'checks'> | null, after: Pick<PeriodAnswer, 'checks'> | null, chosen: readonly AccountingPackage[]): CheckCode[] {
  if (!before || !after) return []
  const codes = new Set(checksFor(chosen))
  const failing = new Set(before.checks.filter((check) => codes.has(check.code) && !check.passed).map((check) => check.code))
  return after.checks.filter((check) => failing.has(check.code) && check.passed).map((check) => check.code)
}

/** A newer read of the month differs from the one on screen (checks, documents, the next number, the lock). */
export function periodChanged(before: PeriodAnswer | null, after: PeriodAnswer | null): boolean {
  if (!before || !after) return false
  const shape = (answer: PeriodAnswer) =>
    JSON.stringify([answer.checks.map((check) => [check.code, check.passed, check.count]), answer.contents.map((entry) => [entry.package, entry.documents, entry.rows]), answer.nextNumber, answer.lock?.version ?? null, answer.reExportOf?.id ?? null])
  return shape(before) !== shape(after)
}

// ---- checks in words ---------------------------------------------------------------------------------------------------------

/** A check's sentence (`check.<CODE>.pass` / `.fail`, with its count and the month). */
export function checkPhrase(check: Pick<Check, 'code' | 'passed' | 'count'>, month: string, end: string, locale: Locale): Phrase {
  return phrase(`check.${check.code}.${check.passed ? 'pass' : 'fail'}`, { count: check.count, month: monthWords(month, locale), end })
}

/** A record a check or a flag names, as words: `fix.<Type>` with its number. */
export const fixLabel = (fix: { readonly recordType: string; readonly number?: string | null }): Phrase =>
  phrase(['Ddt', 'Invoice', 'Payment', 'Style', 'Party', 'StockCount', 'Site'].includes(fix.recordType) ? `fix.${fix.recordType}` : 'fix.other', { number: fix.number ?? '' })

/** The field to fill there, as words (`field.<name>`), or null. */
export const fieldLabel = (field: string | null): Phrase | null => (field && ['hsCode', 'originCountry', 'netMassKg', 'taxIdentity', 'incoterm'].includes(field) ? phrase(`field.${field}`) : null)

// ---- the period lock -----------------------------------------------------------------------------------------------------

export type LockState = 'open' | 'soft' | 'hard' | 'lifted'

export const lockStateOf = (lock: { readonly level: LockLevel; readonly status: 'LOCKED' | 'UNLOCKED' } | null): LockState => (!lock ? 'open' : lock.status === 'UNLOCKED' ? 'lifted' : lock.level === 'HARD' ? 'hard' : 'soft')

export const LOCK_TONE: Readonly<Record<LockState, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = { open: 'neutral', soft: 'warning', hard: 'success', lifted: 'info' }

/** The typed phrase that closes the month for good, in the person's language (the API takes either language). */
export const phraseFor = (month: string, locale: Locale): string => lockPhrases(month)[locale === 'it' ? 'it' : 'en']

/** The typed phrase closes this month (either language; case and spaces free, as the API reads it). */
export const phraseOk = (month: string, typed: string): boolean => phraseMatches(month, typed)

/** The typed phrase as the person types it: nothing yet, on the way, wrong, right (our own words; the DS field's are English). */
export function phraseState(month: string, typed: string, locale: Locale): 'empty' | 'partial' | 'mismatch' | 'match' {
  if (typed.trim() === '') return 'empty'
  if (phraseOk(month, typed)) return 'match'
  const fold = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trimStart().toLowerCase()
  const target = fold(phraseFor(month, locale))
  const other = fold(phraseFor(month, locale === 'it' ? 'en' : 'it'))
  const now = fold(typed)
  return target.startsWith(now) || other.startsWith(now) ? 'partial' : 'mismatch'
}

export interface LockFacts {
  readonly month: string | null
  readonly level: LockLevel
  readonly phrase: string
  /** The month's lock now (null: never locked). */
  readonly current: Pick<PeriodLock, 'level' | 'status'> | null
  readonly can: Pick<AccountingCan, 'lock'>
  readonly busy: boolean
}

/** Why locking is held (null: it may be locked). */
export function lockHeld(facts: LockFacts): Phrase | null {
  if (!facts.can.lock) return phrase('lock.held.noLock')
  if (!facts.month) return phrase('lock.held.chooseMonth')
  if (facts.busy) return phrase('held.busy')
  if (facts.current?.status === 'LOCKED' && facts.current.level === facts.level) return phrase(facts.level === 'HARD' ? 'lock.held.alreadyHard' : 'lock.held.alreadySoft')
  if (facts.current?.status === 'LOCKED' && facts.current.level === 'HARD') return phrase('lock.held.hardFirst')
  if (facts.level === 'HARD' && !phraseOk(facts.month, facts.phrase)) return phrase('lock.held.phrase')
  return null
}

/** Why lifting is held (null: it may be lifted): a soft lock needs accounting.lock, a hard one accounting.unlock; a reason. */
export function liftHeld(lock: Pick<PeriodLock, 'level' | 'status'> | null, reason: string, can: Pick<AccountingCan, 'lock' | 'unlock'>, busy: boolean): Phrase | null {
  if (!lock || lock.status !== 'LOCKED') return phrase('lift.held.notLocked')
  if (lock.level === 'HARD' ? !can.unlock : !can.lock) return phrase(lock.level === 'HARD' ? 'lift.held.noUnlock' : 'lock.held.noLock')
  if (busy) return phrase('held.busy')
  if (reason.trim() === '') return phrase('lift.held.reason')
  return null
}

/** The current month and the two before, with their lock (the band's pills: "October open · September soft-locked"). */
export function recentMonths(today: string, years: readonly (Periods | null)[], count = 3): Array<{ month: string; state: LockState; exported: string | null }> {
  const months = new Map<string, MonthView>()
  for (const year of years) for (const entry of year?.months ?? []) months.set(entry.period.month, entry)
  const current = today.slice(0, 7)
  return Array.from({ length: count }, (_, index) => shiftMonth(current, -index)).map((month) => {
    const entry = months.get(month)
    return { month, state: lockStateOf(entry?.lock ?? null), exported: entry?.latest?.number ?? null }
  })
}

// ---- the history ---------------------------------------------------------------------------------------------------------------

/** Why a batch cannot be re-exported from its row (null: it may). */
export function reExportHeld(row: Pick<ExportRow, 'status' | 'supersededBy' | 'changedSince' | 'number'>, can: Pick<AccountingCan, 'export'>): Phrase | null {
  if (!can.export) return phrase('held.noExport')
  if (row.status !== 'EXPORTED') return phrase('history.held.notExported')
  if (row.supersededBy) return phrase('history.held.notLatest', { number: row.supersededBy.number ?? '' })
  if (row.changedSince && row.changedSince.count === 0) return phrase('history.held.nothingChanged', { number: row.number ?? '' })
  return null
}

/** Why a batch cannot be cancelled (null: it may: only a draft). */
export function cancelHeld(row: Pick<ExportRow, 'status'>, can: Pick<AccountingCan, 'export'>): Phrase | null {
  if (!can.export) return phrase('held.noExport')
  if (row.status !== 'DRAFT') return phrase('history.held.notDraft')
  return null
}

/** A batch without files cannot be chosen for "Files of N batches" (the reason on its box). */
export const rowSelectable = (row: Pick<ExportRow, 'files' | 'status'>): Phrase | null =>
  row.files.length > 0 ? null : phrase(row.status === 'DRAFT' ? 'history.unselectable.draft' : row.status === 'CANCELLED' ? 'history.unselectable.cancelled' : 'history.unselectable.noFiles')

/** Why a file of a batch cannot be downloaded by this person: its package's grain. */
export function fileHeld(file: Pick<ExportFile, 'package'>, can: Pick<AccountingCan, 'view' | 'price' | 'cost'>): Phrase | null {
  if (!can.view) return phrase('files.held.noView')
  const grain = PACKAGE_RULES[file.package].grain
  return grainHeld(grain, can) ? null : phrase(`contents.held.grain.${grain}`)
}

// ---- the API in this page's words -----------------------------------------------------------------------------------------

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid'].includes(error.kind)) return `problem.read.${error.kind}`
  return 'problem.read.internal'
}

export interface WriteProblem extends Phrase {
  /** The month or the record changed meanwhile: read it again. */
  readonly reload: boolean
}

/** The refusal codes the screens say in their own words (`problem/<CODE>` from the API). */
export const REFUSAL_CODES = [
  'ALREADY_EXPORTED',
  'EXPORTED_MEANWHILE',
  'NOTHING_CHANGED',
  'NOT_LATEST',
  'NOTHING_EXPORTED',
  'PACKAGE_W2B',
  'YEAR_END_NOT_THIS_PERIOD',
  'PACKAGE_GRAIN',
  'NOT_DRAFT',
  'CANCELLED',
  'ALREADY_LOCKED',
  'HARD_LOCKED',
  'OVERLAPS',
  'NOT_LOCKED',
  'CHANGED',
  'INVOICE_REJECTED',
  'STOCK_NOT_VALUED',
  'YEAR_END_COUNT_OPEN',
  'YEAR_END_COUNT_MISSING',
] as const

const RELOAD = new Set(['ALREADY_EXPORTED', 'EXPORTED_MEANWHILE', 'NOT_LATEST', 'NOTHING_EXPORTED', 'CANCELLED', 'CHANGED', 'NOT_LOCKED', 'NOT_DRAFT'])

/** A refused write as words (never the API's English). */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.write.internal', reload: false }
  const paths = error.issues.map(issuePath)
  const refusal = paths.map((path) => /^problem[/.]([A-Z_]+)$/.exec(path)?.[1]).find((code): code is string => !!code && (REFUSAL_CODES as readonly string[]).includes(code))
  if (refusal) return { key: `refusal.${refusal}`, reload: RELOAD.has(refusal) }
  const explanation = paths.map((path) => /^body[/.]explanations[/.]([A-Z_]+)$/.exec(path)?.[1]).find((code): code is string => !!code)
  if (explanation) return { key: 'problem.write.explain', reload: true }
  if (paths.some((path) => /^body[/.]phrase/.test(path))) return { key: 'problem.write.phrase', reload: false }
  if (error.kind === 'conflict') return { key: paths.some((path) => path.split(/[./]/).includes('version')) ? 'problem.write.moved' : 'problem.write.changedWhile', reload: true }
  if (['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'step_up', 'invalid'].includes(error.kind)) return { key: `problem.write.${error.kind}`, reload: error.kind === 'not_found' }
  return { key: 'problem.write.internal', reload: false }
}

/** The warnings of a soft lock (what a hard lock would wait for), as words. */
export const warningKey = (code: string): string => ((REFUSAL_CODES as readonly string[]).includes(code) ? `refusal.${code}` : 'refusal.other')

// ---- live -------------------------------------------------------------------------------------------------------------------

/** The history and the band: a batch made or cancelled, a month locked or lifted. */
export const historyTouches = (change: { type: string }): boolean => change.type.startsWith('accounting_export.') || change.type.startsWith('period_lock.')

/** The wizard's month: anything behind a check or a package (invoices, payments, DDTs and shipments, styles and customers, counts). */
export const periodTouches = (change: { type: string }): boolean =>
  historyTouches(change) ||
  ['invoice.', 'payment.', 'ddt.', 'shipment.', 'style.', 'party.', 'inventory.count_'].some((prefix) => change.type.startsWith(prefix))
