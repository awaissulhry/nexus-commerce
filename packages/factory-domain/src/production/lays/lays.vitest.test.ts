import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import { differenceWords, estimateOf, recordedOf, splitByWeight } from './consumption'
import { bySize, fabricCut, leatherCut, lineFigures, reasonProblems, reconcileRefusal, reconcileWords } from './reconcile'
import { atTableRefusal, countRefusal, endWarning, layLengthRefusal, pliesFromLength, pliesRefusal, plyLength, rollUse, spreadProblems, spreadWords, stillNeeded } from './rules'

const table = { cutOrderNumber: 'CO-2026-0001', kind: 'FABRIC', cutOrderStatus: 'IN_PROGRESS', laySeq: 1, layStatus: 'PLANNED', ticket: { number: 'CTA-2026-00001', status: 'STARTED' } }

describe('the lay at the table (MES-038)', () => {
  it('is spread from its started ticket, while the cut order is at the table and the lay open', () => {
    expect(atTableRefusal(table)).toBeNull()
    expect(atTableRefusal({ ...table, kind: 'LEATHER' })?.code).toBe('NOT_FABRIC')
    expect(atTableRefusal({ ...table, cutOrderStatus: 'CUT' })?.code).toBe('CUT_ORDER_NOT_AT_TABLE')
    expect(atTableRefusal({ ...table, layStatus: 'CUT' })).toEqual({ code: 'LAY_NOT_OPEN', message: 'Lay 1 is cut: its report no longer changes.' })
    expect(atTableRefusal({ ...table, ticket: { number: 'CTA-2026-00001', status: 'OPEN' } })).toEqual({ code: 'TICKET_NOT_STARTED', message: 'Scan ticket CTA-2026-00001 at the start first: lay 1 is spread from its started ticket.' })
    expect(atTableRefusal({ ...table, ticket: null })?.message).toContain('Scan its ticket')
  })

  it('checks a roll of the report: plies, splices, end loss and end returned up to the roll', () => {
    expect(spreadProblems({ plies: 6, splices: 1, endLoss: '0.35', endReturned: '12' }, new Dec('60'))).toEqual([])
    expect(spreadProblems({ plies: 0, splices: -1, endLoss: '1,5', endReturned: '61' }, new Dec('60')).map((problem) => problem.path)).toEqual(['plies', 'splices', 'endLoss', 'endReturned'])
  })

  it('takes the ply off a roll as the lay on the table, else the marker, in the roll\'s unit', () => {
    const marker = { length: '2', uom: 'M' } as const
    expect(plyLength(marker, null, 'CM').toFixed(4)).toBe('200.0000')
    expect(plyLength(marker, { length: '210', uom: 'CM' }, 'M').toFixed(4)).toBe('2.1000')
    expect(layLengthRefusal(marker, { length: '190', uom: 'CM' }, 2)).toEqual({ code: 'PLY_TOO_SHORT', message: 'Lay 2: a ply of 190 cm is shorter than the marker (2 m).' })
    expect(layLengthRefusal(marker, { length: '2.05', uom: 'M' }, 2)).toBeNull()
    expect(rollUse(6, new Dec('2.1'), '0.4').toFixed(4)).toBe('13.0000')
    expect(pliesFromLength(new Dec('12.99'), new Dec('2.1'))).toBe(6)
    expect(pliesFromLength(new Dec('0'), new Dec('2.1'))).toBe(0)
    expect(stillNeeded(6, 4)).toBe(2)
    expect(stillNeeded(6, 7)).toBe(0)
  })

  it('refuses plies beyond the lay\'s plan or the roll\'s length, in words', () => {
    const facts = { laySeq: 1, planned: 6, others: 2, rollCode: 'RL-1', available: new Dec('9'), ply: new Dec('2'), uom: 'M' } as const
    expect(pliesRefusal({ plies: 4, endLoss: new Dec('0.5') }, facts)).toBeNull()
    expect(pliesRefusal({ plies: 5, endLoss: new Dec('0') }, facts)).toEqual({ code: 'LAY_FULL', message: 'Lay 1 plans 6 plies; with these it would have 7.' })
    expect(pliesRefusal({ plies: 4, endLoss: new Dec('1.5') }, facts)).toEqual({
      code: 'ROLL_SHORT',
      message: 'Roll RL-1 has 9 m for this lay: 3 plies of 2 m, not 4. If it is longer, the warehouse measures it again.',
    })
  })

  it('warns when the roll end measured back differs from what the report leaves on it', () => {
    const roll = { code: 'RL-1', length: new Dec('60'), uom: 'M' } as const
    expect(endWarning(roll, new Dec('47'), new Dec('0'))).toBeNull()
    expect(endWarning(roll, new Dec('47'), new Dec('46.5'))).toBeNull()
    expect(endWarning(roll, new Dec('47'), new Dec('45'), 'it')?.message).toBe('Roll RL-1: the end back measures 45 m, the lay report leaves 47 m on it. The warehouse measures the roll again (correct the roll).')
  })

  it('says the running sums in words', () => {
    expect(spreadWords({ plies: 6, rolls: 2, ply: new Dec('2.1'), uom: 'M' }, 'en')).toBe('6 plies · lay 2.1 m · 2 rolls')
    expect(spreadWords({ plies: 1, rolls: 1, ply: new Dec('2.1'), uom: 'M' }, 'it')).toBe('1 strato · materasso 2,1 m · 1 rotolo')
  })
})

