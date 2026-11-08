import { formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { PortalBand } from '../../shell/frame'
import { copyHref, type OrderChip, type OrderPage } from './api'
import { recordHref, stateTone, type RecordTab } from './model'

/**
 * The frame's band of each supplier page (design portal.supplier.home h, portal.supplier.orders h, rec "Purchase order"):
 * one builder per page, used by the live page and its design cases alike. At most two actions, the primary last; the ⋯
 * items (the frame ends them with "Ask a question"); the record's link tabs.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

export function homeBandOf(input: { t: Translate; locale: Locale; asOf: string | null; prefix: string; firstToConfirm: string | null; preview: boolean }): PortalBand {
  const { t, locale } = input
  return {
    status: input.asOf ? { label: t('band.updated', { time: formatTime(input.asOf, { locale }) }), tone: 'neutral' } : null,
    actions: input.firstToConfirm ? [{ id: 'confirm-orders', label: t('band.confirmOrders'), variant: 'primary', href: recordHref(input.prefix, input.firstToConfirm, 'confirm') }] : [],
    more: input.preview ? [] : [{ id: 'email', label: t('band.emailSettings'), href: '?dialog=email-settings' }],
    keys: [
      { keys: ['j', 'k'], words: t('keys.todo') },
      { keys: ['↵'], words: t('keys.runVerb') },
      { keys: ['g', 'o'], words: t('keys.goOrders') },
    ],
  }
}

export function listBandOf(input: {
  t: Translate
  locale: Locale
  asOf: string | null
  waiting: number
  /** The list shows the orders waiting now: the action confirms them; else it opens that chip. */
  onWaitingChip: boolean
  confirmHeld: string | null
  rows: number
  onConfirm?: () => void
  onChip?: (chip: OrderChip) => void
  onExport?: () => void
}): PortalBand {
  const { t, locale } = input
  return {
    title: t('list.title'),
    status: input.asOf ? { label: t('band.updated', { time: formatTime(input.asOf, { locale }) }), tone: 'neutral' } : null,
    actions:
      input.waiting > 0
        ? [
            input.onWaitingChip
              ? { id: 'confirm', label: t('band.confirmWaiting', { count: input.waiting }), variant: 'primary', heldReason: input.confirmHeld, onClick: () => input.onConfirm?.() }
              : { id: 'confirm', label: t('band.confirmWaiting', { count: input.waiting }), variant: 'primary', onClick: () => input.onChip?.('TO_CONFIRM') },
          ]
        : [],
    more: [{ id: 'export', label: t('band.export'), disabled: input.rows === 0, description: input.rows === 0 ? t('held.noRows') : undefined, onSelect: () => input.onExport?.() }],
    keys: [
      { keys: ['/'], words: t('keys.search') },
      { keys: ['↵'], words: t('keys.open') },
      { keys: ['j', 'k'], words: t('keys.rows') },
      { keys: ['c'], words: t('keys.confirm') },
    ],
  }
}

export function orderBandOf(input: {
  t: Translate
  locale: Locale
  page: OrderPage
  tab: RecordTab
  prefix: string
  /** The answer just sent: the actions to answer are gone. */
  done: boolean
  confirmHeld: string | null
  notices: number | null
  onConfirmAll?: () => void
  onDecline?: () => void
  onVersion?: (revision: number) => void
}): PortalBand {
  const { t, locale, page } = input
  const tabHref = (tab: RecordTab) => recordHref(input.prefix, page.order.id, tab)
  const answering = page.answer.canAnswer && !input.done
  return {
    title: t('record.title', { number: page.order.documentNumber }),
    back: { href: `${input.prefix}/orders`, label: t('list.title') },
    refs: { theirs: page.order.supplierRef ?? page.proposal?.supplierRef ?? null, ours: page.order.documentNumber },
    status: { label: page.order.words[locale], tone: stateTone(page.order.state) },
    actions: answering ? [{ id: 'confirm-all', label: t('band.confirmAll'), variant: 'primary', heldReason: input.confirmHeld, onClick: () => input.onConfirmAll?.() }] : [],
    more: [
      ...(answering ? [{ id: 'decline', label: t('band.decline'), disabled: input.confirmHeld !== null, description: input.confirmHeld ?? undefined, onSelect: () => input.onDecline?.() }] : []),
      ...(page.changes ? [{ id: 'changes', label: t('changes.title', { version: page.changes.revision }), onSelect: () => input.onVersion?.(page.changes!.revision) }] : []),
      { id: 'pdf', label: t('band.pdf'), href: copyHref(page.order.id, locale), target: '_blank' as const },
    ],
    tabs: {
      label: t('tabs.label'),
      active: input.tab,
      items: [
        { id: 'lines', label: t('tabs.lines'), count: page.lines.length, href: tabHref('lines') },
        { id: 'confirm', label: t('tabs.confirm'), href: tabHref('confirm'), ...(answering ? { badge: t('tabs.toAnswer') } : {}) },
        { id: 'asn', label: t('tabs.asn'), count: input.notices, href: tabHref('asn') },
        { id: 'documents', label: t('tabs.documents'), href: tabHref('documents') },
        { id: 'messages', label: t('tabs.messages'), href: `${tabHref('messages')}#messages` },
      ],
    },
    ask: { type: 'PurchaseOrder', id: page.order.id, label: page.order.documentNumber },
    keys: [
      { keys: ['c'], words: t('keys.confirm') },
      { keys: ['Esc'], words: t('keys.closeSheet') },
    ],
  }
}
