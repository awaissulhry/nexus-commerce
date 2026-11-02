import { isApiError, issuePath } from '../../../lib/api/errors'
import { ratePerPieceOf } from '@nexus/factory-domain/people/piecerates/rates'
import { TRIAL_ENDING_DAYS } from '@nexus/factory-domain/people/piecerates/rates'
import { PRECONDITION_PAGE } from '@nexus/factory-domain/people/piecerates/switch'
import { EARNINGS_KINDS, EARNINGS_REFUSALS } from '@nexus/factory-domain/people/earnings/rules'
import { SCHEME_REFUSALS } from '@nexus/factory-domain/people/schemes/rules'
import { termsOf } from '@nexus/factory-domain/people/schemes/rules'
import { VERSION_REFUSALS } from '@nexus/factory-domain/people/piecerates/rates'
import type { ChangeReason, EarningsKind, HeldRow, HoldStatus, OverviewSite, PeriodDetail, PeriodRow, PeriodStatus, Precondition, PreconditionCode, RateBasis, RateBody, RateRow, RateView, SchemeBody, SchemeDetail, SwitchView, VersionDetail, VersionState } from './api'

/**
 * The pure rules of People › Piece rates (B-W2b-62): what this person may do (the API checks each again), the page's address,
 * when the person-side sections exist at all (a site's switch that was never on shows the gate and nothing of a person), the
 * API's facts in our words (never its English), the drafts of the pop-ups, and the walk through a period's statements. No
 * name, no filter and no group by person: a person is opened as one record (Owner answer W1).
 */

export type Words = { readonly key: string; readonly params?: Readonly<Record<string, string | number>> }
export const NAMESPACE = 'piecerates'

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface PieceCan {
  /** people.piecerates.view: the gate, the rates (operations and SMVs without the pay grain), the schemes. */
  view: boolean
  /** people.piecerates.manage: rate tables, versions, publishing, preconditions, schemes. */
  manage: boolean
  /** people.piecerates.switch: Start piece pay and stop it. */
  switch: boolean
  /** people.earnings.view: pay periods, held scans, the tiles' counts. */
  earnings: boolean
  /** people.earnings.records: one person's figures, the ledger (with the pay grain). */
  records: boolean
  /** people.earnings.manage: run, review, lock, approve, correct, resolve. */
  managePay: boolean
  /** people.earnings.review: a lead opens a statement of someone they lead, through the gate, and says it looks right. */
  review: boolean
  /** money.pay: the pay grain. */
  pay: boolean
  /** people.efficiency.view: the standard review tile. */
  efficiency: boolean
  /** product.operations / styles: the pickers of a new rate. */
  operations: boolean
  styles: boolean
  /** sites.view / workorders.view: where the lines come from. */
  sites: boolean
  floorLines: boolean
}

export function pieceCan(permissions: readonly string[]): PieceCan {
  const held = new Set(permissions)
  return {
    view: held.has('people.piecerates.view'),
    manage: held.has('people.piecerates.manage'),
    switch: held.has('people.piecerates.switch'),
    earnings: held.has('people.earnings.view'),
    records: held.has('people.earnings.records'),
    managePay: held.has('people.earnings.manage'),
    review: held.has('people.earnings.review'),
    pay: held.has('money.pay'),
    efficiency: held.has('people.efficiency.view'),
    operations: held.has('product.routing.view'),
    styles: held.has('product.styles.view'),
    sites: held.has('sites.view'),
    floorLines: held.has('workorders.view'),
  }
}

/** The right to one person's figures: the permission AND the pay grain (B-W2b-43). */
export const hasRight = (can: Pick<PieceCan, 'records' | 'pay'>): boolean => can.records && can.pay

// ---- the address -------------------------------------------------------------------------------------------------------------

export const RATE_TILES = ['TRIAL', 'UNREAD'] as const
export type RateTile = (typeof RATE_TILES)[number]

