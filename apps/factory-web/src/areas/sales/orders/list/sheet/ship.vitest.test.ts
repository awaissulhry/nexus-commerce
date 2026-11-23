import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { ReadyCell, ReadyOrder } from '../../../../warehouse/shipments/api'
import type { OrderStatus } from '../../api'
import { completeWarnings, readyNowOf, SHIP_STATES, shipFirstOf, shipHeld, shipRowHeld, shipRowOffered, shipSummaryOf, type ShipRow } from './ship'

/**
 * F-CW-301 (customer Work tab plan §4; 10-design §4, §5, §6 W1; lead settles S8, S23) — "Ship N together…" on the ONE Orders sheet
 * and "Create shipment…" on a row: when the act is held before the click, the order the window opens on, and the sheet's own words
 * over Warehouse's window (runs on / not on, "wants it all in one delivery"). The window itself is Warehouse's (never copied): its
 * rules are tested beside it (warehouse/shipments/new/ship-together.vitest.test.ts). Made-up orders only.
 */

const ALPHA = '11111111-1111-4111-8111-111111111111'
const BETA = '22222222-2222-4222-8222-222222222222'
const part = (readyNow: number | undefined) => ({ stage: null, stageSince: null, health: null, waitingOn: null, since: null, held: false, supervisorMark: 'NOT_SET', openRequests: 0, openIssues: 0, withheld: [], ...(readyNow === undefined ? {} : { readyNow }) }) as NonNullable<ShipRow['production']>
const row = (n: number, status: OrderStatus, readyNow?: number | null, partyId = ALPHA): ShipRow => ({ id: `o${n}`, number: `SEED-SO-000${n}`, customerRef: null, partyId, partyName: partyId === ALPHA ? 'Seed Racing' : 'Brand Beta', status, units: 244, shippedUnits: 0, ...(readyNow === null ? {} : { production: part(readyNow) }) })
const order = (id: string, shippable: number, shipsWith: ReadyOrder['shipsWith'] = { allowed: true, why: null }): ReadyOrder =>
  ({ salesOrderId: id, number: id.toUpperCase(), customerRef: null, status: 'READY', companyId: 'c1', partyId: ALPHA, party: { code: 'SEED', legalName: 'Seed Racing' }, shipsWith, cells: shippable > 0 ? [{ workOrderSizeId: `${id}-a`, shippable } as ReadyCell] : [] }) as ReadyOrder

