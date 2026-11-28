import { orderLifeOf, type LifeNote, type OrderLife, type OrderLifeAnswer, type OrderStatusFacts } from '@nexus/factory-domain/sales/order-life'
import type { ReadPictures } from '../../../../../lib/record-picture/cache'
import type { SaveOrderPicture } from '../../../../../lib/record-picture/api'
import type { PictureChoice } from '../../../../../lib/record-picture/order-picture'
import type { Department } from '../../../../../lib/department/model'
import type { BasketCard } from '../../../../../lib/production/baskets-board'
import type { ReadOrderLog } from '../../../../../lib/change-log/api'
import type { PaymentNotice } from './api'

/**
 * owb-of5 step 1 (design plan § 5i "ONE frame for every record page"; prototype rec.js orderBand, office.js officeNext) — the order
 * band's rules, pure: the ONE main act of an order by its life, the tags beside its ONE state chip, and its life from the facts the
 * office reads. ONE design order is two records (a Draft or Sent order is a PortalOrderRequest, Confirm makes the SalesOrder): both
 * pages ask these rules, so the band says the same thing on both.
 *
 *   Draft · Sent        → Confirm the order…           (orders.manage)
 *   Confirmed           → Print and start the work…    (production.print.start — drawn only for who holds it; S3's window)
 *   In production       → no main act
 *   Ready to ship       → Ship…                        (shipping.manage or shipping.plan, with pieces ready; S3's window)
 *   Shipped · a leg on its way to our warehouse → It arrived     (the leg's own `may.arrived`; S3's window)
 *   At our warehouse    → Send on to the customer      (the leg's own `may.sendOn`; S3's window)
 *
 * An act this reader may not do is not drawn (the section kit's rule: a button you may not use is not drawn).
 */

export const ORDER_ACTS = ['CONFIRM', 'PRINT', 'SHIP', 'ARRIVED', 'SEND_ON'] as const
export type OrderAct = (typeof ORDER_ACTS)[number]

/** A warehouse leg as S3's read gives it (`GET /shipping/warehouse-legs?salesOrderId=`, owb-ss1 Shape). */
export type LegState = 'ON_THE_WAY' | 'AT_OUR_WAREHOUSE' | 'SENT_ON'
export interface LegFacts {
  readonly shipmentId: string
  readonly state: LegState
  readonly may: { readonly arrived: boolean; readonly sendOn: boolean }
}

export interface ActInput {
  readonly life: OrderLife
  readonly note?: LifeNote | null
  /** What this reader may do: confirm (orders.manage), print (production.print.start), ship (a shipping right AND pieces ready). */
  readonly may: { readonly confirm?: boolean; readonly print?: boolean; readonly ship?: boolean }
  /** The order's warehouse legs (S3's read); absent or null: none read. */
  readonly legs?: readonly LegFacts[] | null
}

export interface ActAnswer {
  readonly act: OrderAct
  /** ARRIVED / SEND_ON: the shipment whose leg the window acts on. */
  readonly shipmentId?: string
}

/** The ONE main act of the band, or null (none: in production, a final state, or an act this reader may not do). */
export function orderActOf(input: ActInput): ActAnswer | null {
  const legs = input.legs ?? []
  switch (input.life) {
    case 'DRAFT':
    case 'SENT':
      // A Sent order that waits for the office's yes (PENDING_APPROVAL) keeps today's yes door: the band's caller decides it.
      return input.may.confirm && input.note?.kind !== 'WAITS_FOR_APPROVAL' ? { act: 'CONFIRM' } : null
    case 'CONFIRMED':
      return input.may.print ? { act: 'PRINT' } : null
    case 'READY_TO_SHIP':
      return input.may.ship ? { act: 'SHIP' } : null
    case 'SHIPPED': {
      const leg = legs.find((entry) => entry.state === 'ON_THE_WAY' && entry.may.arrived)
      if (leg) return { act: 'ARRIVED', shipmentId: leg.shipmentId }
      // Partly shipped with pieces ready: the rest ships.
      return input.note?.kind === 'PARTLY_SHIPPED' && input.may.ship ? { act: 'SHIP' } : null
    }
    case 'AT_OUR_WAREHOUSE': {
      const leg = legs.find((entry) => entry.state === 'AT_OUR_WAREHOUSE' && entry.may.sendOn)
      return leg ? { act: 'SEND_ON', shipmentId: leg.shipmentId } : null
    }
    case 'IN_PRODUCTION':
    case 'DELIVERED':
    case 'WITHDRAWN':
      return null
  }
}

/** A sales order's life from what the office reads: its status, its pieces and S3's legs (a leg arrived and not sent on). */
export function lifeOfOrder(order: { readonly status: OrderStatusFacts['status']; readonly progress: { readonly shipped: number; readonly ordered: number } }, legs?: readonly LegFacts[] | null): OrderLifeAnswer {
  return orderLifeOf({
    order: {
      status: order.status,
      pieces: { shipped: order.progress.shipped, total: order.progress.ordered },
      atOurWarehouse: legs ? legs.some((leg) => leg.state === 'AT_OUR_WAREHOUSE') : null,
    },
  })
}

