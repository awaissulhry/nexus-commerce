import { csvLine } from '../../quality/_shared/hooks'
import type { LiveState, Notice, QualityCan, Read } from '../../quality/_shared/model'
import type { Entry, EntryDetail, EntryQuery, PartyOption, RegisterKind, RegisterRisk, ReversedRelease, StyleOption, Trace } from './api'

/**
 * The PPE register's rules without React or the API (SCR-113; design compliance.register; Reg. (EU) 2016/425 art. 8(4),
 * 8(8)): the saved views (tiles and Rows ▾ are ONE model: a tile is a view), the query each sends, the tile counts from
 * the rows read, the next duty of an entry and why an action is held, the CSV of the view, and where an entry's source
 * opens. Words are message keys of the `register` catalogue.
 */

// ---- views and filters ----------------------------------------------------------------------------------------------------

export const VIEWS = ['all', 'open', 'risk', 'assessing', 'uninformed', 'closed'] as const
export type RegisterView = (typeof VIEWS)[number]

/** The tiles (each a saved view; pressing one again goes back to every entry). */
export const TILES = ['open', 'risk', 'assessing', 'uninformed', 'closed'] as const
export type TileId = (typeof TILES)[number]

export interface RegisterFilters {
  readonly kind?: RegisterKind | null
  readonly risk?: RegisterRisk | null
}

/** The list reads 50 a page; "Show more" reads a larger page, up to the API's 500 (the list has no cursor). */
export const PAGE = 50
export const LIST_MAX = 500

/**
 * The view an address names: `?view=` when it is one, else the API's own filters (`?status=OPEN&risk=YES` → risk, Today's
 * `?status=OPEN` → open), else every entry. `kind` and a `risk` the view does not take become filters.
 */
export function addressState(params: { get(name: string): string | null } | null): { view: RegisterView; filters: RegisterFilters } {
  const view = params?.get('view') ?? ''
  const status = params?.get('status')
  const risk = params?.get('risk')
  const kind = params?.get('kind')
  const kindFilter = kind === 'COMPLAINT' || kind === 'NON_CONFORMITY' || kind === 'RECALL' ? kind : null
  const riskValue = risk === 'NO' || risk === 'ASSESSING' || risk === 'YES' ? risk : null
  if ((VIEWS as readonly string[]).includes(view)) return { view: view as RegisterView, filters: { kind: kindFilter, risk: riskValue } }
  if (status === 'OPEN' && riskValue === 'YES') return { view: 'risk', filters: { kind: kindFilter } }
  if (status === 'OPEN' && riskValue === 'ASSESSING') return { view: 'assessing', filters: { kind: kindFilter } }
  if (status === 'OPEN') return { view: 'open', filters: { kind: kindFilter, risk: riskValue } }
  if (status === 'CLOSED') return { view: 'closed', filters: { kind: kindFilter, risk: riskValue } }
  return { view: 'all', filters: { kind: kindFilter, risk: riskValue } }
}

/** The API query of a view with its filters and search. A view's own risk wins over a risk filter. */
export function viewQuery(view: RegisterView, filters: RegisterFilters, q: string, limit: number): EntryQuery {
  const base: EntryQuery = { kind: filters.kind ?? null, risk: filters.risk ?? null, q: q.trim() || null, limit }
  switch (view) {
    case 'open':
    case 'uninformed':
      return { ...base, status: 'OPEN' }
    case 'risk':
      return { ...base, status: 'OPEN', risk: 'YES' }
    case 'assessing':
      return { ...base, status: 'OPEN', risk: 'ASSESSING' }
    case 'closed':
      return { ...base, status: 'CLOSED' }
    default:
      return base
  }
}

/**
 * The rows a view shows from what the API answered. "Distributors not yet informed" has no API filter (the list rows
 * carry no duties): it keeps the OPEN entries not marked as informed, which is what the row fields prove.
 */
export function viewRows(view: RegisterView, rows: readonly Entry[]): Entry[] {
  return view === 'uninformed' ? rows.filter((row) => row.status === 'OPEN' && row.distributorsInformedAt === null) : [...rows]
}

