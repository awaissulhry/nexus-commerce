import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../../lib/api/client'
import { readyToShipPage, type ReadyCell, type ReadyOrder } from '../api'
import { askedLines, askedMissing, firstReadyOf, othersOfAsked, READY_PAGES_MAX, SHIP_TOGETHER_MAX } from '../model'

/**
 * F-CW-301 (customer Work tab plan §4; 13-backend §5, §8; 10-design §6 W1) — "Ship N together…" from ticked orders: the SAME New
 * shipment window, opened with the selection (`asked`). The pure rules: which ticked order the shipment is made for, which join it
 * at once, why a ticked order is not on it; and the two facts of the read the hook respects (the first order decides the verdicts;
 * 100 orders a page). Warehouse's own mount and the order page's are untouched. Made-up orders only.
 */

const cell = (id: string, shippable: number): ReadyCell => ({ workOrderSizeId: id, shippable }) as ReadyCell
const MAY = { allowed: true, why: null }
const order = (id: string, shippable: number, shipsWith: ReadyOrder['shipsWith'] = MAY): ReadyOrder =>
  ({ salesOrderId: id, number: `SEED-SO-${id}`, customerRef: null, status: 'READY', companyId: 'c1', partyId: 'p1', party: { code: 'SEED', legalName: 'Seed Racing' }, shipsWith, cells: shippable > 0 ? [cell(`${id}-a`, shippable)] : [] }) as ReadyOrder
const OTHER_ADDRESS = { allowed: false, code: 'SHIP_TO' as const, why: 'x' }

describe('F-CW-301: the order the shipment is made for, and the ticked orders that join it', () => {
  it('the first ticked order with garments ready (the asked one first); none ready: null', () => {
    const read = [order('2', 24), order('3', 10)]
    expect(firstReadyOf(['1', '2', '3'], read)).toBe('2') // the asked order 1 is not in the read: nothing of it is ready
    expect(firstReadyOf(['2', '3'], read)).toBe('2')
    expect(firstReadyOf(['1'], read)).toBeNull()
    expect(firstReadyOf(['1', '4'], [order('4', 0)])).toBeNull() // read, but nothing of it can still ship
  })

  it('the others join at once only when read, with garments ready, and their verdict allows — never more than the cap', () => {
    const read = [order('1', 5, null), order('2', 24), order('3', 10, OTHER_ADDRESS), order('4', 0)]
    expect(othersOfAsked(['1', '2', '3', '4', '5'], '1', read)).toEqual(['2'])
    const many = Array.from({ length: 30 }, (_, index) => order(String(index + 1), 1, index === 0 ? null : MAY))
    const asked = many.map((entry) => entry.salesOrderId)
    expect(SHIP_TOGETHER_MAX).toBe(20)
    expect(othersOfAsked(asked, '1', many)).toHaveLength(SHIP_TOGETHER_MAX - 1) // the first counts
    // An order the customer has, not ticked, is never added by itself.
    expect(othersOfAsked(['1'], '1', read)).toEqual([])
  })

  it('"Runs on 2 · Not on 3": each ticked order on the shipment, or not with why — nothing released, its verdict, taken off here', () => {
    const read = [order('1', 5, null), order('2', 24), order('3', 10, OTHER_ADDRESS), order('4', 0)]
    const window = { orders: read, salesOrderId: '1', others: ['2'], asked: ['1', '2', '3', '4', '5'] }
    expect(askedLines(window)).toEqual([
      { id: '1', on: true, why: null },
      { id: '2', on: true, why: null },
      { id: '3', on: false, why: { kind: 'held', held: { key: 'shipOrders.why.SHIP_TO', detail: null } } }, // another delivery address
      { id: '4', on: false, why: { kind: 'nothing' } }, // read, nothing of it can still ship
      { id: '5', on: false, why: { kind: 'nothing' } }, // not in the read at all
    ])
    // The person takes order 2 off in the window: said so, never silently dropped.
    expect(askedLines({ ...window, others: [] })[1]).toEqual({ id: '2', on: false, why: { kind: 'off' } })
    // Nothing ready on any ticked order: every line says so (the window shows "Nothing released to ship").
    expect(askedLines({ orders: [order('9', 3)], salesOrderId: '1', others: [], asked: ['1', '4'] }).map((line) => line.why?.kind)).toEqual(['nothing', 'nothing'])
    // Over the cap: the 21st allowed order says the cap.
    const many = Array.from({ length: 22 }, (_, index) => order(String(index + 1), 1, index === 0 ? null : MAY))
    const ids = many.map((entry) => entry.salesOrderId)
    const full = askedLines({ orders: many, salesOrderId: '1', others: othersOfAsked(ids, '1', many), asked: ids })
    expect(full.filter((line) => line.on)).toHaveLength(SHIP_TOGETHER_MAX)
    expect(full.filter((line) => !line.on).map((line) => line.why)).toEqual([{ kind: 'cap' }, { kind: 'cap' }])
    // Not opened from ticked orders (Warehouse, the order page): no line at all.
    expect(askedLines({ orders: read, salesOrderId: '1', others: [] })).toEqual([])
  })
})