export interface PieceAddress {
  tile: RateTile | null
  /** Every version of every table, or what is in force, to come and in draft. */
  allVersions: boolean
  q: string
  /** A rate version's record. */
  open: string | null
  /** A pay period's record. */
  period: string | null
  /** The top bar's site, written for the ledger's export (a view's filters are the list's own address terms). */
  site: string | null
  ledgerPeriod: string | null
  ledgerLine: string | null
  ledgerKind: EarningsKind | null
  /** Held scans: every state, not only those waiting. */
  heldAll: boolean
  /** A held scan's Resolve. */
  resolve: string | null
  /** A ledger entry's record. */
  entry: string | null
}

type Params = { get(name: string): string | null } | null | undefined

export function pieceAddressOf(params: Params): PieceAddress {
  const term = (name: string) => params?.get(name) || null
  const tile = term('tile')
  const kind = term('ledgerKind')
  return {
    tile: (RATE_TILES as readonly string[]).includes(tile ?? '') ? (tile as RateTile) : null,
    allVersions: term('rates') === 'all',
    q: term('q') ?? '',
    open: term('open'),
    period: term('period'),
    site: term('site'),
    ledgerPeriod: term('ledgerPeriod'),
    ledgerLine: term('ledgerLine'),
    ledgerKind: (EARNINGS_KINDS as readonly string[]).includes(kind ?? '') ? (kind as EarningsKind) : null,
    heldAll: term('held') === 'all',
    resolve: term('resolve'),
    entry: term('entry'),
  }
}

const OWN_TERMS = ['tile', 'rates', 'q', 'open', 'period', 'site', 'ledgerPeriod', 'ledgerLine', 'ledgerKind', 'held', 'resolve', 'entry']

/** The address of a state; `keep` holds the terms other parts of the page own (the list frame's saved view). */
export function pieceAddressText(address: PieceAddress, keep?: URLSearchParams): string {
  const out = new URLSearchParams(keep?.toString() ?? '')
  for (const name of OWN_TERMS) out.delete(name)
  const put = (name: string, value: string | null | false) => {
    if (value) out.set(name, value)
  }
  put('site', address.site)
  put('tile', address.tile)
  put('rates', address.allVersions && 'all')
  put('q', address.q.trim() || null)
  put('open', address.open)
  put('period', address.period)
  put('ledgerPeriod', address.ledgerPeriod)
  put('ledgerLine', address.ledgerLine)
  put('ledgerKind', address.ledgerKind)
  put('held', address.heldAll && 'all')
  put('resolve', address.resolve)
  put('entry', address.entry)
  const text = out.toString()
  return text ? `?${text}` : ''
}

// ---- the switch --------------------------------------------------------------------------------------------------------------

/** Piece pay was on here, now or in an earlier window: only then does the page show periods, the ledger and held scans. */
export const everOn = (view: Pick<SwitchView, 'state' | 'onFrom' | 'earlierWindows'>): boolean => view.state === 'ON' || view.onFrom !== null || view.earlierWindows.length > 0
export const everOnRow = (row: OverviewSite): boolean => row.switch.state === 'ON' || row.switch.onFrom !== null

/** Where a precondition is kept: the page's address, a section of this page, or null while that page is not built. */
export function preconditionHref(code: PreconditionCode, prefix: string, built: (path: string) => boolean): string | null {
  if (code === 'SCHEME') return '#scheme'
  if (code === 'RATES_PUBLISHED') return '#rates'
  const page = PRECONDITION_PAGE[code]
  if (!page) return null
  const path = `/${page.replace('.', '/')}`
  return built(path) ? `${prefix}${path}` : null
}

