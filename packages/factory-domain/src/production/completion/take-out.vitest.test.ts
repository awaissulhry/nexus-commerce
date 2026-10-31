import { describe, expect, it } from 'vitest'
import { releaseTakeOut, type TakeOutFacts } from './rules'

// B-W2b-10 (B-W2a-12's follow-up): a quality release reversal takes the garments out of finished goods. Figures by hand.
const base: TakeOutFacts = {
  label: 'BLK 52',
  netReleased: 3,
  onShipments: 0,
  received: 5,
  reversed: 2,
  receipts: [
    { moveId: 'm2', quantity: 2, placeId: 'fg' },
    { moveId: 'm1', quantity: 3, placeId: 'fg' },
  ],
  placeHolds: new Map([['fg', 5]]),
  canReceive: true,
}

describe('a release reversal takes the garments out of finished goods (B-W2b-10)', () => {
  it('takes back the newest receipt that covers the garments reversed', () => {
    expect(releaseTakeOut(base)).toEqual({ takeOut: 2, reverse: ['m2'], putBack: 0, putBackPlaceId: null, left: 0, words: 'BLK 52: 2 garments left finished goods with the reversal.' })
  })

  it('takes garments not in stock first: nothing leaves while what stays released still covers the stock', () => {
    expect(releaseTakeOut({ ...base, netReleased: 6, received: 5 })).toMatchObject({ takeOut: 0, reverse: [], words: 'BLK 52: no garment in finished goods is beyond what stays released; nothing leaves stock.' })
    // 4 in stock, 3 still released: only 1 of the 2 reversed was in stock.
    expect(releaseTakeOut({ ...base, received: 4, receipts: [{ moveId: 'm1', quantity: 4, placeId: 'fg' }], placeHolds: new Map([['fg', 4]]) })).toMatchObject({ takeOut: 1, reverse: ['m1'], putBack: 3, putBackPlaceId: 'fg', left: 0 })
  })

  it('takes a receipt back whole and puts the rest back at once; garments on shipments from the release count as gone', () => {
    const one = { ...base, received: 5, receipts: [{ moveId: 'm1', quantity: 5, placeId: 'fg' }] }
    expect(releaseTakeOut(one)).toMatchObject({ takeOut: 2, reverse: ['m1'], putBack: 3, putBackPlaceId: 'fg', words: 'BLK 52: 2 garments left finished goods with the reversal (3 went back in at once: a report is taken back whole).' })
    expect(releaseTakeOut({ ...one, netReleased: 4, onShipments: 1 })).toMatchObject({ takeOut: 2, putBack: 3 })
  })

  it('skips a receipt whose place no longer holds it, and says what is left when the work order takes no receipt', () => {
    expect(releaseTakeOut({ ...base, placeHolds: new Map([['fg', 1]]) })).toMatchObject({ takeOut: 0, reverse: [], left: 2 })
    const closed = { ...base, receipts: [{ moveId: 'm1', quantity: 5, placeId: 'fg' }], canReceive: false }
    expect(releaseTakeOut(closed)).toMatchObject({ takeOut: 0, reverse: [], putBack: 0, left: 2, words: 'BLK 52: 2 garments in finished goods should leave with the reversal; no report could be taken back here: take that report back by hand (Report finished to stock).' })
  })
})