describe('the count at both ends (MES-039)', () => {
  it('blocks the cut on a difference, in the design\'s words, and stores nothing', () => {
    expect(countRefusal({ left: 24, right: 24 }, 24, 1)).toBeNull()
    expect(countRefusal({ left: 24, right: 23 }, 24, 1)).toEqual({ code: 'PLIES_DIFFER', message: 'Left 24, right 23. Recount before cutting.' })
    expect(countRefusal({ left: 23, right: 23 }, 24, 1)).toEqual({ code: 'COUNT_NOT_SPREAD', message: 'Both ends say 23; the rolls gave 24 plies. Recount, or correct the rolls.' })
    expect(countRefusal({ left: 1, right: 1 }, 0, 3)?.code).toBe('NOTHING_SPREAD')
  })
})

describe('fabric used at cut finish (MES-046)', () => {
  it('estimates by the marker and records by the lay report, in metres', () => {
    expect(estimateOf({ length: '240', uom: 'CM' }, 6).toFixed(4)).toBe('14.4000')
    const recorded = recordedOf([{ plies: 4, endLoss: new Dec('30'), uom: 'CM' }, { plies: 2, endLoss: new Dec('0'), uom: 'M' }], new Dec('2.5'))
    expect(recorded.toFixed(4)).toBe('15.3000')
  })

  it('splits a length by the work orders\' garments a ply; the shares add up exactly', () => {
    const shares = splitByWeight(new Dec('10'), [
      { key: 'A', weight: 1 },
      { key: 'B', weight: 0 },
      { key: 'C', weight: 2 },
    ])
    expect(shares.map((share) => [share.key, share.length.toFixed(4)])).toEqual([
      ['A', '3.3333'],
      ['C', '6.6667'],
    ])
    expect(splitByWeight(new Dec('1'), [{ key: 'A', weight: 0 }])).toEqual([])
  })

  it('says the difference to the estimate in words', () => {
    expect(differenceWords(new Dec('12.6'), new Dec('12'), 'en')).toBe('0.6 m more than the estimate (+5%).')
    expect(differenceWords(new Dec('11.4'), new Dec('12'), 'it')).toBe('0,6 m in meno della stima (−5%).')
    expect(differenceWords(new Dec('12'), new Dec('12'), 'en')).toBe('As estimated.')
  })
})

describe('cut against ordered (MES-045)', () => {
  it('counts a fabric line by its ratio and the plies counted, a leather one by the cut log', () => {
    expect(fabricCut(2, 10)).toBe(20)
    expect(leatherCut(12, 5)).toBe(7)
    expect(leatherCut(3, 5)).toBe(0)
    expect(lineFigures(20, 18, 30)).toEqual({ ordered: 20, cut: 18, recut: 18, difference: -2, needsReason: true })
    expect(lineFigures(20, 20, 0)).toMatchObject({ difference: 0, needsReason: false })
  })

  it('is reconciled once cut, with every lay\'s fabric used confirmed', () => {
    expect(reconcileRefusal({ number: 'CO-1', status: 'CUT' }, [])).toBeNull()
    expect(reconcileRefusal({ number: 'CO-1', status: 'IN_PROGRESS' }, [])?.message).toBe('Cut order CO-1 is in progress: a cut order is reconciled once it is cut.')
    expect(reconcileRefusal({ number: 'CO-1', status: 'RECONCILED' }, [])?.code).toBe('NOT_CUT')
    expect(reconcileRefusal({ number: 'CO-1', status: 'CUT' }, [2])).toEqual({ code: 'FABRIC_NOT_CONFIRMED', message: 'The fabric used on lay 2 is not confirmed: confirm it first (it issues the fabric to the work orders).' })
  })

  it('asks a variance reason exactly where cut differs from ordered', () => {
    const lines = [
      { id: 'a', seq: 1, figures: lineFigures(20, 18, 0) },
      { id: 'b', seq: 2, figures: lineFigures(10, 10, 0) },
    ]
    expect(reasonProblems(lines, [{ lineId: 'a', reasonCode: 'PLIES_SHORT' }])).toEqual([])
    expect(reasonProblems(lines, []).map((problem) => problem.path)).toEqual(['lines/reasonCode'])
    expect(reasonProblems(lines, [{ lineId: 'a', reasonCode: 'PLIES_SHORT' }, { lineId: 'b', reasonCode: 'MISCUT' }]).map((problem) => problem.path)).toEqual(['lines/1/reasonCode'])
    expect(reasonProblems(lines, [{ lineId: 'a', reasonCode: 'LOST' }])[0]?.message).toContain('PLIES_SHORT')
    expect(reasonProblems(lines, [{ lineId: 'a', reasonCode: 'OTHER', note: ' ' }]).map((problem) => problem.path)).toEqual(['lines/0/note'])
    expect(reasonProblems(lines, [{ lineId: 'z', reasonCode: 'OTHER' }]).map((problem) => problem.path)).toEqual(['lines/0/lineId', 'lines/reasonCode'])
  })

  it('sums per size and in words', () => {
    const sizes = bySize([
      { size: '52', figures: lineFigures(30, 28, 0) },
      { size: '50', figures: lineFigures(20, 20, 0) },
      { size: '52', figures: lineFigures(10, 10, 1) },
    ])
    expect(sizes).toEqual([
      { size: '52', ordered: 40, cut: 38, recut: 1, difference: -2 },
      { size: '50', ordered: 20, cut: 20, recut: 0, difference: 0 },
    ])
    expect(reconcileWords({ ordered: 60, cut: 58 }, 'en')).toBe('60 ordered · 58 cut (−2)')
    expect(reconcileWords({ ordered: 60, cut: 60 }, 'it')).toBe('60 ordinati · 60 tagliati')
  })
})
