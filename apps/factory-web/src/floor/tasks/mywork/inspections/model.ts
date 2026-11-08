import type { Blocks, QueueKind, Taken } from '@nexus/factory-domain/quality/queue/rules'
import { floorListChanges } from '@nexus/ui/floor/FloorListUpdates/floorListUpdatesModel'
import type { FloorMode, TileKey } from '../../../model'

/**
 * My work's inspector queue (B-W2b-109; design floor.mywork "queue" variant: the inspector queue, QHS-068 — blocking lots first,
 * waiting time; Owner answers W1, F2): the rules of the screen without React or the network, so the tests hold them. The order is
 * the API's (B-W2b-106 `queueOrder`: what a row holds up — a first piece's run, a lot open work orders need, garments due to ship —
 * then the earliest date, then the longest wait). A row opens its card; the work starts at the bench that records it (the final
 * bench, the in-line screen), by a tap or a scan. Never a person: a row is mine or nobody's yet.
 */

export interface InspectorRow {
  readonly key: string
  readonly kind: QueueKind
  readonly kindWords: Words
  readonly recordType: string | null
  readonly id: string | null
  readonly number: string | null
  /** Codes and names only (work order · style, lot · item, bundle · operation): no words to translate. */
  readonly title: string
  readonly workOrder: { readonly id: string; readonly number: string } | null
  readonly lot: { readonly id: string; readonly code: string; readonly qualityStatus: string } | null
  readonly item: { readonly code: string; readonly name: string } | null
  readonly bundle: { readonly id: string; readonly code: string } | null
  readonly operation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string } | null
  readonly plan: { readonly code: string; readonly number: number } | null
  readonly progress: { readonly done: number | null; readonly of: number | null; readonly words: Words } | null
  readonly openedAt: string | null
  readonly waitingSince: string | null
  readonly waiting: { readonly minutes: number; readonly words: Words } | null
  readonly dueAt: string | null
  readonly overdue: boolean
  readonly blocks: { readonly what: Blocks; readonly rank: number; readonly needBy: string | null; readonly count: number | null; readonly words: Words }
  readonly taken: Taken
  readonly may: { readonly record: boolean; readonly start: boolean }
  readonly start: { readonly code: string; readonly stage: string } | null
}

export interface Words {
  readonly it: string
  readonly en: string
}

export interface InspectorQueue {
  readonly asOf: string
  readonly rows: readonly InspectorRow[]
  /** More rows than one read carries (the API's limit). */
  readonly capped: boolean
}

/** The API's words in the screen's language (Italian and English come with every code). */
export const wordsIn = (words: Words, language: string): string => (language === 'it' ? words.it : words.en)

/** The rights that show a row of the queue (each kind to whoever holds its module's view; B-W2b-106 decision 1). */
export const QUEUE_VIEW_PERMISSIONS = ['quality.inspections.view', 'quality.incoming.view', 'quality.inprocess.view'] as const

/** The person may see the inspector queue: any one of the three views. */
export const mayQueue = (permissions: readonly string[]): boolean => QUEUE_VIEW_PERMISSIONS.some((permission) => permissions.includes(permission))

/** At an inspection bench the queue IS My work (design "Variants: … inspector queue"); elsewhere a For your work tile opens it. */
export const queueFirst = (mode: FloorMode | null, permissions: readonly string[]): boolean => mode === 'inspection' && mayQueue(permissions)

/** The floor screen that records a row's kind: the final bench, the in-line screen; an incoming inspection has no floor screen yet. */
export function taskOfKind(kind: QueueKind): Extract<TileKey, 'final' | 'inline'> | null {
  switch (kind) {
    case 'FINAL':
    case 'FINAL_DUE':
      return 'final'
    case 'FIRST_PIECE':
    case 'CUTTING':
    case 'ROVING':
    case 'END_OF_LINE':
      return 'inline'
    case 'INCOMING':
      return null
  }
}

