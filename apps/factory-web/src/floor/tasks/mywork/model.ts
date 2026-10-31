import type { DispatchState } from '@nexus/factory-domain/planning/schedule/dispatch'

/**
 * SCR-089 — My work (design floor.mywork; MES-021; Owner answers P3, F2): the rules of the screen without React or the
 * network, so the tests hold them.
 *
 *   list      what `GET /production/dispatch/station` answers (B-W2a-34): the station's queue from the site's CURRENT
 *             published plan, rush first, then due date, then sequence, each entry with where its work stands from the
 *             floor's scans — per work order and operation, never a person, never money
 *   arranged  the one next task (the first ready one) big, then the rest ("Then"); work put last on this tablet moves
 *             to the end; finished entries leave the queue (counted apart)
 *   empty     why there is nothing: no station, nothing published yet, the first plan not started, nothing queued, all
 *             done — each in the screen's own words
 *   changed   a fresher list differs from the one on screen: it waits behind "List changed · Show" (rows never move under
 *             the finger, anatomy §1.6 on the floor)
 *   put last  design mywork.cant-find: a task the worker cannot find goes to the end of THIS tablet's list with a reason
 *             tile (the office's PAUSE list); the office's plan does not change (the floor never writes the plan, P3)
 */

export interface DispatchEntry {
  readonly slotId: string
  readonly workOrder: {
    readonly id: string
    readonly number: string
    readonly status: string
    readonly priority: number
    readonly rush: boolean
    readonly dueDate: string | null
    readonly style: { readonly code: string; readonly name: string }
    readonly holdReason: string | null
  }
  readonly operation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string }
  /** The operation before it (B-W2a-74 added it to the read); null: the first. */
  readonly previous: { readonly seq: number; readonly code: string; readonly name: string } | null
  readonly startAt: string
  readonly endAt: string
  readonly garments: number
  readonly minutes: string
  readonly state: DispatchState
  /** The API's sentence, in English: never shown (the screen says it in its own words). */
  readonly words: string
  readonly arrived: number
  readonly waiting: number
  readonly done: number
}

export interface DispatchList {
  readonly site: { readonly id: string; readonly code: string; readonly name: string; readonly timeZone: string }
  readonly target: {
    readonly kind: 'LINE' | 'WORK_CENTRE' | 'STATION'
    readonly id: string
    readonly code: string
    readonly name: string
    readonly line: { readonly id: string; readonly code: string; readonly name: string } | null
    readonly workCentre: { readonly id: string; readonly code: string; readonly name: string } | null
  } | null
  readonly asOf: string
  readonly version: { readonly id: string; readonly number: number; readonly coversFrom: string; readonly coversTo: string; readonly effectiveFrom: string; readonly publishedAt: string } | null
  readonly upcoming: { readonly id: string; readonly number: number; readonly effectiveFrom: string } | null
  readonly next: DispatchEntry | null
  readonly entries: readonly DispatchEntry[]
  readonly words: string | null
}

/** A task put last on this tablet, with the reason tile picked (its words kept, so the row says it offline too). */
export interface PutLast {
  readonly slotId: string
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly at: string
}

export interface QueueRow {
  readonly entry: DispatchEntry
  readonly putLast: PutLast | null
}

export interface Arranged {
  /** The one next task: the first ready one (work put last comes back only when nothing else is ready). */
  readonly next: QueueRow | null
  /** The rest, in the list's order, work put last at the end. */
  readonly queue: readonly QueueRow[]
  /** Entries finished at this station (good + scrapped = all), left out of the queue. */
  readonly done: number
}

export function arranged(list: Pick<DispatchList, 'entries'>, putLast: readonly PutLast[]): Arranged {
  const open = list.entries.filter((entry) => entry.state !== 'DONE')
  const last = new Map(putLast.map((item) => [item.slotId, item]))
  const kept = open.filter((entry) => !last.has(entry.slotId))
  // Work put last keeps the order it was put last in.
  const moved = putLast.map((item) => open.find((entry) => entry.slotId === item.slotId)).filter((entry): entry is DispatchEntry => entry !== undefined)
  const rows = [...kept, ...moved].map((entry): QueueRow => ({ entry, putLast: last.get(entry.slotId) ?? null }))
  const next = rows.find((row) => row.entry.state === 'READY') ?? null
  return { next, queue: rows.filter((row) => row !== next), done: list.entries.length - open.length }
}

