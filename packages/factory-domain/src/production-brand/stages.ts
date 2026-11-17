import type { OrderFreezeStage } from '../sales/order-changes/freeze'

/**
 * B-PR-13 (production plan §4 "5 plain stages"; threads rule 8 "only true states"): the stage a customer reads of its order
 * in production, pure. The API reads the facts of the customer's OWN order lines and their own cells only (the freeze stage
 * reader apps/factory-api modules/sales/order-changes/stages.ts: RELEASED < CUT < SEWING < FINISHED < SHIPPED, the furthest
 * any cell of the line reached; the pieces released and still to ship), and these rules say:
 *
 *   PREPARING   the order is confirmed and nothing of the line is cut: a gate, the deposit, material or a draft work order
 *               is still open (a work order released but not cut is still preparing)
 *   CUTTING     its first pieces are cut (a cut of leather logged or a bundle made)
 *   SEWING      its first bundle is started or reported at a sewing step; where a site does not scan sewing it reads
 *               CUTTING until pieces are released, with the note "sewing not counted here"
 *   QUALITY     its first pieces are released by quality
 *   READY       every piece still to ship of the line is released (packing happens here); shipped pieces leave it
 *
 * The ORDER shows its slowest unfinished line, with how many of its own lines are further on ("1 line ahead"). A line with
 * nothing left to make or ship (shipped in full, cancelled, closed short) no longer counts, so on a partly shipped order the
 * open lines decide, and they read READY once all their pieces are released. An order with no open line has no stage: it
 * leaves My production. The order keeps its six commercial steps (sales/portal-orders/status); the stage is the note of
 * "In production". A stage never names a line, a work order, a worker, a site, a workshop or another customer.
 */
export const BRAND_STAGES = ['PREPARING', 'CUTTING', 'SEWING', 'QUALITY', 'READY'] as const
export type BrandStage = (typeof BRAND_STAGES)[number]

/** The stage's place (PREPARING 0 … READY 4). */
export const brandStageRank = (stage: BrandStage): number => BRAND_STAGES.indexOf(stage)

/** The stage after this one (null after READY). */
export const nextStageOf = (stage: BrandStage): BrandStage | null => BRAND_STAGES[brandStageRank(stage) + 1] ?? null

/** One line of the customer's own order, as its own cells say. */
export interface LineStageFacts {
  /** The furthest freeze stage its cells reached (null: no work order of it was released yet). */
  readonly reached: OrderFreezeStage | null
  /** Every piece still to ship of the line is released by quality (net of reversals; at least one piece open). */
  readonly allReleased: boolean
  /** Nothing is left to make or ship of the line (shipped in full, cancelled or closed short). */
  readonly done: boolean
  /** The site making it scans sewing (false: no SEWING signal can come, the line reads CUTTING until released). */
  readonly sewingCounted: boolean
}

/** The plain stage of one line (null: the line is done and no longer counts). */
export function lineStageOf(line: LineStageFacts): BrandStage | null {
  if (line.done) return null
  if (line.allReleased) return 'READY'
  switch (line.reached) {
    case null:
    case 'RELEASED':
      return 'PREPARING'
    case 'CUT':
      return 'CUTTING'
    case 'SEWING':
      return 'SEWING'
    case 'FINISHED':
    case 'SHIPPED':
      return 'QUALITY'
  }
}

export interface OrderStage {
  /** The slowest unfinished line's stage. */
  readonly stage: BrandStage
  /** How many of the order's own unfinished lines are further on ("2 lines ahead"). */
  readonly ahead: number
  /** The stage that comes next (null at READY). */
  readonly next: BrandStage | null
  /** At CUTTING because a line's site does not scan sewing: the page adds "sewing not counted here". */
  readonly sewingNotCounted: boolean
}

/** The order's plain stage: its slowest unfinished line (null: no line is open, the order left My production). */
export function orderStageOf(lines: readonly LineStageFacts[]): OrderStage | null {
  const open = lines.flatMap((line) => {
    const stage = lineStageOf(line)
    return stage === null ? [] : [{ stage, sewingCounted: line.sewingCounted }]
  })
  if (open.length === 0) return null
  const slowest = open.reduce((least, line) => (brandStageRank(line.stage) < brandStageRank(least) ? line.stage : least), open[0]!.stage)
  return {
    stage: slowest,
    ahead: open.filter((line) => brandStageRank(line.stage) > brandStageRank(slowest)).length,
    next: nextStageOf(slowest),
    sewingNotCounted: slowest === 'CUTTING' && open.some((line) => line.stage === 'CUTTING' && !line.sewingCounted),
  }
}

/** A forward move only (the keeper's stage notice fires on it; a stage going back never tells the customer). */
export const movedForward = (previous: BrandStage | null, next: BrandStage | null): boolean =>
  next !== null && (previous === null || brandStageRank(next) > brandStageRank(previous))
