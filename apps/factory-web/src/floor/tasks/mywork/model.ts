import type { DispatchState } from '@nexus/factory-domain/planning/schedule/dispatch'
import type { MaterialScope, MaterialState } from '@nexus/factory-domain/production/dispatch/material'
import type { FloorRuleMode } from '@nexus/factory-domain/production/settings/floor-rules'
import { floorListChanges } from '@nexus/ui/floor/FloorListUpdates/floorListUpdatesModel'

/**
 * SCR-089 — My work (design floor.mywork; MES-021, MES-022, MES-026, COL-036; Owner answers P3, F2): the rules of the screen without React or the
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
 *
 * B-W2b-71 (the W2b part):
 *   my list   `GET /production/dispatch/mine`: what the day names the signed-in person for, across stations, their running
 *             work first. With open work on it, it is the list; else the station's queue (design "Station or person view")
 *   material  each entry's flag (MES-026): in stock, on the way or missing, by icon, tone and word. B-W2b-88: it is the
 *             OPERATION's own where the BOM says which operation uses a line (scope OPERATION), else the work order's;
 *             the card says which. An operation that uses no material shows no flag
 *   messages  `GET /production/dispatch/mine/messages`: "For your work" counts the ones not opened on this tablet and hides
 *             at zero; which ones were opened stays on the tablet, per tablet, never per person (art. 4)
 *   help      Call for help: Material, the site's first active MATERIAL type: one tap through the floor queue, so it works
 *             offline; held with the reason when it cannot go
 *   warehouse a tablet at no station has no queue: B-W2b-308's task inbox is its My work (./warehouse, chosen by ./warehouse/entry.tsx)
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
  /** What the site's sequence rule makes of it (B-W2b-49; a saved list from before it has none). */
  readonly sequence?: { readonly rule: FloorRuleMode; readonly state: string; readonly words: string | null } | null
  /** The material flag (MES-026): the operation's or the work order's (`scope`); null: nothing known or nothing used. */
  readonly material?: MaterialFlag | null
  /** My list only: where the work is, how many bundles by name, and whether I am on it now. */
  readonly station?: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly bundles?: number
  readonly current?: boolean
}

export interface MaterialFlag {
  readonly state: MaterialState
  /** When it is expected (on the way); null when no date is known. */
  readonly date: string | null
  /** B-W2b-88: whose material it is about; left out (an older answer): the work order's. */
  readonly scope?: MaterialScope | undefined
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
  /** The list is what the day names the signed-in person for (design "person view"), not the station's queue. */
  readonly person?: boolean
}

/** `GET /production/dispatch/mine`. */
export interface MyList {
  readonly version: DispatchList['version']
  readonly entries: readonly DispatchEntry[]
}

