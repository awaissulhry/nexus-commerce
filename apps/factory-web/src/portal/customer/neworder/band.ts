import type { MenuItemDef } from '@nexus/ui/components'
import type { PortalBand } from '../../shell/frame'
import type { OrderingWords } from './words'

/**
 * The frame's band of New order & reorder (design portal.customer.neworder h): the title, their PO first (RefPair), the
 * pill "Request" (it becomes an order when we confirm), the primary "Send order request" held with the count of problems,
 * ⋯ Discard draft, Download order template (XLSX, a new tab) and the frame's own Ask a question. One builder for the live
 * page and its design cases.
 */

export type NewOrderPhase = 'start' | 'draft' | 'sent' | 'closed'

export function newOrderBandOf(input: {
  words: OrderingWords
  phase: NewOrderPhase
  prefix: string
  template: string
  customerRef?: string | null
  number?: string | null
  /** Send's held reason in words (null: it may go). */
  sendHeld?: string | null
  /** Discard's held reason in words (null: it may go). */
  discardHeld?: string | null
  onSend?: () => void
  onDiscard?: () => void
}): PortalBand {
  const { t } = input.words
  // No ‹ back: New order is a page of Orders, and the band's Pages already leads to Orders & tracking (a phone keeps the title).
  const template: MenuItemDef = { id: 'template', label: t('band.template'), href: input.template, target: '_blank' }
  if (input.phase === 'sent') {
    return {
      title: t('band.sentTitle'),
      refs: { theirs: input.customerRef ?? null, ours: input.number ?? null },
      status: { label: t('band.pillSent'), tone: 'info' },
      actions: [],
      more: [],
    }
  }
  if (input.phase === 'draft') {
    return {
      title: t('band.title'),
      // Their PO is the first field of Order details (no RefPair in the draft's band: on a phone it squeezed the title).
      status: { label: t('band.pill'), tone: 'info' },
      actions: [{ id: 'send', label: t('band.send'), variant: 'primary', heldReason: input.sendHeld ?? null, onClick: () => input.onSend?.() }],
      more: [{ id: 'discard', label: t('band.discard'), disabled: Boolean(input.discardHeld), description: input.discardHeld ?? undefined, onSelect: () => input.onDiscard?.() }, template],
      keys: [
        { keys: ['/'], words: t('keys.search') },
        { keys: ['←', '→', '↑', '↓'], words: t('keys.cells') },
        { keys: ['↵'], words: t('keys.down') },
        { keys: ['Esc'], words: t('keys.restore') },
        { keys: ['⌘', '↵'], words: t('keys.send') },
      ],
    }
  }
  return { title: t('band.title'), actions: [], more: [template] }
}
