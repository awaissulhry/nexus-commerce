import { OPEN_REASONS, type OpenReason } from '@nexus/factory-domain/people/privacy/figures'
import { EDIT_KINDS, INBOX_KINDS, LABOUR_LIMITS, LINE_DAY_STATES, type DisputeOutcome, type EditKind, type InboxKind, type LineDayState } from '@nexus/factory-domain/production/labour/rules'
import { OFF_STANDARD_LIMITS, UNUSUAL_REASONS } from '@nexus/factory-domain/production/offstandard/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { BlockRecord, Change, CorrectionRequest, DayRecord, Dispute, FigureAccess, InboxItem, LabourCounts, LabourRecord, LineDay, OffStandardCode } from './api'

/**
 * Production › Floor control › Labour & corrections (B-W2b-57; SCR-139, SCR-143; design production.labour), pure: what this
 * person may do, the address (`?kind=&line=&q=&open=&state=&from=&to=&editFrom=&editTo=&editKind=`, the tiles are the API's
 * own `kind` filter), the legal band's state per site, why each step is held, the bulk targets ("Approve N normal blocks",
 * "Close N days"), the words of an age, a change and a blocker, and the API's refusals in this page's words. Keys of
 * `production-labour`.
 *
 * Nothing here counts, groups or filters by person (Owner answers W1, F2; Statuto dei Lavoratori art. 4): a row says at
 * most that its record names someone. A worker's name reaches the page only from ONE record, where the API serves it
 * behind the site's legal gate; `namesShown` is the one test this page makes on it, and it only reads the API's answer.
 */

export const LABOUR_NAMESPACE = 'production-labour'
export const LABOUR_NAMESPACES = [LABOUR_NAMESPACE, 'lists', 'ds-words'] as const

export interface Phrase {
  key: string
  params?: Readonly<Record<string, string | number>>
}

const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

// ---- what this person may do ----------------------------------------------------------------------------------------------

export interface LabourCan {
  /** production.labour.view: the page. */
  view: boolean
  /** production.labour.close: close a line's day. */
  close: boolean
  /** production.labour.reopen: reopen one, with a reason. */
  reopen: boolean
  /** production.labour.answer: answer a dispute. */
  answer: boolean
  /** production.scan.correct: read and decide a correction request. */
  correct: boolean
  /** production.offstandard.view: one block's record, the codes' words. */
  blocks: boolean
  /** production.offstandard.approve: approve or reject a block. */
  approveBlocks: boolean
  /** workorders.view: the work order's link, the bundle's scans for context. */
  workOrders: boolean
  /** production.settings.view: the site's recorded basis, the link to Floor rules & codes. */
  settings: boolean
  /** people.figures.view: open one person's day (the API decides who, one person at a time). */
  figures: boolean
  /** people.view: the name search. */
  people: boolean
}

export function labourCanOf(permissions: readonly string[]): LabourCan {
  const held = new Set(permissions)
  return {
    view: held.has('production.labour.view'),
    close: held.has('production.labour.close'),
    reopen: held.has('production.labour.reopen'),
    answer: held.has('production.labour.answer'),
    correct: held.has('production.scan.correct'),
    blocks: held.has('production.offstandard.view'),
    approveBlocks: held.has('production.offstandard.approve'),
    workOrders: held.has('workorders.view'),
    settings: held.has('production.settings.view'),
    figures: held.has('people.figures.view'),
    people: held.has('people.view'),
  }
}

// ---- the address ----------------------------------------------------------------------------------------------------------

export interface LabourAddress {
  /** The queue's kind (a tile pressed). */
  kind: InboxKind | null
  /** The whole page's line. */
  line: string | null
  q: string
  /** The item open in its DetailModal: `<KIND>:<id>`. */
  open: string | null
  /** Line days: their state and dates. */
  state: LineDayState | null
  from: string | null
  to: string | null
  /** Changes to labour records: their kind and dates. */
  editKind: EditKind | null
  editFrom: string | null
  editTo: string | null
}

const pick = <T extends string>(values: readonly T[], value: string | null | undefined): T | null => (value && (values as readonly string[]).includes(value) ? (value as T) : null)
const DAY = /^\d{4}-\d{2}-\d{2}$/
const dayOf = (value: string | null | undefined): string | null => (value && DAY.test(value) ? value : null)