/** A tile's count, or "at least N" when the read stopped at the API's limit. */
export interface TileCount {
  readonly count: number
  readonly complete: boolean
}

/**
 * The tile counts from two reads (every OPEN entry and every CLOSED one, up to 500 each): the counts and the lists agree
 * because both come from the same rows and the same rules (`viewRows`).
 */
export function tileCounts(open: readonly Entry[] | null, closed: readonly Entry[] | null, limit = LIST_MAX): Partial<Record<TileId, TileCount | null>> {
  const openComplete = open !== null && open.length < limit
  const of = (rows: readonly Entry[] | null, complete: boolean, keep: (row: Entry) => boolean): TileCount | null => (rows === null ? null : { count: rows.filter(keep).length, complete })
  return {
    open: of(open, openComplete, () => true),
    risk: of(open, openComplete, (row) => row.risk === 'YES'),
    assessing: of(open, openComplete, (row) => row.risk === 'ASSESSING'),
    uninformed: of(open, openComplete, (row) => row.distributorsInformedAt === null),
    closed: of(closed, closed !== null && closed.length < limit, () => true),
  }
}

/** Whether the list shows anything but every entry (a view, a filter or a search). */
export function isFiltered(view: RegisterView, filters: RegisterFilters, q: string): boolean {
  return view !== 'all' || !!filters.kind || !!filters.risk || q.trim() !== ''
}

// ---- words of a row -------------------------------------------------------------------------------------------------------

/** The batches or serials an entry names: the first few and how many more ("B-1, B-2 and 3 more"). */
export function concernSummary(entry: Pick<Entry, 'batchNumbers' | 'serials'>, shown = 2): { kind: 'batch' | 'serial' | 'none'; shown: string[]; more: number } {
  if (entry.batchNumbers.length > 0) return { kind: 'batch', shown: entry.batchNumbers.slice(0, shown), more: Math.max(0, entry.batchNumbers.length - shown) }
  if (entry.serials.length > 0) return { kind: 'serial', shown: entry.serials.slice(0, shown), more: Math.max(0, entry.serials.length - shown) }
  return { kind: 'none', shown: [], more: 0 }
}

/** Where an entry came from, as a message key of `register` (`source.QualityReleaseReversal` …; `source.none` = by hand). */
export function sourceKey(entry: Pick<Entry, 'source'>): string {
  return entry.source ? `source.${entry.source.type}` : 'source.none'
}

export const RISK_TONE: Record<RegisterRisk, 'danger' | 'warning' | 'success'> = { YES: 'danger', ASSESSING: 'warning', NO: 'success' }
export const STATUS_TONE: Record<Entry['status'], 'info' | 'neutral'> = { OPEN: 'info', CLOSED: 'neutral' }

// ---- the CSV of the view ----------------------------------------------------------------------------------------------------

export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** "This view (CSV)" / "Export N": one line per entry, in the person's language, dates as the API's days. */
export function registerCsv(rows: readonly Entry[], t: Translate): string {
  const head = ['reference', 'reportedAt', 'kind', 'style', 'styleName', 'batchNumbers', 'serials', 'reporter', 'risk', 'source', 'status', 'distributorsInformedAt', 'authorityNotifiedAt', 'authorityReference', 'closedAt'].map((column) =>
    t(`csv.${column}`),
  )
  const day = (instant: string | null) => (instant ? instant.slice(0, 10) : '')
  const lines = rows.map((row) =>
    csvLine([
      row.reference,
      day(row.reportedAt),
      t(`kind.${row.kind}`),
      row.style.code,
      row.style.name,
      row.batchNumbers.join(' '),
      row.serials.join(' '),
      row.party ? `${row.party.code} ${row.party.name}` : '',
      t(`risk.${row.risk}`),
      t(sourceKey(row)),
      t(`status.${row.status}`),
      day(row.distributorsInformedAt),
      day(row.authorityNotifiedAt),
      row.authorityReference ?? '',
      day(row.closedAt),
    ]),
  )
  return [csvLine(head), ...lines].join('\r\n')
}

// ---- the record's duties and actions ----------------------------------------------------------------------------------------

