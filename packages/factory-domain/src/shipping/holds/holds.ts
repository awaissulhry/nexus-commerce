import type { Issue } from '../../core/errors'
import type { Permission } from '../../core/permissions'
import { SHIPPING_HOLDS_MANAGE, SHIPPING_HOLDS_RELEASE } from './permissions'

/**
 * Shipment holds (B-W2b-386; LOG-017, FIN-079; follow-up LQ1:01), pure. A hold stops a DRAFT or PACKED shipment: while it is
 * in force the database refuses carton contents, a serial into a carton, a line into a parcel, a carrier label and the move
 * to PACKED or SHIPPED (factory-db …_packing_w2b_guards, B-W2b-364). It is placed with a reason and words, released once
 * with words, never edited or deleted: the rows are the history. One hold in force per shipment and reason.
 *
 *   CREDIT            the customer is over the credit limit, or its account is on hold for credit
 *   DEPOSIT           the deposit is not paid
 *   BALANCE_UNPAID    the balance before shipping is not paid (FIN-079)
 *   QUALITY           the office holds the goods for a quality question (a commercial hold; goods held by quality on
 *                     the floor are quality holds, holds.prisma)
 *   CUSTOMER_REQUEST  the customer asked us to wait
 *   OTHER             said in words (required)
 *
 * Who releases (LOG-017 "only allowed roles release, with words"): a money hold (credit, deposit, balance) and any hold the
 * system placed need shipping.holds.release (finance); the others shipping.holds.manage (the dispatch desk). The system
 * (placedById null) places and lifts its own holds as their cause comes and goes (system.ts).
 */

export const SHIPMENT_HOLD_REASONS = ['CREDIT', 'DEPOSIT', 'BALANCE_UNPAID', 'QUALITY', 'CUSTOMER_REQUEST', 'OTHER'] as const
export type ShipmentHoldReason = (typeof SHIPMENT_HOLD_REASONS)[number]
export const isHoldReason = (value: unknown): value is ShipmentHoldReason => typeof value === 'string' && (SHIPMENT_HOLD_REASONS as readonly string[]).includes(value)

/** The money reasons: released by finance only. */
export const MONEY_HOLD_REASONS: readonly ShipmentHoldReason[] = Object.freeze(['CREDIT', 'DEPOSIT', 'BALANCE_UNPAID'])

export const HOLD_LIMITS = Object.freeze({ words: 2000, bulk: 100 })

/** The shipment states a hold is placed on (nothing is held once it left, or when it is cancelled). */
export const HOLDABLE_STATUSES = ['DRAFT', 'PACKED'] as const

/** Why a hold write is refused (409 with the issue path `refusal/<CODE>`; the screens word the code). */
export const HOLD_REFUSALS = ['NOT_OPEN', 'ALREADY_HELD', 'NOT_IN_FORCE', 'MAY_NOT_RELEASE'] as const
export type HoldRefusalCode = (typeof HOLD_REFUSALS)[number]

export const holdRefusalPath = (code: HoldRefusalCode): string => `refusal/${code}`

/** A reason in words, for the refusals and the system's own words (English; the screens word the code themselves). */
export const HOLD_REASON_WORDS: Readonly<Record<ShipmentHoldReason, string>> = Object.freeze({
  CREDIT: 'credit',
  DEPOSIT: 'deposit not paid',
  BALANCE_UNPAID: 'balance before shipping not paid',
  QUALITY: 'quality',
  CUSTOMER_REQUEST: "the customer's request",
  OTHER: 'another reason',
})

/** The permission that releases a hold of this reason (placed by the system or by a person). */
export function releasePermissionFor(reason: ShipmentHoldReason, bySystem: boolean): Permission {
  return bySystem || MONEY_HOLD_REASONS.includes(reason) ? SHIPPING_HOLDS_RELEASE : SHIPPING_HOLDS_MANAGE
}

const clean = (value: string | null | undefined): string => (value ?? '').trim()

/** The words of a hold to place: required for OTHER, at most 2000 characters (paths are field names). */
export function placeProblems(input: { readonly reason: ShipmentHoldReason; readonly words?: string | null | undefined }): Issue[] {
  const words = clean(input.words)
  if (input.reason === 'OTHER' && words === '') return [{ path: 'words', message: 'Say in words why the shipment is held.' }]
  if (words.length > HOLD_LIMITS.words) return [{ path: 'words', message: `At most ${HOLD_LIMITS.words} characters.` }]
  return []
}

/** The words of a release: required, at most 2000 characters. */
export function releaseProblems(words: string | null | undefined): Issue[] {
  const text = clean(words)
  if (text === '') return [{ path: 'words', message: 'Say in words why the hold is released.' }]
  if (text.length > HOLD_LIMITS.words) return [{ path: 'words', message: `At most ${HOLD_LIMITS.words} characters.` }]
  return []
}

/** The stored words of a hold (null for none). */
export const storedWords = (words: string | null | undefined): string | null => (clean(words) === '' ? null : clean(words))

export interface HoldFacts {
  readonly id: string
  readonly reason: ShipmentHoldReason
  readonly placedAt: Date
  readonly placedById: string | null
  readonly releasedAt: Date | null
  readonly releasedById: string | null
}

export const inForce = (hold: Pick<HoldFacts, 'releasedAt'>): boolean => hold.releasedAt === null

/** Why a hold cannot be placed now (null: it can). */
export function placeRefusal(shipment: { readonly number: string; readonly status: string }, reason: ShipmentHoldReason, holds: readonly Pick<HoldFacts, 'reason' | 'releasedAt'>[]): { code: HoldRefusalCode; message: string } | null {
  if (!(HOLDABLE_STATUSES as readonly string[]).includes(shipment.status)) {
    return { code: 'NOT_OPEN', message: `Shipment ${shipment.number} is ${shipment.status}: only a shipment that has not left (DRAFT or PACKED) is held.` }
  }
  if (holds.some((hold) => inForce(hold) && hold.reason === reason)) {
    return { code: 'ALREADY_HELD', message: `Shipment ${shipment.number} is already on hold for ${HOLD_REASON_WORDS[reason]}.` }
  }
  return null
}

/** Why a hold cannot be released by this person now (null: it can). `may` says whether they hold the permission it needs. */
export function releaseRefusal(shipmentNumber: string, hold: HoldFacts, may: (permission: Permission) => boolean): { code: HoldRefusalCode; message: string } | null {
  if (!inForce(hold)) return { code: 'NOT_IN_FORCE', message: `This hold of shipment ${shipmentNumber} was released already.` }
  const permission = releasePermissionFor(hold.reason, hold.placedById === null)
  if (!may(permission)) {
    const who = permission === SHIPPING_HOLDS_RELEASE ? 'finance (shipping.holds.release)' : 'the dispatch desk (shipping.holds.manage)'
    const what = hold.placedById === null ? `the system's hold for ${HOLD_REASON_WORDS[hold.reason]}` : `a hold for ${HOLD_REASON_WORDS[hold.reason]}`
    return { code: 'MAY_NOT_RELEASE', message: `Only ${who} releases ${what} on shipment ${shipmentNumber}.` }
  }
  return null
}

/** The reasons in force, in the list's order (a shipment's holds as one line: "credit · the customer's request"). */
export function reasonsInForce(holds: readonly Pick<HoldFacts, 'reason' | 'releasedAt'>[]): ShipmentHoldReason[] {
  return SHIPMENT_HOLD_REASONS.filter((reason) => holds.some((hold) => inForce(hold) && hold.reason === reason))
}