export function addressOf(params: { get(name: string): string | null } | null): LabourAddress {
  return {
    kind: pick(INBOX_KINDS, params?.get('kind')),
    line: params?.get('line') || null,
    q: params?.get('q') ?? '',
    open: params?.get('open') || null,
    state: pick(LINE_DAY_STATES, params?.get('state')),
    from: dayOf(params?.get('from')),
    to: dayOf(params?.get('to')),
    editKind: pick(EDIT_KINDS, params?.get('editKind')),
    editFrom: dayOf(params?.get('editFrom')),
    editTo: dayOf(params?.get('editTo')),
  }
}

export function addressText(address: LabourAddress): string {
  const query = new URLSearchParams()
  if (address.kind) query.set('kind', address.kind)
  if (address.line) query.set('line', address.line)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.state) query.set('state', address.state)
  if (address.from) query.set('from', address.from)
  if (address.to) query.set('to', address.to)
  if (address.editKind) query.set('editKind', address.editKind)
  if (address.editFrom) query.set('editFrom', address.editFrom)
  if (address.editTo) query.set('editTo', address.editTo)
  if (address.open) query.set('open', address.open)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** An item's key in the address and the list. */
export const itemKey = (item: Pick<InboxItem, 'kind' | 'id'>): string => `${item.kind}:${item.id}`
export const dayKey = (day: Pick<LineDay, 'line' | 'workDate'>): string => `LINE_DAY:${day.line.id}:${day.workDate}`

export interface OpenItem {
  kind: InboxKind
  id: string
}

/** `<KIND>:<id>` read back; anything else opens nothing. */
export function openOf(text: string | null | undefined): OpenItem | null {
  if (!text) return null
  const at = text.indexOf(':')
  if (at < 1) return null
  const kind = pick(INBOX_KINDS, text.slice(0, at))
  const id = text.slice(at + 1)
  if (!kind || !id) return null
  if (kind === 'LINE_DAY' && !lineDayOf(id)) return null
  return { kind, id }
}

/** A line day's id (`<lineId>:<day>`) read back. */
export function lineDayOf(id: string): { lineId: string; workDate: string } | null {
  const at = id.lastIndexOf(':')
  if (at < 1) return null
  const workDate = id.slice(at + 1)
  return DAY.test(workDate) ? { lineId: id.slice(0, at), workDate } : null
}

// ---- the tiles ---------------------------------------------------------------------------------------------------------------

/** The tiles (design lb-metrics "saved filters"): each is the API's own `kind` filter. */
export const TILES = [
  { kind: 'CORRECTION', count: 'corrections' },
  { kind: 'DISPUTE', count: 'disputes' },
  { kind: 'OFF_STANDARD', count: 'offStandard' },
  { kind: 'LINE_DAY', count: 'lineDays' },
] as const satisfies ReadonlyArray<{ kind: InboxKind; count: keyof LabourCounts }>

/** A tile pressed: its kind; pressed again: the whole queue. */
export const tileKind = (address: Pick<LabourAddress, 'kind'>, kind: InboxKind): InboxKind | null => (address.kind === kind ? null : kind)

// ---- the legal band -----------------------------------------------------------------------------------------------------------

/**
 * What a site's records may say about a person (design lb-basis; plan §2 GATE-LABOUR):
 *   BASIS     the site names workers and its PERFORMANCE gate is in force, with the basis on record;
 *   ON        the gate is in force, its basis not readable by this person (no production.settings.view);
 *   GATE_OFF  the gate is off (the default): records say where and what, never who, and no sheet opens;
 *   STATION   the site records stations: "Per-person sheets are off", line days and station corrections remain;
 *   UNKNOWN   the read failed: said as such, never as off or on.
 */
export type LegalState = 'BASIS' | 'ON' | 'GATE_OFF' | 'STATION' | 'UNKNOWN'

export interface LegalBasis {
  kind: string
  reference: string
  recordedAt: string
  recordedByName: string | null
}

export interface LegalRow {
  siteId: string
  site: string
  state: LegalState
  basis: LegalBasis | null
  /** Leads see one person's figures here (the basis covers them and the site chose it). */
  leads: boolean
}

export interface SiteFacts {
  scanSubject: 'WORKER' | 'STATION'
  legalBasis: LegalBasis | null
}

