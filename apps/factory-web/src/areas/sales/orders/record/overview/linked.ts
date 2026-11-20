import type { Order } from '../../api'
import { depositGate, linesNotInProduction, type OrderAbilities, type Phrase } from '../../model'
import { tabHref } from '../../../../_shared/record-frame/address' // F-OP-104: the tab links keep the dock's scope (F-OP-210)
// ---- F-OO-207 (order overview §6; review F5, F8; Owner D3, D8): one count rule, the doors that make the next record ----
import { orderLinkCountsOf } from '@nexus/factory-domain/sales/orders/linked-counts'
import { makeHeldOf } from '../production'
import { createShipmentDoor, createShipmentHeld, type CreateShipmentDoor } from '../shipments/model'

/**
 * F-OO-100 (order overview lane: one file per section) — Linked records' rules (F-SA-233).
 *
 * F-OO-207 (11-design §6; review F5, F8; Owner D3, D8): one row per kind, its state, its link, its next step when one is due —
 *
 *   Work orders   "4 · 2 in work · 1 draft · 1 on hold · 1 done" (D3: their statuses; the stage is Where it is now's) — Production
 *   Shipments     "3 · last DDT 101/2026" — Shipments, where every DDT is
 *   Invoices      "1 issued · 1 draft · 1 credit note · 1 deposit invoice" — Money › Invoices, where the credit notes are; without
 *                 invoices.view the Money tab's own sentence alone (F-OP-306)
 *   Complaints · Returns   their counts (GET …/links) — Shipments' "Complaints & returns"
 *
 * Every number is the domain's ONE count rule (`orderLinkCountsOf`, B-OO-012): live records only, what was cancelled said in words
 * ("· 1 cancelled"), never added in — the tab badges call the same rule (F-OO-206). Kinds at zero fold into one quiet line ("None
 * yet: …"). A last quiet line names where the order came from (its quote, the request it was made from, or "Typed by the office"),
 * the deposit when it waits for nothing (Not needed · Paid · Waived; a deposit that waits is Where it is now's strip) and the orders
 * of the same quote. Two doors, only when due (F8): Make work orders… while a line is not in work orders (CONFIRMED or in
 * production), Create shipment… while released garments wait to ship — the band's own rules and dialogs (makeHeldOf,
 * createShipmentDoor / createShipmentHeld), held in their words; Read-only: none.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export const LINKED_KINDS = ['workOrders', 'shipments', 'invoices', 'complaints', 'returns'] as const
export type LinkedKind = (typeof LINKED_KINDS)[number]

/** A door that makes the order's next record (only when due): Make work orders… or Create shipment…, each held with its words. */
export type LinkedDoor = { readonly kind: 'make'; readonly held: Phrase | null } | { readonly kind: 'ship'; readonly to: CreateShipmentDoor | null; readonly held: Phrase | null }

/** One kind of linked record on the card. */
export interface LinkedRow {
  readonly kind: LinkedKind
  /** ready: its value · reading: the links are still read (complaints, returns) · unread: they could not be read · held: no right. */
  readonly state: 'ready' | 'reading' | 'unread' | 'held'
  /** The number that leads the value ("4 · …"); null: the value is its parts alone (invoices). */
  readonly count: number | null
  /** The value's parts in words, each non-zero one only (joined with " · " on screen). */
  readonly parts: readonly Phrase[]
  /** Where the value opens (the order's own tab, the dock's scope kept); null: nothing to open. */
  readonly href: string | null
  /** Held for this reader: the sentence it reads alone, no label and no number (F-OP-306). */
  readonly held: Phrase | null
  readonly door: LinkedDoor | null
}

/** A part of the quiet last line: where the order came from, the deposit that waits for nothing, an order of the same quote. */
export type LinkedQuiet =
  /** The quote it came from ("Quote: Q-2026-0188 v2 ›", a link with quotes.view). */
  | { readonly kind: 'quote'; readonly number: string; readonly revision: number; readonly href: string | null }
  /** No quote: the request it was made from ("Made from request INQ-… ›"), or "Typed by the office". */
  | { readonly kind: 'origin'; readonly words: Phrase; readonly href: string | null }
  | { readonly kind: 'deposit'; readonly state: 'NOT_NEEDED' | 'PAID' | 'WAIVED'; readonly href: string }
  | { readonly kind: 'sameQuote'; readonly number: string; readonly href: string }

export interface LinkedView {
  readonly rows: readonly LinkedRow[]
  /** The kinds with nothing yet (and no door due): "None yet: Shipments · Invoices". */
  readonly none: readonly LinkedKind[]
  readonly quiet: readonly LinkedQuiet[]
}

/** Complaints or returns as the links read gives them: a count; null: no right (not drawn); still read; could not be read. */
export type LinkCount = number | null | 'reading' | 'unread'

interface LinkedInput {
  readonly order: Order
  readonly prefix: string
  readonly can: OrderAbilities
  readonly complaints: LinkCount
  readonly returns: LinkCount
  readonly sameQuote: readonly { readonly id: string; readonly number: string }[]
  /** B-TH-228: the request an order was made from straight (no quote between); undefined: still read (nothing claimed). */
  readonly madeFrom?: { readonly id: string; readonly number: string } | null
  /** F-OP-104: the page's address terms now (a tab link keeps the dock's scope, tabHref); absent: none. */
  readonly search?: string
  /** Create shipment… opens in place on this page (its container mounts Warehouse's New shipment); else Warehouse's page. */
  readonly shipInPlace: boolean
  /** Read-only (no acting right on the page): no door at all. */
  readonly readOnly: boolean
}

