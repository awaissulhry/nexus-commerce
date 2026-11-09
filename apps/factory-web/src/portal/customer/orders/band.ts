import type { MenuItemDef } from '@nexus/ui/components'
import type { PortalBand, PortalBandAction } from '../../shell/frame'
import type { OrderChip, OrderRecord } from './api'
import { listQuery, recordHref, statusTone, type RecordTab } from './model'
import type { OrderWords } from './words'

/**
 * The frame's band of each Orders & tracking page (design portal.customer.orders h, rec "Order"): one builder per page, used
 * by the live page and its design cases alike. At most two actions, the primary last; the ⋯ items (the frame ends them with
 * "Ask a question"); the record's link tabs.
 */

export function listBandOf(input: { words: OrderWords; asOf: string | null; rows: number; chip: OrderChip | null; q: string; prefix: string; onExport?: () => void }): PortalBand {
  const { t, time } = input.words
  return {
    title: t('list.title'),
    status: input.asOf ? { label: t('band.updated', { time: time(input.asOf) }), tone: 'neutral' } : null,
    actions: [],
    more: [
      { id: 'export', label: t('band.export'), disabled: input.rows === 0, description: input.rows === 0 ? t('held.noRows') : undefined, onSelect: () => input.onExport?.() },
      { id: 'print', label: t('band.print'), href: `${input.prefix}/orders${listQuery(input.chip, input.q, { print: '1' })}`, target: '_blank' },
    ],
    keys: [
      { keys: ['/'], words: t('keys.search') },
      { keys: ['↵'], words: t('keys.open') },
      { keys: ['j', 'k'], words: t('keys.rows') },
    ],
  }
}

export interface OrderBandFacts {
  /** "Ask for a change" cannot open: the reason in words (null: it opens). */
  changeHeld: string | null
  /** "Ask to cancel" cannot open: the reason in words. */
  cancelHeld: string | null
  /** A revised version waits for the person's re-confirmation (its number); null: none. */
  reconfirm: { revision: number; held: string | null } | null
  /** The shipments shown (null while unknown). */
  shipments: number | null
  /** The promise moved: the history can open. */
  moves: number
  /** The order confirmation PDF can open in a new tab. */
  confirmation: boolean
  /** An open deposit may be paid here (null: no such deposit). */
  pay: { held: string | null } | null
}

export function orderBandOf(input: {
  words: OrderWords
  record: OrderRecord
  tab: RecordTab
  prefix: string
  facts: OrderBandFacts
  onChange?: () => void
  onCancel?: () => void
  onReconfirm?: () => void
  onHistory?: () => void
  onConfirmation?: () => void
  onPay?: () => void
}): PortalBand {
  const { t, locale } = input.words
  const { record, facts } = input
  const order = record.order
  const tabHref = (tab: RecordTab) => recordHref(input.prefix, order.id, tab)
  // One action: Ask for a change (design h). A revised version is re-confirmed from the "Please re-confirm" banner (its
  // opener in the design); the band names it in the ⋯ and on the Status tab.
  const change: PortalBandAction = { id: 'change', label: t('band.change'), variant: 'primary', heldReason: facts.changeHeld, onClick: () => input.onChange?.() }
  const actions: PortalBandAction[] = order.status === 'CANCELLED' || order.status === 'DELIVERED' ? [] : [change]
  const more: MenuItemDef[] = [
    ...(facts.reconfirm ? [{ id: 'reconfirm', label: t('band.reconfirm', { version: facts.reconfirm.revision }), disabled: facts.reconfirm.held !== null, description: facts.reconfirm.held ?? undefined, onSelect: () => input.onReconfirm?.() }] : []),
    ...(order.status !== 'CANCELLED' && order.status !== 'DELIVERED'
      ? [{ id: 'cancel', label: t('band.cancel'), disabled: facts.cancelHeld !== null, description: facts.cancelHeld ?? undefined, onSelect: () => input.onCancel?.() }]
      : []),
    ...(facts.pay ? [{ id: 'pay', label: t('band.pay'), disabled: facts.pay.held !== null, description: facts.pay.held ?? undefined, onSelect: () => input.onPay?.() }] : []),
    ...(facts.moves > 0 ? [{ id: 'history', label: t('band.history'), onSelect: () => input.onHistory?.() }] : []),
    ...(facts.confirmation ? [{ id: 'confirmation', label: t('band.confirmation'), onSelect: () => input.onConfirmation?.() }] : []),
  ]
  return {
    title: t('record.title', { number: order.number }),
    back: { href: `${input.prefix}/orders`, label: t('list.title') },
    refs: { theirs: order.customerRef, ours: order.number },
    status: { label: order.words[locale], tone: statusTone(order.status) },
    actions,
    more,
    tabs: {
      label: t('tabs.label'),
      active: input.tab,
      items: [
        { id: 'status', label: t('tabs.status'), href: tabHref('status'), ...(facts.reconfirm ? { badge: t('tabs.toConfirm') } : {}) },
        { id: 'lines', label: t('tabs.lines'), count: record.lines.length, href: tabHref('lines') },
        { id: 'shipments', label: t('tabs.shipments'), count: facts.shipments, href: tabHref('shipments') },
        { id: 'documents', label: t('tabs.documents'), href: tabHref('documents') },
        { id: 'messages', label: t('tabs.messages'), href: tabHref('messages') },
      ],
    },
    ask: { type: 'SalesOrder', id: order.id, label: order.number },
    keys: [
      { keys: ['j', 'k'], words: t('keys.orders') },
      { keys: ['←', '→'], words: t('keys.tabs') },
      { keys: ['Esc'], words: t('keys.close') },
    ],
  }
}
