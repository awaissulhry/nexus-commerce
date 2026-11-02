import { codeKey } from '../shared/as-of'
import { touched, type Counts } from './model'
import type { OpenItem, Timing } from './timing'

/**
 * What a person left on Operation when they moved to another page (B-W2b-F6): the counts typed and not sent, and the bundle's open
 * work, so a move never loses them and an offline Home can offer Continue. Memory for this visit only, as the screen's cards; one
 * person's never reaches the next.
 */

export interface LeftWork {
  readonly card: { readonly bundle: { readonly id: string; readonly code: string } }
  readonly operation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string }
  readonly counts: Counts
  readonly work?: { readonly timing: Timing | null } | null
}

const LEFT = new Map<string, { readonly person: string; readonly counts: Counts; readonly item: OpenItem | null }>()

const keyOf = (person: string, code: string, operationId: string) => `${person}:${codeKey(code)}:${operationId}`

export function keepLeft(person: string, left: LeftWork): void {
  const timing = left.work?.timing ?? null
  const open = timing?.state === 'RUNNING' || timing?.state === 'PAUSED'
  const key = keyOf(person, left.card.bundle.code, left.operation.id)
  if (!open && !touched(left.counts)) return void LEFT.delete(key)
  const item: OpenItem | null =
    timing && open
      ? {
          bundleId: left.card.bundle.id,
          bundleCode: left.card.bundle.code,
          operation: { id: left.operation.id, seq: left.operation.seq, code: left.operation.code, name: left.operation.name },
          state: timing.state,
          pausedAt: timing.pausedAt,
          runningSince: timing.runningSince,
          pausedAtClockOut: timing.pausedAtClockOut,
        }
      : null
  LEFT.set(key, { person, counts: left.counts, item })
}

export function leftCounts(person: string, code: string, operationId: string): Counts | null {
  return LEFT.get(keyOf(person, code, operationId))?.counts ?? null
}

export function forgetLeft(person: string, code: string, operationId: string): void {
  LEFT.delete(keyOf(person, code, operationId))
}

/** The rows the last read from the server cannot know, this person's own, added to it: a bundle left here wins over an older answer. */
export function withLeft(person: string, items: readonly OpenItem[]): readonly OpenItem[] {
  const mine = [...LEFT.values()].flatMap((entry) => (entry.person === person && entry.item ? [entry.item] : []))
  const same = (a: OpenItem, b: OpenItem) => a.bundleId === b.bundleId && a.operation.id === b.operation.id
  return [...mine, ...items.filter((item) => !mine.some((left) => same(left, item)))]
}
