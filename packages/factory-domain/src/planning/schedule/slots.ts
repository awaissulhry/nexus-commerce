import type { Issue } from '../../core/errors'

/**
 * The planning board's slots (B-W2a-34; PLN-129, PLN-131, PLN-132, PLN-147, PLN-160; Owner answer P3), pure: what a slot
 * books, the rules of a place or a move the API checks before the database (the …_production_w2a_guards triggers keep
 * the same lane, time and garment rules for every login), and what changed between the working plan and the last
 * published version (the Publish dialog's diff).
 *
 *   a slot   one work order (the allocation board's card: a whole-order slot) or one of its operations (a bar) on ONE
 *            lane of the site's plan: a line, a work centre, or a workshop (a party with the SUBCONTRACTOR role), from
 *            a start to a later end. A bar books the whole operation (splitting an operation is W3): it names no
 *            garments. A whole-order slot names the garments of the part of the order it books (null: all of them).
 *   minutes  standard minutes × garments, when placed or moved: the operation's garments still to do (a bar), or the
 *            part's garments × the standard minutes of the operations its lane does (a whole-order slot).
 *   moves    a lane, a start and end, garments (whole-order slots), a reason to keep it on an overbooked lane, a note.
 *            The plan, work order and operation of a slot never change (the trigger), so a "move to another operation"
 *            is a remove and a place.
 */

export const SCHEDULE_LANE_KINDS = ['LINE', 'WORK_CENTRE', 'WORKSHOP'] as const
export type ScheduleLaneKind = (typeof SCHEDULE_LANE_KINDS)[number]

export interface LaneRef {
  readonly kind: ScheduleLaneKind
  readonly id: string
}

export const SLOT_LIMITS = Object.freeze({ reason: 500, note: 1000, maxDays: 366, perBatch: 200 })

export const laneKey = (lane: LaneRef): string => `${lane.kind}:${lane.id}`

/** The lane of a stored slot (exactly one of its three columns is set). */
export function laneOfSlot(slot: { readonly lineId: string | null; readonly workCentreId: string | null; readonly partyId: string | null }): LaneRef {
  if (slot.lineId) return { kind: 'LINE', id: slot.lineId }
  if (slot.workCentreId) return { kind: 'WORK_CENTRE', id: slot.workCentreId }
  return { kind: 'WORKSHOP', id: slot.partyId! }
}

/** The three lane columns of a lane. */
export const laneColumns = (lane: LaneRef): { lineId: string | null; workCentreId: string | null; partyId: string | null } => ({
  lineId: lane.kind === 'LINE' ? lane.id : null,
  workCentreId: lane.kind === 'WORK_CENTRE' ? lane.id : null,
  partyId: lane.kind === 'WORKSHOP' ? lane.id : null,
})

export interface SlotInput {
  readonly startAt: number
  readonly endAt: number
  /** Whole-order slots only. */
  readonly pieces?: number | null | undefined
  readonly overloadReason?: string | null | undefined
  readonly note?: string | null | undefined
}

/** A place or move's own problems (400, issues at `body/<field>`); `whole`: a whole-order slot; `garments`: the work order's. */
export function slotInputProblems(input: SlotInput, facts: { readonly whole: boolean; readonly garments: number }): Issue[] {
  const problems: Issue[] = []
  if (!(input.endAt > input.startAt)) problems.push({ path: 'body/endAt', message: 'A slot ends after it starts.' })
  else if (input.endAt - input.startAt > SLOT_LIMITS.maxDays * 86_400_000) problems.push({ path: 'body/endAt', message: `A slot spans at most ${SLOT_LIMITS.maxDays} days.` })
  if (input.pieces !== undefined && input.pieces !== null) {
    if (!facts.whole) problems.push({ path: 'body/pieces', message: 'A bar books its whole operation; only a part of a work order (no operation) names garments.' })
    else if (!Number.isInteger(input.pieces) || input.pieces < 1) problems.push({ path: 'body/pieces', message: 'Give whole garments, from 1.' })
    else if (input.pieces > facts.garments) problems.push({ path: 'body/pieces', message: `The work order has ${facts.garments} garments.` })
  }
  if (input.overloadReason !== undefined && input.overloadReason !== null) {
    const reason = input.overloadReason.trim()
    if (reason.length < 3) problems.push({ path: 'body/overloadReason', message: 'Say in a few words why it stays on the overbooked lane.' })
    else if (reason.length > SLOT_LIMITS.reason) problems.push({ path: 'body/overloadReason', message: `At most ${SLOT_LIMITS.reason} characters.` })
  }
  if (input.note !== undefined && input.note !== null && input.note.length > SLOT_LIMITS.note) problems.push({ path: 'body/note', message: `At most ${SLOT_LIMITS.note} characters.` })
  return problems
}