/** The band's row of a site. `sight` is the API's own reading of the gate (`GET /people/privacy/what-you-see`, legalGateFor). */
export function legalRowOf(site: { id: string; name: string }, rules: SiteFacts | null, sight: { open: boolean; leadsSeeFigures: boolean } | null): LegalRow {
  const row = { siteId: site.id, site: site.name, basis: rules?.legalBasis ?? null, leads: sight?.leadsSeeFigures ?? false }
  if (rules?.scanSubject === 'STATION') return { ...row, state: 'STATION', leads: false }
  if (!sight) return { ...row, state: 'UNKNOWN', leads: false }
  if (!sight.open) return { ...row, state: 'GATE_OFF', leads: false }
  return { ...row, state: rules?.legalBasis ? 'BASIS' : 'ON' }
}

/** A person's name came with this record: the API served it (its gate is on), and only then this page says it. */
export const namesShown = (record: { worker: { name: string } | null; workerHidden: boolean }): boolean => record.worker !== null && !record.workerHidden

/**
 * B-W2b-73: who decided a block, for its record. A team leader who decided on the tablet is a worker on this record: with the
 * site's legal gate off the API keeps the name back and says so (`…ByHidden`), and the screen says "a person", never nothing.
 */
export function blockDecision(block: Pick<BlockRecord, 'approvedAt' | 'approvedBy' | 'approvedByHidden' | 'rejectedAt' | 'rejectedBy' | 'rejectedByHidden'>): { label: string; who: string | null; hidden: boolean; at: string } | null {
  if (block.approvedAt) return { label: 'detail.approvedBy', who: block.approvedBy?.name ?? null, hidden: block.approvedByHidden, at: block.approvedAt }
  if (block.rejectedAt) return { label: 'detail.rejectedBy', who: block.rejectedBy?.name ?? null, hidden: block.rejectedByHidden, at: block.rejectedAt }
  return null
}

// ---- words --------------------------------------------------------------------------------------------------------------------

/** An item's age: "45 min", "3 h", "2 d". */
export function agePhrase(minutes: number): Phrase {
  if (minutes < 60) return phrase('age.min', { count: Math.max(0, minutes) })
  if (minutes < 1440) return phrase('age.h', { count: Math.floor(minutes / 60) })
  return phrase('age.d', { count: Math.floor(minutes / 1440) })
}

/** An item waits long enough to be said louder. */
export const ageTone = (minutes: number): 'neutral' | 'warning' | 'danger' => (minutes >= 2880 ? 'danger' : minutes >= 1440 ? 'warning' : 'neutral')

