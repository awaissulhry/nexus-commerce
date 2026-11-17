/**
 * B-PR-13 (production plan §4 "Waiting on"; 07-control §4.1): who an order in production waits on, pure. The API finds the
 * blockers of the customer's own order from real data; each has an owner and the time it started:
 *
 *   the customer   an approval asked of it is open (sample, PP, size set, TOP, colour, leather, fabric, trims, artwork,
 *                  proof, concession, a revised order to confirm); a task of ours waits for it (a new date to answer, how
 *                  to ship); the deposit is unpaid while it holds the release; material it supplies has not all come; it
 *                  asked for a pause that holds
 *   a supplier     a material is short and its purchase comes after the need, or a trims gate waits for the goods
 *   a workshop     an operation is out at a subcontractor and the pieces are not back
 *   us             a request of the customer waits for our answer; a gate we own, a release check, a quality hold or
 *                  nonconformance, or work that does not move
 *
 * The order waits on the first owner with a blocker in this order: customer → supplier → workshop → us, since its earliest
 * blocker; with no blocker it waits on us (the work is ours). The office reads the four; the customer reads only two: "You"
 * or "Us" — a supplier and a workshop are the factory's business and are never named to it.
 */
export const WAITING_ON = ['BRAND', 'SUPPLIER', 'WORKSHOP', 'US'] as const
export type WaitingOn = (typeof WAITING_ON)[number]

export const BLOCKER_KINDS = [
  'APPROVAL',
  'PARTNER_TASK',
  'DEPOSIT',
  'CUSTOMER_MATERIAL',
  'BRAND_PAUSE',
  'MATERIAL_SHORT',
  'SUBCONTRACT',
  'BRAND_REQUEST',
  'GATE',
  'RELEASE_CHECK',
  'QUALITY_HOLD',
  'NONCONFORMANCE',
  'NO_MOVE',
] as const
export type BlockerKind = (typeof BLOCKER_KINDS)[number]

/** Whose move each blocker waits for. */
export const BLOCKER_OWNER: Readonly<Record<BlockerKind, WaitingOn>> = Object.freeze({
  APPROVAL: 'BRAND',
  PARTNER_TASK: 'BRAND',
  DEPOSIT: 'BRAND',
  CUSTOMER_MATERIAL: 'BRAND',
  BRAND_PAUSE: 'BRAND',
  MATERIAL_SHORT: 'SUPPLIER',
  SUBCONTRACT: 'WORKSHOP',
  BRAND_REQUEST: 'US',
  GATE: 'US',
  RELEASE_CHECK: 'US',
  QUALITY_HOLD: 'US',
  NONCONFORMANCE: 'US',
  NO_MOVE: 'US',
})

export interface Blocker {
  readonly kind: BlockerKind
  /** When it started (asked, opened, held, issued…; null: not known). */
  readonly since: Date | null
}

export interface Waiting {
  readonly on: WaitingOn
  /** The earliest known start of that owner's blockers (null: none known, or nothing blocks). */
  readonly since: Date | null
}

/** Who the order waits on: the first owner with a blocker (customer → supplier → workshop → us), else us. */
export function waitingOn(blockers: readonly Blocker[]): Waiting {
  for (const on of WAITING_ON) {
    const mine = blockers.filter((blocker) => BLOCKER_OWNER[blocker.kind] === on)
    if (mine.length === 0) continue
    const known = mine.flatMap((blocker) => (blocker.since === null ? [] : [blocker.since.getTime()]))
    return { on, since: known.length > 0 ? new Date(Math.min(...known)) : null }
  }
  return { on: 'US', since: null }
}

/** What the customer reads: only You or Us. */
export const BRAND_SIDES = ['YOU', 'US'] as const
export type BrandSide = (typeof BRAND_SIDES)[number]

/** The customer's side of a waiting owner (a supplier or a workshop reads as us). */
export const brandSideOf = (on: WaitingOn): BrandSide => (on === 'BRAND' ? 'YOU' : 'US')
