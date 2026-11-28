import { describe, expect, it } from 'vitest'
import { order } from '../../_demo/fixtures'
import type { Order } from '../../api'
import { BUCKETS, contentsRead, countedOf, receivedOf, shownBuckets, sumWord, whereAnswer, whereOf, type ShipmentRow } from './where'

/**
 * F-OS-102 (order SHIPMENTS tab, 10-design §4) — "Where every garment is", pure: every garment in ONE bucket and the buckets add up to
 * what was ordered; packed and draft told apart by the contents; came back only where the deliveries read says so; made to measure in
 * units; fees never drawn; today's figures until the server counts what is planned and ready now. Every number is made up.
 */

type Line = Order['lines'][number]
type P = Line['progress']

const base = order('READY')
const p = (ordered: number, over: Partial<P> = {}): P => ({ ordered, inWorkOrders: ordered, made: null, released: 0, shipped: 0, invoiced: '0', toShip: ordered, closedShort: 0, ...over })
const total = (rows: readonly P[], counted = true): P => {
  const add = (pick: (row: P) => number) => rows.reduce((sum, row) => sum + pick(row), 0)
  return { ...p(add((row) => row.ordered), { released: add((row) => row.released), shipped: add((row) => row.shipped), toShip: add((row) => row.toShip), closedShort: add((row) => row.closedShort) }), ...(counted ? { planned: add((row) => row.planned ?? 0), readyNow: add((row) => row.readyNow ?? 0) } : {}) }
}
const sized = (template: Line, id: string, sizes: Array<[string, P]>, over: Partial<Line> = {}): Line => {
  const rows = sizes.map(([size, progress]) => ({ size, quantity: progress.ordered, unitPrice: null, progress }))
  return { ...template, id, quantity: rows.reduce((sum, row) => sum + row.quantity, 0), sizes: rows, progress: total(rows.map((row) => row.progress), rows.every((row) => row.progress.planned !== undefined)), ...over }
}

// Black (line 10): 50 → 4 shipped on SH-1, 2 packed on SH-2, 1 on the draft SH-3, 2 ready now, 1 still to make; 52 → 4 came back on SH-4
// (not received yet), 6 still to make. Red (line 20, closed short): 50 → 6 delivered, 4 closed short; 52 → 10 delivered.
const BLACK = sized(base.lines[0]!, 'blk', [
  ['50', p(10, { released: 9, shipped: 4, toShip: 6, planned: 3, readyNow: 2 })],
  ['52', p(10, { released: 4, toShip: 10, planned: 0, readyNow: 0 })],
])
const RED = sized(base.lines[1]!, 'red', [
  ['50', p(10, { released: 10, shipped: 6, toShip: 0, closedShort: 4, planned: 0, readyNow: 0 })],
  ['52', p(10, { released: 10, shipped: 10, toShip: 0, planned: 0, readyNow: 0 })],
], { closedShort: { quantity: 4, at: '2026-11-04T10:00:00.000Z', byId: null, reason: 'The customer took fewer Red.', reasonCode: null } })

const ship = (id: string, number: string, status: string, contents?: ShipmentRow['contents']): ShipmentRow => ({ id, number, status, shippedAt: null, deliveredAt: null, ...(contents ? { contents } : {}) })
const ROWS: ShipmentRow[] = [
  ship('sh-1', 'SEED-SH-0011', 'SHIPPED', [{ lineId: 'blk', size: '50', pieces: 4 }]),
  ship('sh-2', 'SEED-SH-0012', 'PACKED', [{ lineId: 'blk', size: '50', pieces: 2 }]),
  ship('sh-3', 'SEED-SH-0013', 'DRAFT', [{ lineId: 'blk', size: '50', pieces: 1 }]),
  ship('sh-4', 'SEED-SH-0014', 'RETURNED', [{ lineId: 'blk', size: '52', pieces: 4 }]),
  ship('sh-5', 'SEED-SH-0015', 'DELIVERED', [{ lineId: 'red', size: '50', pieces: 6 }, { lineId: 'red', size: '52', pieces: 10 }]),
  ship('sh-6', 'SEED-SH-0016', 'CANCELLED'),
]
const of = (lines: Line[], rows: ShipmentRow[] = ROWS, over: Partial<Order> = {}): Order => ({ ...base, lines, progress: total(lines.map((line) => line.progress), lines.every((line) => line.progress.planned !== undefined)), chain: { ...base.chain, shipments: rows }, ...over })
const ORDER = of([BLACK, RED])
const RECEIVED = new Map([['sh-4', false]])
const sumOf = (totals: Record<string, number>) => BUCKETS.reduce((sum, bucket) => sum + totals[bucket]!, 0)