/** What a published version is compared by: one work order's operation (or whole-order part on a lane). */
export interface DiffSlot {
  readonly workOrderId: string
  readonly operationId: string | null
  readonly lane: LaneRef
  readonly startAt: number
  readonly endAt: number
  readonly pieces: number | null
}

const keyOf = (slot: DiffSlot): string => (slot.operationId ? `${slot.workOrderId}|${slot.operationId}` : `${slot.workOrderId}|WHOLE|${laneKey(slot.lane)}`)
const placeOf = (slot: DiffSlot): string => `${laneKey(slot.lane)}|${slot.startAt}|${slot.endAt}|${slot.pieces ?? '-'}`

export interface PlanDiff {
  readonly moved: number
  readonly added: number
  readonly removed: number
  /** Per lane: a move is counted on the lane it goes to, a removal on the lane it left. */
  readonly byLane: readonly { readonly lane: LaneRef; readonly moved: number; readonly added: number; readonly removed: number }[]
}

/**
 * What the working plan changes against a published version: per work order operation (and whole-order part per lane),
 * its slots compared as a set of places. Added: in the working plan only; removed: in the version only; moved: in
 * both, placed differently (another lane, time or garments). Several slots of one operation count once.
 */
export function planDiff(working: readonly DiffSlot[], published: readonly DiffSlot[]): PlanDiff {
  const group = (slots: readonly DiffSlot[]) => {
    const out = new Map<string, DiffSlot[]>()
    for (const slot of slots) out.set(keyOf(slot), [...(out.get(keyOf(slot)) ?? []), slot])
    return out
  }
  const now = group(working)
  const was = group(published)
  const lanes = new Map<string, { lane: LaneRef; moved: number; added: number; removed: number }>()
  const count = (lane: LaneRef, what: 'moved' | 'added' | 'removed') => {
    const entry = lanes.get(laneKey(lane)) ?? { lane, moved: 0, added: 0, removed: 0 }
    entry[what] += 1
    lanes.set(laneKey(lane), entry)
  }
  let moved = 0
  let added = 0
  let removed = 0
  for (const [key, slots] of now) {
    const before = was.get(key)
    if (!before) {
      added += 1
      count(slots[0]!.lane, 'added')
      continue
    }
    const a = slots.map(placeOf).sort().join(';')
    const b = before.map(placeOf).sort().join(';')
    if (a !== b) {
      moved += 1
      count(slots[0]!.lane, 'moved')
    }
  }
  for (const [key, slots] of was) {
    if (now.has(key)) continue
    removed += 1
    count(slots[0]!.lane, 'removed')
  }
  const byLane = [...lanes.values()].sort((x, y) => (laneKey(x.lane) < laneKey(y.lane) ? -1 : 1))
  return { moved, added, removed, byLane }
}

/** "6 moved, 3 added, 1 removed" (nothing: "no change"). */
export function diffWords(diff: Pick<PlanDiff, 'moved' | 'added' | 'removed'>): string {
  const parts = [diff.moved ? `${diff.moved} moved` : null, diff.added ? `${diff.added} added` : null, diff.removed ? `${diff.removed} removed` : null].filter(Boolean)
  return parts.length ? parts.join(', ') : 'no change'
}

export const PUBLISH_LIMITS = Object.freeze({ maxDays: 62, note: 1000 })
