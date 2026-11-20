import { PLAIN_STAGES, type PlainStage, type StageStripInput } from '../../../../../lib/production/model'
import { officeStripStateOf, type OfficeStripState } from '@nexus/factory-domain/production-brand/stages' // F-OO-101: the ONE strip state
import type { Order } from '../../api'
import type { Phrase } from '../../model'
import type { BrandStage, Dates, Headline } from './api'

/**
 * F-OO-100 (order overview lane: one file per section) — "Where it is now", its rules moved out of model.ts (F-SA-232). The health
 * stays in model.ts: the band reads it too.
 *
 * F-OO-101 / F-OO-102 / F-OO-103: the headline is the status and the stage, the five stages read the same office state, and the
 * section keeps only that (the facts that left live on in one other place each: WhereCard.tsx says where).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** The production read's stage is the parts' plain stage (the same five codes). */
export const plainStageOf = (stage: BrandStage): PlainStage => stage

// ---- F-OO-101 (order overview §1.2; review F8, F11): the headline is the status AND the stage, in one sentence the dots agree with ----
/**
 * The band's own status word (`status.*`), then " · ", then the production stage word (`parts.stage.*`): "In production · Quality
 * check", "Confirmed · Preparing", "Partly shipped · Ready to ship". One word per thing: the status "Ready" with every piece ready
 * is the stage alone, "Ready to ship" (never "Ready · Ready to ship"). Waiting for a yes: the status alone and a quiet line (production
 * starts once the order is confirmed). Shipped: "Shipped 12/11", "· delivered 14/11" once the order is delivered; closed: "Closed ·
 * shipped 12/11". Cancelled: "Cancelled" and, when work had begun, where it had reached. No "· 1 line ahead" (F8: not in the sketch,
 * never explained). The state is the domain's `officeStripStateOf` — the dots read the same one (`stageStripOf`), so the two never
 * disagree. Derived: the stage is the floor's and quality's, never set here.
 */
export interface HeadlineWords {
  /** The office strip state (the domain's): the headline and the dots read the same one. */
  readonly state: OfficeStripState
  /** The status words — `status.*`, or after shipping the dated words; null when the stage word says it alone ("Ready to ship"). */
  readonly status: Phrase | null
  /** The stage word after it: a plain stage, 'unknown' ("Stage not known yet", never step 1), or null (waiting, after production). */
  readonly stage: PlainStage | 'unknown' | null
  /** The quiet line under the headline: waiting — production starts once confirmed; cancelled — where the work had reached. */
  readonly note: { readonly key: string; readonly stage?: PlainStage } | null
}

/** The latest of some instants (null: none). */
const latestOf = (instants: readonly (string | null)[]): string | null => instants.filter((at): at is string => !!at).sort().at(-1) ?? null

export function headlineOf(order: Pick<Order, 'status' | 'chain'>, headline: Headline | null | undefined): HeadlineWords {
  const state = officeStripStateOf(order.status)
  const stage = headline?.stage ? plainStageOf(headline.stage.code) : null
  const status = phrase(`status.${order.status}`)
  switch (state) {
    case 'WAITING':
      return { state, status, stage: null, note: { key: 'where.note.waiting' } }
    case 'STOPPED':
      // Where the work had reached, from the kept stage — only once it was beyond Preparing (nothing begun: nothing to say).
      return { state, status, stage: null, note: stage && PLAIN_STAGES.indexOf(stage) > 0 ? { key: 'where.note.reached', stage } : null }
    case 'ALL_DONE': {
      const shipped = latestOf(order.chain.shipments.map((shipment) => shipment.shippedAt))
      // "Delivered" only once the order is (its last shipment arrived): an older shipment's arrival never reads as the order's.
      const delivered = order.status === 'DELIVERED' ? latestOf(order.chain.shipments.map((shipment) => shipment.deliveredAt)) : null
      if (order.status === 'CLOSED') return { state, status: shipped ? phrase('where.headline.closedShipped', { shipped }) : status, stage: null, note: null }
      if (shipped && delivered) return { state, status: phrase('overview.headline.delivered', { shipped, delivered }), stage: null, note: null }
      return { state, status: shipped ? phrase('overview.headline.shipped', { shipped }) : status, stage: null, note: null }
    }
    case 'CURRENT':
      if (order.status === 'READY' && stage === 'READY') return { state, status: null, stage: 'READY', note: null }
      // Confirmed with no stage read yet: the order is preparing (before any work order); in production: "Stage not known yet".
      return { state, status, stage: stage ?? (order.status === 'CONFIRMED' ? 'PREPARING' : 'unknown'), note: null }
  }
}
// ---- end F-OO-101

/**
 * The five plain stages for the StageStrip (office face): the stage now, its day, the working plan's days, the blocked mark.
 * F-OO-102 (order overview §1.2; review F11): with the office's strip state — the domain's `officeStripStateOf`, the headline's own —
 * so the dots never disagree with the words: waiting for a yes, every stage to come; production over, every stage done (the kept
 * stage keeps its day); cancelled, no strip. The blocked mark stays while the work is current, but its why leaves the current dot's
 * note: the strips say it (one place per fact). Derived: the floor and quality set the stages, never a hand.
 */
export function stageStripOf(order: Pick<Order, 'status'>, headline: Headline | null | undefined, dates: Dates | null | undefined): StageStripInput {
  const state = officeStripStateOf(order.status)
  const stage = headline?.stage ?? null
  if (state === 'WAITING' || state === 'STOPPED') return { state, stage: null }
  if (state === 'ALL_DONE') return { state, stage: stage ? plainStageOf(stage.code) : null, reached: stage?.since ? { [stage.code]: stage.since } : {} }
  const planned = dates?.planned ?? null
  const expected: Partial<Record<PlainStage, string | null>> = { CUTTING: planned?.cutStart ?? null, SEWING: planned?.sewStart ?? null, QUALITY: planned?.finish ?? null }
  const blocked = headline?.held ? { why: null } : null
  if (!stage) {
    // Before any work order the order is preparing (never "step 1" by default once it is in work).
    if (order.status === 'CONFIRMED') return { state, stage: 'PREPARING', expected, blocked }
    return { state, stage: null }
  }
  return { state, stage: plainStageOf(stage.code), reached: stage.since ? { [stage.code]: stage.since } : {}, expected, sewingCounted: !stage.sewingNotCounted, blocked }
}

/**
 * F-OO-102: the dots are drawn — with their quiet line ("Stages are set by the floor and quality, never by hand") — only where they say
 * something true: while the work is current and once production is over; never while the order waits for a yes (no stage is now)
 * or once it is cancelled (the headline's line says where the work had reached).
 */
export const stagesShown = (state: OfficeStripState): boolean => state === 'CURRENT' || state === 'ALL_DONE'
