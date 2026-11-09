import type { PortalBand } from '../../shell/frame'

/**
 * The frame's band of the customer's Documents (design portal.customer.documents h: AsOf; "Download statement" — Finance's
 * primary, a new tab; ⋯ "Download selected as zip" is Later; the frame ends ⋯ with "Ask a question"), and the page's keys.
 * One builder for the live page and its design cases.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

export function documentsBandOf(input: {
  t: Translate
  /** The read's time, written ("10:42"); null while unread. */
  asOf: string | null
  /** The statement opens (Finance or the customer's admin with prices, not a preview): its click. */
  onStatement: (() => void) | null
  /** No connection: the statement waits, with the reason. */
  statementHeld: string | null
}): PortalBand {
  const { t } = input
  return {
    title: t('title'),
    status: input.asOf ? { label: t('band.updated', { time: input.asOf }), tone: 'neutral' } : null,
    actions: input.onStatement ? [{ id: 'statement', label: t('band.statement'), variant: 'primary', onClick: input.onStatement, heldReason: input.statementHeld }] : [],
    more: [],
    keys: [
      { keys: ['/'], words: t('keys.search') },
      { keys: ['j', 'k'], words: t('keys.rows') },
      { keys: ['↵'], words: t('keys.preview') },
      { keys: ['d'], words: t('keys.download') },
      { keys: ['x'], words: t('keys.select') },
      { keys: ['J', 'K'], words: t('keys.nextDocument') },
      { keys: ['PageUp', 'PageDown'], words: t('keys.pages') },
    ],
  }
}