const WORDS_OF: Readonly<Record<PreconditionCode, (item: Precondition, view: SwitchView) => Words>> = {
  SITE_BASIS: (item): Words => {
    if (item.met) return { key: 'gate.SITE_BASIS.met', params: { reference: /\((.+)\)\.$/.exec(item.words)?.[1] ?? '' } }
    return { key: /record the station/.test(item.words) ? 'gate.SITE_BASIS.station' : 'gate.SITE_BASIS.noBasis' }
  },
  PERFORMANCE_GATE: (item) => ({ key: item.met ? 'gate.PERFORMANCE_GATE.met' : 'gate.PERFORMANCE_GATE.off' }),
  WORKER_NOTICE: (item, view): Words => {
    const notice = view.recorded.workerNotice
    if (!notice) return { key: 'gate.WORKER_NOTICE.none' }
    return { key: item.met ? 'gate.WORKER_NOTICE.met' : 'gate.WORKER_NOTICE.wrong', params: { label: notice.label } }
  },
  DPIA: (item, view): Words => {
    const dpia = view.recorded.dpia
    if (!dpia) return { key: 'gate.DPIA.none' }
    return { key: item.met ? 'gate.DPIA.met' : 'gate.DPIA.wrong', params: { version: dpia.versionNo } }
  },
  CCNL: (item, view): Words => (item.met ? { key: 'gate.CCNL.met', params: { name: view.recorded.ccnlName ?? '', article: view.recorded.ccnlArticle ?? '' } } : { key: 'gate.CCNL.none' }),
  CONSULTANT: (item, view): Words => {
    const { consultantName: name, consultantAgreedOn: day } = view.recorded
    if (item.met) return { key: 'gate.CONSULTANT.met', params: { name: name ?? '', day: day ?? '' } }
    return name && day ? { key: 'gate.CONSULTANT.later', params: { day } } : { key: 'gate.CONSULTANT.none' }
  },
  SCHEME: (item, view): Words => {
    const scheme = view.recorded.scheme
    if (!scheme) return { key: 'gate.SCHEME.none' }
    if (item.met) return { key: 'gate.SCHEME.met', params: { name: scheme.name, day: scheme.validFrom } }
    if (scheme.status !== 'ACTIVE') return { key: 'gate.SCHEME.notActive', params: { name: scheme.name } }
    return { key: /another site/.test(item.words) ? 'gate.SCHEME.otherSite' : 'gate.SCHEME.notInForce', params: { name: scheme.name, day: scheme.validFrom } }
  },
  RATES_PUBLISHED: (item): Words => {
    const told = /^(\d+) of (\d+) active workers/.exec(item.words)
    if (told) return { key: 'gate.RATES_PUBLISHED.notTold', params: { count: Number(told[1]), of: Number(told[2]) } }
    const all = /to all (\d+) active workers/.exec(item.words)
    if (all) return { key: 'gate.RATES_PUBLISHED.met', params: { count: Number(all[1]) } }
    return { key: /no active worker/.test(item.words) ? 'gate.RATES_PUBLISHED.noWorkers' : 'gate.RATES_PUBLISHED.noRates' }
  },
  EARNING_CODES: (item): Words => {
    if (item.met) return { key: 'gate.EARNING_CODES.met', params: { count: Number(/\((\d+)\)/.exec(item.words)?.[1] ?? 0) } }
    const codes = /yet: (.+)\.$/.exec(item.words)?.[1]
    return codes ? { key: 'gate.EARNING_CODES.unmapped', params: { codes } } : { key: 'gate.EARNING_CODES.none' }
  },
}

/** A precondition in our words: from the facts on the switch, or read from the API's sentence (a test runs them all). */
export function preconditionWords(item: Precondition, view: SwitchView, locale = 'en'): Words {
  const words = WORDS_OF[item.code](item, view)
  const day = words.params?.day
  return typeof day === 'string' && day ? { ...words, params: { ...words.params, day: dayText(day, locale) ?? day } } : words
}

/** The first day a start can name. */
export const startDayFloor = (view: Pick<SwitchView, 'today' | 'offFrom'>): string => (view.offFrom && view.offFrom > view.today ? view.offFrom : view.today)

// ---- refusals ----------------------------------------------------------------------------------------------------------------

const REFUSALS = new Set<string>([...VERSION_REFUSALS, ...SCHEME_REFUSALS, ...EARNINGS_REFUSALS])

export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && REFUSALS.has(path.slice('refusal/'.length))) return path.slice('refusal/'.length)
  }
  return null
}

/** Each precondition a refused start names (`preconditions/<CODE>`), in the API's order. */
export function missingOf(error: unknown): PreconditionCode[] {
  if (!isApiError(error)) return []
  return error.issues.flatMap((issue) => {
    const path = issuePath(issue)
    return path.startsWith('preconditions/') ? [path.slice('preconditions/'.length) as PreconditionCode] : []
  })
}

