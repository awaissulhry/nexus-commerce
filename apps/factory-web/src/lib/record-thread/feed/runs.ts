import type { CardMessage } from '../card/model'
import { dayOf, THREAD_TIME_ZONE } from '../parts/time'

/**
 * tw- W1.1 (10-design §3 "Sides and runs", D1, D3; R5): where a message sits and whether it starts a run.
 *
 *   side    mine = written by the reader (the API's own rule: a user AND the reader) → right, no tile, no name; everyone else left
 *   run     the same sender key + the same audience (office note / shared) + the same company day + nothing between (a day pill,
 *           a step, the unread band): one run — the tile and the name once, the tail on the first bubble, 2 px apart; 12 between runs
 *   name    on a run's first bubble of someone else, and again on one that starts with a block (a quote, a correction, files: W-018)
 *   R5      a message without a sender key (a floor writer the site's gate keeps back, the system) never joins a run: each of them is
 *           a run of its own with the "?" tile, whoever wrote it — never keyed on an id
 * On paper (`paper`) every message stands alone, on the left, with its name (R18). Pure: the feed's rows carry the answer.
 */

export interface RunPlace {
  readonly side: 'mine' | 'others'
  /** The run's first bubble: the tile, the tail, 12 px above it. */
  readonly first: boolean
  /** The run's last bubble. */
  readonly last: boolean
  /** The name line (someone else's run start, or a bubble that starts with a block). */
  readonly showName: boolean
}

export type RunMessage = Pick<CardMessage, 'kind' | 'at' | 'senderKey' | 'mine'> & Partial<Pick<CardMessage, 'replyTo' | 'corrects' | 'files'>>

/** Office note (and the floor's) or shared with the customer: a run never mixes the two. */
export const audienceKind = (message: Pick<CardMessage, 'kind'>): 'note' | 'shared' => (message.kind === 'note' || message.kind === 'floor' ? 'note' : 'shared')

export const sideOf = (message: Pick<CardMessage, 'mine'>): 'mine' | 'others' => (message.mine ? 'mine' : 'others')

/** Two messages next to each other (nothing between) are one run. */
export function sameRun(previous: RunMessage | null | undefined, next: RunMessage, timeZone: string = THREAD_TIME_ZONE): boolean {
  if (!previous || !previous.senderKey || !next.senderKey) return false
  return previous.senderKey === next.senderKey && audienceKind(previous) === audienceKind(next) && dayOf(previous.at, timeZone) === dayOf(next.at, timeZone)
}

/** A bubble that starts with a block names its sender again (W-018). */
export const startsWithBlock = (message: RunMessage): boolean => Boolean(message.replyTo || message.corrects || (message.files && message.files.length > 0))

/** The place of `message` between its neighbours in the feed (null: a row that is not a message, or none). */
export function runPlace(previous: RunMessage | null, message: RunMessage, next: RunMessage | null, options: { readonly timeZone?: string; readonly paper?: boolean } = {}): RunPlace {
  if (options.paper) return { side: 'others', first: true, last: true, showName: true }
  const timeZone = options.timeZone ?? THREAD_TIME_ZONE
  const side = sideOf(message)
  const first = !sameRun(previous, message, timeZone)
  const last = next === null || !sameRun(message, next, timeZone)
  return { side, first, last, showName: side === 'others' && (first || startsWithBlock(message)) }
}
