import type { MenuItemDef, TabItem } from '@nexus/ui/components'
import type { PortalBand, PortalBandAction, PortalBandChips } from '../../shell/frame'
import type { ProductionHealth, ProductionOrder } from '../production/api'
import { healthInputOf } from '../production/model'
import type { OrderRecord } from './api'
import { customerStatusTone } from '../../../lib/order-cells/model' // pp-w1 (L4)
import { recordHref, shownLinesOf, type RecordTab } from './model'
// B-TH-275: the order named by the customer's own number (plan §0.5).
import { orderNameOf } from './model'
import type { OrderWords } from './words'

/**
 * The frame's band of each Orders & tracking page (design portal.customer.orders h, rec "Order"): one builder per page, used
 * by the live page and its design cases alike. At most two actions, the primary last; the ⋯ items (the frame ends them with
 * "Ask a question"). pp-w1 (w1.3, D6 a): the order's tabs sit in the body under the band, as the office's (`orderTabsOf`).
 */

// B-W2b-194: `newOrder` = the New order page's address for a person who may order (else null: no button).
// pg-w2 (Z8): ONE export — "Download (Excel)" of the group shown, written by the server; Export this view (CSV) and Print left.
export function listBandOf(input: { words: OrderWords; asOf: string | null; newOrder?: string | null; /* B-TH-246 */ onDownloadAll?: (() => void) | null; downloading?: boolean }): PortalBand {
  const { t, time } = input.words
  return {
    title: t('list.title'),
    status: input.asOf ? { label: t('band.updated', { time: time(input.asOf) }), tone: 'neutral' } : null,
    // B-W2b-194: the band's primary "New order" (a buyer's).
    actions: input.newOrder ? [{ id: 'new-order', label: t('band.newOrder'), variant: 'primary', href: input.newOrder }] : [],
    more: [
      // B-TH-246 (SHEET-G10, Owner decision 13): the group's rows with the portal columns, written by the server in the customer's scope.
      ...(input.onDownloadAll ? [{ id: 'download-all', label: input.downloading ? t('band.downloading') : t('band.downloadAll'), description: t('band.downloadAllHint'), disabled: !!input.downloading, onSelect: () => input.onDownloadAll?.() }] : []),
    ],
    keys: [
      { keys: ['/'], words: t('keys.search') },
      { keys: ['↵'], words: t('keys.open') },
      { keys: ['j', 'k'], words: t('keys.rows') },
    ],
  }
}

export interface OrderBandFacts {
  /**
   * pp-w1 (w1.2; O1-B1, O1-B7): the ONE "Ask for a change…" — the Ask dialog (change, cancel and the production asks the customer's
   * limits open) — and why it cannot open (words: a preview, no right to ask, offline; null: it opens).
   */
  ask: { held: string | null }
  /** "Ask to cancel" cannot open: the reason in words. */
  cancelHeld: string | null
  /** A revised version waits for the person's re-confirmation (its number); null: none. */
  reconfirm: { revision: number; held: string | null } | null
  /** The order confirmation PDF can open in a new tab. */
  confirmation: boolean
  /** An open deposit may be paid here (null: no such deposit). */
  pay: { held: string | null } | null
  /** F-PR-24: "Report a problem" (the order in production, a person who writes to us): why it waits, or null; absent: not offered. */
  problem?: { held: string | null } | null
  /** pp-w1 (w1.2): the order's production read for the health and urgency chips (`bandProductionOf`); null / absent: no chip. */
  production?: BandProduction | null
  /** pp-w1 (w1.2): "Made from your request #7" (the summary read, `madeFromOf`); null / absent: none. */
  madeFrom?: { kind: 'request' | 'quote'; href: string; label: string | null } | null
}

/** pp-w1 (w1.2): the only part of the order's production read the band draws (its two chips). */
export type BandProduction = Pick<ProductionOrder, 'health' | 'urgency'>

/**
 * PW-O02 (part 1): the production read reaches the band only for a person who sees production (portal.production.view; Designer and
 * Finance do not) — and only its health and urgency; without the right the band holds no chip. The band never holds an amount.
 */
export function bandProductionOf(read: BandProduction | null | undefined, seesProduction: boolean): BandProduction | null {
  return seesProduction && read ? { health: read.health, urgency: read.urgency } : null
}

/** pp-w1 (w1.2): the health chip only when it matters, as the office band's — Late or At risk (a person's raise), never On track or No date. */
export function bandHealthOf(health: ProductionHealth | null): NonNullable<PortalBandChips['health']> | null {
  const input = healthInputOf(health)
  if (input.computed !== 'LATE' && input.computed !== 'AT_RISK' && !input.raised) return null
  return { computed: input.computed ?? null, raised: input.raised ? { reason: input.raised.reason } : null }
}

/** pp-w1 (w1.2; 10-design § 2): the band's chips — health, the customer's own urgency, made from — or null when none applies. */
export function bandChipsOf(words: OrderWords, facts: Pick<OrderBandFacts, 'production' | 'madeFrom'>): PortalBandChips | null {
  const { t } = words
  const health = bandHealthOf(facts.production?.health ?? null)
  const urgent = facts.production?.urgency?.code === 'URGENT' ? t('band.urgent') : null
  const made = facts.madeFrom ?? null
  const madeFrom = made
    ? { href: made.href, label: t(made.kind === 'request' ? (made.label ? 'status.madeFromRequest' : 'status.madeFromRequestNone') : made.label ? 'status.madeFromQuote' : 'status.madeFromQuoteNone', made.label ? { label: made.label } : undefined) }
    : null
  return health || urgent || madeFrom ? { health, urgent, madeFrom } : null
}

