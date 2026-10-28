import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import { countDifferences, countProblems, type CountedLine } from './count'
import {
  changesSiteStock,
  directionOf,
  foldBalances,
  balancesFromSums,
  locationDelta,
  moveProblems,
  reversalOf,
  reversalProblems,
  shortfalls,
  siteDelta,
  stockCard,
  type LedgerMove,
  type MoveFacts,
  type PostedMove,
} from './moves'
import { baseQuantityOf } from './units'
import { costBasis, lotUnitCost, stockValue, valuationKey, valueOfMove } from './valuation'

const SITE = '0195f5d0-0000-7000-8000-0000000000a1'
const ITEM = '0195f5d0-0000-7000-8000-0000000000b1'
const LOT = '0195f5d0-0000-7000-8000-0000000000c1'
const HIDE = '0195f5d0-0000-7000-8000-0000000000d1'
const STORE = '0195f5d0-0000-7000-8000-0000000000e1'
const BIN = '0195f5d0-0000-7000-8000-0000000000e2'

const key = { siteId: SITE, itemId: ITEM, itemColourId: null, lotId: null, hideId: null }
const into = (location: string, quantity: string): LedgerMove => ({ ...key, fromLocationId: null, toLocationId: location, baseQuantity: quantity })
const outOf = (location: string, quantity: string): LedgerMove => ({ ...key, fromLocationId: location, toLocationId: null, baseQuantity: quantity })
const between = (from: string, to: string, quantity: string): LedgerMove => ({ ...key, fromLocationId: from, toLocationId: to, baseQuantity: quantity })
const text = (value: { toFixed(places: number): string }) => value.toFixed(4)

const untracked = { tracking: 'NONE' as const, baseUom: 'PCS' }
const facts = (overrides: Partial<MoveFacts> = {}): MoveFacts => ({
  reason: 'ADJUSTMENT',
  toLocationId: STORE,
  quantity: '2',
  uom: 'PCS',
  baseQuantity: '2',
  note: 'Found in the wrong bin.',
  item: untracked,
  ...overrides,
})
const paths = (move: MoveFacts) => moveProblems(move).map((issue) => issue.path)

// Ported from the old app (apps/factory src/lib/__tests__/ledger.test.ts, material-stock.test.ts): stock is derived from
// the moves, never stored; IN/OUT/ADJUST become moves into and out of locations (the locations give the direction).
describe('the ledger fold (ported: foldMovements)', () => {
  it('derives stock from moves in, out and a correction down', () => {
    const balances = foldBalances([into(STORE, '10'), outOf(STORE, '3'), outOf(STORE, '1')])
    expect(balances.map((balance) => [balance.locationId, text(balance.onHand)])).toEqual([[STORE, '6.0000']])
  })

  it('an empty ledger folds to nothing', () => {
    expect(foldBalances([])).toEqual([])
    expect(foldBalances([into(STORE, '4'), outOf(STORE, '4')])).toEqual([])
    expect(foldBalances([into(STORE, '4'), outOf(STORE, '4')], { keepZero: true }).map((balance) => text(balance.onHand))).toEqual(['0.0000'])
  })

  it('a correction up is a move in, with decimals kept exact (never a float)', () => {
    const balances = foldBalances([into(STORE, '0.1'), into(STORE, '0.2'), outOf(STORE, '0.3')], { keepZero: true })
    expect(text(balances[0]!.onHand)).toBe('0.0000')
    expect(text(foldBalances([into(STORE, '53.2'), into(STORE, '51.8')])[0]!.onHand)).toBe('105.0000')
  })

  it('a transfer moves stock between locations and leaves the site total unchanged', () => {
    const moves = [into(STORE, '8'), between(STORE, BIN, '5')]
    expect(foldBalances(moves).map((balance) => [balance.locationId, text(balance.onHand)])).toEqual([
      [STORE, '3.0000'],
      [BIN, '5.0000'],
    ])
    expect(moves.map(siteDelta).reduce((sum, delta) => sum.plus(delta), new Dec(0)).toFixed(4)).toBe('8.0000')
    expect(changesSiteStock(moves[1]!)).toBe(false)
    expect(locationDelta(moves[1]!, STORE).toFixed(4)).toBe('-5.0000')
    expect(locationDelta(moves[1]!, BIN).toFixed(4)).toBe('5.0000')
  })

  it('keeps each lot, hide and colour apart', () => {
    const lotMove = { ...into(STORE, '2'), lotId: LOT }
    const hideMove = { ...into(STORE, '53.2'), lotId: LOT, hideId: HIDE }
    expect(foldBalances([into(STORE, '1'), lotMove, hideMove])).toHaveLength(3)
  })

  it('the database way (sums per side) gives the same balances as the fold', () => {
    const moves = [into(STORE, '10'), between(STORE, BIN, '4'), outOf(BIN, '1.5')]
    const sums = (side: 'toLocationId' | 'fromLocationId') =>
      moves.filter((move) => move[side]).map((move) => ({ ...key, locationId: move[side]!, quantity: move.baseQuantity }))
    expect(balancesFromSums(sums('toLocationId'), sums('fromLocationId'))).toEqual(foldBalances(moves))
  })
})