/** "Minutes" as the API sends them ("12.500" standard minutes): at most what the value has. */
export function minutesText(value: string, locale: string): string {
  const number = Number(value)
  return Number.isFinite(number) ? new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(number) : '—'
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const KIND_TONE: Readonly<Record<InboxKind, Tone>> = Object.freeze({ CORRECTION: 'info', DISPUTE: 'warning', OFF_STANDARD: 'neutral', LINE_DAY: 'success' })
export const DAY_TONE: Readonly<Record<LineDayState, Tone>> = Object.freeze({ OPEN: 'warning', READY: 'info', CLOSED: 'success' })

/** A code in the page's language; its own letters when no word is known (the person cannot read the codes, or it is new). */
export function codeWords(code: string | null, codes: readonly OffStandardCode[] | null, locale: string): string | null {
  if (!code) return null
  const found = codes?.find((entry) => entry.code === code)
  if (!found) return code
  if (locale === 'it') return found.labelIt || found.labelEn || code
  if (locale === 'en') return found.labelEn || code
  return found.labelI18n[locale] || found.labelEn || code
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const CLOCK = /^([A-Z_]+) (\d{4}-\d{2}-\d{2}T.+)$/
const KNOWN_FIELDS = ['good', 'scrap', 'rework', 'codeId', 'startedAt', 'endedAt', 'workDate', 'status', 'approvedAt', 'rejectedAt', 'rejectReason', 'clock'] as const

/** A change's field in the page's words (never the field's own name). */
export const fieldKey = (field: string): string => ((KNOWN_FIELDS as readonly string[]).includes(field) ? `field.${field}` : field.endsWith('Minutes') ? 'field.minutes' : 'field.other')

export interface ValueWords {
  instant: (iso: string) => string
  code: (id: string) => string | null
  word: (key: string) => string
  /** A clock kind ("IN") → its word. */
  clock: (kind: string) => string
}

/** A change's value already written. */
export function valueText(field: string, value: Change['from'], words: ValueWords): string | null {
  if (value === null) return null
  if (typeof value === 'boolean') return words.word(value ? 'common.yes' : 'common.no')
  if (typeof value === 'number') return String(value)
  if (field === 'codeId') return words.code(value) ?? '—'
  if (field === 'status') return words.word(`blockStatus.${value}`)
  const clock = CLOCK.exec(value)
  if (clock) return `${words.clock(clock[1]!)} ${words.instant(clock[2]!)}`
  if (INSTANT.test(value)) return words.instant(value)
  return value
}

/** Changes as ChangeValue's lines. A value taken away says so in our words: the DS part's own word is English. */
export function changeLines(changes: readonly Change[], words: ValueWords): Array<{ label: string; from: string | null; to: string }> {
  return changes.flatMap((change) => {
    const from = valueText(change.field, change.from, words)
    const to = valueText(change.field, change.to, words)
    if (from === null && to === null) return []
    return [{ label: words.word(fieldKey(change.field)), from, to: to ?? words.word('change.none') }]
  })
}

/** A dispute's correction keeps "Dispute upheld: <the answer>" as its stored reason: the answer is what the person wrote. */
export const editReason = (reason: string | null, disputeId: string | null): string | null => (reason && disputeId ? reason.replace(/^Dispute upheld: /, '') : reason)

/** What holds a day, each in words with its count. */
export const blockerPhrase = (blocker: { kind: string; count: number }): Phrase => phrase(`blocker.${blocker.kind}`, { count: blocker.count })

/** "Off-standard coded (yes / 3 blocks left)". */
export const codedPhrase = (day: Pick<LineDay, 'offStandard'>): Phrase => (day.offStandard.coded ? phrase('days.coded') : phrase('days.left', { count: day.offStandard.left }))

/** The rows the search keeps (line, work order, bundle, operation, code, the kind's word). */
export function searchItems(items: readonly InboxItem[], q: string, kindWord: (kind: InboxKind) => string, code: (item: InboxItem) => string | null): InboxItem[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return [...items]
  return items.filter((item) =>
    [kindWord(item.kind), item.line?.code, item.line?.name, item.workOrder?.number, item.bundle?.code, item.operation?.code, item.operation?.name, item.code, code(item)]
      .filter((text): text is string => typeof text === 'string')
      .some((text) => text.toLowerCase().includes(needle)),
  )
}

// ---- bulk ---------------------------------------------------------------------------------------------------------------------

/** "Approve N normal blocks" (design: large or unusual blocks are excluded and say why). */
export const normalTargets = <T extends Pick<InboxItem, 'kind' | 'unusual'>>(items: readonly T[]): T[] => items.filter((item) => item.kind === 'OFF_STANDARD' && item.unusual.length === 0)
export const dayTargets = <T extends Pick<InboxItem, 'kind'>>(items: readonly T[]): T[] => items.filter((item) => item.kind === 'LINE_DAY')

export const UNUSUAL_KEYS = UNUSUAL_REASONS

/** Why a queue row may not be selected, in words; null: it may. */
export function rowHeld(item: Pick<InboxItem, 'kind' | 'unusual'>, can: Pick<LabourCan, 'approveBlocks' | 'close'>): Phrase | null {
  if (item.kind === 'LINE_DAY') return can.close ? null : phrase('held.noClose')
  if (item.kind !== 'OFF_STANDARD') return phrase('select.oneByOne')
  if (!can.approveBlocks) return phrase('held.noApprove')
  return item.unusual.length > 0 ? phrase('select.unusual') : null
}

/** Why the band's "Approve N normal blocks" is held. */
export function normalHeld(count: number | null, can: Pick<LabourCan, 'approveBlocks'>, busy: boolean): string | null {
  if (!can.approveBlocks) return 'held.noApprove'
  if (count === 0) return 'held.noNormal'
  if (count === null) return 'held.loading'
  return busy ? 'held.busy' : null
}

/** Pieces of a bulk approve, each at most what one call takes. */
export function chunks<T>(rows: readonly T[], size: number = OFF_STANDARD_LIMITS.perBulk): T[][] {
  const out: T[][] = []
  for (let at = 0; at < rows.length; at += size) out.push(rows.slice(at, at + size))
  return out
}

// ---- held steps ---------------------------------------------------------------------------------------------------------------

/** One item as the detail read it. */
export type ItemRecord =
  | { kind: 'CORRECTION'; request: CorrectionRequest | null; record: LabourRecord | null; around: readonly import('./api').AroundScan[] | null }
  | { kind: 'DISPUTE'; dispute: Dispute }
  | { kind: 'OFF_STANDARD'; block: BlockRecord | null; item: InboxItem | null }
  | { kind: 'LINE_DAY'; day: DayRecord }

export interface StepState {
  can: LabourCan
  busy: boolean
}

/** Why Approve (A) is held, or null. What "approve" means is each kind's: a correction, a block, an upheld dispute, a closed day. */
export function approveHeld(record: ItemRecord | null, state: StepState): string | null {
  if (!record) return 'held.loading'
  const { can, busy } = state
  const held = (() => {
    switch (record.kind) {
      case 'CORRECTION':
        if (!can.correct) return 'held.noCorrect'
        return record.request?.status === 'PENDING' ? null : 'held.decided'
      case 'DISPUTE':
        return disputeHeld(record.dispute, can)
      case 'OFF_STANDARD':
        return blockHeld(record.block, can)
      case 'LINE_DAY':
        if (!can.close) return 'held.noClose'
        if (record.day.state === 'CLOSED') return 'held.closedAlready'
        return record.day.state === 'READY' ? null : 'held.dayHeld'
    }
  })()
  return held ?? (busy ? 'held.busy' : null)
}

/** Why Reject (R) is held, or null. A line day is closed or not: it has nothing to reject. */
export function rejectHeld(record: ItemRecord | null, state: StepState): string | null {
  if (record?.kind === 'LINE_DAY') return 'held.dayNoReject'
  return approveHeld(record, state)
}

function disputeHeld(dispute: Dispute, can: Pick<LabourCan, 'answer'>): string | null {
  if (!can.answer) return 'held.noAnswer'
  if (dispute.status !== 'OPEN') return 'held.decided'
  if (dispute.own) return 'held.ownDispute'
  return dispute.canAnswer ? null : 'held.noAnswer'
}

function blockHeld(block: BlockRecord | null, can: Pick<LabourCan, 'approveBlocks'>): string | null {
  if (!can.approveBlocks) return 'held.noApprove'
  if (!block) return null
  if (block.status !== 'PENDING') return 'held.decided'
  if (block.own) return 'held.ownBlock'
  return block.canDecide ? null : 'held.noApprove'
}

/** The first step of a row's verbs, read from the row alone: a person's rights and whether the row can be decided at all. */
export function rowApproveHeld(item: Pick<InboxItem, 'kind'>, can: LabourCan, busy: boolean): string | null {
  const need = { CORRECTION: can.correct ? null : 'held.noCorrect', DISPUTE: can.answer ? null : 'held.noAnswer', OFF_STANDARD: can.approveBlocks ? null : 'held.noApprove', LINE_DAY: can.close ? null : 'held.noClose' }[item.kind]
  return need ?? (busy ? 'held.busy' : null)
}

export const rowRejectHeld = (item: Pick<InboxItem, 'kind'>, can: LabourCan, busy: boolean): string | null => (item.kind === 'LINE_DAY' ? 'held.dayNoReject' : rowApproveHeld(item, can, busy))

/** Why a line day's Close is held, with its count ("held until anomalies are cleared, with the count"). */
export function closeDayHeld(day: Pick<LineDay, 'state' | 'blockers'>, can: Pick<LabourCan, 'close'>, busy: boolean): Phrase | null {
  if (!can.close) return phrase('held.noClose')
  if (day.state === 'CLOSED') return phrase('held.closedAlready')
  if (day.state === 'OPEN') return phrase('held.dayHeldCount', { count: day.blockers.reduce((sum, blocker) => sum + blocker.count, 0) })
  return busy ? phrase('held.busy') : null
}

export function reopenDayHeld(day: Pick<LineDay, 'state'>, can: Pick<LabourCan, 'reopen'>, busy: boolean): Phrase | null {
  if (!can.reopen) return phrase('held.noReopen')
  if (day.state !== 'CLOSED') return phrase('held.notClosed')
  return busy ? phrase('held.busy') : null
}

/** A day picked in Line days, kept by a dialog. */
export interface DayTarget {
  lineId: string
  lineCode: string
  lineName: string
  workDate: string
  version: number | null
}

export const dayTarget = (day: Pick<LineDay, 'line' | 'workDate' | 'version'>): DayTarget => ({ lineId: day.line.id, lineCode: day.line.code, lineName: day.line.name, workDate: day.workDate, version: day.version })

export function itemDayTarget(item: InboxItem): DayTarget | null {
  const place = lineDayOf(item.id)
  if (!place) return null
  return { lineId: place.lineId, lineCode: item.line?.code ?? '', lineName: item.line?.name ?? '', workDate: place.workDate, version: item.version }
}

/** The days a row of Line days may join in Close N: ready ones, for someone who may close. */
export const daySelectable = (day: Pick<LineDay, 'state' | 'blockers'>, can: Pick<LabourCan, 'close'>): Phrase | null => closeDayHeld(day, can, false)

// ---- the dialogs' rules -----------------------------------------------------------------------------------------------------------

/** The longest reason of each kind, and the shortest: a correction's refusal asks three letters (the API's rule). */
export function reasonLimits(kind: InboxKind): { min: number; max: number } {
  if (kind === 'CORRECTION') return { min: 3, max: 300 }
  if (kind === 'DISPUTE') return { min: 1, max: LABOUR_LIMITS.answer }
  return { min: 1, max: OFF_STANDARD_LIMITS.reason }
}

export function reasonHeld(kind: InboxKind, reason: string, busy: boolean): string | null {
  const limits = reasonLimits(kind)
  const typed = reason.trim().length
  if (typed === 0) return 'held.reason'
  if (typed < limits.min) return 'held.reasonShort'
  if (typed > limits.max) return 'held.reasonLong'
  return busy ? 'held.busy' : null
}

export interface BlockFix {
  codeId: string
  startedAt: string
  endedAt: string
}

export interface AnswerDraft {
  outcome: DisputeOutcome
  answer: string
  /** Upheld, a block: its right code and times (blank: unchanged). */
  fix: BlockFix
}

/** The block's correction an upheld answer carries, only what differs; none for a report or a rejection. */
export function blockCorrection(dispute: Pick<Dispute, 'recordType' | 'record'>, draft: AnswerDraft): { version: number; codeId?: string; startedAt?: string; endedAt?: string } | null {
  const version = dispute.record?.version
  if (draft.outcome !== 'UPHELD' || dispute.recordType !== 'OffStandardEntry' || version === null || version === undefined) return null
  const changes = {
    ...(draft.fix.codeId ? { codeId: draft.fix.codeId } : {}),
    ...(draft.fix.startedAt && draft.fix.startedAt !== dispute.record?.startedAt ? { startedAt: draft.fix.startedAt } : {}),
    ...(draft.fix.endedAt && draft.fix.endedAt !== dispute.record?.endedAt ? { endedAt: draft.fix.endedAt } : {}),
  }
  return Object.keys(changes).length > 0 ? { version, ...changes } : null
}

/** Why the dispute's answer is held: the words are required (sent to the person). */
export function answerHeld(draft: AnswerDraft, busy: boolean): string | null {
  return reasonHeld('DISPUTE', draft.answer, busy)
}

export function closeHeld(note: string, busy: boolean): string | null {
  if (note.trim().length > LABOUR_LIMITS.note) return 'held.noteLong'
  return busy ? 'held.busy' : null
}

export function reopenHeld(reason: string, busy: boolean): string | null {
  if (!reason.trim()) return 'held.reason'
  if (reason.trim().length > LABOUR_LIMITS.reason) return 'held.reasonLong'
  return busy ? 'held.busy' : null
}

export { OPEN_REASONS, type OpenReason }

/** Why "Open this person's day" is held on a record, with the band's words; null: it opens (the API still decides). */
export function dayOpenHeld(record: { workerHidden: boolean; employeeId: string | null; worker: { name: string } | null }, can: Pick<LabourCan, 'figures'>): string | null {
  if (record.workerHidden || !record.worker) return 'held.sheetsOff'
  if (!record.employeeId) return 'held.noEmployee'
  return can.figures ? null : 'held.noFigures'
}

/** Why the sheet's Open is held: someone else's day needs a reason. */
export function sheetHeld(access: FigureAccess | null, reason: OpenReason | '', busy: boolean): string | null {
  if (!access) return 'held.loading'
  if (!access.allowed) return access.refusal === 'GATE_CLOSED' ? 'held.sheetsOff' : 'held.noFigures'
  if (access.needsReason && !reason) return 'held.sheetReason'
  return busy ? 'held.busy' : null
}

export function findHeld(can: Pick<LabourCan, 'people' | 'figures'>): string | null {
  if (!can.figures) return 'held.noFigures'
  return can.people ? null : 'held.noPeople'
}

// ---- the API's answers in words ------------------------------------------------------------------------------------------------

/** The refusal's code of a 409 (`refusal/<CODE>`, `gate/<PURPOSE>`, `figures/<CODE>`), else null. */
export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/')) return path.slice('refusal/'.length)
    if (path.startsWith('gate/')) return 'GATE'
    if (path.startsWith('figures/')) return 'FIGURES'
  }
  return null
}