describe('F-CW-301: held before the click only by a state or a cap — never by a missing right (the bar does not draw it then)', () => {
  it('orders of two customers; more than 20 orders; nothing ready now on any — only when every ticked row knows it', () => {
    expect(shipHeld([row(1, 'READY', 24), row(2, 'READY', 10, BETA)], null)).toEqual({ key: 'bulk.oneCustomer', params: { count: 2 } })
    expect(shipHeld([row(1, 'READY', 24, BETA)], ALPHA)).toEqual({ key: 'bulk.notThisCustomer' })
    expect(shipHeld(Array.from({ length: 21 }, (_, index) => row(index + 1, 'READY', 5)), null)).toEqual({ key: 'ship.cap', params: { max: 20 } })
    expect(shipHeld(Array.from({ length: 20 }, (_, index) => row(index + 1, 'READY', 5)), null)).toBeNull()
    // Nothing ready: known zeros, or a state in which nothing can wait to ship (not started, all shipped, closed, cancelled).
    expect(shipHeld([row(1, 'IN_PRODUCTION', 0), row(2, 'CONFIRMED', undefined), row(3, 'SHIPPED', 0)], null)).toEqual({ key: 'ship.nothing', params: { count: 3 } })
    // One with something ready is enough: the window says which ones it does not run on.
    expect(shipHeld([row(1, 'IN_PRODUCTION', 0), row(2, 'READY', 24)], null)).toBeNull()
    // The count is not known here (the production part was not read: Sales › Orders' own default view): never held — the window reads it.
    expect(shipHeld([row(1, 'READY', null), row(2, 'IN_PRODUCTION', undefined)], null)).toBeNull()
    expect(shipHeld([], null)).toBeNull()
    expect([readyNowOf(row(1, 'READY', 24)), readyNowOf(row(1, 'READY', 0)), readyNowOf(row(1, 'READY', null)), readyNowOf(row(1, 'READY', undefined))]).toEqual([24, 0, null, null])
  })

  it('a row offers Create shipment… only where garments can wait to ship; held with words when it knows nothing is ready', () => {
    expect([...SHIP_STATES]).toEqual(['IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'])
    for (const status of ['PENDING_APPROVAL', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) expect(shipRowOffered({ status }), status).toBe(false)
    for (const status of SHIP_STATES) expect(shipRowOffered({ status }), status).toBe(true)
    expect(shipRowHeld(row(1, 'IN_PRODUCTION', 0))).toBe(true)
    expect(shipRowHeld(row(1, 'READY', 24))).toBe(false)
    expect(shipRowHeld(row(1, 'READY', null))).toBe(false) // not known: it opens, the window says
    // The words are the order page's own ("No released garment waits to ship …"), in both languages.
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['step.createShipment', 'ship.create.held.nothing', 'ship.createdDoor']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
  })

  it('the window opens on a ticked order that has garments ready (so the API judges the others against its site)', () => {
    expect(shipFirstOf([row(1, 'IN_PRODUCTION', 0), row(2, 'READY', 24), row(3, 'READY', 10)])).toBe('o2')
    expect(shipFirstOf([row(1, 'CONFIRMED', undefined), row(2, 'READY', null)])).toBe('o2') // none known ready: the first that can ship
    expect(shipFirstOf([row(1, 'CLOSED', 0)])).toBe('o1')
    expect(shipFirstOf([])).toBeNull()
  })
})

describe('F-CW-301: the sheet\'s words over the window', () => {
  it('"Runs on 2 · Not on 1": from the window as it stands; nothing while it reads, nothing when it was not opened from ticked orders', () => {
    const read = [order('o1', 5, null), order('o2', 24), order('o3', 10, { allowed: false, code: 'SHIP_TO', why: 'x' })]
    const summary = shipSummaryOf({ orders: read, salesOrderId: 'o1', others: ['o2'], asked: ['o1', 'o2', 'o3'] })!
    expect([summary.runs, summary.notOn.map((line) => line.id), summary.asked]).toEqual([2, ['o3'], 3])
    expect(shipSummaryOf({ orders: null, salesOrderId: 'o1', others: [], asked: ['o1', 'o2'] })).toBeNull()
    expect(shipSummaryOf({ orders: read, salesOrderId: 'o1', others: [] })).toBeNull() // a row's Create shipment…: no selection
  })

  it('"wants it all in one delivery": only for an order ON the shipment that ships complete, while the shipment carries less than it still owes', () => {
    const read = [order('o1', 24, null), order('o2', 10)]
    const rows = [{ id: 'o1', units: 244, shippedUnits: 0 }, { id: 'o2', units: 10, shippedUnits: 0 }]
    const step1 = { orders: read, salesOrderId: 'o1', others: ['o2'], quantities: {}, step: 1 as const }
    // Step 1: what it can ship now — 24 of the 244 it still owes.
    expect(completeWarnings(step1, rows, { o1: true, o2: true })).toEqual([{ id: 'o1', carried: 24, owed: 244 }]) // o2 goes whole: no warning
    // Step 2: the garments typed.
    expect(completeWarnings({ ...step1, step: 2, quantities: { 'o1-a': 12, 'o2-a': 10 } }, rows, { o1: true, o2: true })).toEqual([{ id: 'o1', carried: 12, owed: 244 }])
    // Not ship complete, not read yet, or not on the shipment: nothing is said (never a guess).
    expect(completeWarnings(step1, rows, { o1: false })).toEqual([])
    expect(completeWarnings(step1, rows, {})).toEqual([])
    expect(completeWarnings({ ...step1, others: [] }, rows, { o2: true })).toEqual([])
    // Part already left: the pieces it still owes.
    expect(completeWarnings(step1, [{ id: 'o1', units: 244, shippedUnits: 220 }], { o1: true })).toEqual([])
  })

  it('every word of the act, the window\'s lines and the notice in both languages (no key left); the approved words reused', () => {
    for (const locale of LOCALES) {
      const s = createTranslator(locale, messagesFor(locale, ['orders-sheet'])['orders-sheet']!)
      const params = { count: 3, max: 20, customer: 'Seed Racing', order: 'SEED-SO-0009', carried: 24, owed: 244, number: 'SEED-SH-0012' }
      for (const key of ['bar.ship', 'ship.cap', 'ship.nothing', 'ship.capLine', 'ship.notOnLabel', 'ship.off', 'ship.complete', 'ship.completeCarries', 'ship.draft', 'ship.created', 'ship.createdDraft', 'ship.createdDraftAny', 'receipt.showThread', 'commands.runs', 'commands.notOn']) expect(s(key, params), `${locale} ${key}`).not.toBe(key)
      expect(createTranslator(locale, messagesFor(locale, ['shipments']).shipments!)('new.empty.title'), locale).not.toBe('new.empty.title')
      expect(createTranslator(locale, messagesFor(locale, ['warehouse-shipments-depth'])['warehouse-shipments-depth']!)('shipOrders.why.SHIP_TO'), locale).not.toBe('shipOrders.why.SHIP_TO')
    }
    const en = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
    const it_ = createTranslator('it', messagesFor('it', ['orders-sheet'])['orders-sheet']!)
    expect([en('bar.ship', { count: 3 }), it_('bar.ship', { count: 3 })]).toEqual(['Ship 3 together…', 'Spedisci 3 insieme…'])
    expect(en('ship.capLine', { max: 20, count: 6 })).toBe('One shipment carries at most 20 orders of one customer, to one address, from one site. 6 are ticked.')
    expect(en('ship.created', { number: 'SEED-SH-0012', count: 4 })).toBe('Shipment SEED-SH-0012 created with 4 orders:')
    expect(en('ship.createdDraft', { customer: 'Seed Racing' })).toBe('a draft: Seed Racing is not told.')
    expect(en('ship.nothing', { count: 3 })).toBe('Nothing is ready now on the 3 ticked.')
  })
})

describe('F-CW-301: the third mount of the ONE window — never a copy (source)', () => {
  it('the sheet mounts Warehouse\'s own hook and dialog, hands its lines to the dialog\'s slot, and draws no window of its own', () => {
    const container = readFileSync(new URL('../use-ship-together.ts', import.meta.url), 'utf8')
    expect(container).toContain("import { useNewShipment, type NewShipmentActions } from '../../../warehouse/shipments/new/use-new-shipment'")
    expect(container).toContain("ship.open(first, { together: true, asked: rows.map((row) => row.id) })")
    expect(container).toContain('ship.open(row.id, { together: true })') // a row's Create shipment…: as on the order page
    const view = readFileSync(new URL('../view/ShipTogether.tsx', import.meta.url), 'utf8')
    expect(view).toContain("import { NewShipmentDialog } from '../../../../warehouse/shipments/list/view/NewShipmentDialog'")
    expect(view).toContain('<NewShipmentDialog model={model.window} can={model.can} actions={actions} above={<ShipAbove model={model} rows={rows} prefix={prefix} />} />')
    expect(view).not.toMatch(/<Modal|Stepper|NumberStepper/) // no dialog of its own
    const sheet = readFileSync(new URL('../use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(sheet).toContain('const ship = useShipTogether(api, session.permissions, rereadInPlace)')
    expect(sheet).toContain('onShipTogether: (ids) => ship.open(pickedRows(ids)),')
  })

  it('hidden without shipping.manage: the bar\'s act, the row\'s step and the container (S9, S23: not for Sales)', () => {
    const list = readFileSync(new URL('../view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(list).toContain('{ ship: !!model.ship?.can.manage /* F-CW-301 */,')
    expect(list).toContain('can.createShipment && act()?.onCreateShipment && shipRowOffered(data)')
    expect(list).toContain("...(shipRowHeld(data) ? { disabled: true, description: t('ship.create.held.nothing') } : { onSelect: () => act()?.onCreateShipment?.(data.id) })")
    const container = readFileSync(new URL('../use-ship-together.ts', import.meta.url), 'utf8')
    expect(container).toContain('if (!first || !can.manage) return')
    expect(container).toContain('if (!can.manage) return')
  })

  it('after Create: ONE notice — the draft, its orders (each a door to its thread), the way to Warehouse; the rows read again in place', () => {
    const list = readFileSync(new URL('../view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(list).toContain('onOrder={(id) => actions?.onOpenRow?.(id, false)}')
    const container = readFileSync(new URL('../use-ship-together.ts', import.meta.url), 'utf8')
    expect(container).toContain('created.current(orders.map((order) => order.id))')
    const sheet = readFileSync(new URL('../use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(sheet).toContain('for (const fresh of page.orders) placeRow(fresh.id, () => fresh, fresh.status)')
    const view = readFileSync(new URL('../view/ShipTogether.tsx', import.meta.url), 'utf8')
    expect(view).toContain("<Link href={`${prefix}/warehouse/shipments/${encodeURIComponent(notice.shipmentId)}`}>{t('ship.createdDoor')}</Link>")
  })
})
