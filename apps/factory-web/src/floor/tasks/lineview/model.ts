import { HANDOVER_LIMITS, HANDOVER_TOPICS, type HandoverTopic } from '@nexus/factory-domain/production/dispatch/handover'
import { OVERRIDABLE_REFUSALS, OVERRIDE_REASONS } from '@nexus/factory-domain/production/guards/rules'
import type { FloorTone } from '@nexus/ui/floor'
import type { BoardStation, LineBoard } from '../../../lib/line-board/schema'
import type { QueueItem } from '../../queue/model'
import type { BundleCard } from '../scans/model'
import type { BehalfOptions, BlockRow, Conflict, ConflictDecisions, CorrectionRow, FloorLine, HandoverNote, Operator, ReassignRow, RefusalTile, ScrapRow } from './api'

/**
 * The Line view's rules (SCR-168; design floor.supervisor; Owner answer F2). Pure, so the tests hold them: the numbers of
 * "My line now" (line totals only), what waits for the team leader as ONE list (oldest first), each station's state (a
 * call, a machine down, waiting for material, nobody signed in: nothing else per station), which call the action bar
 * answers, the handover note's draft and the entry on behalf's draft.
 */

export const CALL_ANSWER = 'andon.call.answer'
export const HANDOVER_WRITE = 'andon.handover.write'
export const SCAN_ON_BEHALF = 'production.scan.onBehalf'
export const NOTE_MAX = HANDOVER_LIMITS.text
export const REASON_MAX = 500
/** A correction's refusal: the API keeps at most this many words. */
export const CORRECTION_NOTE_MAX = 300

// ---- what the screen reads ----------------------------------------------------------------------------------------------

export interface LineCan {
  /** Team leader: decisions, conflicts, the screen itself. */
  readonly lead: boolean
  readonly answer: boolean
  readonly reassign: boolean
  readonly handover: boolean
  readonly behalf: boolean
}

export function lineCan(permissions: readonly string[]): LineCan {
  const held = new Set(permissions)
  return { lead: held.has('floor.lead'), answer: held.has('production.calls.answer'), reassign: held.has('production.dispatch.manage'), handover: held.has('production.dispatch.handover'), behalf: held.has('production.scan.behalf') }
}

// ---- My line now ------------------------------------------------------------------------------------------------------------

export interface LineNumbers {
  readonly done: number
  readonly target: number | null
  readonly pace: LineBoard['output']['pace']
  readonly wip: number
  readonly stuck: number
  readonly calls: number
  readonly machinesDown: number
  readonly dhu: string | null
  readonly defects: number
}

/** The strip's numbers: the line's totals, never a station's or a person's. */
export function lineNumbers(board: Pick<LineBoard, 'output' | 'wip' | 'stations' | 'quality'>, calls: { readonly calls: readonly unknown[] } | null): LineNumbers {
  return {
    done: board.output.done,
    target: board.output.target,
    pace: board.output.pace,
    wip: board.wip.bundles,
    stuck: board.wip.stuck,
    calls: calls ? calls.calls.length : board.stations.filter((station) => station.call !== 'CLEAR').length,
    machinesDown: board.stations.filter((station) => station.machineDown).length,
    dhu: board.quality.dhu,
    defects: board.quality.defects,
  }
}

// ---- Calls ----------------------------------------------------------------------------------------------------------------

export interface QueuedAnswer {
  readonly clientEventId: string
  readonly callId: string
  readonly step: string
}

/** The answers saved on this tablet and not yet recorded (the row says so; the same answer is not offered twice). */
export function queuedAnswers(items: readonly Pick<QueueItem, 'kind' | 'state' | 'clientEventId' | 'payload'>[]): QueuedAnswer[] {
  return items.flatMap((item) => (item.kind === CALL_ANSWER && item.state === 'waiting' && typeof item.payload.callId === 'string' && typeof item.payload.step === 'string' ? [{ clientEventId: item.clientEventId, callId: item.payload.callId, step: item.payload.step }] : []))
}

/** The call the action bar answers: the one picked while it is still listed, else the first (one tap: On my way). */
export function selectedCall<Call extends { readonly id: string }>(calls: readonly Call[], picked: string | null): Call | null {
  return calls.find((call) => call.id === picked) ?? calls[0] ?? null
}

export const answerPayload = (callId: string, step: 'ON_THE_WAY' | 'SOLVED'): Record<string, unknown> => ({ callId, step })

// ---- Waiting for you --------------------------------------------------------------------------------------------------------

