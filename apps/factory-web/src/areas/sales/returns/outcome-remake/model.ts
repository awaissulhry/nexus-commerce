import type { RemakeLine, RemakeView } from './api'

/**
 * A remake as a return outcome on the RMA record (B-W2b-368, XF1:03; design SCR-112 "Inspection & decision"; B-W2b-360's API): a
 * line that takes back a made-to-measure unit and is decided (or drafted) Remake shows its unit, the revision the remake is made
 * to (the rider's newest) and its factory review, that the returned unit is scrapped or held in quarantine, and "Make the remake
 * order" — held with the reason from the facts, never the API's English — or, once made, the remake order. A line that is no
 * unit says so beside a drafted Remake. Pure.
 */

export const NAMESPACE = 'sales-mtm-followups'

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** Who may make the remake order (B-W2b-360: decide the return, manage orders, see measurements). */
export const REMAKE_PERMISSIONS = ['sales.returns.decide', 'orders.manage', 'sales.measurements.view'] as const
export const mayMakeRemake = (permissions: readonly string[]): boolean => REMAKE_PERMISSIONS.every((permission) => permissions.includes(permission))

export type RemakePart =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly problem: Phrase }
  | { readonly state: 'notUnit'; readonly words: Phrase }
  | {
      readonly state: 'unit'
      readonly unit: Phrase
      readonly madeTo: Phrase
      readonly remakeTo: Phrase
      /** The factory review of the revision the remake is made to. */
      readonly review: Phrase
      readonly order: { readonly number: string; readonly href: string; readonly waits: boolean } | null
      readonly held: Phrase | null
      /** The last "Make the remake order" refused, in words (null: none). */
      readonly problem: Phrase | null
    }

const REVIEW_WORDS = new Set(['WAITING', 'CONFIRMED', 'NEED_MORE'])
const reviewWords = (review: string): Phrase => phrase(REVIEW_WORDS.has(review) ? `remake.review.${review}` : 'remake.review.other')

export interface RemakeFacts {
  readonly permissions: readonly string[]
  readonly offline: boolean
  readonly busy: boolean
  /** The last write refused (null: none). */
  readonly writeProblem?: Phrase | null
  /** The line's disposition as decided, else as drafted ('' none). */
  readonly disposition: string
  readonly prefix: string
}

/** Why "Make the remake order" waits for this line (null: it may be made), from the facts. */
export function remakeHeld(view: Pick<RemakeView, 'status' | 'number'>, line: RemakeLine, facts: Pick<RemakeFacts, 'permissions' | 'offline' | 'busy'>): Phrase | null {
  if (!mayMakeRemake(facts.permissions)) return phrase('remake.held.right')
  if (line.unit && !line.unit.started) return phrase('remake.held.off')
  if (line.disposition !== 'REMAKE') return phrase('remake.held.decide', { seq: line.seq })
  if (view.status !== 'RECEIVED' && view.status !== 'INSPECTED') return phrase('remake.held.status')
  if (facts.offline) return phrase('remake.held.offline')
  if (facts.busy) return phrase('remake.held.busy')
  return null
}

/** The part of one line, or null when there is nothing to say (no Remake decided or drafted on it). */
export function remakePartOf(view: RemakeView | null, problem: Phrase | null, lineId: string, facts: RemakeFacts): RemakePart | null {
  if (facts.disposition !== 'REMAKE') return null
  if (problem) return { state: 'error', problem }
  if (!view) return { state: 'loading' }
  const line = view.lines.find((entry) => entry.lineId === lineId)
  if (!line) return null
  if (!line.unit) return { state: 'notUnit', words: phrase('remake.notUnit', { seq: line.seq }) }
  const unit = line.unit
  const order = line.remakeOrder ? { number: line.remakeOrder.number, href: `${facts.prefix}/sales/orders/${encodeURIComponent(line.remakeOrder.orderId)}`, waits: line.remakeOrder.status === 'PENDING_APPROVAL' } : null
  return {
    state: 'unit',
    unit: phrase('remake.unit', { order: unit.orderNumber, seq: unit.seq, style: unit.style, colourway: unit.colourway, size: unit.baseSize ?? '—' }),
    madeTo: phrase('remake.madeTo', { revision: unit.madeTo.revision }),
    remakeTo: phrase(unit.newest.id === unit.madeTo.id ? 'remake.remakeToSame' : 'remake.remakeToNewer', { revision: unit.newest.revision }),
    review: reviewWords(unit.newest.review),
    order,
    held: order ? null : remakeHeld(view, line, facts),
    problem: order ? null : (facts.writeProblem ?? null),
  }
}

/** A failed read or write in this catalogue's words. */
export function remakeProblem(kind: string | null): Phrase {
  if (kind === 'forbidden') return phrase('remake.problem.forbidden')
  if (kind === 'conflict') return phrase('remake.problem.moved')
  if (kind === 'unavailable') return phrase('remake.problem.unavailable')
  return phrase('remake.problem.internal')
}