// ---- the tags beside the ONE state chip ------------------------------------------------------------------------------------------

/**
 * The band's tags (prototype orderBand chips): Customer on hold (a Draft or Sent order only) · the design's state · Restricted on the
 * floor · n problems · Remake. Late is the band's health chip (Late · N d / At risk, today's BandHealth): it is not drawn twice.
 */
export const BAND_TAGS = ['CUSTOMER_ON_HOLD', 'DESIGN', 'RESTRICTED', 'PROBLEMS', 'REMAKE'] as const
export type BandTagKind = (typeof BAND_TAGS)[number]
export type DesignState = 'WAITS' | 'APPROVED' | 'CHANGE'

export interface TagFacts {
  readonly life: OrderLife
  readonly customerOnHold?: boolean
  readonly design?: DesignState | null
  readonly restricted?: boolean
  readonly problems?: number
  readonly remake?: boolean
}

export interface BandTag {
  readonly kind: BandTagKind
  readonly tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
  /** The tag's words in the flow catalogue (`tag.*`) and their values. */
  readonly key: string
  readonly params?: Readonly<Record<string, number>>
}

const DESIGN_TONE: Readonly<Record<DesignState, BandTag['tone']>> = Object.freeze({ WAITS: 'info', APPROVED: 'success', CHANGE: 'warning' })

/** The tags in the design's order; a fact not known (absent) draws nothing. */
export function bandTagsOf(facts: TagFacts): BandTag[] {
  const out: BandTag[] = []
  if (facts.customerOnHold && (facts.life === 'DRAFT' || facts.life === 'SENT')) out.push({ kind: 'CUSTOMER_ON_HOLD', tone: 'danger', key: 'tag.CUSTOMER_ON_HOLD' })
  if (facts.design) out.push({ kind: 'DESIGN', tone: DESIGN_TONE[facts.design], key: `tag.DESIGN_${facts.design}` })
  if (facts.restricted) out.push({ kind: 'RESTRICTED', tone: 'danger', key: 'tag.RESTRICTED' })
  if ((facts.problems ?? 0) > 0) out.push({ kind: 'PROBLEMS', tone: 'danger', key: 'tag.PROBLEMS', params: { count: facts.problems ?? 0 } })
  if (facts.remake) out.push({ kind: 'REMAKE', tone: 'neutral', key: 'tag.REMAKE' })
  return out
}

/** The open problems of an order: the production asks still OPEN (the issues list). */
export const openProblemsOf = (issues: readonly { readonly status: string }[] | null | undefined): number => (issues ?? []).filter((issue) => issue.status === 'OPEN').length

// ---- the order as it was written (owb-of5 step 2; design § 5g "A text order on the factory's side") -------------------------------

/** What the customer wrote when it sent the order: the mail's subject, its text, its described lines and its files (names only). */
export interface TextCard {
  readonly subject: string | null
  readonly text: string | null
  /** The lines in the customer's own words ("As in the message"): their number and words. */
  readonly lines: readonly { readonly seq: number; readonly words: string }[]
  readonly files: readonly { readonly id: string; readonly name: string }[]
}

/** The request facts this card reads (lib/order-draft's DraftRequest, the parts it needs). */
export interface WrittenRequest {
  readonly subject?: string | null
  readonly note: string | null
  readonly customLines?: readonly { readonly seq: number; readonly kind: string; readonly description: string | null }[]
  readonly files?: { readonly references: readonly { readonly id: string; readonly originalName: string | null }[] }
}

/**
 * The card "The order as it was written" — only for an order that came as text: the customer's mail has words, or a line is in the
 * customer's own words (a DESCRIBED line). An order typed from the catalogue has no card (null).
 */
export function textCardOf(request: WrittenRequest | null | undefined): TextCard | null {
  if (!request) return null
  const text = request.note?.trim() || null
  const lines = (request.customLines ?? []).filter((line) => line.kind === 'DESCRIBED' && !!line.description?.trim()).map((line) => ({ seq: line.seq, words: line.description!.trim() }))
  if (!text && lines.length === 0) return null
  const files = (request.files?.references ?? []).filter((file) => file.originalName !== null).map((file) => ({ id: file.id, name: file.originalName! }))
  return { subject: request.subject?.trim() || null, text, lines, files }
}

// ---- Restrict on the floor (owb-of5 step 2; design § 5g R23; of1 step 4) ----------------------------------------------------------

/** Restrict on the floor / Open it to the department: drawn for orders.manage (sales + owner, L6) and never for the designer. */
export const mayRestrict = (permissions: readonly string[]): boolean => permissions.includes('orders.manage')