export type WaitingItem =
  | { readonly kind: 'scrap'; readonly id: string; readonly at: string; readonly row: ScrapRow }
  | { readonly kind: 'block'; readonly id: string; readonly at: string; readonly row: BlockRow }
  | { readonly kind: 'conflict'; readonly id: string; readonly at: string; readonly row: Conflict }
  | { readonly kind: 'correction'; readonly id: string; readonly at: string; readonly row: CorrectionRow }

/** One list, oldest first: scrap over the limit, off-standard blocks and corrections of this line, sync conflicts (what is with the office last). */
export function waitingItems(scrap: readonly ScrapRow[], blocks: readonly BlockRow[], conflicts: readonly Conflict[], lineId: string | null, corrections: readonly CorrectionRow[] = []): WaitingItem[] {
  const items: WaitingItem[] = [
    ...scrap.map((row) => ({ kind: 'scrap' as const, id: row.scanId, at: row.at, row })),
    ...blocks.filter((row) => lineId === null || row.line === null || row.line.id === lineId).map((row) => ({ kind: 'block' as const, id: row.id, at: row.startedAt, row })),
    ...conflicts.map((row) => ({ kind: 'conflict' as const, id: row.id, at: row.refused.serverTime, row })),
    ...corrections.filter((row) => lineId === null || row.line === null || row.line.id === lineId).map((row) => ({ kind: 'correction' as const, id: row.id, at: row.at, row })),
  ]
  const late = (item: WaitingItem) => (item.kind === 'conflict' && item.row.state === 'WITH_OFFICE' ? 1 : 0)
  return items.sort((a, b) => late(a) - late(b) || Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : 1))
}

export const waitingKey = (item: Pick<WaitingItem, 'kind' | 'id'>): string => `${item.kind}:${item.id}`

/** What makes a waiting row look different (the list's "2 new · Show"). */
export function waitingVersion(item: WaitingItem): string {
  return item.kind === 'conflict' ? `${item.row.version}:${item.row.state}` : item.kind === 'scrap' ? String(item.row.scrapQuantity) : String(item.row.version)
}

/** Why this person may not decide it: their own scan or time (four eyes), or it is with the office. */
export function decisionHeld(item: WaitingItem): 'own' | 'withOffice' | null {
  if (item.kind === 'conflict') return item.row.state === 'WITH_OFFICE' ? 'withOffice' : null
  return item.row.own ? 'own' : null
}

/** The next item that may be decided after this one ("The next item opens after a decision"). */
export function nextItem(items: readonly WaitingItem[], after: Pick<WaitingItem, 'kind' | 'id'>): WaitingItem | null {
  return items.find((item) => waitingKey(item) !== waitingKey(after) && decisionHeld(item) === null) ?? null
}

export interface CountChange {
  readonly key: 'good' | 'scrap' | 'rework'
  readonly from: number
  readonly to: number
}

/** A correction's old → new counts: only what it changes (no count: it moves a reason). */
export function correctionChanges(row: Pick<CorrectionRow, 'recorded' | 'asked'>): CountChange[] {
  return (['good', 'scrap', 'rework'] as const).flatMap((key) => (row.recorded[key] === row.asked[key] ? [] : [{ key, from: row.recorded[key], to: row.asked[key] }]))
}

/** The reason tiles a rejection offers: a correction has its own, a time block none (it takes words). */
export const rejectTiles = (item: Pick<WaitingItem, 'kind'>, tiles: { readonly scrap: readonly RefusalTile[]; readonly correction: readonly RefusalTile[] }): readonly RefusalTile[] => (item.kind === 'correction' ? tiles.correction : item.kind === 'scrap' ? tiles.scrap : [])

/** A rejection signs with the PIN where the API says so: a time block's and a correction's. */
export const rejectSigns = (item: Pick<WaitingItem, 'kind'>): boolean => item.kind === 'block' || item.kind === 'correction'

/** A conflict's decision with its tiles. */
export const decisionOf = (decisions: ConflictDecisions, decision: ConflictDecisions[number]['decision']) => decisions.find((entry) => entry.decision === decision) ?? null

/** Why a rejection cannot go yet: a tile that asks for words needs them; a block's rejection always does. */
export function rejectHeld(input: { readonly item: WaitingItem; readonly tile: Pick<RefusalTile, 'needsDetail'> | null; readonly words: string }): 'tile' | 'words' | null {
  if (input.item.kind === 'block') return input.words.trim() === '' ? 'words' : null
  if (!input.tile) return 'tile'
  return input.tile.needsDetail && input.words.trim() === '' ? 'words' : null
}

// ---- Stations ---------------------------------------------------------------------------------------------------------------

export interface StationState {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly call: BoardStation['call']
  readonly machineDown: boolean
  readonly material: boolean
  /** Null: not known (the dispatch read failed); false says "Nobody signed in". */
  readonly signedIn: boolean | null
  readonly reassign: readonly ReassignRow[]
  readonly tone: FloorTone
}