describe('a move on its own (ported: validateMovement)', () => {
  it('refuses a zero, negative or non-decimal quantity: the locations give the direction', () => {
    expect(paths(facts({ quantity: '0', baseQuantity: '0' }))).toEqual(['quantity', 'baseQuantity'])
    expect(paths(facts({ quantity: '-2', baseQuantity: '-2' }))).toEqual(['quantity', 'baseQuantity'])
    expect(paths(facts({ quantity: 'NaN', baseQuantity: '1e3' }))).toEqual(['quantity', 'baseQuantity'])
    expect(paths(facts({ quantity: '1.23456', baseQuantity: '1.23456' }))).toEqual(['quantity', 'baseQuantity'])
  })

  it('an adjustment, a count and a scrap say why (SCM-192); a reversal says why at its own command', () => {
    expect(paths(facts({ note: ' ' }))).toEqual(['note'])
    expect(paths(facts({ reason: 'COUNT', note: null }))).toEqual(['note'])
    expect(paths(facts({ reason: 'SCRAP', toLocationId: null, fromLocationId: STORE, note: '' }))).toEqual(['note'])
    expect(paths(facts({ note: 'recount' }))).toEqual([])
    expect(paths(facts({ note: null, reversalOfId: LOT, fromLocationId: STORE, toLocationId: null }))).toEqual([])
  })

  it('accepts a quantity above 0 in and out', () => {
    for (const move of [facts(), facts({ toLocationId: null, fromLocationId: STORE }), facts({ reason: 'TRANSFER', fromLocationId: STORE, toLocationId: BIN, note: null })]) {
      expect(moveProblems(move)).toEqual([])
    }
  })
})