/** My list when it holds open work, else the station's queue. */
export function listOf(station: DispatchList, mine: MyList | null): DispatchList {
  if (!mine || !mine.entries.some((entry) => entry.state !== 'DONE')) return station
  return { ...station, version: mine.version ?? station.version, entries: mine.entries, next: null, words: null, person: true }
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
  const next = rows.find((row) => row.entry.current) ?? rows.find((row) => row.entry.state === 'READY') ?? rows.find((row) => row.entry.state === 'WAITING_FOR_PREVIOUS' && row.entry.sequence?.rule === 'FREE') ?? null
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

export function emptyOf(list: Pick<DispatchList, 'target' | 'version' | 'upcoming' | 'entries' | 'person'>): EmptyKind | null {
  if (list.person) return null
  // B-W2b-308: a warehouse tablet (no station, floor/model modeOf) opens the task inbox instead; here no station is a misplaced tablet.
  if (list.target === null) return 'noStation'
  if (list.version === null) return list.upcoming ? 'firstUpcoming' : 'nothingPublished'
  if (list.entries.length === 0) return 'nothingQueued'
  if (list.entries.every((entry) => entry.state === 'DONE')) return 'allDone'
  return null
}

/** What on the list a worker would see change (the plan, its order, each task's state and counts, a hold's words). */
export function signatureOf(list: Pick<DispatchList, 'target' | 'version' | 'upcoming' | 'entries' | 'person'>): string {
  return JSON.stringify([
    list.target?.id ?? null,
    list.version?.id ?? null,
    list.upcoming?.id ?? null,
    Boolean(list.person),
    list.entries.map(rowVersion),
  ])
}

/** What makes one task look different to a worker. */
function rowVersion(entry: DispatchEntry): readonly unknown[] {
  return [entry.slotId, entry.state, entry.arrived, entry.waiting, entry.done, entry.workOrder.holdReason, entry.workOrder.priority, entry.material?.state ?? null, entry.material?.date ?? null, entry.station?.id ?? null, Boolean(entry.current)]
}

/** A fresher list differs from the one on screen: it waits behind "List changed · Show". */
export function listChanged(shown: DispatchList | null, fresh: DispatchList): boolean {
  return shown !== null && signatureOf(shown) !== signatureOf(fresh)
}

/** How many tasks differ between the list on screen and the fresher one (0: only the plan or the list's kind changed). */
export function changedRows(shown: Pick<DispatchList, 'entries'>, fresh: Pick<DispatchList, 'entries'>): number {
  return floorListChanges(shown.entries, fresh.entries, (entry) => entry.slotId, (entry) => JSON.stringify(rowVersion(entry)))
}

/** The tone of a task's status word (icon + word + colour; never colour alone). */
export const STATE_TONE: Readonly<Record<DispatchState, 'success' | 'info' | 'neutral' | 'danger' | 'primary'>> = {
  READY: 'success',
  WAITING_FOR_PREVIOUS: 'info',
  NOT_RELEASED: 'neutral',
  ON_HOLD: 'danger',
  DONE: 'success',
}

/** The tone of the material flag (with its icon and word; never colour alone). */
export const MATERIAL_TONE: Readonly<Record<MaterialState, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  IN_STOCK: 'success',
  ON_THE_WAY: 'warning',
  MISSING: 'danger',
  NOT_KNOWN: 'neutral',
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

// ---- For your work: the messages on my work orders (COL-036) --------------------------------------------------------

export type MessageFrom = 'OFFICE' | 'FLOOR'

export interface WorkMessage {
  readonly id: string
  readonly workOrder: { readonly id: string; readonly number: string }
  /** Where it comes from; never who. */
  readonly from: MessageFrom
  readonly text: string
  /** The text was cut for the tablet: the rest is in the office. */
  readonly cut: boolean
  readonly at: string
}

export interface MyMessages {
  readonly asOf: string
  readonly messages: readonly WorkMessage[]
}

/** The ones not opened on this tablet: the chip's count. */
export function unreadCount(messages: readonly Pick<WorkMessage, 'id'>[], seen: readonly string[]): number {
  const opened = new Set(seen)
  return messages.filter((message) => !opened.has(message.id)).length
}

export const SEEN_KEY = 'nexus.floor.mywork.seen'

const SEEN_KEPT = 300

/** The message opened on this tablet, newest last; the oldest marks fall off. */
export function withSeen(seen: readonly string[], id: string): string[] {
  return seen.includes(id) ? [...seen] : [...seen, id].slice(-SEEN_KEPT)
}

/** The marks kept on this tablet (anything unreadable is dropped). */
export function readSeen(text: string | null): string[] {
  if (!text) return []
  try {
    const value = JSON.parse(text) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(-SEEN_KEPT) : []
  } catch {
    return []
  }
}

/** The first words of a message, for its row. */
export function excerptOf(text: string, length = 120): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > length ? `${line.slice(0, length - 1).trimEnd()}…` : line
}

// ---- Call for help: Material (design mywork.cant-find; MES-137) -------------------------------------------------------

export interface HelpType {
  readonly id: string
  readonly code: string
  readonly kind: string
  readonly labelIt: string
  readonly labelEn: string
}

/** `GET /production/calls/station`, what this screen needs of it. */
export interface StationHelp {
  readonly station: { readonly id: string; readonly code: string } | null
  readonly tiles: readonly { readonly type: HelpType; readonly open: { readonly id: string } | null }[]
}

/** Who to call for material: the site's first active MATERIAL type, in the office's order. */
export function materialTile(help: StationHelp | null): StationHelp['tiles'][number] | null {
  return help?.tiles.find((tile) => tile.type.kind === 'MATERIAL') ?? null
}

export type HelpHeld =
  /** Still reading who to call. */
  | 'reading'
  /** Offline, and this tablet has not read the site's help types yet. */
  | 'offline'
  /** The office did not answer. */
  | 'failed'
  /** The tablet is at no station: a call goes out from a station. */
  | 'noStation'
  /** The site has no active material call. */
  | 'noType'
  /** This station already has a material call open. */
  | 'open'
  /** The call from this tablet still waits to be sent. */
  | 'waiting'

/** Why the call cannot go now; null: one tap sends it. */
export function helpHeld(input: { readonly help: StationHelp | null; readonly problem: 'reading' | 'offline' | 'failed' | null }): HelpHeld | null {
  if (!input.help) return input.problem ?? 'failed'
  if (!input.help.station) return 'noStation'
  const tile = materialTile(input.help)
  if (!tile) return 'noType'
  return tile.open ? 'open' : null
}

/** What goes in the tablet's queue (kind `andon.call.send`): the type, the work order and the operation in words. */
export function helpPayload(typeId: string, entry: Pick<DispatchEntry, 'workOrder' | 'operation'>): { typeId: string; workOrderId: string; note: string } {
  return { typeId, workOrderId: entry.workOrder.id, note: `Op ${entry.operation.seq} ${entry.operation.name}`.slice(0, 500) }
}