describe('the buckets add up to what was ordered (one counted set: Overview, Lines, Production and this tab agree)', () => {
  it('shipped · packed · draft · came back · ready now · still to be made or released · closed short = ordered', () => {
    const where = whereOf(ORDER, RECEIVED)
    expect(where.mode).toBe('counted')
    expect(where.split).toBe(true)
    expect(where.totals).toEqual({ shipped: 20, atWarehouse: 0, packed: 2, draft: 1, planned: 0, back: 4, ready: 2, making: 7, closed: 4 })
    expect(where.ordered).toBe(40)
    expect(sumOf(where.totals)).toBe(40)
    // Still to ship = ready now + still to be made or released + came back: the garments on a draft or packed shipment are not "to ship".
    expect(where.stillToShip).toBe(2 + 7 + 4)
  })

  it('a shipment whose contents are not read yet: packed and draft stay one bucket "on shipments not left" — never a guess', () => {
    const rows = ROWS.map((row) => (row.id === 'sh-3' ? ship('sh-3', 'SEED-SH-0013', 'DRAFT') : row))
    expect(contentsRead(rows)).toBe(false)
    const where = whereOf(of([BLACK, RED], rows), RECEIVED)
    expect(where.split).toBe(false)
    expect(where.totals.planned).toBe(3)
    expect(where.totals.packed + where.totals.draft).toBe(0)
    expect(sumOf(where.totals)).toBe(40)
    // A cancelled shipment never needs its contents.
    expect(contentsRead([ship('x', 'X', 'CANCELLED')])).toBe(true)
  })

  it('came back is said only where the deliveries read says "not received": else those garments stay still to be made or released', () => {
    expect(whereOf(ORDER, null).totals).toMatchObject({ back: 0, making: 11 })
    expect(whereOf(ORDER, new Map([['sh-4', true]])).totals).toMatchObject({ back: 0, making: 11 })
    expect(whereOf(ORDER, RECEIVED).doors.back.map((ref) => ref.number)).toEqual(['SEED-SH-0014'])
    expect(receivedOf({ shipments: [{ id: 'sh-4', returned: { at: null, received: false } }, { id: 'sh-1' }] as never })).toEqual(new Map([['sh-4', false]]))
    expect(receivedOf(null)).toBeNull()
  })

  it('until the server counts what is planned and ready now (B-OS-002): today\'s figures, no bar, never a made-up 0', () => {
    const today = (line: Line): Line => ({ ...line, sizes: line.sizes.map((size) => ({ ...size, progress: { ...size.progress, planned: undefined, readyNow: undefined } })), progress: { ...line.progress, planned: undefined, readyNow: undefined } })
    const old = of([today(BLACK), today(RED)])
    expect(countedOf(old)).toBe(false)
    const where = whereOf(old, RECEIVED)
    expect(where.mode).toBe('today')
    expect(where.totals).toMatchObject({ packed: 0, draft: 0, planned: 0, ready: 0, making: 0, back: 0 })
    expect(whereAnswer(where, old)).toEqual([{ ns: 'orders', key: 'ship.figures', params: { ordered: 40, released: 33, shipped: 20, toShip: 16 } }])
    // Both demo lines are one style: its card says the style's figures of today.
    expect(where.cards[0]!.facts[0]).toEqual({ kind: 'figures', ordered: 40, released: 33, shipped: 20, toShip: 16 })
  })
})