/**
 * pp-w1 (w1.3; D2 a, D6 a, P0-B15): the order's tab strip, drawn in the BODY under the band (the office's place; the return, repair,
 * supplier and job pages keep theirs in the band for now) — Overview ("to confirm" while a revised version waits) · Lines · Shipments
 * · Files, each with its count (0 too; null while unknown: no pill, never a made-up 0).
 */
export function orderTabsOf(input: { words: OrderWords; record: OrderRecord; prefix: string; toConfirm: boolean; files: number | null }): TabItem[] {
  const { t } = input.words
  const href = (tab: RecordTab) => recordHref(input.prefix, input.record.order.id, tab)
  return [
    { id: 'overview', label: t('tabs.overview'), href: href('overview'), ...(input.toConfirm ? { badge: t('tabs.toConfirm') } : {}) },
    { id: 'lines', label: t('tabs.lines'), count: shownLinesOf(input.record.lines).length, href: href('lines') }, // w1.4: a charge line is not counted
    { id: 'shipments', label: t('tabs.shipments'), count: input.record.shipments.shown, href: href('shipments') },
    { id: 'files', label: t('tabs.files'), count: input.files, href: href('files') },
  ]
}

export function orderBandOf(input: {
  words: OrderWords
  record: OrderRecord
  prefix: string
  facts: OrderBandFacts
  /** pp-w1 (w1.2): "Ask for a change…" opens the Ask dialog at its first step. */
  onAsk?: () => void
  onCancel?: () => void
  onReconfirm?: () => void
  onConfirmation?: () => void
  onPay?: () => void
  onProblem?: () => void // F-PR-24
}): PortalBand {
  const { t, locale } = input.words
  const { record, facts } = input
  const order = record.order
  // pp-w1 (w1.2; O1-B1, O1-B2): ONE "Ask for a change…" — the Ask dialog at its first step (the line ⋯ opens the same dialog at its
  // line); none on a cancelled or delivered order. The ⋯ keeps the real acts; the promise's history is the tracker's own popover.
  const open = order.status !== 'CANCELLED' && order.status !== 'DELIVERED'
  const actions: PortalBandAction[] = open ? [{ id: 'ask', label: t('band.change'), variant: 'primary', heldReason: facts.ask.held, onClick: () => input.onAsk?.() }] : []
  const more: MenuItemDef[] = [
    ...(facts.reconfirm ? [{ id: 'reconfirm', label: t('band.reconfirm', { version: facts.reconfirm.revision }), disabled: facts.reconfirm.held !== null, description: facts.reconfirm.held ?? undefined, onSelect: () => input.onReconfirm?.() }] : []),
    ...(open ? [{ id: 'cancel', label: t('band.cancel'), disabled: facts.cancelHeld !== null, description: facts.cancelHeld ?? undefined, onSelect: () => input.onCancel?.() }] : []),
    ...(facts.pay ? [{ id: 'pay', label: t('band.pay'), disabled: facts.pay.held !== null, description: facts.pay.held ?? undefined, onSelect: () => input.onPay?.() }] : []),
    ...(facts.confirmation ? [{ id: 'confirmation', label: t('band.confirmation'), onSelect: () => input.onConfirmation?.() }] : []),
    // F-PR-24: one message in this order's thread; we answer there.
    ...(facts.problem ? [{ id: 'problem', label: t('reported.report'), disabled: facts.problem.held !== null, description: facts.problem.held ?? undefined, onSelect: () => input.onProblem?.() }] : []),
  ]
  const chips = bandChipsOf(input.words, facts)
  // ---- B-TH-275 (P-CUS-ORD.band; plan §0.5, B-TH-303): "Your order 12" — the customer's own number, never the office's SO- series;
  // their PO first in the band's references. The conversation docks beside the body (no Messages tab, no Ask modal).
  const name = orderNameOf(order, locale, t)
  return {
    title: name,
    back: { href: `${input.prefix}/orders`, label: t('list.title') },
    refs: order.customerRef ? { theirs: order.customerRef, ours: null } : null,
    // pp-w1 (L4): the shared status chip (the shell draws lib/order-cells StateChip from `order`: the list's chip, the office's tone).
    status: { label: order.words[locale], tone: customerStatusTone(order.status), order: order.status },
    actions,
    more,
    ask: { type: 'SalesOrder', id: order.id, label: name },
    // ---- end B-TH-275
    ...(chips ? { chips } : {}),
    // pp-w1 (w1.2; O1-B9): + ⌘J (show or hide the conversation) and ⌘↵ (send the message), in the shell's ONE keys window.
    keys: [
      { keys: ['j', 'k'], words: t('keys.orders') },
      { keys: ['←', '→'], words: t('keys.tabs') },
      { keys: ['⌘', 'J'], words: t('keys.thread') },
      { keys: ['⌘', '↵'], words: t('keys.send') },
      { keys: ['Esc'], words: t('keys.close') },
    ],
  }
}
