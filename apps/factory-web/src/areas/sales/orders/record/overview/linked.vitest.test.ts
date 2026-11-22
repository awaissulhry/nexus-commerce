import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { orderLinkCountsOf } from '@nexus/factory-domain/sales/orders/linked-counts'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { rolePermissions } from '../../../../../shell/design-data'
import { canOf, order, type Role } from '../../_demo/fixtures'
import { abilitiesOf, createShipmentHref } from '../../model'
import type { Order } from '../../api'
import { base } from '../fixtures'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { LinkedCard } from '../view/overview/LinkedCard'
import { linkedRowsOf, type LinkedKind, type LinkedView } from './linked'
import { invoicePartsOf } from './linked' // walk #8, #9
import { tabCountOf } from '../../model' // walk #9: the Money badge's one rule
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'

/**
 * F-OO-100 (order overview lane: one file per section) — Linked records' rules.
 * F-OO-207 (11-design §6; review F5, F8; Owner D3, D8): one row per kind through the domain's ONE count rule (live only, cancelled said
 * in words), the work orders' statuses, the doors that make the next record only when due, the zero kinds and the quiet line.
 */

const PREFIX = '/w/demo'
type Input = Parameters<typeof linkedRowsOf>[0]
const input = (value: Order, over: Partial<Input> = {}): Input => ({ order: value, prefix: PREFIX, can: canOf('owner'), complaints: null, returns: null, sameQuote: [], madeFrom: undefined, shipInPlace: true, readOnly: false, ...over })
const rowOf = (view: LinkedView, kind: LinkedKind) => view.rows.find((row) => row.kind === kind) ?? null
const READ_ONLY = abilitiesOf(rolePermissions('read_only'))
/** The card drawn alone (the reader's rights; Read-only: no acting right on the page). */
const card = (value: Order, role: Role | 'read_only', locale: 'en' | 'it' = 'en', over: Partial<OrderRecordModel> = {}, actions?: OrderRecordActions) => {
  const record = role === 'read_only' ? { ...base('manager', value).record, can: READ_ONLY } : base(role, value).record
  return render(createElement(LinkedCard, { order: value, model: { ...record, ...over }, actions }), locale)
}

/** An order whose chain holds every state the count rule tells apart (made up). */
const MIXED: Order = (() => {
  const value = order('IN_PRODUCTION')
  const wo = (n: number, status: string) => ({ id: `0190f0e2-9191-7000-8000-0000000000${n}`, number: `WO-000${n}`, status, siteId: value.chain.workOrders[0]!.siteId, releasedAt: null })
  const ship = (n: number, status: string, over: Partial<Order['chain']['shipments'][number]> = {}): Order['chain']['shipments'][number] => ({ id: `0190f0e2-8181-7000-8000-0000000000${n}`, number: `SH-2026-00${n}`, status, shippedAt: null, deliveredAt: null, ...over })
  const invoice = (n: number, docType: string, status: string) => ({ id: `0190f0e2-2121-7000-8000-0000000000${n}`, number: status === 'DRAFT' ? null : `FA-2026-000${n}`, docType, status, issueDate: status === 'DRAFT' ? null : '2026-11-12', depositRequestId: null })
  return {
    ...value,
    chain: {
      ...value.chain,
      workOrders: [wo(21, 'RELEASED'), wo(22, 'IN_PROGRESS'), wo(23, 'DRAFT'), wo(24, 'ON_HOLD'), wo(25, 'COMPLETED'), wo(26, 'CANCELLED')],
      shipments: [
        ship(41, 'DELIVERED', { ddt: { number: '101/2026', date: '2026-11-15' } }),
        ship(42, 'SHIPPED', { origin: 'ELSEWHERE', externalDdt: { number: 'P-7', date: '2026-11-12' } }),
        // A cancelled shipment's DDT is never the last one, however late.
        ship(43, 'CANCELLED', { ddt: { number: '120/2026', date: '2026-11-20' } }),
      ],
      invoices: [invoice(31, 'TD02', 'ISSUED'), invoice(32, 'TD01', 'DELIVERED'), invoice(33, 'TD04', 'ISSUED'), invoice(34, 'TD01', 'DRAFT')],
    },
  }
})()