export const ACTIONS = ['edit', 'risk', 'action', 'distributors', 'authority', 'close'] as const
export type EntryAction = (typeof ACTIONS)[number]

/** The band's primary while the entry is OPEN: the next duty, in the law's order, then Close. Null once CLOSED. */
export function nextAction(entry: Pick<EntryDetail, 'status' | 'risk' | 'actionTaken' | 'actionCompletedAt' | 'duties'>): EntryAction | null {
  if (entry.status !== 'OPEN') return null
  if (entry.risk === 'ASSESSING') return 'risk'
  if (!entry.actionTaken?.trim() || entry.actionCompletedAt === null) return 'action'
  const duty = (code: string) => entry.duties.find((item) => item.code === code)
  const distributors = duty('DISTRIBUTORS')
  if (distributors?.required && !distributors.done) return 'distributors'
  const authority = duty('AUTHORITY')
  if (authority?.required && !authority.done) return 'authority'
  return 'close'
}

/**
 * Why an action is held (a message key of `register`), or null when it may run: the right first, then a closed entry
 * (it never changes: a correction is a note), then the action's own state.
 */
export function actionHeld(action: EntryAction, entry: Pick<EntryDetail, 'status' | 'actionTaken' | 'actionCompletedAt' | 'distributorsInformedAt' | 'authorityNotifiedAt'>, can: Pick<QualityCan, 'registerManage'>): string | null {
  if (!can.registerManage) return 'held.manage'
  if (entry.status !== 'OPEN') return 'held.closed'
  if (action === 'action' && entry.actionCompletedAt !== null) return 'held.actionDone'
  if (action === 'distributors' && entry.distributorsInformedAt !== null) return 'held.informed'
  if (action === 'authority' && entry.authorityNotifiedAt !== null) return 'held.notified'
  return null
}

/** The duties of an entry as check lines: done, open (required and not done), not needed. */
export function dutyState(duty: EntryDetail['duties'][number]): 'OK' | 'OPEN' | 'NOT_NEEDED' {
  if (duty.done) return 'OK'
  return duty.required ? 'OPEN' : 'NOT_NEEDED'
}

/** Where the entry's source opens: the reversed release (found in the reversed releases list), the lot of a lab result, or nothing. */
export type SourceLink =
  | { readonly kind: 'release'; readonly releaseId: string; readonly label: string }
  | { readonly kind: 'lot'; readonly lotId: string }
  | { readonly kind: 'none' }

export function sourceLink(entry: Pick<Entry, 'source' | 'lotIds'>, releases: readonly ReversedRelease[] | null): SourceLink {
  if (!entry.source) return { kind: 'none' }
  if (entry.source.type === 'QualityReleaseReversal' && releases) {
    const release = releases.find((item) => item.reversals.some((reversal) => reversal.id === entry.source!.id))
    if (release) return { kind: 'release', releaseId: release.id, label: release.releaseNumber ?? release.number }
  }
  if (entry.source.type === 'QualityRelease' && releases) {
    const release = releases.find((item) => item.id === entry.source!.id)
    if (release) return { kind: 'release', releaseId: release.id, label: release.releaseNumber ?? release.number }
  }
  if (entry.source.type === 'LabResult' && entry.lotIds[0]) return { kind: 'lot', lotId: entry.lotIds[0] }
  return { kind: 'none' }
}

/** The evidence trail of the entry's first batch, else its first serial (a new tab), or null when it names neither. */
export function evidenceSubject(entry: Pick<Entry, 'batchNumbers' | 'serials'>): { batch?: string; serial?: string } | null {
  if (entry.batchNumbers[0]) return { batch: entry.batchNumbers[0] }
  if (entry.serials[0]) return { serial: entry.serials[0] }
  return null
}

/**
 * A day picked in a dialog as the instant the API takes: today → now (the API's own clock; a later hour would be "in the
 * future"), another day → 10:00 UTC of that day (around midday in Rome, inside the business day the rule compares).
 */
export function dayInstant(day: string, today: string, now: Date = new Date()): string | undefined {
  if (!day) return undefined
  if (day === today) return now.toISOString()
  return `${day}T10:00:00.000Z`
}

/** Today's business day in Rome (the register's days). */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