const stationTone = (station: Pick<BoardStation, 'machineDown' | 'call'>, signedIn: boolean | null, reassign: number): FloorTone => {
  if (station.machineDown) return 'danger'
  if (station.call === 'CALLING' || reassign > 0) return 'warning'
  if (station.call === 'COMING') return 'info'
  return signedIn === false ? 'neutral' : 'success'
}

/** Each station's board state: the call, the machine, material and whether anyone is signed in. Never output, never who (F2). */
export function stationStates(board: Pick<LineBoard, 'stations'>, line: Pick<FloorLine, 'stations'> | null): StationState[] {
  return board.stations.map((station) => {
    const own = line?.stations.find((entry) => entry.id === station.id) ?? null
    const signedIn = own ? own.signedIn : null
    const reassign = own?.reassign ?? []
    return { id: station.id, code: station.code, name: station.name, call: station.call, machineDown: station.machineDown, material: station.material, signedIn, reassign, tone: stationTone(station, signedIn, reassign.length) }
  })
}

// ---- Reassign ---------------------------------------------------------------------------------------------------------------

/** The people offered: a HOLD says why on the tile; a WARN asks a reason before it goes. */
export const reassignHeld = (operator: Pick<Operator, 'decision' | 'words'>): string | null => (operator.decision === 'HOLD' ? (operator.words ?? '') : null)
export const reassignNeedsReason = (operator: Pick<Operator, 'decision'>): boolean => operator.decision === 'WARN'

// ---- the handover note --------------------------------------------------------------------------------------------------------

export const TOPICS: readonly HandoverTopic[] = HANDOVER_TOPICS

export interface HandoverDraft {
  readonly topics: readonly HandoverTopic[]
  readonly text: string
}

export const EMPTY_HANDOVER: HandoverDraft = Object.freeze({ topics: [], text: '' })

export const draftOfNote = (note: Pick<HandoverNote, 'topics' | 'text'> | null): HandoverDraft => (note ? { topics: note.topics.map((entry) => entry.topic), text: note.text ?? '' } : EMPTY_HANDOVER)

export const toggleTopic = (draft: HandoverDraft, topic: HandoverTopic): HandoverDraft => ({ ...draft, topics: draft.topics.includes(topic) ? draft.topics.filter((entry) => entry !== topic) : [...draft.topics, topic] })

export const handoverHeld = (draft: HandoverDraft): 'empty' | 'long' | null => (draft.text.length > NOTE_MAX ? 'long' : draft.topics.length === 0 && draft.text.trim() === '' ? 'empty' : null)

/** The queued note: the shift it goes to and the version read (one note per line and shift). */
export function handoverPayload(lineId: string, shift: string, draft: HandoverDraft, current: Pick<HandoverNote, 'version' | 'shiftLabel'> | null): Record<string, unknown> {
  const text = draft.text.trim()
  return { lineId, shiftLabel: current?.shiftLabel ?? shift, topics: draft.topics, text: text === '' ? null : text, ...(current ? { version: current.version } : {}) }
}

// ---- Scan on behalf ---------------------------------------------------------------------------------------------------------

export interface BehalfDraft {
  readonly stationId: string | null
  readonly personId: string | null
  readonly card: BundleCard | null
  readonly operationId: string | null
  readonly good: number
  readonly scrap: Readonly<Record<string, number>>
  readonly rework: Readonly<Record<string, number>>
  readonly reason: string | null
  readonly note: string
}

export const EMPTY_BEHALF: BehalfDraft = Object.freeze({ stationId: null, personId: null, card: null, operationId: null, good: 0, scrap: {}, rework: {}, reason: null, note: '' })

/** The operations an entry can report: scanned, open, in routing order; the one the API names next first. */
export function openOperations(card: Pick<BundleCard, 'operations' | 'next'>): BundleCard['operations'] {
  const open = card.operations.filter((operation) => operation.scanRequired && operation.state === 'OPEN')
  return [...open].sort((a, b) => Number(b.id === card.next) - Number(a.id === card.next) || a.seq - b.seq)
}

export const expectedOf = (draft: Pick<BehalfDraft, 'card' | 'operationId'>): number => draft.card?.operations.find((operation) => operation.id === draft.operationId)?.expected ?? draft.card?.bundle.quantity ?? 0

const sum = (record: Readonly<Record<string, number>>) => Object.values(record).reduce((total, value) => total + value, 0)

