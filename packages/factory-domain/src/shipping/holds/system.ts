import type { ShipmentHoldReason, HoldFacts } from './holds'
import { inForce } from './holds'

/**
 * The holds the system places and lifts by itself (B-W2b-386; FIN-079 and follow-up LQ1:01), pure. For a shipment that has
 * not left (DRAFT or PACKED) the system wants a hold while its cause stands:
 *
 *   BALANCE_UNPAID   FIN-079: the order's payment terms ask the balance before shipping (an OPEN BEFORE_SHIPPING step of
 *                    its payment schedule): held until it is paid (or waived, or no longer due), then it lifts itself
 *   CREDIT           LQ1:01: the customer's account is on hold for credit with the shipment's company, or the credit
 *                    check of a shipment leaving would hold it now (over the limit where the company's rules hold) and no
 *                    yes let this shipment through
 *   QUALITY          the customer's account is on hold for a quality dispute
 *   OTHER            the customer's account is on hold for another reason (legal, data missing, other)
 *
 * so a shipment drafted before the hold came can no longer be packed or leave (W1 only stopped it leaving). The system
 * lifts only its own holds (placedById null) when their cause is gone; a person's hold stays until a person releases it.
 * A person who releases the system's hold while its cause still stands lets the shipment go: the system does not place
 * that reason again until a new cause comes (a cause newer than that release).
 */

/** An account hold's reason (parties HOLD_REASONS) → the shipment hold it places. */
export const ACCOUNT_HOLD_REASONS: Readonly<Record<string, ShipmentHoldReason>> = Object.freeze({
  CREDIT: 'CREDIT',
  QUALITY_DISPUTE: 'QUALITY',
  LEGAL: 'OTHER',
  DATA_MISSING: 'OTHER',
  OTHER: 'OTHER',
})

const ACCOUNT_WORDS: Readonly<Record<string, string>> = Object.freeze({
  CREDIT: 'credit',
  QUALITY_DISPUTE: 'a quality dispute',
  LEGAL: 'a legal matter',
  DATA_MISSING: 'missing data',
  OTHER: 'another reason',
})

export interface SystemHoldFacts {
  readonly customerCode: string
  readonly orderNumber: string
  /** The order's OPEN before-shipping steps: since when the earliest is due (its step was made); null: none open. */
  readonly balanceOpenSince: Date | null
  /** The customer's account holds in force for the shipment's company (or every company). */
  readonly accountHolds: readonly { readonly reason: string; readonly placedAt: Date }[]
  /** The credit check of the shipment leaving would hold it now, since when (its newest HOLD check; null: no check yet); null: it would not. */
  readonly creditHeld: { readonly since: Date | null } | null
  /** The shipment's holds, every one (in force and released). */
  readonly holds: readonly HoldFacts[]
}

export interface WantedHold {
  readonly reason: ShipmentHoldReason
  /** Since when its cause stands (a person's release after it lets the shipment go). */
  readonly since: Date
  readonly words: string
}

const EPOCH = new Date(0)
const latest = (dates: readonly Date[]): Date => dates.reduce((best, date) => (date.getTime() > best.getTime() ? date : best), EPOCH)

/** The holds the system wants on the shipment now, one per reason. */
export function wantedHolds(facts: SystemHoldFacts): WantedHold[] {
  const wanted: WantedHold[] = []
  if (facts.balanceOpenSince) {
    wanted.push({
      reason: 'BALANCE_UNPAID',
      since: facts.balanceOpenSince,
      words: `The balance before shipping of order ${facts.orderNumber} is not paid: the shipment waits until it is paid, and the hold lifts itself then.`,
    })
  }
  const byReason = new Map<ShipmentHoldReason, { reasons: string[]; dates: Date[] }>()
  for (const hold of facts.accountHolds) {
    const reason = ACCOUNT_HOLD_REASONS[hold.reason] ?? 'OTHER'
    const entry = byReason.get(reason) ?? { reasons: [], dates: [] }
    if (!entry.reasons.includes(hold.reason)) entry.reasons.push(hold.reason)
    entry.dates.push(hold.placedAt)
    byReason.set(reason, entry)
  }
  const credit = byReason.get('CREDIT')
  if (credit || facts.creditHeld) {
    const dates = [...(credit?.dates ?? []), ...(facts.creditHeld?.since ? [facts.creditHeld.since] : [])]
    const why = [credit ? `${facts.customerCode}'s account is on hold for credit` : null, facts.creditHeld ? `${facts.customerCode} is over the credit limit` : null].filter((part): part is string => part !== null).join(' and ')
    wanted.push({ reason: 'CREDIT', since: latest(dates), words: `${why}: the shipment waits until finance lets it go, and the hold lifts itself when the credit allows it.` })
  }
  for (const reason of ['QUALITY', 'OTHER'] as const) {
    const entry = byReason.get(reason)
    if (!entry) continue
    const what = entry.reasons.map((code) => ACCOUNT_WORDS[code] ?? 'another reason').join(', ')
    wanted.push({ reason, since: latest(entry.dates), words: `${facts.customerCode}'s account is on hold (${what}): the shipment waits until the account hold is released, and the hold lifts itself then.` })
  }
  return wanted
}

/** Why the system lifts its hold of a reason whose cause is gone. */
export const LIFT_WORDS: Readonly<Record<ShipmentHoldReason, string>> = Object.freeze({
  CREDIT: "The customer's credit allows the shipment now: the account hold for credit is released and the credit check lets it go.",
  DEPOSIT: 'The deposit is paid or no longer due.',
  BALANCE_UNPAID: 'The balance before shipping is paid or no longer due.',
  QUALITY: "The customer's account hold for a quality dispute is released.",
  CUSTOMER_REQUEST: "The customer's request is over.",
  OTHER: "The customer's account hold is released.",
})

export interface SystemHoldPlan {
  readonly place: readonly WantedHold[]
  /** The system's holds in force whose cause is gone. */
  readonly lift: readonly HoldFacts[]
}

/**
 * What the system writes now: each wanted reason not in force (by anyone) and not let go by a person since its cause
 * stands; each of its own holds in force whose reason is no longer wanted.
 */
export function systemHoldPlan(facts: SystemHoldFacts): SystemHoldPlan {
  const wanted = wantedHolds(facts)
  const place = wanted.filter((hold) => {
    if (facts.holds.some((row) => inForce(row) && row.reason === hold.reason)) return false
    const letGo = facts.holds.some((row) => row.reason === hold.reason && row.releasedAt !== null && row.releasedById !== null && row.releasedAt.getTime() >= hold.since.getTime())
    return !letGo
  })
  const reasons = new Set(wanted.map((hold) => hold.reason))
  const lift = facts.holds.filter((row) => inForce(row) && row.placedById === null && !reasons.has(row.reason))
  return { place, lift }
}
