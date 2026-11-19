import type { MenuItemDef } from '@nexus/ui/components'
import type { PortalBand } from '../../shell/frame'
import type { OrderingWords } from './words'
import { newOrderHref } from './model' // F-CP-150

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
  /** Send's held reason in words (null: it may go). */
  sendHeld?: string | null
  /** Discard's held reason in words (null: it may go). */
  discardHeld?: string | null
  onSend?: () => void
  onDiscard?: () => void
  // ---- F-CP-150 (12 §2): the draft's name ("Draft order · <title>") and its conversation (the ⋯ "Ask a question" focuses the dock).
  title?: string | null
  ask?: { type: string; id: string; label?: string | null } | null
  // ---- end F-CP-150
}): PortalBand {
  const { t } = input.words
  // No ‹ back: New order is a page of Orders, and the band's Pages already leads to Orders & tracking (a phone keeps the title).
  const template: MenuItemDef = { id: 'template', label: t('band.template'), href: input.template, target: '_blank' }
  if (input.phase === 'sent') {
    return {
      title: t('band.sentTitle'),
      // B-TH-304 (pick A): their PO only — the office's request number would tell how much the others order.
      refs: input.customerRef ? { theirs: input.customerRef, ours: null } : null,
      status: { label: t('band.pillSent'), tone: 'info' },
      actions: [],
      more: [],
      ask: input.ask ?? null, // F-CP-150: the thread stays after Send
    }
  }
  if (input.phase === 'draft') {
    // ---- F-CP-150 (12 §2; picture 22): "‹ New order" (the start, with the drafts), "Draft order · <title>", Discard… and Send to the
    // factory — both held with words, never hidden (a Designer reads who may send it). Their PO is a field of Date and delivery.
    return {
      title: input.title ? t('draftPage.titleOf', { title: input.title }) : t('draftPage.title'),
      back: { href: newOrderHref(input.prefix), label: t('draftPage.back') },
      actions: [
        { id: 'discard', label: t('draftPage.discard'), variant: 'secondary', heldReason: input.discardHeld ?? null, onClick: () => input.onDiscard?.() },
        { id: 'send', label: t('draftPage.send'), variant: 'primary', heldReason: input.sendHeld ?? null, onClick: () => input.onSend?.() },
      ],
      more: [template],
      ask: input.ask ?? null,
      keys: draftKeys(input.words),
    }
    // ---- end F-CP-150
  }
  // F-CP-150: a draft no longer a draft keeps its conversation (the ⋯ asks about it) and the way back to the start.
  if (input.phase === 'closed') return { title: input.title ? t('draftPage.titleOf', { title: input.title }) : t('draftPage.title'), back: { href: newOrderHref(input.prefix), label: t('draftPage.back') }, actions: [], more: [], ask: input.ask ?? null }
  return { title: t('band.title'), actions: [], more: [template] }
}

// ── B-TH-220: New order as an e-mail ─────────────────────────────────────────────────────────────────────────────────
/**
 * The band of New order as an e-mail: the title; Send lives at the compose's foot (under the message, as in a mail), so the
 * band has no button; ⌘ Enter in the keys. After Send: "Request sent", their PO first, the request's true state.
 */
export function requestBandOf(input: {
  words: OrderingWords
  phase: 'loading' | 'compose' | 'closed' | 'noRight' | 'sent'
  /** The sent request's true state (its words in the page's language). */
  state?: { label: string; code: string } | null
  customerRef?: string | null
}): PortalBand {
  const { t } = input.words
  if (input.phase === 'sent') {
    return {
      title: t('receipt.bandTitle'),
      refs: input.customerRef ? { theirs: input.customerRef, ours: null } : null,
      status: input.state ? { label: input.state.label, tone: 'info' } : null,
      actions: [],
      more: [],
    }
  }
  return {
    title: t('request.title'),
    actions: [],
    more: [],
    ...(input.phase === 'compose' ? { keys: [{ keys: ['⌘', '↵'], words: t('request.keySend') }] } : {}),
  }
}

// ---- F-CP-150 (review G3): the draft page's keys — in the shortcuts dialog (?) and ONE information icon in the draft's footer,
// never as hints above the cards.
export function draftKeys(words: OrderingWords): { keys: string[]; words: string }[] {
  const { t } = words
  return [
    { keys: ['←', '→', '↑', '↓'], words: t('keys.cells') },
    { keys: ['↵'], words: t('keys.down') },
    { keys: ['Esc'], words: t('keys.restore') },
    { keys: ['⌘', '↵'], words: t('draftPage.keySend') },
    { keys: ['⌘', 'J'], words: t('draftPage.keyThread') },
  ]
}
// ---- end F-CP-150
