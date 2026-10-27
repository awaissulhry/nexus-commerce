/**
 * The order page's "Manage Feedback" card — what Nexus knows about the buyer's feedback for one order (live audit A10:
 * it said "has not left you feedback for this order yet" while Nexus does not read Amazon seller feedback at all).
 *
 *   - The feedback itself when Nexus holds it (a visible Review linked to the order: eBay feedback, Amazon's 1–3 star
 *     seller feedback).
 *   - Otherwise only what can be known: Amazon gives Nexus only its 1–3 star seller feedback, and only where that read is
 *     switched on; eBay feedback is read every 30 minutes where eBay is read; other channels have no seller feedback.
 * Words for a person, never a setting's name. `orderFeedbackWords` is pure (review-order-feedback.vitest.test.ts).
 */
import prisma from '../../db.js'
import { sellerFeedbackOn } from './amazon-seller-feedback.service.js'
import { reviewKindOf, visibleReviewWhere } from './review-visibility.js'

export interface OrderFeedback {
  /** 'none': the channel has no seller feedback (Shopify, Etsy …) — the card is not shown. */
  channel: 'AMAZON' | 'EBAY' | 'none'
  /** Nexus reads this channel's feedback in this setup. */
  read: boolean
  /** The newest feedback Nexus holds for the order. */
  feedback: { id: string; postedAt: string; rating: number | null; text: string } | null
  words: string
}

/** What to say for an order with no feedback in Nexus (pure). */
export function orderFeedbackWords(channel: string, read: boolean, found: boolean): Pick<OrderFeedback, 'channel' | 'words'> {
  const c = channel.toUpperCase()
  if (c === 'AMAZON') {
    if (found) return { channel: 'AMAZON', words: 'Amazon’s 1–3 star feedback for this order, as Nexus read it from Amazon’s report.' }
    return read
      ? { channel: 'AMAZON', words: 'No 1–3 star feedback for this order in Nexus. Amazon gives Nexus only its 1–3 star feedback, so 4–5 star feedback shows only in Seller Central.' }
      : { channel: 'AMAZON', words: 'Not read: Nexus does not read Amazon seller feedback in this setup, so it cannot say whether this buyer left feedback. Feedback Manager in Seller Central shows it.' }
  }
  if (c === 'EBAY') {
    if (found) return { channel: 'EBAY', words: 'The buyer’s feedback for this order, as Nexus read it from eBay.' }
    return read
      ? { channel: 'EBAY', words: 'No feedback from this buyer in Nexus yet. Nexus reads eBay feedback every 30 minutes.' }
      : { channel: 'EBAY', words: 'Not read: Nexus does not read eBay feedback in this setup, so it cannot say whether this buyer left feedback.' }
  }
  return { channel: 'none', words: '' }
}

/** Whether this setup reads the channel's seller feedback (deployment switches, never shown by name). */
function readsFeedback(channel: string): boolean {
  const c = channel.toUpperCase()
  if (c === 'AMAZON') return sellerFeedbackOn()
  if (c === 'EBAY') return process.env.NEXUS_EBAY_REAL_API === 'true' && process.env.NEXUS_REVIEW_INGEST_MODE === 'live'
  return false
}

/** The card's facts for one order. */
export async function orderFeedback(order: { id: string; channel: string }): Promise<OrderFeedback> {
  const read = readsFeedback(order.channel)
  const rows = order.channel.toUpperCase() === 'AMAZON' || order.channel.toUpperCase() === 'EBAY'
    ? await prisma.review.findMany({
        where: visibleReviewWhere({ orderId: order.id, channel: order.channel.toUpperCase() }),
        orderBy: { postedAt: 'desc' },
        select: { id: true, channel: true, kind: true, postedAt: true, rating: true, body: true },
        take: 5,
      })
    : []
  const seller = rows.find((r) => reviewKindOf(r.channel, r.kind) === 'seller') ?? null
  const words = orderFeedbackWords(order.channel, read, !!seller)
  return {
    ...words,
    read,
    feedback: seller ? { id: seller.id, postedAt: seller.postedAt.toISOString(), rating: seller.rating, text: seller.body } : null,
  }
}