// ---- what the band and the Overview read beside the order (the container's; absent in a design case) ------------------------------

export interface OrderFlowModel {
  /** S3's warehouse legs of the order (null: not read, or none for this reader). */
  readonly legs: readonly LegFacts[] | null
  /** The order's picture: the page's batch read, the save door (null: this reader may not change it) and the files that may be it. */
  readonly picture: {
    readonly read: ReadPictures | null
    readonly save: SaveOrderPicture | null
    readonly fileId: string | null
    readonly choices: readonly PictureChoice[]
  }
  /** Restrict on the floor: whether drawn, its state (null: open to the department), a write running, its refusal in words. */
  readonly restrict: { readonly may: boolean; readonly now: { readonly by: string; readonly at: string } | null; readonly busy: boolean; readonly problem: string | null }
  /** The subject the customer gave (the request it came from), null when none. */
  readonly subject: string | null
  /** The card "The order as it was written" (null: the order did not come as text, or the request is not read). */
  readonly text: TextCard | null
  /** The order's baskets per department (S5's board read; null before it is read or where it is not on the server). */
  readonly departments: readonly { readonly dept: Department; readonly count: number }[] | null
  // ---- owb-of6 ----
  /** Every basket of the order (S5's board read, L8); null: not read (the Baskets section keeps today's work-order rows). */
  readonly baskets: readonly { readonly card: BasketCard; readonly dept: Department | null }[] | null
  /** The ONE order log's read port (Changes › What changed; the base's `GET /sales/orders/:id/log`). */
  readonly log: ReadOrderLog | null
  /** The customer's "I paid" notices (of1): the rows (null before read or before of1), the one being answered, a refusal, who may answer. */
  readonly notices: { readonly rows: readonly PaymentNotice[] | null; readonly busy: string | null; readonly problem: string | null; readonly may: boolean }
  /** Download all (of1's zip): running, the files it left out (null: not run yet), a refusal in words. */
  readonly zip: { readonly busy: boolean; readonly leftOut: number | null; readonly problem: string | null }
  // ---- end owb-of6
  /**
   * owb-of7 step 2: the design's approval — its state (the latest ARTWORK / PROOF request on the order: the band's Design tag), the
   * door "Send the design for approval" (drawn only for who may: partners.approvals.ask + orders.manage), why it waits (a key), a send
   * running, a refusal in words.
   */
  readonly design: { readonly state: DesignState | null; readonly may: boolean; readonly held: string | null; readonly busy: boolean; readonly problem: string | null }
}

export interface OrderFlowActions {
  onPictureSaved?: () => void
  onRestrict?: (restricted: boolean) => void
  /** owb-of6: answer a customer's "I paid" notice (Recorded: seen — the payment is then recorded with Record a payment…; Dismissed). */
  onNotice?: (noticeId: string, state: 'RECORDED' | 'DISMISSED') => void
  /** owb-of6: Download all — ONE zip of what this reader may open. */
  onZip?: () => void
  /** owb-of7: Send the design for approval (ONE `POST /approvals-out`, kind ARTWORK, the order's picture as the mockup). */
  onSendDesign?: () => void
}

/** owb-of7 step 2: the design's state from the order's approval requests — the latest ARTWORK or PROOF one (withdrawn, expired: none). */
export function designStateOf(requests: readonly { readonly kind: string; readonly status: string; readonly createdAt: string }[] | null | undefined): DesignState | null {
  const latest = [...(requests ?? [])].filter((request) => request.kind === 'ARTWORK' || request.kind === 'PROOF').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!latest) return null
  if (latest.status === 'OPEN') return 'WAITS'
  if (latest.status === 'APPROVED') return 'APPROVED'
  if (latest.status === 'APPROVED_WITH_CHANGES' || latest.status === 'REFUSED') return 'CHANGE'
  return null
}

/** owb-of7 step 2: who may send the design for approval (the designer may not today: shared-asks line of owb-of7). */
export const maySendDesign = (permissions: readonly string[]): boolean => permissions.includes('partners.approvals.ask') && permissions.includes('orders.manage')

/** The ask's due day: the ARTWORK rule's default, 7 days (YYYY-MM-DD plus 7, as an instant at noon UTC). */
export function designDueOf(today: string): string {
  const day = new Date(`${today}T12:00:00Z`)
  day.setUTCDate(day.getUTCDate() + 7)
  return day.toISOString()
}

/** The open notices (the Waiting entry and the Money row count them). */
export const openNoticesOf = (rows: readonly { readonly state: string }[] | null | undefined): number => (rows ?? []).filter((row) => row.state === 'OPEN').length

/** "Paid too much" when the order's total went below what is paid (price grain only): the amount over, in minor units; else null. */
export function paidTooMuchOf(input: { readonly total: number | null | undefined; readonly paid: number | null | undefined }): number | null {
  if (input.total == null || input.paid == null) return null
  return input.paid > input.total ? input.paid - input.total : null
}
