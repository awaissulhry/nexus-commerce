import type { PortalBand } from '../../shell/frame'
import type { OrderingWords } from '../neworder/words'

/**
 * The frame's band of the Catalogue (design portal.customer.catalogue h): "Updated 10:42" (AsOf), the primary "Start an
 * order" (opens the draft; held with the reason for a person who may not order), and the frame's own Ask a question. The
 * line sheet download is Later (no line sheets yet). One builder for the live page and its design cases.
 */
export function catalogueBandOf(input: { words: OrderingWords; asOf: string | null; start: string; startHeld: string | null }): PortalBand {
  const { t, time } = input.words
  return {
    title: t('catalogue.title'),
    status: input.asOf ? { label: t('catalogue.updated', { time: time(input.asOf) }), tone: 'neutral' } : null,
    actions: [{ id: 'start', label: t('catalogue.start'), variant: 'primary', heldReason: input.startHeld, ...(input.startHeld ? {} : { href: input.start }) }],
    more: [],
    keys: [
      { keys: ['/'], words: t('keys.search') },
      { keys: ['↵'], words: t('keys.openStyle') },
      { keys: ['J', 'K'], words: t('keys.nextStyle') },
      { keys: ['Esc'], words: t('keys.close') },
    ],
  }
}