/** What an API error says, in this page's words. */
export function problemWords(error: unknown): Words {
  const code = refusalCode(error)
  if (code) return { key: `refusal.${code}` }
  if (missingOf(error).length > 0) return { key: 'problem.preconditions' }
  if (!isApiError(error)) return { key: 'problem.unavailable' }
  // A document refused because the company's legal data are incomplete (c.c. art. 2250): the fix is in Admin.
  if (error.issues.some((issue) => issuePath(issue).startsWith('company/'))) return { key: 'problem.companyData' }
  switch (error.kind) {
    case 'invalid':
      return { key: 'problem.invalid' }
    case 'signed_out':
      return { key: 'problem.signedOut' }
    case 'forbidden':
      return { key: 'problem.forbidden' }
    case 'step_up':
      return { key: 'problem.stepUp' }
    case 'not_found':
      return { key: 'problem.notFound' }
    case 'conflict':
      return { key: 'problem.conflict' }
    default:
      return { key: 'problem.unavailable' }
  }
}

// ---- figures -----------------------------------------------------------------------------------------------------------------

/** An amount in minor units, or null while the grain or the group hides it. */
export function moneyText(minor: number | null | undefined, currency: string, locale: string): string | null {
  if (minor === null || minor === undefined) return null
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency }).format(minor / 100)
}

/** A rate: at least two decimals, up to six. */
export function rateText(value: string | null | undefined, currency: string, locale: string): string | null {
  if (value === null || value === undefined) return null
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(Number(value))
}

export function minutesText(value: string | number | null | undefined, locale: string): string | null {
  if (value === null || value === undefined) return null
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 3 }).format(Number(value))
}

