/**
 * Parallel operations (B-W2b-88; MES-025 "parallel operations where the routing says so"), pure: steps of a routing with
 * the same `parallelGroup` run side by side (sleeves and body sewn at two stations at once) and count as ONE step of the
 * order. A garment passes every step of the group, in any order, before the step after the group takes it.
 *
 *   number      a group is a whole number from 1 to MAX_PARALLEL_GROUP (the …_followups_floor_w2b_guards trigger holds "from
 *               1"); null: in sequence. Numbers only name groups within one routing.
 *   adjacent    a group's steps follow each other in the routing (the release refuses a split group: the database does not
 *               hold it); a group has two steps or more (one alone is only a warning: it runs like any step)
 *   order       a step's siblings are never before or after it: the step before a group member is the one before the
 *               group (one step, or every step of an earlier group), and the step after is the one after the group
 *   frozen      a work order copies the group with each step (WorkOrderOperation.parallelGroup, filled by the trigger), so the
 *               floor's rules read the copy; an unplanned operation (B-W2b-82) is in no group
 *
 * These helpers take any rows with a `seq` and an optional `parallelGroup` (routing steps, a work order's operations, the
 * scanned ones only), already filtered by the caller.
 */

export const MAX_PARALLEL_GROUP = 99

export interface Grouped {
  readonly seq: number
  /** Left out or null: in sequence. */
  readonly parallelGroup?: number | null | undefined
}

/** Two rows run side by side: the same parallel group. A row is never side by side with itself by this test alone. */
export const sideBySide = (a: Grouped, b: Grouped): boolean => a.parallelGroup != null && a.parallelGroup === b.parallelGroup

const bySeq = <Row extends Grouped>(rows: readonly Row[]): Row[] => [...rows].sort((a, b) => a.seq - b.seq)

/** The other rows of its group (its siblings), in routing order; none when it runs in sequence. */
export function siblingsOf<Row extends Grouped>(rows: readonly Row[], self: Grouped): Row[] {
  return bySeq(rows).filter((row) => row.seq !== self.seq && sideBySide(row, self))
}

/**
 * The step before this one: the last earlier row that is not its sibling, with every earlier row of that row's group (a
 * group before it is one step). Empty at the first step.
 */
export function stepBefore<Row extends Grouped>(rows: readonly Row[], self: Grouped): Row[] {
  const earlier = bySeq(rows).filter((row) => row.seq < self.seq && !sideBySide(row, self))
  const last = earlier.at(-1)
  if (!last) return []
  return last.parallelGroup == null ? [last] : earlier.filter((row) => sideBySide(row, last))
}

/** The step after this one: the first later row that is not its sibling, with every later row of that row's group. */
export function stepAfter<Row extends Grouped>(rows: readonly Row[], self: Grouped): Row[] {
  const later = bySeq(rows).filter((row) => row.seq > self.seq && !sideBySide(row, self))
  const first = later[0]
  if (!first) return []
  return first.parallelGroup == null ? [first] : later.filter((row) => sideBySide(row, first))
}

export interface GroupProblems {
  /** Groups whose steps do not follow each other, with the steps in routing order. */
  readonly split: readonly { readonly group: number; readonly seqs: readonly number[] }[]
  /** Groups of a single step. */
  readonly alone: readonly { readonly group: number; readonly seq: number }[]
}

/** What is wrong with a routing's groups (the release check reads it: product/routing rules routingIssues). */
export function groupProblems(rows: readonly Grouped[]): GroupProblems {
  const ordered = bySeq(rows)
  const groups = new Map<number, number[]>()
  ordered.forEach((row, index) => {
    if (row.parallelGroup == null) return
    groups.set(row.parallelGroup, [...(groups.get(row.parallelGroup) ?? []), index])
  })
  const split: { group: number; seqs: number[] }[] = []
  const alone: { group: number; seq: number }[] = []
  for (const [group, places] of [...groups].sort((a, b) => a[1][0]! - b[1][0]!)) {
    if (places.length === 1) alone.push({ group, seq: ordered[places[0]!]!.seq })
    else if (places.at(-1)! - places[0]! !== places.length - 1) split.push({ group, seqs: places.map((place) => ordered[place]!.seq) })
  }
  return { split, alone }
}

/** Why a typed parallel group cannot be stored (a whole number from 1 to MAX_PARALLEL_GROUP, or null), or null. */
export function parallelGroupProblem(group: number | null): string | null {
  if (group === null) return null
  if (!Number.isInteger(group) || group < 1 || group > MAX_PARALLEL_GROUP) return `A parallel group is a whole number from 1 to ${MAX_PARALLEL_GROUP}, or none.`
  return null
}

/**
 * The groups of steps copied after the steps a routing keeps, numbered on after the kept ones' highest so a copied group
 * never joins a kept one: old number → new number (an empty map when nothing is kept or nothing is grouped).
 */
export function groupsAfter(kept: readonly Grouped[], copied: readonly Grouped[]): Map<number, number> {
  const top = kept.reduce((max, row) => Math.max(max, row.parallelGroup ?? 0), 0)
  const map = new Map<number, number>()
  if (top === 0) return map
  for (const row of bySeq(copied)) if (row.parallelGroup != null && !map.has(row.parallelGroup)) map.set(row.parallelGroup, Math.min(MAX_PARALLEL_GROUP, top + map.size + 1))
  return map
}

/** The next group number a routing has not used yet (the screen's "New group"). */
export const nextGroup = (rows: readonly Grouped[]): number => Math.min(MAX_PARALLEL_GROUP, rows.reduce((max, row) => Math.max(max, row.parallelGroup ?? 0), 0) + 1)
