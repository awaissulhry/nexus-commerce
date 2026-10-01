/**
 * Undo for a Shopify draft cell: its VALUE and its actual own/follow STATE (lane01, Plan A part 4).
 *
 * The sheet's history (`sheetUndo.ts`) keeps raw before/after values, so undoing "a follower set to the value it
 * already showed" wrote that value back as an OWN value — the follow state was lost, and with equal values nothing
 * even looked wrong. Here a Shopify cell's history holds a private envelope: the value plus the state it had, captured
 * from the cell BEFORE the edit (also when the values are equal). The envelope lives only in the history: the Shopify
 * column's value setter unwraps it at once and records which intent the replay needs (`set` = own, `reset` = follow),
 * and the sheet's undo replays it only into a column that says it reads one. A cell, a sort, a copy, a validation or a
 * save never sees it.
 *
 * The legacy contradictory state — a saved pin kept while the sharing rule still follows (Owner decision (a), final) —
 * cannot be recreated by the current set/reset intents. Undo REFUSES it explicitly, writes nothing, and names the old
 * value for review; it never claims an exact restoration.
 */
import { HISTORY_ONLY } from '../sheet/sheetUndo'
import { sheetValuesMatch } from '@/design-system/grid/editors/sheetWriter'
import type { StudioCellValue } from '../sheet/channel/types'
import type { ShopifySheetWrite } from '@nexus/shared/shopify-information'

/** own: this cell stores its own value · follow: it shows what it inherits · contradictory: a saved pin while the sharing
 *  rule still follows · unknown: the sharing facts were not reported (never proof of either). */
export type ShopifyDraftState = 'own' | 'follow' | 'contradictory' | 'unknown'
export interface ShopifyHistoryValue {
  readonly [HISTORY_ONLY]: true
  readonly kind: 'shopify-draft'
  readonly value: unknown
  readonly state: ShopifyDraftState
}
export type ShopifyReplayIntent = 'set' | 'reset'

/* Optimistic states: an edit made here (own) or an undo that restored following (follow), until the next read. */
const optimistic = new WeakMap<object, 'own' | 'follow'>()
/* The cell an edit replaced, read once by the history record. */
const priors = new WeakMap<object, StudioCellValue>()
/* The intent an undo/redo replay needs, read once by the write. */
const replays = new WeakMap<object, ShopifyReplayIntent>()

/**
 * A cell's state from the server's reported facts alone (`ShopifySheetWrite.sharing`). A follower of a sharing rule
 * follows it unless the rule excludes it; a follower that still keeps a saved pin is the legacy contradictory state. The
 * source, and a field no rule covers, are own when pinned and follow their provider/mapping otherwise. Facts that were
 * not reported prove nothing (`unknown`) — also not ownership.
 */
export function shopifyFactsState(cell: { pinned?: boolean; shopifyWrite?: ShopifySheetWrite } | undefined): ShopifyDraftState {
  const write = cell?.shopifyWrite
  if (!write || write.sharing === undefined) return 'unknown'
  const sharing = write.sharing
  if (sharing && sharing.sourceOwnerId !== write.ownerId) return sharing.follows ? (cell.pinned ? 'contradictory' : 'follow') : 'own'
  return cell.pinned ? 'own' : 'follow'
}
/** The state this sheet shows: an optimistic edit or replay made here first, else the reported facts. */
export function shopifyDraftState(cell: StudioCellValue | undefined): ShopifyDraftState {
  return (cell && optimistic.get(cell)) || shopifyFactsState(cell)
}

export const isShopifyHistoryValue = (value: unknown): value is ShopifyHistoryValue =>
  typeof value === 'object' && value !== null && (value as Partial<ShopifyHistoryValue>)[HISTORY_ONLY] === true && (value as Partial<ShopifyHistoryValue>).kind === 'shopify-draft'
const envelope = (value: unknown, state: ShopifyDraftState): ShopifyHistoryValue => Object.freeze({ [HISTORY_ONLY]: true as const, kind: 'shopify-draft' as const, value, state })

/** An operator edit made `next` from `previous` (the Shopify column's value setter). */
export function noteShopifyEdit(previous: StudioCellValue, next: StudioCellValue): void {
  priors.set(next, previous)
  optimistic.set(next, 'own')
}

/** The history entry for an edit of `cell`: the state BEFORE it (equal values included) and the own value after it. */
export function shopifyHistoryChange(cell: StudioCellValue | undefined, before: unknown, after: unknown): { before: ShopifyHistoryValue; after: ShopifyHistoryValue } | null {
  const previous = cell ? priors.get(cell) : undefined
  if (!cell || !previous) return null
  priors.delete(cell)
  return { before: envelope(before, shopifyDraftState(previous)), after: envelope(after, 'own') }
}

export type ShopifyReplay =
  | { kind: 'apply'; cell: StudioCellValue; intent: ShopifyReplayIntent; state: 'own' | 'follow' | null }
  | { kind: 'skip' }
  | { kind: 'refuse'; earlier: unknown }

/** What replaying `entry` into `current` does. Pure: the column's value setter applies it. */
export function replayShopifyHistory(current: StudioCellValue, entry: ShopifyHistoryValue): ShopifyReplay {
  if (entry.state === 'contradictory') return { kind: 'refuse', earlier: entry.value }
  // Facts were not reported when the step was taken: the value alone, as the sheet's plain undo does.
  if (entry.state === 'unknown') return { kind: 'apply', intent: 'set', state: null, cell: { ...current, value: entry.value, pinned: true, inherited: false } }
  if (shopifyDraftState(current) === entry.state && sheetValuesMatch(current.value, entry.value)) return { kind: 'skip' }
  return entry.state === 'own'
    ? { kind: 'apply', intent: 'set', state: 'own', cell: { ...current, value: entry.value, pinned: true, inherited: false } }
    : { kind: 'apply', intent: 'reset', state: 'follow', cell: { ...current, value: entry.value, pinned: false, inherited: true } }
}

/** The value setter applied a replay: remember the intent its write needs and, when known, the cell's optimistic state. */
export function noteShopifyReplay(replay: Extract<ShopifyReplay, { kind: 'apply' }>): void {
  if (replay.state) optimistic.set(replay.cell, replay.state)
  replays.set(replay.cell, replay.intent)
}

/** The write intent an undo/redo replay left on this cell, once. */
export function takeShopifyReplayIntent(cell: StudioCellValue | undefined): ShopifyReplayIntent | undefined {
  if (!cell) return undefined
  const intent = replays.get(cell)
  replays.delete(cell)
  return intent
}

/** The refusal, in the sheet's words, naming the earlier value for review. */
export function shopifyHistoryRefusal(where: string, earlier: string): string {
  return `Undo did not change ${where}. Before that edit the cell kept a saved Nexus draft (${earlier}) while its sharing rule still copied the shared source. `
    + 'Undo cannot recreate that mixed state exactly, so nothing was saved. Review the earlier value and set or reset the cell yourself.'
}