describe('walk #8, #9: the invoices lead with the Money badge\'s own number; a deposit invoice is one of the issued ones', () => {
  const words = (inv: { issued: number; drafts: number; creditNotes: number; deposits: number }, locale: 'en' | 'it' = 'en') => {
    const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
    return invoicePartsOf(inv).map((part) => t(part.key, part.of ? { ...part.params, of: part.of.map((inner) => t(inner.key, inner.params)).join(', ') } : part.params)).join(' · ')
  }

  it('one deposit invoice issued reads as ONE invoice; nothing issued but a draft leads with "none issued" (the badge\'s 0)', () => {
    expect([words({ issued: 1, drafts: 0, creditNotes: 0, deposits: 1 }), words({ issued: 1, drafts: 0, creditNotes: 0, deposits: 1 }, 'it')]).toEqual(['1 issued (1 deposit invoice)', '1 emessa (1 fattura di acconto)'])
    expect([words({ issued: 0, drafts: 1, creditNotes: 0, deposits: 0 }), words({ issued: 0, drafts: 1, creditNotes: 0, deposits: 0 }, 'it')]).toEqual(['none issued · 1 draft', 'nessuna emessa · 1 in bozza'])
    expect(words({ issued: 2, drafts: 0, creditNotes: 0, deposits: 0 })).toBe('2 issued')
  })

  it('the lead number is the Money badge\'s invoice count (tabCountOf: issued, drafts apart)', () => {
    const draftOnly: Order = { ...MIXED, chain: { ...MIXED.chain, invoices: [MIXED.chain.invoices[3]!], depositRequests: [] } }
    expect(tabCountOf('money', draftOnly, { viewInvoices: true })).toBe(0)
    expect(rowOf(linkedRowsOf(input(draftOnly)), 'invoices')!.parts[0]).toEqual({ key: 'linked.inv.noneIssued' })
    const mixed: Order = { ...MIXED, chain: { ...MIXED.chain, depositRequests: [] } }
    expect(rowOf(linkedRowsOf(input(mixed)), 'invoices')!.parts[0]!.params).toEqual({ count: tabCountOf('money', mixed, { viewInvoices: true }) })
  })
})