describe('the sides of a move', () => {
  it('each reason has its sides; a reversal has its original swapped', () => {
    expect(directionOf({ toLocationId: STORE })).toBe('IN')
    expect(directionOf({ fromLocationId: STORE })).toBe('OUT')
    expect(directionOf({ fromLocationId: STORE, toLocationId: BIN })).toBe('INSIDE')
    expect(directionOf({ fromLocationId: STORE, toLocationId: STORE })).toBeNull()
    expect(directionOf({})).toBeNull()

    expect(paths(facts({ reason: 'OPENING', fromLocationId: STORE, toLocationId: null }))).toEqual(['toLocationId'])
    expect(paths(facts({ reason: 'SCRAP', note: 'torn' }))).toEqual(['fromLocationId'])
    expect(paths(facts({ reason: 'TRANSFER', note: null }))).toEqual(['toLocationId'])
    expect(paths(facts({ fromLocationId: STORE, toLocationId: BIN }))).toEqual(['toLocationId'])
    expect(paths(facts({ fromLocationId: STORE, toLocationId: STORE }))).toEqual(['toLocationId'])
    // A reversed SCRAP enters again: the reason's sides do not apply to a reversal.
    expect(paths(facts({ reason: 'SCRAP', reversalOfId: LOT }))).toEqual([])
  })

  it('a receipt names its line and only it; an issue and a return name the work order', () => {
    expect(paths(facts({ reason: 'RECEIPT', note: null }))).toEqual(['receiptLineId'])
    expect(paths(facts({ reason: 'RECEIPT', receiptLineId: LOT }))).toEqual([])
    expect(paths(facts({ receiptLineId: LOT }))).toEqual(['receiptLineId'])
    expect(paths(facts({ reason: 'ISSUE', toLocationId: null, fromLocationId: STORE }))).toEqual(['workOrderId'])
    expect(paths(facts({ reason: 'RETURN', workOrderId: LOT }))).toEqual([])
  })

  it('names the lot and hide exactly as the item is tracked; the base unit gives the base quantity', () => {
    expect(paths(facts({ item: { tracking: 'LOT', baseUom: 'M' }, uom: 'M' }))).toEqual(['lotId'])
    expect(paths(facts({ item: { tracking: 'HIDE', baseUom: 'FT2' }, uom: 'FT2', lotId: LOT }))).toEqual(['hideId'])
    expect(paths(facts({ item: { tracking: 'LOT', baseUom: 'M' }, uom: 'M', lotId: LOT, hideId: HIDE }))).toEqual(['hideId'])
    expect(paths(facts({ lotId: LOT }))).toEqual(['lotId'])
    expect(paths(facts({ quantity: '2', baseQuantity: '3' }))).toEqual(['baseQuantity'])
    // Another unit (a hide in m² for an item counted in ft²): the base quantity is the caller's conversion.
    expect(paths(facts({ item: { tracking: 'HIDE', baseUom: 'FT2' }, uom: 'M2', quantity: '4.9', baseQuantity: '52.7432', lotId: LOT, hideId: HIDE }))).toEqual([])
  })
})

describe('never below zero (SCM-194)', () => {
  const hold = (quantities: Record<string, string>) => (located: { locationId: string }) => quantities[located.locationId] ?? '0'

  it('finds the moves of a batch that take more than the location holds, in order', () => {
    expect(shortfalls(hold({ [STORE]: '5' }), [outOf(STORE, '5')])).toEqual([])
    const found = shortfalls(hold({ [STORE]: '5' }), [outOf(STORE, '3'), outOf(STORE, '3')])
    expect(found.map((entry) => [entry.index, text(entry.holds), text(entry.takes)])).toEqual([[1, '2.0000', '3.0000']])
  })

  it('an earlier move of the batch may bring what a later one takes', () => {
    expect(shortfalls(hold({}), [into(STORE, '2'), between(STORE, BIN, '2'), outOf(BIN, '2')])).toEqual([])
    expect(shortfalls(hold({}), [between(STORE, BIN, '1')]).map((entry) => entry.locationId)).toEqual([STORE])
  })

  it('two scans of one hide: the second finds it gone', () => {
    const hide = { ...key, lotId: LOT, hideId: HIDE }
    const issue = { ...hide, fromLocationId: STORE, toLocationId: null, baseQuantity: '53.2' }
    expect(shortfalls(() => '53.2', [issue, issue]).map((entry) => entry.index)).toEqual([1])
  })
})

describe('the stock card (SCM-191)', () => {
  it('shows each move and the balance after it, for a location or for the site', () => {
    const moves = [into(STORE, '10'), between(STORE, BIN, '4'), outOf(BIN, '1')]
    expect(stockCard('2', moves, STORE).map((line) => [text(line.delta), text(line.balance)])).toEqual([
      ['10.0000', '12.0000'],
      ['-4.0000', '8.0000'],
      ['0.0000', '8.0000'],
    ])
    expect(stockCard('0', moves).map((line) => text(line.balance))).toEqual(['10.0000', '10.0000', '9.0000'])
  })
})

