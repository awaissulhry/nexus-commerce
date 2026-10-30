import { describe, expect, it } from 'vitest'
import { askRefusal, cancelRefusal, decisionRefusal, recutDoneRefusal, replacedFrom, scrapByLot } from './rules'

/** Scrap and its replacement (B-W2a-13; MES-129, MES-130): figures by hand. */

describe('the leather a scrapped garment held (MES-129)', () => {
  it('shares the garments over the bundle’s entries by what each cut for the cell, at the BOM need per garment', () => {
    // 2 garments of 48.16 ft² each; hide H1 cut 8 of the cell's garments, hide H2 4: 2/3 and 1/3 of 96.32.
    const shares = scrapByLot(
      2,
      [
        { cutLogId: 'e1', lotId: 'L1', hideId: 'H1', garments: 8 },
        { cutLogId: 'e2', lotId: 'L1', hideId: 'H2', garments: 4 },
      ],
      '48.16',
    )
    expect(shares).toEqual([
      { lotId: 'L1', hideId: 'H1', area: '64.2133' },
      { lotId: 'L1', hideId: 'H2', area: '32.1067' },
    ])
  })

  it('adds the entries of one hide and leaves nothing when nothing was scrapped or the need is unknown', () => {
    expect(scrapByLot(1, [{ cutLogId: 'e1', lotId: 'L1', hideId: 'H1', garments: 3 }, { cutLogId: 'e2', lotId: 'L1', hideId: 'H1', garments: 1 }], '10')).toEqual([{ lotId: 'L1', hideId: 'H1', area: '10.0000' }])
    expect(scrapByLot(0, [{ cutLogId: 'e1', lotId: 'L1', hideId: 'H1', garments: 3 }], '10')).toEqual([])
    expect(scrapByLot(1, [{ cutLogId: 'e1', lotId: 'L1', hideId: 'H1', garments: 3 }], null)).toEqual([])
  })
})

describe('replacing scrapped garments (MES-130)', () => {
  const ask = {
    workOrder: { number: 'WO-3', status: 'IN_PROGRESS' as const },
    cell: { label: 'BLK 50', quantity: 12, parts: ['back', 'front', 'sleeve'] },
    kind: 'RECUT' as const,
    quantity: 2,
    part: null,
    source: { what: 'The scan of bundle B-4', scrapped: 3, replaced: 1 },
  }

  it('replaces at most what the source scrapped less what it replaces already', () => {
    expect(askRefusal(ask)).toBeNull()
    expect(askRefusal({ ...ask, quantity: 3 })?.message).toBe('The scan of bundle B-4 scrapped 3 garments; 2 not yet replaced, 3 asked.')
    expect(askRefusal({ ...ask, source: { ...ask.source, scrapped: 0 } })?.code).toBe('NO_SCRAP')
    expect(replacedFrom([{ status: 'OPEN', quantity: 1 }, { status: 'REFUSED', quantity: 5 }, { status: 'DONE', quantity: 2 }, { status: 'CANCELLED', quantity: 1 }])).toBe(3)
  })

  it('a recut names a part of the cell or none; a reduction never; the work order is open or completed', () => {
    expect(askRefusal({ ...ask, part: 'sleeve' })).toBeNull()
    expect(askRefusal({ ...ask, part: 'collar' })?.message).toBe('collar is not a part of BLK 50 cut from hides (back, front, sleeve).')
    expect(askRefusal({ ...ask, kind: 'REDUCE', part: 'sleeve' })?.code).toBe('PART_ON_REDUCE')
    expect(askRefusal({ ...ask, quantity: 13, source: null })?.code).toBe('MORE_THAN_CELL')
    expect(askRefusal({ ...ask, workOrder: { number: 'WO-3', status: 'COMPLETED' } })).toBeNull()
    expect(askRefusal({ ...ask, workOrder: { number: 'WO-3', status: 'CLOSED' } })?.code).toBe('WORK_ORDER_NOT_OPEN')
  })

  it('a reduction is decided once, by another person; a recut needs no decision', () => {
    expect(decisionRefusal({ kind: 'REDUCE', status: 'OPEN', createdById: 'u1', deciderId: 'u2' })).toBeNull()
    expect(decisionRefusal({ kind: 'REDUCE', status: 'OPEN', createdById: 'u1', deciderId: 'u1' })?.code).toBe('SELF_DECISION')
    expect(decisionRefusal({ kind: 'REDUCE', status: 'APPROVED', createdById: 'u1', deciderId: 'u2' })?.code).toBe('WRONG_STATE')
    expect(decisionRefusal({ kind: 'RECUT', status: 'OPEN', createdById: 'u1', deciderId: 'u2' })?.code).toBe('NOT_A_REDUCE')
    expect(cancelRefusal('APPROVED')).toBeNull()
    expect(cancelRefusal('DONE')?.code).toBe('WRONG_STATE')
  })

  it('a recut is done by a live entry with pieces of its cell (and part)', () => {
    const entry = { live: true, pieces: [{ cellId: 'c1', part: 'sleeve', pieces: 2 }] }
    expect(recutDoneRefusal({ kind: 'RECUT', status: 'OPEN', part: 'sleeve', cellLabel: 'BLK 50', entry, cellId: 'c1' })).toBeNull()
    expect(recutDoneRefusal({ kind: 'RECUT', status: 'OPEN', part: 'front', cellLabel: 'BLK 50', entry, cellId: 'c1' })?.code).toBe('CUT_NOT_OF_CELL')
    expect(recutDoneRefusal({ kind: 'RECUT', status: 'OPEN', part: null, cellLabel: 'BLK 50', entry: { ...entry, live: false }, cellId: 'c1' })?.code).toBe('CUT_NOT_OF_CELL')
    expect(recutDoneRefusal({ kind: 'REDUCE', status: 'APPROVED', part: null, cellLabel: 'BLK 50', entry, cellId: 'c1' })?.code).toBe('NOT_A_RECUT')
  })
})