describe('F-OO-207: Linked records — one row per kind through the ONE count rule; the work orders\' statuses (D3); cancelled in words (D8)', () => {
  it('the numbers are the domain\'s orderLinkCountsOf (live only), each part said only when not zero; cancelled apart, never added in', () => {
    const view = linkedRowsOf(input(MIXED))
    const counts = orderLinkCountsOf(MIXED.chain)
    const wo = rowOf(view, 'workOrders')!
    expect(wo).toMatchObject({ state: 'ready', count: counts.workOrders.live, href: `${PREFIX}/sales/orders/${MIXED.id}?tab=production` })
    expect(wo.count).toBe(5)
    expect(wo.parts).toEqual([
      { key: 'linked.wo.inWork', params: { count: 2 } },
      { key: 'linked.wo.draft', params: { count: 1 } },
      { key: 'linked.wo.onHold', params: { count: 1 } },
      { key: 'linked.wo.done', params: { count: 1 } },
      { key: 'linked.wo.cancelled', params: { count: 1 } },
    ])
    const ship = rowOf(view, 'shipments')!
    expect(ship).toMatchObject({ count: counts.shipments.live, href: `${PREFIX}/sales/orders/${MIXED.id}?tab=shipments` })
    expect(ship.count).toBe(2)
    expect(ship.parts).toEqual([{ key: 'linked.ship.lastDdt', params: { number: '101/2026' } }, { key: 'linked.ship.cancelled', params: { count: 1 } }])
    const invoices = rowOf(view, 'invoices')!
    expect(invoices).toMatchObject({ count: null, href: `${PREFIX}/sales/orders/${MIXED.id}?tab=money#invoices` })
    // Walk #8: the credit note and the deposit invoice are said AS PART of the issued ones (one count), then the drafts.
    expect(invoices.parts).toEqual([
      { key: 'linked.inv.issuedOf', params: { count: counts.invoices.issued }, of: [{ key: 'linked.inv.creditNote', params: { count: 1 } }, { key: 'linked.inv.deposit', params: { count: 1 } }] },
      { key: 'linked.inv.draft', params: { count: 1 } },
    ])
    // Shipments before any DDT: "no DDT yet" (never "shipped").
    const packed = { ...MIXED, chain: { ...MIXED.chain, shipments: [{ id: 's1', number: 'SH-1', status: 'PACKED', shippedAt: null, deliveredAt: null }] } }
    expect(rowOf(linkedRowsOf(input(packed)), 'shipments')!.parts).toEqual([{ key: 'linked.ship.noDdt' }])
  })

  it('draws EN + IT: the label, the value as one real link ("… ›"), in the kinds\' order', () => {
    const want = {
      en: ['Work orders 5 · 2 in work · 1 draft · 1 on hold · 1 done · 1 cancelled ›', 'Shipments 2 · last DDT 101/2026 · 1 cancelled ›', 'Invoices 3 issued (1 credit note, 1 deposit invoice) · 1 draft ›'],
      it: ['Ordini di lavoro 5 · 2 in lavorazione · 1 in bozza · 1 in sospeso · 1 finito · 1 annullato ›', 'Spedizioni 2 · ultimo DDT 101/2026 · 1 annullata ›', 'Fatture 3 emesse (1 nota di credito, 1 fattura di acconto) · 1 in bozza ›'],
    } as const
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(card(MIXED, 'owner', locale))
      const at = want[locale].map((words) => text.indexOf(words))
      expect(at.every((index) => index >= 0), `${locale}: ${at.join(',')} in ${text}`).toBe(true)
      expect([...at].sort((a, b) => a - b)).toEqual(at)
    }
    const html = card(MIXED, 'owner')
    // One list (a reader's landmark: the golden flow finds it by name), each row the shared card row.
    expect(html).toContain('<ul class="fw-so-linked-list" aria-label="Linked records">')
    expect(html.match(/<li class="fw-so-ov-row">/g)?.length).toBeGreaterThanOrEqual(3)
    expect(html).toMatch(/<a [^>]*href="\/w\/[^"]*\?tab=production"[^>]*>5 · 2 in work/)
    // The dashed count chips went (no is-plain, no countbtn).
    expect(html).not.toContain('fw-so-countbtn')
  })

  it('kinds at zero fold into one quiet line; complaints and returns: reading, could not be read, no right (not drawn), a count', () => {
    const confirmed = order('CONFIRMED')
    const view = linkedRowsOf(input(confirmed, { complaints: 0, returns: 0 }))
    // The work orders' row stays: its door is due (Make work orders…); shipments, invoices, complaints and returns have none yet.
    expect(view.rows.map((row) => row.kind)).toEqual(['workOrders'])
    expect(view.none).toEqual(['shipments', 'invoices', 'complaints', 'returns'])
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(card(confirmed, 'owner', locale, { links: { state: 'ready', links: { complaints: [], returns: [], rePromises: [], gateRefusals: [] } as never, busy: null, tell: {}, decline: null, said: null } }))
      expect(text).toContain(locale === 'en' ? 'None yet: Shipments · Invoices · Complaints · Returns' : 'Ancora nessuno: Spedizioni · Fatture · Reclami · Resi')
    }
    expect(linkedRowsOf(input(MIXED, { complaints: 'reading', returns: 'unread' })).rows.filter((row) => row.kind === 'complaints' || row.kind === 'returns').map((row) => [row.kind, row.state])).toEqual([['complaints', 'reading'], ['returns', 'unread']])
    expect(textOf(card(MIXED, 'owner', 'en', { links: { state: 'error', problem: 'problem.read.unavailable' } }))).toContain('Could not be read')
    expect(textOf(card(MIXED, 'owner', 'it', { links: { state: 'error', problem: 'problem.read.unavailable' } }))).toContain('Non è stato possibile leggerli')
    const counted = linkedRowsOf(input(MIXED, { complaints: 2, returns: null }))
    expect(rowOf(counted, 'complaints')).toMatchObject({ count: 2, href: `${PREFIX}/sales/orders/${MIXED.id}?tab=shipments` })
    expect(rowOf(counted, 'returns')).toBeNull()
    expect(counted.none).not.toContain('returns')
  })

  it('F-OP-306: without invoices.view the Money tab\'s own sentence alone — no label, no number', () => {
    const view = linkedRowsOf(input(MIXED, { can: canOf('manager') }))
    expect(rowOf(view, 'invoices')).toEqual({ kind: 'invoices', state: 'held', count: null, parts: [], href: null, held: { key: 'money.noInvoiceRight' }, door: null })
    expect(view.none).not.toContain('invoices')
    const text = textOf(card(MIXED, 'manager'))
    expect(text).toContain('Invoices are shown to people who see invoices.')
    expect(text).not.toMatch(/Invoices 3|issued|credit note/)
  })
})