export const dayText = (day: string | null | undefined, locale: string): string | null =>
  day ? new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00.000Z`)) : null

export function monthText(month: string, locale: string): string {
  const [year, number] = month.split('-').map(Number)
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year ?? 1970, (number ?? 1) - 1, 1)))
}

// ---- the rate table ----------------------------------------------------------------------------------------------------------

/** The rows a tile keeps: trial ending in 14 days or ended; read by fewer than it went to. */
export function rowsOfTile(rows: readonly RateRow[], tile: RateTile | null, today: string): RateRow[] {
  if (!tile) return [...rows]
  if (tile === 'UNREAD') return rows.filter((row) => row.version.readBy.of > row.version.readBy.read)
  const until = new Date(`${today}T12:00:00.000Z`)
  until.setUTCDate(until.getUTCDate() + TRIAL_ENDING_DAYS)
  const last = until.toISOString().slice(0, 10)
  return rows.filter((row) => row.version.state === 'PROVISIONAL' && row.version.trialEndsOn !== null && row.version.trialEndsOn <= last)
}

/** The table's rows grouped by style: the general tables last; a style said on its first row only. */
export function byStyle(rows: readonly RateRow[]): (RateRow & { readonly first: boolean })[] {
  const sorted = [...rows].sort((a, b) => {
    const left = a.style?.code ?? '￿'
    const right = b.style?.code ?? '￿'
    return left.localeCompare(right) || a.table.code.localeCompare(b.table.code) || b.version.versionNo - a.version.versionNo || a.rate.operation.code.localeCompare(b.rate.operation.code) || a.rate.sizeBand.localeCompare(b.rate.sizeBand)
  })
  return sorted.map((row, index) => ({ ...row, first: index === 0 || (sorted[index - 1]!.style?.id ?? null) !== (row.style?.id ?? null) }))
}

/** Bulk "Confirm n provisional rates": a row may be chosen when its version's trial let it; the reason otherwise. */
export function confirmHeld(row: RateRow, today: string): Words | null {
  if (row.version.state !== 'PROVISIONAL') return { key: 'rates.held.notProvisional' }
  if (row.version.trialEndsOn !== null && today < row.version.trialEndsOn) return { key: 'rates.held.trialRunning', params: { day: row.version.trialEndsOn } }
  return null
}

/** The distinct versions of the rows chosen (a version confirms whole). */
export function versionsOfRows(rows: readonly RateRow[], chosen: readonly string[]): { ids: string[]; rates: number } {
  const set = new Set(chosen)
  const picked = rows.filter((row) => set.has(row.rate.id))
  return { ids: [...new Set(picked.map((row) => row.version.id))], rates: picked.length }
}

// ---- a new rate version ------------------------------------------------------------------------------------------------------

export interface RateDraft {
  key: string
  operationId: string
  operationLabel: string
  sizeBand: string
  basis: RateBasis
  standardMinutes: string
  ratePerMinute: string
  ratePerPiece: string
}

export const blankRate = (key: string): RateDraft => ({ key, operationId: '', operationLabel: '', sizeBand: 'ALL', basis: 'SMV_RATE', standardMinutes: '', ratePerMinute: '', ratePerPiece: '' })

export const draftOfRate = (rate: RateView, key: string): RateDraft => ({
  key,
  operationId: rate.operation.id,
  operationLabel: `${rate.operation.code} · ${rate.operation.name}`,
  sizeBand: rate.sizeBand,
  basis: rate.basis,
  standardMinutes: rate.standardMinutes ?? '',
  ratePerMinute: rate.ratePerMinute ?? '',
  ratePerPiece: rate.basis === 'FIXED' ? (rate.ratePerPiece ?? '') : '',
})

const DECIMAL = /^\d+([.,]\d+)?$/
const typed = (value: string) => value.trim().replace(',', '.')

/** SMV × rate per minute as typed, or null until both are numbers. */
export function pieceOfDraft(draft: RateDraft): string | null {
  if (draft.basis === 'FIXED') return DECIMAL.test(draft.ratePerPiece.trim()) ? typed(draft.ratePerPiece) : null
  if (!DECIMAL.test(draft.standardMinutes.trim()) || !DECIMAL.test(draft.ratePerMinute.trim())) return null
  return ratePerPieceOf(typed(draft.standardMinutes), typed(draft.ratePerMinute))
}

export const bodyOfRate = (draft: RateDraft): RateBody => ({
  operationId: draft.operationId,
  sizeBand: draft.sizeBand.trim() || 'ALL',
  basis: draft.basis,
  standardMinutes: draft.standardMinutes.trim() ? typed(draft.standardMinutes) : null,
  ratePerMinute: draft.basis === 'SMV_RATE' ? typed(draft.ratePerMinute) : null,
  ratePerPiece: draft.basis === 'FIXED' ? typed(draft.ratePerPiece) : null,
})

export interface VersionDraft {
  tableId: string
  changeReason: ChangeReason | ''
  changeNote: string
  effectiveFrom: string
  provisional: boolean
  trialEndsOn: string
  rates: RateDraft[]
}

/** Why Create version is held, in words (the API's rules asked before the click). */
export function versionHeld(draft: VersionDraft, today: string): Words | null {
  if (!draft.tableId) return { key: 'version.held.table' }
  if (!draft.changeReason) return { key: 'version.held.reason' }
  if (draft.changeReason === 'CORRECTION' && !draft.changeNote.trim()) return { key: 'version.held.correction' }
  if (!draft.effectiveFrom) return { key: 'version.held.from' }
  if (draft.effectiveFrom < today) return { key: 'version.held.past' }
  if (draft.provisional && !draft.trialEndsOn) return { key: 'version.held.trial' }
  if (draft.provisional && draft.trialEndsOn <= draft.effectiveFrom) return { key: 'version.held.trialOrder' }
  if (draft.rates.length === 0) return { key: 'version.held.noRates' }
  const seen = new Set<string>()
  for (const rate of draft.rates) {
    if (!rate.operationId) return { key: 'version.held.operation' }
    const key = `${rate.operationId}|${rate.sizeBand.trim().toUpperCase() || 'ALL'}`
    if (seen.has(key)) return { key: 'version.held.twice' }
    seen.add(key)
    if (rate.basis === 'SMV_RATE' && rate.standardMinutes.trim() && !pieceOfDraft(rate)) return { key: 'version.held.values' }
    if (rate.basis === 'SMV_RATE' && !DECIMAL.test(rate.ratePerMinute.trim())) return { key: 'version.held.values' }
    if (rate.basis === 'FIXED' && !pieceOfDraft(rate)) return { key: 'version.held.values' }
  }
  return null
}

/** A table's code from its name: capitals, digits and hyphens. */
export const tableCodeOf = (name: string): string =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)

// ---- schemes -----------------------------------------------------------------------------------------------------------------

export type SchemeDraft = Omit<SchemeBody, 'efficiencyThresholdPct' | 'guaranteedHourlyRate' | 'traineeHourlyRate' | 'ownFaultRatePct' | 'note'> & { efficiencyThresholdPct: string; guaranteedHourlyRate: string; traineeHourlyRate: string; ownFaultRatePct: string; note: string; lineId: string | null }

export const blankScheme = (today: string): SchemeDraft => ({
  name: '',
  kind: 'PIECE_RATE',
  efficiencyThresholdPct: '',
  guaranteedBasis: 'UNDECIDED',
  guaranteedHourlyRate: '',
  traineeHourlyRate: '',
  teamSplit: null,
  reworkOwnFault: 'UNPAID',
  scrapOwnFault: 'UNPAID',
  ownFaultRatePct: '',
  othersFaultPay: 'AVERAGE',
  waitingPay: 'AVERAGE',
  payOnlyWhileClockedIn: true,
  validFrom: today,
  note: '',
  lineId: null,
})

/** The form of a scheme: its own (a draft edited), or a new draft from it (a scheme in force is never edited). */
export function draftOfScheme(detail: SchemeDetail, today: string, asNew: boolean): SchemeDraft {
  const { scheme } = detail
  return {
    name: scheme.name,
    kind: scheme.kind,
    efficiencyThresholdPct: scheme.efficiencyThresholdPct ?? '',
    guaranteedBasis: scheme.guaranteedBasis,
    guaranteedHourlyRate: scheme.guaranteedHourlyRate ?? '',
    traineeHourlyRate: scheme.traineeHourlyRate ?? '',
    teamSplit: scheme.teamSplit,
    reworkOwnFault: scheme.reworkOwnFault,
    scrapOwnFault: scheme.scrapOwnFault,
    ownFaultRatePct: scheme.ownFaultRatePct ?? '',
    othersFaultPay: scheme.othersFaultPay,
    waitingPay: scheme.waitingPay,
    payOnlyWhileClockedIn: scheme.payOnlyWhileClockedIn,
    validFrom: asNew ? today : scheme.validFrom,
    note: scheme.note ?? '',
    lineId: scheme.line?.id ?? null,
  }
}

const orNull = (value: string): string | null => value.trim().replace(',', '.') || null

export const bodyOfScheme = (draft: SchemeDraft): SchemeBody => ({
  name: draft.name.trim(),
  kind: draft.kind,
  efficiencyThresholdPct: draft.kind === 'STANDARD_MINUTE_BONUS' ? orNull(draft.efficiencyThresholdPct) : null,
  guaranteedBasis: draft.guaranteedBasis,
  guaranteedHourlyRate: orNull(draft.guaranteedHourlyRate),
  traineeHourlyRate: orNull(draft.traineeHourlyRate),
  teamSplit: draft.kind === 'TEAM_INCENTIVE' ? draft.teamSplit : null,
  reworkOwnFault: draft.reworkOwnFault,
  scrapOwnFault: draft.scrapOwnFault,
  ownFaultRatePct: draft.reworkOwnFault === 'REDUCED_RATE' || draft.scrapOwnFault === 'REDUCED_RATE' ? orNull(draft.ownFaultRatePct) : null,
  othersFaultPay: draft.othersFaultPay,
  waitingPay: draft.waitingPay,
  payOnlyWhileClockedIn: draft.payOnlyWhileClockedIn,
  validFrom: draft.validFrom,
  note: draft.note.trim() || null,
})

/** The first field the domain's own rules refuse, in our words; null when the scheme can be saved. */
export function schemeHeld(draft: SchemeDraft, today: string): Words | null {
  const problem = termsOf(bodyOfScheme(draft)).problems[0]
  if (problem) return { key: `scheme.held.${problem.path}` }
  return draft.validFrom < today ? { key: 'scheme.held.past' } : null
}

export const SCHEME_FIELDS_HELD = ['name', 'kind', 'efficiencyThresholdPct', 'teamSplit', 'guaranteedBasis', 'guaranteedHourlyRate', 'traineeHourlyRate', 'reworkOwnFault', 'scrapOwnFault', 'ownFaultRatePct', 'othersFaultPay', 'waitingPay', 'currency', 'validFrom', 'note'] as const

// ---- pay periods -------------------------------------------------------------------------------------------------------------

export const PERIOD_STEPS: readonly PeriodStatus[] = ['OPEN', 'PREVIEW', 'REVIEW', 'LOCKED']
export const PERIOD_TONE: Readonly<Record<PeriodStatus, 'neutral' | 'info' | 'warning' | 'success'>> = { OPEN: 'neutral', PREVIEW: 'info', REVIEW: 'warning', LOCKED: 'success' }
export const STATE_TONE: Readonly<Record<VersionState, 'neutral' | 'info' | 'warning' | 'success' | 'danger'>> = { DRAFT: 'neutral', PROVISIONAL: 'warning', CONFIRMED: 'success', SUPERSEDED: 'neutral', CANCELLED: 'danger' }

/** The month of a business day. */
export const monthOfDay = (day: string): string => day.slice(0, 7)

/**
 * What "Run <month> pay period" runs: the earliest month not in review or locked; none: a new period for this month. A
 * period in review is run again only by going back on purpose, on its own record.
 */
export function runTarget(periods: readonly PeriodRow[], today: string): { month: string; period: PeriodRow | null } {
  const open = periods.filter((period) => period.status === 'OPEN' || period.status === 'PREVIEW').sort((a, b) => a.month.localeCompare(b.month))
  const first = open[0]
  return first ? { month: first.month, period: first } : { month: monthOfDay(today), period: null }
}

/** A period's actions the API refuses, as the held reason of its button. */
export const actionHeld = (action: { allowed: boolean; refusal: { code: string } | null }): Words | null => (action.allowed ? null : { key: `refusal.${action.refusal?.code ?? 'WRONG_STATE'}` })

/** Blocking checks first; each in words with its count. */
export const checkRows = (detail: PeriodDetail): { code: string; blocking: boolean; words: Words }[] =>
  [...detail.checks].sort((a, b) => Number(b.blocking) - Number(a.blocking)).map((check) => ({ code: check.code, blocking: check.blocking, words: { key: `check.${check.code}`, params: { count: check.count } } }))

// ---- held scans --------------------------------------------------------------------------------------------------------------

export const HOLD_TONE: Readonly<Record<HoldStatus, 'warning' | 'success' | 'neutral'>> = { OPEN: 'warning', COUNTED: 'success', NOT_PAID: 'neutral' }

export const heldSelectable = (row: HeldRow): Words | null => (row.status === 'OPEN' ? null : { key: 'held.decided' })

export const REASON_MIN = 3
export const reasonHeld = (reason: string): Words | null => (reason.trim().length >= REASON_MIN ? null : { key: 'common.reasonHeld' })

/** Euros as typed → minor units; null when it is not an amount. */
export function minorOfTyped(value: string): number | null {
  const text = value.trim().replace(',', '.')
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null
  return Math.round(Number(text) * 100)
}

// ---- the version's record ----------------------------------------------------------------------------------------------------

/** "Read by n of m" over the version's live publications, each worker once, for the AckTracker. */
export function ackRows(detail: VersionDetail) {
  const rows = new Map<string, { workerId: string; name: string; employeeId: string | null; read: { at: string; channel: 'DEVICE' | 'PAPER' } | null; publicationId: string }>()
  for (const publication of detail.publications) {
    if (publication.status !== 'PUBLISHED') continue
    for (const worker of publication.workers) {
      const before = rows.get(worker.workerId)
      if (!before || (!before.read && worker.read)) rows.set(worker.workerId, { ...worker, publicationId: publication.id })
    }
  }
  return [...rows.values()].sort((a, b) => Number(!!a.read) - Number(!!b.read) || a.name.localeCompare(b.name))
}