const KNOWN_REFUSALS = new Set([
  // Line days and disputes (B-W2b-45).
  'ALREADY_CLOSED', 'NOT_YET', 'HELD', 'NOT_CLOSED', 'DAY_CLOSED', 'STATION_SITE', 'DISPUTE_NOT_OPEN', 'OWN_DISPUTE', 'BLOCK_RUNNING',
  // Off-standard blocks (B-W2b-29).
  'STILL_RUNNING', 'NOT_PENDING', 'OWN_TIME', 'OVERLAPS', 'CODE_INACTIVE',
  // A correction's decision (B-W1-42).
  'DECIDED_ALREADY', 'SELF_APPROVAL', 'TARGET_VOIDED', 'WORK_ORDER_NOT_OPEN', 'PREVIOUS_NOT_REPORTED', 'MORE_THAN_BUNDLE', 'MORE_THAN_PASSED', 'LESS_THAN_TAKEN', 'NO_COUNT', 'UNKNOWN_SCAN', 'SAME_COUNTS', 'NEXT_REPORTED', 'ON_HOLD',
  // One person's figures (B-W2b-27).
  'GATE', 'FIGURES',
])

/** A refused write in this page's words: the rule's refusal, a version moved, no right, offline. */
export function writeProblem(error: unknown): Phrase {
  const code = refusalCode(error)
  if (code && KNOWN_REFUSALS.has(code)) return phrase(`refusal.${code}`)
  if (!isApiError(error)) return phrase('problem.write')
  switch (error.kind) {
    case 'conflict':
      return phrase(code ? 'problem.refused' : 'problem.changed')
    case 'forbidden':
    case 'step_up':
      return phrase('problem.forbidden')
    case 'not_found':
      return phrase('problem.gone')
    case 'invalid':
      return phrase('problem.invalid')
    case 'unavailable':
      return phrase('problem.offline')
    default:
      return phrase('problem.write')
  }
}