describe('F-OO-207: the doors that make the next record — only when due (F8), held in the band\'s words, never for Read-only', () => {
  it('CONFIRMED with lines not in work orders: Make work orders… — held with the deposit\'s words for who may make them, the right\'s words for Sales', () => {
    const confirmed = order('CONFIRMED')
    const owner = rowOf(linkedRowsOf(input(confirmed)), 'workOrders')!
    expect(owner.door).toEqual({ kind: 'make', held: { key: 'held.deposit', params: { date: confirmed.chain.depositRequests[0]!.dueDate } } })
    // Sales holds no workorders.manage (its template): the right's words come first, as the band says them (makeHeldOf).
    expect(rowOf(linkedRowsOf(input(confirmed, { can: canOf('sales') })), 'workOrders')!.door).toEqual({ kind: 'make', held: { key: 'held.noWorkOrders' } })
    for (const locale of ['en', 'it'] as const) {
      const owned = card(confirmed, 'owner', locale)
      expect(textOf(owned)).toContain(locale === 'en' ? 'Make work orders…' : 'Crea ordini di lavoro…')
      expect(owned).toMatch(locale === 'en' ? /aria-description="Production waits for the deposit \(due [^"]+\)"/ : /aria-description="La produzione aspetta l&#x27;acconto \(scade il [^"]+\)"/)
      expect(card(confirmed, 'sales', locale)).toMatch(locale === 'en' ? /aria-description="Making work orders needs the production manager&#x27;s right"/ : /aria-description="Creare ordini di lavoro richiede il diritto del responsabile di produzione"/)
    }
    // Deposit paid, every line in work orders (in production): no door; one line left out: the door, open for who may.
    const inWork = order('IN_PRODUCTION')
    expect(rowOf(linkedRowsOf(input(inWork)), 'workOrders')!.door).toBeNull()
    const lineLeft = { ...inWork, lines: inWork.lines.map((line, index) => (index === 1 ? { ...line, progress: { ...line.progress, inWorkOrders: 0 } } : line)) }
    expect(rowOf(linkedRowsOf(input(lineLeft)), 'workOrders')!.door).toEqual({ kind: 'make', held: null })
  })

  it('READY with released garments not shipped: Create shipment… in place (or Warehouse\'s page); without the right held in its words', () => {
    const ready = order('READY')
    expect(ready.progress.released).toBeGreaterThan(ready.progress.shipped)
    expect(rowOf(linkedRowsOf(input(ready)), 'shipments')!.door).toEqual({ kind: 'ship', to: { kind: 'inPlace' }, held: null })
    expect(rowOf(linkedRowsOf(input(ready, { shipInPlace: false })), 'shipments')!.door).toEqual({ kind: 'ship', to: { kind: 'warehouse', href: createShipmentHref(PREFIX, ready.id) }, held: null })
    expect(rowOf(linkedRowsOf(input(ready, { can: canOf('manager') })), 'shipments')!.door).toEqual({ kind: 'ship', to: null, held: { key: 'ship.create.held.noRight' } })
    // No shipment yet, but one is due: the row stands with its door (never folded into "None yet").
    expect(linkedRowsOf(input(ready)).none).not.toContain('shipments')
    let opened = 0
    const html = card(ready, 'owner', 'en', {}, { onCreateShipment: () => (opened += 1) })
    expect(textOf(html)).toContain('Create shipment…')
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Create shipment…/)
    expect(card(ready, 'manager')).toMatch(/aria-description="Making a shipment needs the warehouse&#x27;s shipping right"/)
    expect(opened).toBe(0)
  })

  it('nothing due: no door — shipped in full, cancelled, closed; Read-only: none at all, the rows stay', () => {
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) {
      const view = linkedRowsOf(input(order(status)))
      expect(view.rows.every((row) => row.door === null), status).toBe(true)
    }
    for (const status of ['CONFIRMED', 'READY'] as const) {
      const view = linkedRowsOf(input(order(status), { readOnly: true }))
      expect(view.rows.every((row) => row.door === null), status).toBe(true)
      const html = card(order(status), 'read_only')
      expect(html, status).not.toContain('<button')
      expect(html, status).not.toContain('nds-btn')
      expect(textOf(html), status).toContain('Linked records')
    }
  })
})

