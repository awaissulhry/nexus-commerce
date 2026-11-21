import type { OrderFreezeStage } from '../sales/order-changes/freeze'
import type { SalesOrderStatus } from '../sales/orders/orders' // B-OO-007

/**
 * B-PR-13 (production plan §4 "5 plain stages"; threads rule 8 "only true states"): the stage a customer reads of its order
 * in production, pure. B-MS-001 (R21): the one named exception — a person may set the stage where the work really is, with a
 * reason, audited (./stage-set; B-SC-001: any stage, forward or back, also below the floor). The stored stage
 * (BrandOrderProduction.stage) is then the SHOWN one (stage-set shownStageOf); a reader that needs the floor's own stage reads
 * the facts (orderStageOf), never the stored stage.
 * The API reads the facts of the customer's OWN order lines and their own cells only (the freeze stage reader apps/factory-api
 * modules/sales/order-changes/stages.ts: RELEASED < CUT < SEWING < FINISHED < SHIPPED, the furthest any cell of the line
 * reached; the pieces released and still to ship), and these rules say:
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

// ── B-MS-001 (R2): where the work had reached when the order left production ──
/**
 * The floor's stage with `done` ignored: each line by the furthest its cells reached (a shipped, cancelled or closed line too),
 * the order by its slowest line, as orderStageOf; PREPARING when it has no line. The keeper writes it back when an order with a
 * stage set by hand leaves production, so "the work had reached …" says only what the floor really did.
 */
export function reachedStageOf(lines: readonly LineStageFacts[]): BrandStage {
  return orderStageOf(lines.map((line) => ({ ...line, done: false })))?.stage ?? 'PREPARING'
}
// ── end B-MS-001 ──

/** A forward move only (the keeper's stage notice fires on it; a stage going back never tells the customer). */
export const movedForward = (previous: BrandStage | null, next: BrandStage | null): boolean =>
  next !== null && (previous === null || brandStageRank(next) > brandStageRank(previous))

// ── B-OO-007 (order overview plan §6; review F11): the office's strip state — the ONE phase rule (the web imports it) ──
/**
 * How the office's stage strip reads one order, from its status alone (the stage itself stays the floor's and quality's):
 *
 *   WAITING   the order waits for a yes (PENDING_APPROVAL): nothing is current yet, every stage is to come
 *   CURRENT   confirmed, in production, ready or partly shipped: the stage is now
 *   ALL_DONE  shipped, delivered or closed: every stage is done, nothing is "now" (no health, no hold or date wait)
 *   STOPPED   cancelled: no stage is current; the office says where the work had reached
 *
 * Office only: the customer's portal keeps its own reader (it never reads this state).
 */
export const OFFICE_STRIP_STATES = ['WAITING', 'CURRENT', 'ALL_DONE', 'STOPPED'] as const
export type OfficeStripState = (typeof OFFICE_STRIP_STATES)[number]

export function officeStripStateOf(status: SalesOrderStatus): OfficeStripState {
  switch (status) {
    case 'PENDING_APPROVAL':
      return 'WAITING'
    case 'CONFIRMED':
    case 'IN_PRODUCTION':
    case 'READY':
    case 'PARTLY_SHIPPED':
      return 'CURRENT'
    case 'SHIPPED':
    case 'DELIVERED':
    case 'CLOSED':
      return 'ALL_DONE'
    case 'CANCELLED':
      return 'STOPPED'
  }
}

/** Production is over for the office (shipped, delivered, closed or cancelled): nothing of it is "now" any more. */
export const isAfterProduction = (state: OfficeStripState): boolean => state === 'ALL_DONE' || state === 'STOPPED'
// ── end B-OO-007 ──