/** The code the bench is opened with: an inspection's number, the work order that waits, the bundle of an in-line check. */
export function codeOfRow(row: Pick<InspectorRow, 'kind' | 'number' | 'start' | 'workOrder' | 'bundle'>): string | null {
  switch (row.kind) {
    case 'FINAL':
      return row.number ?? row.workOrder?.number ?? null
    case 'FINAL_DUE':
      return row.start?.code ?? row.workOrder?.number ?? null
    case 'INCOMING':
      return null
    default:
      return row.bundle?.code ?? null
  }
}

/**
 * Why "Inspect" cannot open the row here: no floor screen records it yet (an incoming inspection: the office records it until the
 * floor's incoming screen lands), the person has no such tile at this station, or it is not theirs to record. Null: it opens.
 */
export type OpenHeld = 'noFloorScreen' | 'noTile' | 'notYours' | null

export function openHeld(row: Pick<InspectorRow, 'kind' | 'may'>, tiles: readonly { readonly key: TileKey; readonly held: string | null }[]): OpenHeld {
  const task = taskOfKind(row.kind)
  if (task === null) return 'noFloorScreen'
  if (!tiles.some((tile) => tile.key === task && tile.held === null)) return 'noTile'
  if (!row.may.record && !row.may.start) return 'notYours'
  return null
}

/** What makes a row look different to the inspector (its place, what it holds up, the sample so far, whose it is). */
function rowVersion(row: InspectorRow): string {
  return JSON.stringify([row.kind, row.blocks.what, row.blocks.count, row.progress?.done ?? null, row.progress?.of ?? null, row.taken, row.overdue, row.dueAt])
}

/** A fresher queue differs from the one on screen: it waits behind "List changed · Show" (rows never move under the finger). */
export function queueChanged(shown: InspectorQueue | null, fresh: InspectorQueue): boolean {
  if (!shown) return false
  return shown.rows.map((row) => `${row.key}:${rowVersion(row)}`).join('|') !== fresh.rows.map((row) => `${row.key}:${rowVersion(row)}`).join('|')
}

/** How many rows differ between the queue on screen and the fresher one. */
export const changedCount = (shown: InspectorQueue, fresh: InspectorQueue): number => floorListChanges(shown.rows, fresh.rows, (row) => row.key, rowVersion)

/** The live changes after which my inspections may differ (B-W2b-106: all already live to the floor). */
export const QUEUE_MOVES: ReadonlySet<string> = new Set([
  'final_inspection.recorded',
  'quality.inspection_opened',
  'quality.inspection_decided',
  'quality.inspection_cancelled',
  'incoming_inspection.opened',
  'incoming_inspection.recorded',
  'incoming_inspection.decided',
  'in_process_check.changed',
  'in_process_check.first_piece',
  'inspection_trigger.inspection_opened',
])

/** A live message that may move the queue: one of ours, or any incoming inspection change. */
export const movesQueue = (type: string): boolean => QUEUE_MOVES.has(type) || type.startsWith('incoming_inspection.')

/** The tone of a row (icon + words + colour; never colour alone): what it holds up, then whether it is overdue. */
export function rowTone(row: Pick<InspectorRow, 'blocks' | 'overdue'>): 'danger' | 'warning' | 'info' | 'neutral' {
  if (row.blocks.rank === 0) return 'danger'
  if (row.overdue || row.blocks.rank === 1) return 'warning'
  return row.blocks.rank === 2 ? 'info' : 'neutral'
}

/** The big number of a row: what it holds up (work orders, garments), else the sample still to inspect; null: nothing to count. */
export function rowCount(row: Pick<InspectorRow, 'blocks' | 'progress'>): { readonly value: number; readonly what: 'blocks' | 'left' } | null {
  if (row.blocks.count !== null && row.blocks.count > 0) return { value: row.blocks.count, what: 'blocks' }
  if (row.progress?.of !== null && row.progress?.of !== undefined) return { value: Math.max(0, row.progress.of - (row.progress.done ?? 0)), what: 'left' }
  return null
}