describe('the style cards: the grid of what is still to ship BESIDE its facts', () => {
  it('ready now by colour and size, each shipment that carries the style, still to make, closed short with its reason', () => {
    const [card] = whereOf(of([BLACK, { ...RED, styleId: BLACK.styleId }]), RECEIVED).cards
    expect(card!.seqs).toEqual([10, 20])
    expect(card!.closed).toBe(4)
    expect(card!.grid!.value).toEqual({ blk: { '50': 3, '52': 10 }, red: { '50': 0, '52': 0 } })
    const kinds = card!.facts.map((fact) => (fact.kind === 'shipment' ? `${fact.kind}:${fact.ref.status}` : fact.kind))
    expect(kinds).toEqual(['ready', 'shipment:SHIPPED', 'shipment:PACKED', 'shipment:DRAFT', 'shipment:RETURNED', 'shipment:DELIVERED', 'making', 'closed'])
    expect(card!.facts[0]).toEqual({ kind: 'ready', cells: [{ colour: 'Nero', sizes: [{ size: '50', pieces: 2 }], units: null }] })
    expect(card!.facts.find((fact) => fact.kind === 'shipment' && fact.ref.status === 'RETURNED')).toMatchObject({ received: false, colours: [{ colour: 'Nero', pieces: 4 }] })
    expect(card!.facts.at(-1)).toEqual({ kind: 'closed', cells: [{ colour: 'Rosso', sizes: [{ size: '50', pieces: 4 }], units: null }], reason: 'The customer took fewer Red.', at: '2026-11-04T10:00:00.000Z' })
  })

  it('nothing of a style left to ship: no grid of zeros', () => {
    const cards = whereOf(ORDER, RECEIVED).cards
    expect(cards).toHaveLength(1) // one style (both demo lines are DEMO-JKT-01)
    const done = whereOf(of([RED]), RECEIVED).cards[0]!
    expect(done.stillToShip).toBe(0)
    expect(done.grid).toBeNull()
    expect(done.promise).toBeNull()
  })

  it('made to measure is counted in units (no grid); a fee line never ships and is never drawn (H1-B1, H1-B2)', () => {
    const unit = (id: string, seq: number, over: Partial<P>): Line => ({ ...BLACK, id, seq, kind: 'MADE_TO_MEASURE', styleId: 'mtm-style', style: { code: 'SEED-MTM-01', name: 'Rider suit' }, quantity: 1, sizes: [{ size: null, quantity: 1, unitPrice: null, progress: p(1, over) }], progress: p(1, over) })
    const fee: Line = { ...BLACK, id: 'fee', seq: 90, kind: 'FEE', feeKind: 'DEVELOPMENT', sizes: [], quantity: 1, progress: p(1, { toShip: 0, planned: 0, readyNow: 0 }) }
    const units = [unit('u1', 30, { released: 1, toShip: 1, planned: 0, readyNow: 1 }), unit('u2', 31, { toShip: 1, planned: 1, readyNow: 0 })]
    const where = whereOf(of([...units, fee], [ship('d', 'SEED-SH-0020', 'DRAFT', [{ lineId: 'u2', size: '52', pieces: 1 }])]), null)
    expect(where.ordered).toBe(2) // the fee is not a garment
    expect(where.cards.map((card) => card.code)).toEqual(['SEED-MTM-01'])
    const card = where.cards[0]!
    expect(card.mtm).toBe(true)
    expect(card.grid).toBeNull()
    expect(card.facts[0]).toEqual({ kind: 'ready', cells: [{ colour: 'Nero', sizes: [], units: 1 }] })
    // A made-to-measure line's contents match it whatever size the shipment line names (one cell).
    expect(where.totals).toMatchObject({ ready: 1, draft: 1 })
  })
})

describe('the order\'s state says it in one line', () => {
  it('waits for a yes · cancelled · fees only', () => {
    expect(whereOf({ ...ORDER, status: 'PENDING_APPROVAL' }, null).state).toBe('pending')
    expect(whereOf({ ...ORDER, status: 'CANCELLED' }, null).state).toBe('cancelled')
    const fee: Line = { ...BLACK, id: 'fee', kind: 'FEE', sizes: [], progress: p(1, { toShip: 0, planned: 0, readyNow: 0 }) }
    expect(whereOf(of([fee], []), null).state).toBe('feesOnly')
    expect(whereAnswer(whereOf({ ...ORDER, status: 'CANCELLED' }, null), ORDER)).toEqual([{ key: 'where.state.cancelled' }])
  })

  it('everything shipped (or closed short): one line — "Everything shipped: 16 garments on 1 shipment · 4 closed short"', () => {
    const where = whereOf(of([RED], [ROWS[4]!]), null)
    expect(where.allOut).toBe(true)
    expect(where.left).toBe(1)
    expect(whereAnswer(where, of([RED]))).toEqual([
      { key: 'where.allOut', words: { garments: { key: 'where.garments', params: { count: 16 } }, shipments: { key: 'where.shipments', params: { count: 1 } } } },
      { key: 'where.closedPart', params: { count: 4 } },
    ])
  })
})

