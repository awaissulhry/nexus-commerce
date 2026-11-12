import { describe, expect, it } from 'vitest'
import { pegMaterial, type DemandPart } from '../mrp/net'
import { byPriority, isRanked, rankWords } from './rank'

/** Scarce material by the backlog's priority (B-W2b-318; PLN-088). Every code and number is made up. */

const part = (fields: Partial<DemandPart> & Pick<DemandPart, 'key' | 'quantity'>): DemandPart => ({
  orderId: 'so-a',
  orderNumber: 'SO-A',
  orderLineId: 'ol-a',
  lineSeq: 10,
  partyId: 'party-1',
  size: '52',
  workOrderId: null,
  workOrderNumber: null,
  pieces: 1,
  dueDate: '2026-12-01',
  issued: '0',
  ...fields,
})
const lot = (id: string) => ({ id, qualityStatus: 'RELEASED' as const, requiresCrViTest: false, crViStatus: 'NOT_REQUIRED' as const })
const base = { itemColourId: 'blk', lotOf: lot, runDate: '2026-11-12' } as const
const stock = (quantity: string) => [{ itemColourId: 'blk', lotId: 'lot-1', quantity, hides: 0 }]
const purchases = [{ purchaseOrderLineId: 'pol-1', purchaseOrderNumber: 'PO-1', openQuantity: '100', dueDate: '2026-12-10' }]
const early = (rank?: number) => part({ key: 'a', dueDate: '2026-12-01', quantity: '100', ...(rank ? { rank } : {}) })
const late = (rank?: number) => part({ key: 'b', orderId: 'so-b', orderNumber: 'SO-B', orderLineId: 'ol-b', dueDate: '2026-12-20', quantity: '150', ...(rank ? { rank } : {}) })
const shortOf = (pegging: ReturnType<typeof pegMaterial>) => pegging.coverage.map((entry) => [entry.part.orderNumber, entry.uncovered])

describe('scarce material by the backlog’s priority (PLN-088)', () => {
  it('orders ranked parts by rank, then the others, each by day', () => {
    const entries = [
      { part: { rank: null }, day: '2026-11-20', index: 0 },
      { part: { rank: 2 }, day: '2026-11-25', index: 1 },
      { part: { rank: 1 }, day: '2026-12-20', index: 2 },
      { part: {}, day: '2026-11-18', index: 3 },
    ]
    expect([...entries].sort(byPriority).map((entry) => entry.index)).toEqual([2, 1, 3, 0])
    expect(isRanked({ rank: 3 })).toBe(true)
    expect(isRanked({ rank: null })).toBe(false)
    expect(rankWords(1)).toBe('rank 1')
    expect(rankWords(null)).toBe('not ranked')
  })

  it('without a rank the walk is by day (W1): the earliest order gets the stock', () => {
    const pegging = pegMaterial({ ...base, parts: [early(), late()], stock: stock('100'), purchases })
    expect(pegging).toMatchObject({ net: '50.0000', needDate: '2026-12-20' })
    expect(pegging.allocation).toBeUndefined()
    expect(shortOf(pegging)).toEqual([
      ['SO-A', '0.0000'],
      ['SO-B', '50.0000'],
    ])
  })

  it('a scarce material goes to the first-ranked order first: it takes the purchase order in time, then stock; the lower one is short', () => {
    const pegging = pegMaterial({ ...base, parts: [early(2), late(1)], stock: stock('100'), purchases })
    expect(pegging).toMatchObject({ allocation: 'PRIORITY', net: '50.0000', gross: '250.0000', usable: '100.0000', onOrder: '100.0000', needDate: '2026-12-01' })
    expect(shortOf(pegging)).toEqual([
      ['SO-A', '50.0000'],
      ['SO-B', '0.0000'],
    ])
    const b = pegging.coverage.find((entry) => entry.part.orderNumber === 'SO-B')!
    expect(b.supplies).toEqual([
      { kind: 'PURCHASE_ORDER', quantity: '100.0000', purchaseOrderLineId: 'pol-1', date: '2026-12-10' },
      { kind: 'STOCK', quantity: '50.0000' },
    ])
  })

  it('a material that is not short keeps the walk by day, ranked or not', () => {
    const pegging = pegMaterial({ ...base, parts: [early(2), late(1)], stock: stock('300'), purchases })
    expect(pegging.allocation).toBeUndefined()
    expect(pegging.net).toBe('0.0000')
  })
})