// ---- New entry --------------------------------------------------------------------------------------------------------------

export interface NewEntryDraft {
  readonly companyId: string
  readonly kind: RegisterKind
  readonly styleId: string
  readonly batchNumbers: readonly string[]
  readonly serials: readonly string[]
  readonly partyId: string
  /** A business day, '' = now. */
  readonly reportedOn: string
  readonly description: string
  readonly risk: RegisterRisk
  readonly actionTaken: string
}

export const blankDraft = (companyId: string): NewEntryDraft => ({
  companyId,
  kind: 'COMPLAINT',
  styleId: '',
  batchNumbers: [],
  serials: [],
  partyId: '',
  reportedOn: '',
  description: '',
  risk: 'ASSESSING',
  actionTaken: '',
})

/** What stops a draft from being added, as message keys of `register` (every problem at once). */
export function draftProblems(draft: NewEntryDraft): string[] {
  const problems: string[] = []
  if (!draft.companyId) problems.push('new.problem.company')
  if (!draft.styleId) problems.push('new.problem.style')
  if (!draft.description.trim()) problems.push('new.problem.description')
  if (draft.kind === 'RECALL' && draft.batchNumbers.length === 0 && draft.serials.length === 0) problems.push('new.problem.recallNeedsGarments')
  if (draft.batchNumbers.length > 50) problems.push('new.problem.tooManyBatches')
  if (draft.serials.length > 500) problems.push('new.problem.tooManySerials')
  return problems
}

/** Whether the draft names enough to ask where the garments are (a style and at least one batch or serial). */
export const canTrace = (draft: NewEntryDraft): boolean => !!draft.companyId && !!draft.styleId && (draft.batchNumbers.length > 0 || draft.serials.length > 0)

/** Codes typed in a field, split on commas, spaces and new lines, without repeats. */
export function splitCodes(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((code) => code.trim()).filter(Boolean))]
}

// ---- the view models --------------------------------------------------------------------------------------------------------

export interface RegisterListModel {
  readonly prefix: string
  readonly can: QualityCan
  readonly rows: Read<readonly Entry[]>
  readonly view: RegisterView
  readonly filters: RegisterFilters
  readonly query: string
  readonly limit: number
  readonly tiles: Partial<Record<TileId, TileCount | null>>
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly selected: readonly string[]
  readonly notice?: Notice | null
  readonly loadingMore?: boolean
  /** The last read filled its page (more may exist), even when a view shows fewer of its rows. */
  readonly pageFull?: boolean
  /** Design cases: the row with the focus. */
  readonly focusRow?: number
  readonly dialog?: ListDialog | null
  readonly newEntry?: NewEntryModel
}

export type ListDialog = { kind: 'new' } | { kind: 'shortcuts' }

/** What the New entry dialog shows. */
export interface NewEntryModel {
  readonly draft: NewEntryDraft
  readonly companies: readonly { id: string; code: string; name: string }[]
  readonly styles: Read<readonly StyleOption[]> | null
  readonly parties: Read<readonly PartyOption[]> | null
  readonly trace: Read<Trace> | null
  readonly busy: boolean
  readonly problem: string | null
  /** Show the draft's problems (after Add was pressed). */
  readonly showProblems: boolean
  /** Today's business day (a report is never dated in the future). */
  readonly today?: string
}

export interface EntryRecordModel {
  readonly prefix: string
  readonly can: QualityCan
  readonly tab: RecordTab
  readonly entry: EntryDetail
  /** The reversed releases (to link a reversal's release); null when not read (no permission, or not needed). */
  readonly releases: readonly ReversedRelease[] | null
  readonly asOf: string | null
  readonly live: LiveState
  readonly notice?: Notice | null
  readonly dialog?: EntryAction | null
  readonly busy?: boolean
  /** A refusal inside the open dialog: a message key, and the API's problem lines under it. */
  readonly dialogProblem?: { key: string; lines: readonly string[] } | null
  /** Someone else changed the entry while a dialog was open. */
  readonly changedAt?: string | null
  readonly dockOpen?: boolean
  readonly today: string
}

export const RECORD_TABS = ['event', 'affected', 'actions', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