const DEPOSIT_SAID = new Set(['NOT_NEEDED', 'PAID', 'WAIVED'])
const FINAL: readonly Order['status'][] = ['CLOSED', 'CANCELLED']

/** The Linked records card: its rows, the kinds at zero, the quiet line (see the file's head). */
export function linkedRowsOf(input: LinkedInput): LinkedView {
  const { order, prefix, can } = input
  const record = `${prefix}/sales/orders/${order.id}`
  // F-OP-104 (F-OP-210, R-19): the order's own tabs through tabHref — the dock's scope kept.
  const tab = (name: string, anchor?: string) => `${tabHref(record, name, input.search ?? '')}${anchor ? `#${anchor}` : ''}`
  const counts = orderLinkCountsOf(order.chain)
  const nonZero = (entries: readonly (readonly [string, number])[]): Phrase[] => entries.filter(([, count]) => count > 0).map(([key, count]) => phrase(key, { count }))

  // F8: the two doors only when due — and Read-only gets none.
  const makeDue = !input.readOnly && (order.status === 'CONFIRMED' || order.status === 'IN_PRODUCTION') && linesNotInProduction(order) > 0
  const shipDue = !input.readOnly && !FINAL.includes(order.status) && order.progress.released > order.progress.shipped
  const shipTo = shipDue ? createShipmentDoor(order, can, prefix, input.shipInPlace) : null
  const make: LinkedDoor | null = makeDue ? { kind: 'make', held: makeHeldOf(order, can) } : null
  const ship: LinkedDoor | null = shipDue ? { kind: 'ship', to: shipTo, held: shipTo ? null : createShipmentHeld(order, can) } : null

  const rows: LinkedRow[] = []
  const none: LinkedKind[] = []
  const ready = (kind: LinkedKind, count: number | null, parts: readonly Phrase[], href: string | null, door: LinkedDoor | null = null) => rows.push({ kind, state: 'ready', count, parts, href, held: null, door })

  const wo = counts.workOrders
  if (wo.live + wo.cancelled > 0 || make) ready('workOrders', wo.live, nonZero([['linked.wo.inWork', wo.inWork], ['linked.wo.draft', wo.draft], ['linked.wo.onHold', wo.onHold], ['linked.wo.done', wo.done], ['linked.wo.cancelled', wo.cancelled]]), wo.live + wo.cancelled > 0 ? tab('production') : null, make)
  else none.push('workOrders')

  const sh = counts.shipments
  if (sh.live + sh.cancelled > 0 || ship) {
    const ddt = sh.lastDdt ? [phrase('linked.ship.lastDdt', { number: sh.lastDdt.number })] : sh.live > 0 ? [phrase('linked.ship.noDdt')] : []
    ready('shipments', sh.live, [...ddt, ...nonZero([['linked.ship.cancelled', sh.cancelled]])], sh.live + sh.cancelled > 0 ? tab('shipments') : null, ship)
  } else none.push('shipments')

  // F-OP-306 (walk #21): without invoices.view no number and the Money tab's own sentence (one rule, one wording for both).
  if (!can.viewInvoices) rows.push({ kind: 'invoices', state: 'held', count: null, parts: [], href: null, held: phrase('money.noInvoiceRight'), door: null })
  else {
    const inv = counts.invoices
    if (inv.issued + inv.drafts > 0) ready('invoices', null, nonZero([['linked.inv.issued', inv.issued], ['linked.inv.draft', inv.drafts], ['linked.inv.creditNote', inv.creditNotes], ['linked.inv.deposit', inv.deposits]]), tab('money', 'invoices'))
    else none.push('invoices')
  }

  for (const [kind, value] of [['complaints', input.complaints], ['returns', input.returns]] as const) {
    if (value === null) continue // no right to them: not drawn
    if (value === 'reading' || value === 'unread') rows.push({ kind, state: value, count: null, parts: [], href: null, held: null, door: null })
    else if (value > 0) ready(kind, value, [], tab('shipments'))
    else none.push(kind)
  }

  const quote = order.chain.quote
  const gate = depositGate(order)
  const quiet: LinkedQuiet[] = [
    ...(quote
      ? [{ kind: 'quote' as const, number: quote.number, revision: quote.revision, href: can.viewQuotes ? `${prefix}/sales/quotes/${quote.id}` : null }]
      : input.madeFrom
        ? [{ kind: 'origin' as const, words: phrase('chain.fromRequest', { number: input.madeFrom.number }), href: `${prefix}/sales/incoming/${encodeURIComponent(input.madeFrom.id)}` }]
        : input.madeFrom === null
          ? [{ kind: 'origin' as const, words: phrase('chain.noQuote'), href: null }]
          : []),
    // The deposit only when it waits for nothing: a deposit that waits (or was never asked) is Where it is now's strip.
    ...(DEPOSIT_SAID.has(gate.state) ? [{ kind: 'deposit' as const, state: gate.state as 'NOT_NEEDED' | 'PAID' | 'WAIVED', href: tab('money') }] : []),
    ...input.sameQuote.map((other) => ({ kind: 'sameQuote' as const, number: other.number, href: `${prefix}/sales/orders/${other.id}` })),
  ]
  return { rows, none, quiet }
}
// ---- end F-OO-207
