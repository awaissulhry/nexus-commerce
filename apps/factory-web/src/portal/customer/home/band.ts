import type { PortalBand } from '../../shell/frame'

/**
 * The frame's band of the customer's Home (design portal.customer.home h): "Updated 10:42"; no button while New order is
 * not built (the design's primary, a buyer's; "Ask for a quote" is W3); ⋯ Download statement of account (Finance, a new
 * tab), E-mail settings (not in a preview) and the frame's own Ask a question; the page's keys. One builder for the live
 * page and its design cases.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

export function homeBandOf(input: {
  t: Translate
  /** The counts' time, written ("10:42"); null while unread. */
  asOf: string | null
  /** The statement's address (a person with the open items and their prices), else null. */
  statement: string | null
  emailSettings: boolean
  /** `g o` opens Orders (the page is built and theirs). */
  ordersKey: boolean
  /** B-W2b-194: New order's address for a buyer (not in a preview), else null. */
  newOrder?: string | null
}): PortalBand {
  const { t } = input
  return {
    status: input.asOf ? { label: t('band.updated', { time: input.asOf }), tone: 'neutral' } : null,
    // B-W2b-194: the design's primary "New order" (h.act), a buyer's.
    actions: input.newOrder ? [{ id: 'new-order', label: t('band.newOrder'), variant: 'primary', href: input.newOrder }] : [],
    more: [
      ...(input.statement ? [{ id: 'statement', label: t('band.statement'), href: input.statement, target: '_blank' as const }] : []),
      ...(input.emailSettings ? [{ id: 'email', label: t('band.emailSettings'), href: '?dialog=email-settings' }] : []),
    ],
    keys: [
      { keys: ['j', 'k'], words: t('keys.todo') },
      { keys: ['↵'], words: t('keys.runVerb') },
      ...(input.ordersKey ? [{ keys: ['g', 'o'], words: t('keys.goOrders') }] : []),
      { keys: ['J', 'K'], words: t('keys.nextApproval') },
      { keys: ['J', 'K'], words: t('keys.nextDocument') },
      { keys: ['PageUp', 'PageDown'], words: t('keys.pages') },
    ],
  }
}
