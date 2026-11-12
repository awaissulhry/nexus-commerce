import { laneKey, type LaneRef } from '../schedule/slots'

/**
 * A published version beside the working plan (B-W2b-329; PLN-154 "a published version opens read-only"; design planning.board
 * new tab "Published version v12 (read-only)": "Compare what the floor has with the working plan side by side"), pure. A
 * version's bar is matched with the working plan's bar of the same work order operation (a whole-order part: the same work
 * order on the same lane), as the publish dialog's diff matches them (planning/schedule/slots planDiff):
 *
 *   SAME     the working plan has it on the same lane at the same times (and garments)
 *   MOVED    the working plan has it elsewhere (another lane, time or garments): where, beside
 *   REMOVED  the working plan has it no more (back in the tray, or its work order closed)
 * and the working plan's bars on the version's days that the version does not have are ADDED.
 */

export const VERSION_COMPARE_STATES = ['SAME', 'MOVED', 'REMOVED'] as const
export type VersionCompareState = (typeof VERSION_COMPARE_STATES)[number]

export interface CompareSlot {
  readonly id: string
  readonly workOrderId: string
  readonly operationId: string | null
  readonly lane: LaneRef
  readonly startAt: number
  readonly endAt: number
  readonly pieces: number | null
}

const keyOf = (slot: CompareSlot): string => (slot.operationId ? `${slot.workOrderId}|${slot.operationId}` : `${slot.workOrderId}|WHOLE|${laneKey(slot.lane)}`)
const placeOf = (slot: CompareSlot): string => `${laneKey(slot.lane)}|${slot.startAt}|${slot.endAt}|${slot.pieces ?? '-'}`

export interface VersionCompare {
  /** Per version slot id: its state and the working plan's bar it was matched with. */
  readonly slots: ReadonlyMap<string, { readonly state: VersionCompareState; readonly working: CompareSlot | null }>
  /** The working plan's bars on those days the version does not have. */
  readonly added: readonly CompareSlot[]
  readonly moved: number
  readonly removed: number
}

/** The version's slots against the working plan's slots on the same days. */
export function compareVersion(version: readonly CompareSlot[], working: readonly CompareSlot[]): VersionCompare {
  const byKey = new Map<string, CompareSlot[]>()
  for (const slot of working) byKey.set(keyOf(slot), [...(byKey.get(keyOf(slot)) ?? []), slot])
  const versionKeys = new Set(version.map(keyOf))
  const slots = new Map<string, { state: VersionCompareState; working: CompareSlot | null }>()
  let moved = 0
  let removed = 0
  for (const slot of version) {
    const candidates = byKey.get(keyOf(slot)) ?? []
    const same = candidates.find((candidate) => placeOf(candidate) === placeOf(slot))
    if (same) slots.set(slot.id, { state: 'SAME', working: same })
    else if (candidates.length > 0) {
      slots.set(slot.id, { state: 'MOVED', working: candidates[0]! })
      moved += 1
    } else {
      slots.set(slot.id, { state: 'REMOVED', working: null })
      removed += 1
    }
  }
  const added = working.filter((slot) => !versionKeys.has(keyOf(slot)))
  return { slots, added, moved, removed }
}

/** "Since v12: 3 moved, 1 added, 0 removed" (nothing: "the working plan has it as published"). */
export function compareWords(number: number, compare: Pick<VersionCompare, 'moved' | 'removed'> & { readonly added: number }): string {
  if (compare.moved + compare.added + compare.removed === 0) return `The working plan has v${number}'s days as they were published.`
  return `Since v${number} the working plan has ${compare.moved} moved, ${compare.added} added, ${compare.removed} removed on its days.`
}