describe('F-CW-301: the two facts of the ready read the hook respects (13-backend §5)', () => {
  it('a ticked order may sit on a later page: the cursor is followed while one is missing, three pages at most', async () => {
    expect(READY_PAGES_MAX).toBe(3)
    expect(askedMissing(['1', '2', '3'], [order('1', 1)])).toEqual(['2', '3'])
    expect(askedMissing(['1'], [order('1', 0)])).toEqual([]) // read (with nothing ready) is not missing
    const calls: Array<Record<string, unknown>> = []
    const api = { get: async (_path: string, options: { query: Record<string, unknown>; schema: { parse: (value: unknown) => unknown } }) => (calls.push(options.query), options.schema.parse({ orders: [], nextCursor: 'next-1' })) } as unknown as ApiClient
    expect(await readyToShipPage(api, { salesOrderId: 'o1', cursor: 'c0' })).toEqual({ orders: [], nextCursor: 'next-1' })
    expect(calls).toEqual([{ salesOrderId: 'o1', together: '1', cursor: 'c0' }])
    const hook = readFileSync(new URL('./use-new-shipment.ts', import.meta.url), 'utf8')
    expect(hook).toContain('for (let page = 0; page < READY_PAGES_MAX; page += 1) {')
    expect(hook).toContain('if (!cursor || askedMissing(asked, orders).length === 0) break')
  })

  it('the first order decides the verdicts: when the asked one has nothing ready the read is asked again with one that has (two reads)', () => {
    const hook = readFileSync(new URL('./use-new-shipment.ts', import.meta.url), 'utf8')
    expect(hook).toContain('if (first && first !== salesOrderId) {')
    expect(hook).toContain('orders = await readFor(first)')
    expect(hook).toContain('others: first ? othersOfAsked(asked, first, orders) : []')
    // A read on its way belongs to the window that asked it.
    expect(hook).toContain('if (mine !== turn.current) return')
  })

  it('Warehouse\'s own mount and the order page\'s are untouched: no `asked`, no lines over the steps; the dialog only gains a slot', () => {
    const hook = readFileSync(new URL('./use-new-shipment.ts', import.meta.url), 'utf8')
    // The path without `asked` is the one read as before.
    expect(hook).toContain('readyToShip(api, together ? { salesOrderId, together: true } : {})')
    const dialog = readFileSync(new URL('../list/view/NewShipmentDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain('{above /* F-CW-301')
    expect(dialog).toContain("{!model.join && <p className=\"fw-sh-hint\">{t('new.number')}</p>}")
    for (const mount of ['../list/ShipmentsPage.tsx', '../list/view/ShipmentsListView.tsx', '../../../sales/orders/record/use-shipments-acts.ts']) {
      const source = readFileSync(new URL(mount, import.meta.url), 'utf8')
      expect(source, mount).not.toMatch(/asked:|above=|above:/)
    }
    // From a selection only: one more than the cap is not added by a tick (the host says why beside it).
    expect(hook).toContain('if (on && current.asked && !(current.others ?? []).includes(salesOrderId) && (current.others ?? []).length >= SHIP_TOGETHER_MAX - 1) return current')
  })
})