/** Only the put-last marks whose task is still open in the list (a new plan, or the task done, drops them). */
export function putLastIn(list: Pick<DispatchList, 'entries'>, putLast: readonly PutLast[]): PutLast[] {
  const open = new Set(list.entries.filter((entry) => entry.state !== 'DONE').map((entry) => entry.slotId))
  return putLast.filter((item) => open.has(item.slotId))
}

/** Puts a task last (again: it moves to the very end with the new reason). */
export function withPutLast(putLast: readonly PutLast[], item: PutLast): PutLast[] {
  return [...putLast.filter((entry) => entry.slotId !== item.slotId), item]
}

export type EmptyKind =
  /** The tablet is not placed at a station: the office places it (Admin › Devices & printers). */
  | 'noStation'
  /** Nothing published for this site yet. */
  | 'nothingPublished'
  /** The first plan is published and starts later. */
  | 'firstUpcoming'
  /** The plan in force puts nothing on this station. */
  | 'nothingQueued'
  /** Everything the plan put here is done. */
  | 'allDone'

export function emptyOf(list: Pick<DispatchList, 'target' | 'version' | 'upcoming' | 'entries'>): EmptyKind | null {
  if (list.target === null) return 'noStation'
  if (list.version === null) return list.upcoming ? 'firstUpcoming' : 'nothingPublished'
  if (list.entries.length === 0) return 'nothingQueued'
  if (list.entries.every((entry) => entry.state === 'DONE')) return 'allDone'
  return null
}

/** What on the list a worker would see change (the plan, its order, each task's state and counts, a hold's words). */
export function signatureOf(list: Pick<DispatchList, 'target' | 'version' | 'upcoming' | 'entries'>): string {
  return JSON.stringify([
    list.target?.id ?? null,
    list.version?.id ?? null,
    list.upcoming?.id ?? null,
    list.entries.map((entry) => [entry.slotId, entry.state, entry.arrived, entry.waiting, entry.done, entry.workOrder.holdReason, entry.workOrder.priority]),
  ])
}

/** A fresher list differs from the one on screen: it waits behind "List changed · Show". */
export function listChanged(shown: DispatchList | null, fresh: DispatchList): boolean {
  return shown !== null && signatureOf(shown) !== signatureOf(fresh)
}

/** The tone of a task's status word (icon + word + colour; never colour alone). */
export const STATE_TONE: Readonly<Record<DispatchState, 'success' | 'info' | 'neutral' | 'danger' | 'primary'>> = {
  READY: 'success',
  WAITING_FOR_PREVIOUS: 'info',
  NOT_RELEASED: 'neutral',
  ON_HOLD: 'danger',
  DONE: 'success',
}

/** Garments still to do at this operation (never below 0). */
export function leftOf(entry: Pick<DispatchEntry, 'garments' | 'done'>): number {
  return Math.max(0, entry.garments - entry.done)
}

/** The put-last reason's words in the screen's language. */
export function putLastWords(item: Pick<PutLast, 'labelIt' | 'labelEn'>, language: string): string {
  return language === 'it' ? item.labelIt : item.labelEn
}

// ---- the tablet's put-last marks (per-tablet convenience: browser storage, wrapped; the office never sees them) ----

export const PUT_LAST_KEY = 'nexus.floor.mywork.putLast'

const isPutLast = (value: unknown): value is PutLast => {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return ['slotId', 'code', 'labelIt', 'labelEn', 'at'].every((key) => typeof item[key] === 'string')
}

/** The marks kept on this tablet (anything unreadable is dropped). */
export function readPutLast(text: string | null): PutLast[] {
  if (!text) return []
  try {
    const value = JSON.parse(text) as unknown
    return Array.isArray(value) ? value.filter(isPutLast).slice(-200) : []
  } catch {
    return []
  }
}