describe('F-OO-207: the quiet line — where the order came from, the deposit only when it waits for nothing, the same quote', () => {
  it('a paid, waived or not needed deposit is said ("Deposit: Paid ›"); one that waits (or was never asked) is not — Where it is now\'s strip', () => {
    const paid = linkedRowsOf(input(order('IN_PRODUCTION'))).quiet
    // F-OM-104 (P0-B11): the deposit's door lands on Money › Payments.
    expect(paid.find((part) => part.kind === 'deposit')).toEqual({ kind: 'deposit', state: 'PAID', href: `${PREFIX}/sales/orders/${order('IN_PRODUCTION').id}?tab=money#payments` })
    expect(linkedRowsOf(input(order('CONFIRMED'))).quiet.some((part) => part.kind === 'deposit')).toBe(false)
    const missing = order('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [] } })
    expect(linkedRowsOf(input(missing)).quiet.some((part) => part.kind === 'deposit')).toBe(false)
    const notNeeded = order('CONFIRMED', { depositRequired: false })
    expect(linkedRowsOf(input(notNeeded)).quiet.find((part) => part.kind === 'deposit')).toMatchObject({ state: 'NOT_NEEDED' })
    expect(textOf(card(order('IN_PRODUCTION'), 'owner'))).toContain('Deposit: Paid ›')
    expect(textOf(card(order('IN_PRODUCTION'), 'owner', 'it'))).toContain('Acconto: Pagato ›')
    expect(textOf(card(order('CONFIRMED'), 'owner'))).not.toMatch(/Deposit: |Waiting for payment/)
  })

  it('the quote (a link with quotes.view), the request it was made from, "Typed by the office"; nothing while the source is read; the same quote', () => {
    const value = order('IN_PRODUCTION')
    expect(linkedRowsOf(input(value)).quiet[0]).toEqual({ kind: 'quote', number: 'Q-2026-0188', revision: 2, href: `${PREFIX}/sales/quotes/${value.chain.quote!.id}` })
    expect(linkedRowsOf(input(value, { can: canOf('manager') })).quiet[0]).toMatchObject({ kind: 'quote', href: null })
    expect(textOf(card(value, 'owner'))).toContain('Quote: Q-2026-0188 v2 ›')
    const typed = { ...value, chain: { ...value.chain, quote: null } }
    expect(linkedRowsOf(input(typed, { madeFrom: { id: 'inq-1', number: 'INQ-2026-0041' } })).quiet[0]).toEqual({ kind: 'origin', words: { key: 'chain.fromRequest', params: { number: 'INQ-2026-0041' } }, href: `${PREFIX}/sales/incoming/inq-1` })
    expect(linkedRowsOf(input(typed, { madeFrom: null })).quiet[0]).toEqual({ kind: 'origin', words: { key: 'chain.noQuote' }, href: null })
    expect(linkedRowsOf(input(typed, { madeFrom: undefined })).quiet.some((part) => part.kind === 'origin' || part.kind === 'quote')).toBe(false)
    const same = linkedRowsOf(input(value, { sameQuote: [{ id: 'o2', number: 'SO-2026-0151' }] })).quiet
    expect(same.at(-1)).toEqual({ kind: 'sameQuote', number: 'SO-2026-0151', href: `${PREFIX}/sales/orders/o2` })
  })
})

// ---- F-OP-104 (order page plan N1; 10-order-page §3.1, §3.3, §3.4; review N-1, R-19): Overview's doors ----------------------------
describe('F-OP-104: Overview doors — linked records keep the dock\'s scope', () => {
  // F-OO-207: rewritten on the new rows (each value a link through tabHref).
  it('linked records: the order\'s own tabs through tabHref — the dock\'s scope kept, the narrow view\'s terms dropped', () => {
    const view = linkedRowsOf(input(MIXED, { complaints: 1, search: 'tab=overview&thread=all&open=r1' }))
    expect(rowOf(view, 'workOrders')!.href).toBe(`${PREFIX}/sales/orders/${MIXED.id}?tab=production&thread=all`)
    expect(rowOf(view, 'complaints')!.href).toBe(`${PREFIX}/sales/orders/${MIXED.id}?tab=shipments&thread=all`)
    expect(rowOf(view, 'invoices')!.href).toBe(`${PREFIX}/sales/orders/${MIXED.id}?tab=money&thread=all#invoices`)
    expect(view.quiet.find((part) => part.kind === 'deposit')!.href).toBe(`${PREFIX}/sales/orders/${MIXED.id}?tab=money&thread=all`)
  })
})
// ---- end F-OP-104

describe('F-OO-207: source and css — one count rule, the band\'s own door rules, its own linked.css; the chips left orders.css', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('linked.ts counts only through orderLinkCountsOf and opens the doors by the band\'s rules; the card, its own css', () => {
    const rules = read('./linked.ts')
    expect(rules).toContain("from '@nexus/factory-domain/sales/orders/linked-counts'")
    expect(rules).not.toMatch(/chain\.(workOrders|shipments|invoices|depositRequests)\.(length|filter)/)
    for (const name of ['makeHeldOf(order, can)', 'createShipmentDoor(order, can, prefix, input.shipInPlace)', 'createShipmentHeld(order, can)', 'linesNotInProduction(order)']) expect(rules, name).toContain(name)
    const view = read('../view/overview/LinkedCard.tsx')
    expect(view).toContain("import './linked.css'")
    expect(view).toContain('actions?.makeWorkOrders?.onOpen?.()')
    expect(view).toContain('actions?.onCreateShipment?.()')
    expect(read('../view/OverviewTab.tsx')).toMatch(/<LinkedCard order=\{order\} model=\{model\} actions=\{actions/)
    const css = read('../view/overview/linked.css')
    expect(css).toMatch(/\.fw-so-linked-list > \.fw-so-ov-row \{\s*grid-column: 1 \/ -1;\s*grid-template-columns: subgrid;/)
    expect(css).toMatch(/@container fw-so-ov-card \(max-width: 479px\)/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    expect(css).not.toContain('container:')
    const orders = read('../../orders.css')
    for (const gone of ['.fw-so-linked {', '.fw-so-countbtn {', 'a.fw-so-countbtn', '.fw-so-countbtn.is-plain']) expect(orders, gone).not.toContain(gone)
  })
})