describe('the answer and the summary\'s words', () => {
  it('"13 still to ship · 2 can go today · 4 came back and wait to be received · 3 on shipments not left"', () => {
    expect(whereAnswer(whereOf(ORDER, RECEIVED), ORDER)).toEqual([
      { key: 'where.answer.toShip', params: { count: 13 } },
      { key: 'where.answer.ready', params: { count: 2 } },
      { key: 'where.answer.back', params: { count: 4 } },
      { key: 'where.answer.onShip', params: { count: 3 } },
    ])
    const nothing = of([sized(base.lines[0]!, 'blk', [['50', p(4, { toShip: 4, planned: 0, readyNow: 0 })]])], [])
    expect(whereAnswer(whereOf(nothing, null), nothing)[1]).toEqual({ key: 'where.answer.nothingReady' })
  })

  it('the legend draws every bucket that holds a garment, Shipped always; the sum names each of them', () => {
    const where = whereOf(ORDER, RECEIVED)
    expect(shownBuckets(where)).toEqual(['shipped', 'packed', 'draft', 'back', 'ready', 'making', 'closed'])
    expect(sumWord(where)).toEqual({ key: 'where.eq', params: { sum: '20 + 2 + 1 + 4 + 2 + 7 + 4', ordered: 40 } })
    const fresh = of([sized(base.lines[0]!, 'blk', [['50', p(4, { toShip: 4, planned: 0, readyNow: 0 })]])], [])
    expect(shownBuckets(whereOf(fresh, null))).toEqual(['shipped', 'making'])
    expect(whereOf(fresh, null).doors.shipped).toEqual([])
  })
})

// ── owb-ss3 step 3.2 (design plan § 5n, § 7; the word "At our warehouse") ──────────────────────────────────────────────────────────
describe('owb-ss3: the "At our warehouse" part (the legs read) adds up', () => {
  it('a shipment at our warehouse moves its garments out of Shipped into At our warehouse; the buckets still add up to 40', () => {
    const where = whereOf(ORDER, RECEIVED, new Set(['sh-1']))
    expect(where.totals).toEqual({ shipped: 16, atWarehouse: 4, packed: 2, draft: 1, planned: 0, back: 4, ready: 2, making: 7, closed: 4 })
    expect(sumOf(where.totals)).toBe(40)
    expect(where.doors.atWarehouse.map((ref) => ref.number)).toEqual(['SEED-SH-0011'])
    expect(where.doors.shipped.map((ref) => ref.number)).toEqual(['SEED-SH-0015'])
    expect(shownBuckets(where)).toEqual(['shipped', 'atWarehouse', 'packed', 'draft', 'back', 'ready', 'making', 'closed'])
    expect(sumWord(where)).toEqual({ key: 'where.eq', params: { sum: '16 + 4 + 2 + 1 + 4 + 2 + 7 + 4', ordered: 40 } })
  })

  it('only a SHIPPED shipment counts (a delivered one was sent on); not read or empty: nothing moves', () => {
    expect(whereOf(ORDER, RECEIVED, new Set(['sh-5'])).totals.atWarehouse).toBe(0)
    expect(whereOf(ORDER, RECEIVED, null).totals).toEqual(whereOf(ORDER, RECEIVED).totals)
    expect(whereOf(ORDER, RECEIVED, new Set()).totals.atWarehouse).toBe(0)
  })

  it('never more than left the factory, and "everything left" still counts the garments at our warehouse', () => {
    // A cell that says 2 shipped while the shipment names 4: at most the 2 that left move.
    const short = of([sized(base.lines[0]!, 'blk', [['50', p(4, { released: 4, shipped: 2, toShip: 2, planned: 0, readyNow: 2 })]])], [ship('sh-1', 'SEED-SH-0011', 'SHIPPED', [{ lineId: 'blk', size: '50', pieces: 4 }])])
    expect(whereOf(short, null, new Set(['sh-1'])).totals).toMatchObject({ shipped: 0, atWarehouse: 2, ready: 2 })
    const all = of([sized(base.lines[0]!, 'blk', [['50', p(4, { released: 4, shipped: 4, toShip: 0, planned: 0, readyNow: 0 })]])], [ship('sh-1', 'SEED-SH-0011', 'SHIPPED', [{ lineId: 'blk', size: '50', pieces: 4 }])])
    const where = whereOf(all, null, new Set(['sh-1']))
    expect(where.allOut).toBe(true)
    expect(whereAnswer(where, all)[0]).toMatchObject({ key: 'where.allOut', words: { garments: { key: 'where.garments', params: { count: 4 } } } })
  })
})