describe('reversals', () => {
  const posted: PostedMove = {
    id: '0195f5d0-0000-7000-8000-0000000000f1',
    ...key,
    reason: 'SCRAP',
    fromLocationId: STORE,
    toLocationId: null,
    quantity: '2',
    uom: 'PCS',
    baseQuantity: '2',
    receiptLineId: null,
    workOrderId: null,
    reference: 'Damaged in the store',
    reversalOfId: null,
  }

  it('is the same move with its locations swapped, saying why', () => {
    expect(reversalOf(posted, '  Wrong item scrapped. ')).toEqual({
      siteId: SITE,
      reason: 'SCRAP',
      itemId: ITEM,
      itemColourId: null,
      lotId: null,
      hideId: null,
      fromLocationId: null,
      toLocationId: STORE,
      quantity: '2.0000',
      uom: 'PCS',
      baseQuantity: '2.0000',
      receiptLineId: null,
      workOrderId: null,
      reference: 'Damaged in the store',
      note: 'Wrong item scrapped.',
      reversalOfId: posted.id,
    })
  })

  it('at most one per move, never of a reversal, never of a receipt move on its own', () => {
    expect(reversalProblems(posted, null)).toEqual([])
    expect(reversalProblems(posted, '0195f5d0-0000-7000-8000-0000000000f2')).toEqual(['This move was reversed already; a move has at most one reversal.'])
    expect(reversalProblems({ ...posted, reversalOfId: posted.id }, null)).toHaveLength(1)
    expect(reversalProblems({ ...posted, reason: 'RECEIPT' }, null)).toEqual(['A receipt move is reversed with its goods receipt, never on its own.'])
  })
})

describe('valuation (@grain cost)', () => {
  it('values a move in or out at quantity × unit cost, signed, rounded half up to cents', () => {
    expect(valueOfMove(into(STORE, '53.2'), '6.25', 'EUR')).toEqual({ quantity: '53.2000', unitCost: '6.250000', valueAmount: 33_250 })
    expect(valueOfMove(outOf(STORE, '1.0001'), '0.005', 'EUR')).toEqual({ quantity: '-1.0001', unitCost: '0.005000', valueAmount: -1 })
    expect(valueOfMove(into(STORE, '3'), '0.001', 'EUR')).toEqual({ quantity: '3.0000', unitCost: '0.001000', valueAmount: 0 })
    expect(valueOfMove(between(STORE, BIN, '3'), '5', 'EUR')).toBeNull()
    expect(() => valueOfMove(into(STORE, '1'), '-1', 'EUR')).toThrow(RangeError)
    expect(valuationKey('abc')).toBe('move:abc')
    expect(stockValue('105', '6.25', 'EUR')).toBe(65_625)
  })

  it('takes the caller’s cost, else a reversal’s original, else the lot’s, else the standard cost, else none', () => {
    expect(costBasis({ explicit: { method: 'PURCHASE_PRICE', unitCost: '6.4' }, lotCost: '6', standardCost: '5' })).toEqual({ method: 'PURCHASE_PRICE', unitCost: new Dec('6.4') })
    expect(costBasis({ reversed: { method: 'MANUAL', unitCost: '7.1' }, lotCost: '6', standardCost: '5' })?.method).toBe('MANUAL')
    expect(costBasis({ lotCost: '6.123456789', standardCost: '5' })).toEqual({ method: 'LOT_COST', unitCost: new Dec('6.123457') })
    expect(costBasis({ lotCost: null, standardCost: '5' })?.method).toBe('STANDARD_COST')
    expect(costBasis({ standardCost: null })).toBeNull()
    expect(costBasis({ standardCost: '-1' })).toBeNull()
  })

  it('a lot costs the moving average of its valued stock; once empty, the average of what came in', () => {
    expect(lotUnitCost([])).toBeNull()
    expect(lotUnitCost([{ quantity: '53.2', unitCost: '6' }, { quantity: '51.8', unitCost: '7' }])?.toFixed(6)).toBe('6.493333')
    // What left at the lot's cost leaves the cost as it was.
    expect(lotUnitCost([{ quantity: '10', unitCost: '6' }, { quantity: '10', unitCost: '8' }, { quantity: '-5', unitCost: '7' }])?.toFixed(6)).toBe('7.000000')
    // A reversed receipt takes back exactly what it brought.
    expect(lotUnitCost([{ quantity: '10', unitCost: '6' }, { quantity: '5', unitCost: '9' }, { quantity: '-5', unitCost: '9' }])?.toFixed(6)).toBe('6.000000')
    // Empty: what came in.
    expect(lotUnitCost([{ quantity: '10', unitCost: '6' }, { quantity: '-10', unitCost: '6' }])?.toFixed(6)).toBe('6.000000')
  })
})