/** Good balances itself against the bundle until it is typed: the pieces with a reason are taken from it. */
export const withDefects = (draft: BehalfDraft, kind: 'scrap' | 'rework', counts: Readonly<Record<string, number>>): BehalfDraft => {
  const next = { ...draft, [kind]: counts }
  return { ...next, good: Math.max(0, expectedOf(draft) - sum(next.scrap) - sum(next.rework)) }
}

/** Why the counts cannot go on, or null. */
export function countsHeld(draft: BehalfDraft): 'nothing' | 'atMost' | null {
  const total = draft.good + sum(draft.scrap) + sum(draft.rework)
  if (total < 1) return 'nothing'
  return total > expectedOf(draft) ? 'atMost' : null
}

/** Why the entry cannot be sent, or null. */
export function behalfHeld(draft: BehalfDraft, options: Pick<BehalfOptions, 'subject' | 'reasons'>): 'station' | 'person' | 'bundle' | 'reason' | 'note' | null {
  if (!draft.stationId) return 'station'
  if (options.subject === 'WORKER' && !draft.personId) return 'person'
  if (!draft.card || !draft.operationId) return 'bundle'
  const reason = options.reasons.find((entry) => entry.code === draft.reason)
  if (!reason) return 'reason'
  return reason.needsNote && draft.note.trim().length < 3 ? 'note' : null
}

const lines = (record: Readonly<Record<string, number>>) => Object.entries(record).filter(([, quantity]) => quantity > 0).map(([reason, quantity]) => ({ reason, quantity }))

/** The report's body: what the queue keeps for `production.scan.onBehalf`, and with a `clientScanId` what the route takes. */
export function behalfPayload(draft: BehalfDraft, subject: BehalfOptions['subject']): Record<string, unknown> {
  const scrap = lines(draft.scrap)
  const rework = lines(draft.rework)
  const note = draft.note.trim()
  return {
    code: draft.card?.bundle.code,
    workOrderOperationId: draft.operationId,
    good: draft.good,
    ...(scrap.length > 0 ? { scrap } : {}),
    ...(rework.length > 0 ? { rework } : {}),
    stationId: draft.stationId,
    ...(subject === 'WORKER' ? { workerId: draft.personId } : {}),
    reasonCode: draft.reason,
    ...(note !== '' ? { note } : {}),
  }
}

/** A held check another team leader may lift (four eyes): the entry goes to the override. */
export const isOverridable = (code: string): boolean => (OVERRIDABLE_REFUSALS as readonly string[]).includes(code)

export const OVERRIDE_TILES = OVERRIDE_REASONS

export interface OverrideDraft {
  readonly reason: string | null
  readonly note: string
  readonly badge: string | null
}

export const EMPTY_OVERRIDE: OverrideDraft = Object.freeze({ reason: null, note: '', badge: null })

export function overrideHeld(draft: OverrideDraft): 'reason' | 'note' | 'badge' | null {
  const reason = OVERRIDE_TILES.find((entry) => entry.code === draft.reason)
  if (!reason) return 'reason'
  if (reason.needsNote && draft.note.trim().length < 3) return 'note'
  return draft.badge ? null : 'badge'
}

export const overrideBody = (report: Readonly<Record<string, unknown>>, draft: OverrideDraft, pin: string): Record<string, unknown> => {
  const note = draft.note.trim()
  return { report, lead: { badgeCode: draft.badge, pin }, overrideReasonCode: draft.reason, ...(note !== '' ? { overrideNote: note } : {}) }
}

/** The refusals this screen has its own words for; any other shows the API's. */
export const KNOWN_REFUSALS = ['SOLVED', 'CANCELLED', 'ALREADY_ON_THE_WAY', 'DECIDED_ALREADY', 'SELF_DECISION', 'BEHALF_SELF', 'BEHALF_NO_NOTICE', 'OVERRIDE_SELF', 'NOT_QUALIFIED', 'NOT_AUTHORISED', 'OVERRIDE_REASON_NEEDED', 'STALE', 'OTHER_KIND'] as const
export const isKnownRefusal = (code: string): boolean => (KNOWN_REFUSALS as readonly string[]).includes(code)

/** What can refuse a correction's decision (B-W2b-83): words of their own, since the same code on an entry on behalf means another thing. */
export const CORRECTION_REFUSALS = ['SELF_APPROVAL', 'TARGET_VOIDED', 'LESS_THAN_TAKEN', 'MORE_THAN_PASSED', 'MORE_THAN_BUNDLE', 'PREVIOUS_NOT_REPORTED', 'NO_COUNT', 'SAME_COUNTS', 'UNKNOWN_SCAN', 'WORK_ORDER_NOT_OPEN', 'ON_HOLD'] as const
export const isCorrectionRefusal = (code: string): boolean => (CORRECTION_REFUSALS as readonly string[]).includes(code)
