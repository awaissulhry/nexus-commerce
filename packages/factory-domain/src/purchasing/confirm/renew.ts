import type { LinkState } from '../../links/purposes'

/**
 * "Ask for a new link" on a purchase order's confirm link (B-W1-31; the links frame's end state; the B-W1-49 pattern):
 * a public route takes the dead link's token and answers ONE thing, whatever the token, at once; the work runs after the
 * answer. A new link goes out only when all of this holds, else nothing happens (the reason is logged by its code only):
 *
 *   NOT_A_CONFIRM_LINK     the token names no PO_CONFIRM link of a purchase order (or the order is gone)
 *   WITHDRAWN              the link was revoked: the office sent a newer one, or cancelled the order
 *   ANSWERED               the link was used: the supplier answered already
 *   STILL_LIVE             the link still works
 *   ORDER_NOT_WAITING      the order no longer waits for the supplier (only a SENT order does)
 *   NEWER_LINK             the order has a live link already (the office or an earlier request sent it)
 *   NO_ADDRESS             the old link has no address
 *   ADDRESS_NOT_ON_FILE    the old link's address is no longer the order's ACTIVE contact's: never mailed elsewhere
 *   ASKED_RECENTLY         a link of the order was made in the last ten minutes
 *
 * The new link goes only to the old link's address (the one on file), with the PDF the supplier got, as "send a new
 * link" does; the buyer gets a note on the order's thread.
 */

export const RENEW_REFUSALS = ['NOT_A_CONFIRM_LINK', 'WITHDRAWN', 'ANSWERED', 'STILL_LIVE', 'ORDER_NOT_WAITING', 'NEWER_LINK', 'NO_ADDRESS', 'ADDRESS_NOT_ON_FILE', 'ASKED_RECENTLY'] as const
export type RenewRefusal = (typeof RENEW_REFUSALS)[number]

/** Two requests within this window make one new link. */
export const RENEW_COALESCE_MS = 10 * 60 * 1000

/** The one answer of "ask for a new link", whatever the token. */
export const RENEW_ANSWER = 'Thank you. If this order still waits for your answer, a new link is on its way to the address the old one was sent to. Otherwise, reply to our e-mail.'

export interface RenewFacts {
  readonly purpose: string
  readonly recordType: string
  readonly state: LinkState
  /** The order's status; null when the order is not found. */
  readonly orderStatus: string | null
  /** Live PO_CONFIRM links of the order now. */
  readonly liveLinks: number
  /** The old link's address. */
  readonly email: string | null
  /** The order's contact now. */
  readonly contact: { readonly email: string | null; readonly status: string } | null
  readonly askedRecently: boolean
}

const normal = (value: string): string => value.trim().toLowerCase()

/** Why no new link goes out, or null when one does (the order of the checks is the table above). */
export function renewalRefusal(facts: RenewFacts): RenewRefusal | null {
  if (facts.purpose !== 'PO_CONFIRM' || facts.recordType !== 'PurchaseOrder' || facts.orderStatus === null) return 'NOT_A_CONFIRM_LINK'
  if (facts.state === 'REVOKED') return 'WITHDRAWN'
  if (facts.state === 'USED_UP') return 'ANSWERED'
  if (facts.state === 'LIVE') return 'STILL_LIVE'
  if (facts.orderStatus !== 'SENT') return 'ORDER_NOT_WAITING'
  if (facts.liveLinks > 0) return 'NEWER_LINK'
  if (!facts.email) return 'NO_ADDRESS'
  if (!facts.contact || facts.contact.status !== 'ACTIVE' || !facts.contact.email || normal(facts.contact.email) !== normal(facts.email)) return 'ADDRESS_NOT_ON_FILE'
  if (facts.askedRecently) return 'ASKED_RECENTLY'
  return null
}