describe('a count posts its differences as COUNT moves (PLAN §2.8, the year-end count)', () => {
  const line = (counted: string, overrides: Partial<CountedLine> = {}): CountedLine => ({ ...key, counted, ...overrides })

  it('more counted → a move in; less → a move out; the same → nothing', () => {
    const system: Record<string, string> = { [LOT]: '10', '-': '4' }
    const lines = [line('12', { lotId: LOT }), line('3.5'), line('0', { lotId: HIDE })]
    const differences = countDifferences(STORE, lines, (counted) => system[counted.lotId ?? '-'] ?? '0')
    expect(differences.map((entry) => [entry.system, entry.counted, entry.difference, entry.move])).toEqual([
      ['10.0000', '12.0000', '2.0000', { reason: 'COUNT', fromLocationId: null, toLocationId: STORE, baseQuantity: '2.0000' }],
      ['4.0000', '3.5000', '-0.5000', { reason: 'COUNT', fromLocationId: STORE, toLocationId: null, baseQuantity: '0.5000' }],
      ['0.0000', '0.0000', '0.0000', null],
    ])
  })

  it('refuses a negative or bad count and the same stock twice', () => {
    expect(countProblems([line('1'), line('-1', { lotId: LOT }), line('x', { lotId: HIDE }), line('2')]).map((issue) => issue.path)).toEqual([
      'lines/1/counted',
      'lines/2/counted',
      'lines/3',
    ])
  })
})

describe('a move’s base quantity (the product units module)', () => {
  const leather = { baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'DM2', consumptionFactor: '0.10763910' } as const
  const fabric = { baseUom: 'M2', purchaseUom: 'M', purchaseFactor: '1.5', consumptionUom: 'M2', consumptionFactor: '1' } as const

  it('ft² ↔ m²: computed with the exact ratio, rounded half up to four decimals', () => {
    expect(baseQuantityOf({ quantity: '10', uom: 'FT2' }, fabric)).toEqual({ baseQuantity: '0.9290' })
    expect(baseQuantityOf({ quantity: '4.9', uom: 'M2' }, leather)).toEqual({ baseQuantity: '52.7432' })
    // dm² for an item counted in ft²: the exact ratio, never the stored (rounded) consumption factor.
    expect(baseQuantityOf({ quantity: '250', uom: 'DM2' }, leather)).toEqual({ baseQuantity: '26.9098' })
    // The item's own conversion of another dimension: metres of a 1.5 m wide fabric.
    expect(baseQuantityOf({ quantity: '12', uom: 'M' }, fabric)).toEqual({ baseQuantity: '18.0000' })
  })

  it('accepts the same base quantity from the caller and refuses another', () => {
    expect(baseQuantityOf({ quantity: '10', uom: 'FT2', baseQuantity: '0.929' }, fabric)).toEqual({ baseQuantity: '0.9290' })
    expect(baseQuantityOf({ quantity: '10', uom: 'FT2', baseQuantity: '0.93' }, fabric)).toEqual({
      problem: { path: 'baseQuantity', message: '10.0000 FT2 is 0.9290 M2; the base quantity sent (0.93) does not match it.' },
    })
  })

  it('a unit of the item’s own size (a hide, a roll) needs the measured base quantity; a unit it cannot convert is refused', () => {
    expect(baseQuantityOf({ quantity: '1', uom: 'HIDE' }, leather).problem?.path).toBe('baseQuantity')
    expect(baseQuantityOf({ quantity: '1', uom: 'HIDE', baseQuantity: '53.2' }, leather)).toEqual({ baseQuantity: '53.2' })
    expect(baseQuantityOf({ quantity: '1', uom: 'KG' }, leather)).toEqual({ problem: { path: 'uom', message: 'This item does not convert KG to its base unit FT2; use M2, DM2, FT2, HIDE.' } })
    expect(baseQuantityOf({ quantity: '3', uom: 'FT2' }, leather)).toEqual({ baseQuantity: '3' })
  })
})
