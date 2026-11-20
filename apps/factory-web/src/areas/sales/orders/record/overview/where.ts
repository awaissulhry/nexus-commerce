import type { PlainStage, StageStripInput } from '../../../../../lib/production/model'
import type { Order } from '../../api'
import { depositGate, type Phrase } from '../../model'
import type { BrandStage, Dates, Headline } from './api'
import { AFTER, say } from './model'

/**
 * F-OO-100 (order overview lane: one file per section) — "Where it is now", its rules moved out of model.ts unchanged (F-SA-232:
 * one sentence, the ex-factory date and how it moved, the five plain stages, what is in work as counts). Who acts next and the
 * health stay in model.ts: the band and the ONE waiting list read them too.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** The production read's stage is the parts' plain stage (the same five codes). */
export const plainStageOf = (stage: BrandStage): PlainStage => stage

/** The headline sentence: the plain stage (+ "1 line ahead"), or before / after production the commercial words. */
export type HeadlineWords = { readonly kind: 'stage'; readonly stage: PlainStage; readonly ahead: Phrase | null } | { readonly kind: 'phrase'; readonly phrase: Phrase } | { readonly kind: 'unknown' }

const BEFORE: readonly Order['status'][] = ['PENDING_APPROVAL', 'CONFIRMED']

export function headlineOf(order: Pick<Order, 'status' | 'depositRequired' | 'chain'>, headline: Headline | null | undefined): HeadlineWords {
  if (order.status === 'PENDING_APPROVAL') return { kind: 'phrase', phrase: phrase('status.PENDING_APPROVAL') }
  if (AFTER.includes(order.status)) {
    const shipped = order.chain.shipments.map((shipment) => shipment.shippedAt).filter((at): at is string => !!at).sort().at(-1) ?? null
    const delivered = order.chain.shipments.map((shipment) => shipment.deliveredAt).filter((at): at is string => !!at).sort().at(-1) ?? null
    if (order.status === 'CANCELLED') return { kind: 'phrase', phrase: phrase('status.CANCELLED') }
    if (order.status === 'CLOSED') return { kind: 'phrase', phrase: phrase('status.CLOSED') }
    if (shipped && delivered) return { kind: 'phrase', phrase: phrase('overview.headline.delivered', { shipped, delivered }) }
    if (shipped) return { kind: 'phrase', phrase: phrase('overview.headline.shipped', { shipped }) }
    return { kind: 'phrase', phrase: phrase(`status.${order.status}`) }
  }
  const stage = headline?.stage ?? null
  if (stage && !(BEFORE.includes(order.status) && stage.code === 'PREPARING')) {
    return { kind: 'stage', stage: plainStageOf(stage.code), ahead: stage.ahead > 0 ? phrase('overview.ahead', { count: stage.ahead }) : null }
  }
  if (order.status === 'CONFIRMED') {
    const gate = depositGate(order)
    return { kind: 'phrase', phrase: gate.state === 'WAITING' || gate.state === 'MISSING' ? phrase('overview.headline.waitingDeposit') : phrase('status.CONFIRMED') }
  }
  // In production with no stage read: "Stage not known yet" (the parts' words), never step 1.
  return { kind: 'unknown' }
}

/** The five plain stages for the StageStrip (office face): the stage now, its day, the working plan's days, blocked with why. */
export function stageStripOf(order: Pick<Order, 'status' | 'depositRequired' | 'chain'>, headline: Headline | null | undefined, dates: Dates | null | undefined, locale: string): StageStripInput & { readonly note?: string | null } {
  const stage = headline?.stage ?? null
  const planned = dates?.planned ?? null
  const expected: Partial<Record<PlainStage, string | null>> = { CUTTING: planned?.cutStart ?? null, SEWING: planned?.sewStart ?? null, QUALITY: planned?.finish ?? null }
  const blocked = headline?.held ? { why: headline.holds[0] ? say(headline.holds[0].words, locale) : null } : null
  if (!stage) {
    // Before any work order the order is preparing (never "step 1" by default once it is in work).
    if (order.status === 'CONFIRMED') return { stage: 'PREPARING', expected, blocked }
    return { stage: null }
  }
  return { stage: plainStageOf(stage.code), reached: stage.since ? { [stage.code]: stage.since } : {}, expected, sewingCounted: !stage.sewingNotCounted, blocked }
}

/** Why the StageStrip waits at Preparing: work orders are made after the deposit. */
export function preparingNote(order: Pick<Order, 'status' | 'depositRequired' | 'chain'>, headline: Headline | null | undefined): Phrase | null {
  if (order.status !== 'CONFIRMED' || headline?.stage) return null
  const gate = depositGate(order)
  return gate.state === 'WAITING' || gate.state === 'MISSING' ? phrase('overview.afterDeposit') : null
}

/** "Bundles in work: 3 at Sewing" — counts only (the order's ACTIVE bundles), never a name or a station; none: nothing said. */
export function inWorkOf(headline: Headline | null | undefined): { readonly count: number; readonly stage: PlainStage } | null {
  const stage = headline?.stage ?? null
  if (!headline || !stage || headline.inWork.bundles <= 0) return null
  return { count: headline.inWork.bundles, stage: plainStageOf(stage.code) }
}

/** The ex-factory line: the promise and how it moved ("moved 2× · +6 d since first promised"); null without a promise. */
export function exFactoryOf(order: Pick<Order, 'promiseDate'>, headline: Headline | null | undefined): Phrase | null {
  const date = headline?.promise.date ?? order.promiseDate
  if (!date) return null
  const moves = headline?.promise.moves ?? 0
  const slip = headline?.promise.slipDays ?? null
  if (moves > 0 && slip !== null && slip !== 0) return phrase('overview.exFactoryMoved', { date, count: moves, days: slip > 0 ? `+${slip}` : String(slip) })
  if (moves > 0) return phrase('overview.exFactoryMovedOnly', { date, count: moves })
  return phrase('overview.exFactory', { date })
}