/** A failed read in words. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'not_found') return 'problem.gone'
  return 'problem.read'
}

/** Live messages that change this page. A hint: the page reads again, it never takes data from the message. */
export const isLabourChange = (type: string): boolean =>
  type.startsWith('labour_day.') ||
  type.startsWith('labour_dispute.') ||
  type === 'production.scan_correction_requested' ||
  type === 'production.scan_correction_decided' ||
  (type.startsWith('production.off_standard_') && type !== 'production.off_standard_code_changed' && type !== 'production.off_standard_started')

/**
 * B-W2b-73: Today sends a person who decides scan corrections here, and their right alone (production.scan.correct, no
 * production.labour.view) reads no queue: such a person gets that one correction, nothing else of the page.
 */
export const decidesOneCorrection = (can: Pick<LabourCan, 'view' | 'correct'>, open: OpenItem | null): boolean => !can.view && can.correct && open?.kind === 'CORRECTION'

/** The next item after a decision: the same place in the list, else the one before; null: nothing left. */
export function nextAfter(keys: readonly string[], current: string): string | null {
  const at = keys.indexOf(current)
  const rest = keys.filter((key) => key !== current)
  if (rest.length === 0) return null
  if (at < 0) return rest[0]!
  return rest[Math.min(at, rest.length - 1)]!
}

/** The lines the page offers: those read for the sites in scope, and any a row names (a person without the lines' read). */
export function linesOffered(read: ReadonlyArray<{ id: string; code: string; name: string }>, rows: ReadonlyArray<{ line: { id: string; code: string; name: string } | null }>): Array<{ id: string; code: string; name: string }> {
  const seen = new Map<string, { id: string; code: string; name: string }>()
  for (const line of read) seen.set(line.id, { id: line.id, code: line.code, name: line.name })
  for (const row of rows) if (row.line && !seen.has(row.line.id)) seen.set(row.line.id, row.line)
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code, 'it', { numeric: true }))
}
