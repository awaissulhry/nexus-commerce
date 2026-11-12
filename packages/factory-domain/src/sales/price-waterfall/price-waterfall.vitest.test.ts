import { describe, expect, it } from 'vitest'
import { listPriceOnBasis } from '../pricelists/pricelists'
import { isPriced, priceVersion } from '../quotes/quotes'
import { orderProgress } from '../orders/orders'
import { taxable } from '../../tax/vat-treatment'
import {
  buildWaterfall,
  explainWaterfall,
  floorFor,
  floorsProblems,
  feeProblems,
  lowersAFloor,
  stepsProblem,
  suggestedPriceOf,
  type BuiltWaterfall,
  type WaterfallStep,
} from './rules'

const ENTRY = '00000000-0000-7000-8000-000000000001'
const BREAK = '00000000-0000-7000-8000-000000000002'
const OPTION = '00000000-0000-7000-8000-000000000003'
const SURCHARGE = '00000000-0000-7000-8000-000000000004'
const REVISION = '00000000-0000-7000-8000-000000000005'

const built = (value: BuiltWaterfall | unknown[]): BuiltWaterfall => {
  if (Array.isArray(value)) throw new Error(JSON.stringify(value))
  return value
}

describe('the waterfall (SAL-174, SAL-175)', () => {
  it('goes list → break → option → discount → manual net → size surcharge → NET, adding up', () => {
    const result = built(
      buildWaterfall({
        start: { kind: 'LIST', unitPrice: '435', source: { type: 'PriceListEntry', id: ENTRY }, label: 'SEED-PL-P1 version 2' },
        breakStep: { delta: '-10', source: { type: 'PriceBreak', id: BREAK }, label: 'From 10 pieces' },
        options: [{ optionId: OPTION, label: 'Thermal liner', amount: '60', pct: null }],
        discount: { pct: '5', reasonCode: 'VOLUME' },
        net: { unitPrice: '460', reasonCode: 'COMPETITION', note: 'Matched the price offered elsewhere.' },
        sizeCharges: [{ surchargeId: SURCHARGE, size: '56', added: '20' }],
        currency: 'EUR',
      }),
    )
    expect(result.steps.map((step) => [step.kind, step.delta ?? null, step.unitPrice ?? null])).toEqual([
      ['LIST', null, '435'],
      ['BREAK', '-10', '425'],
      ['OPTION', '60', '485'],
      ['DISCOUNT', '-24.25', '460.75'],
      ['MANUAL', '-0.75', '460'],
      ['SIZE_SURCHARGE', null, null],
      ['NET', null, '460'],
    ])
    expect(result.unitPrice).toBe('460')
    expect(result.sizePrices).toEqual({ '56': '480' })
    expect(result.adjustmentReason).toBe('COMPETITION')
    expect(stepsProblem(result.steps, '460', '435')).toBeNull()
  })

  it('leaves out a change of 0 and a manual net equal to the running price', () => {
    const result = built(buildWaterfall({ start: { kind: 'LIST', unitPrice: '400', source: { type: 'PriceListEntry', id: ENTRY } }, options: [{ optionId: OPTION, label: 'Default armour', amount: null, pct: null }], net: { unitPrice: '400', reasonCode: 'OTHER' }, currency: 'EUR' }))
    expect(result.steps.map((step) => step.kind)).toEqual(['LIST', 'NET'])
    expect(result.adjustmentReason).toBeNull()
  })

  it('puts an option on a consumer basis (VAT included) so the steps still add up', () => {
    const onBasis = (net: string) => listPriceOnBasis(net, 'GROSS', '22.00')
    const toNet = (gross: string) => String((Number(gross) * 100) / 122)
    const result = built(buildWaterfall({ start: { kind: 'LIST', unitPrice: onBasis('100'), source: { type: 'PriceListEntry', id: ENTRY } }, options: [{ optionId: OPTION, label: 'Liner', amount: '10', pct: null }], onBasis, toNet, currency: 'EUR' }))
    expect(result.steps[0]!.unitPrice).toBe('122')
    expect(result.steps[1]!.delta).toBe('12.2')
    expect(result.unitPrice).toBe('134.2')
    expect(stepsProblem(result.steps, '134.2', '122')).toBeNull()
  })

  it('a typed start and a manual net name their reason code', () => {
    expect(buildWaterfall({ start: { kind: 'MANUAL', unitPrice: '300' }, currency: 'EUR' })).toEqual([{ path: 'body/startReasonCode', message: 'A typed starting price names its reason code (SAL-175).' }])
    const typed = built(buildWaterfall({ start: { kind: 'MANUAL', unitPrice: '300', reasonCode: 'GOODWILL' }, currency: 'EUR' }))
    expect(typed.steps).toEqual([{ kind: 'MANUAL', unitPrice: '300', reasonCode: 'GOODWILL' }, { kind: 'NET', unitPrice: '300' }])
    expect(typed.adjustmentReason).toBe('GOODWILL')
    expect(buildWaterfall({ start: { kind: 'LIST', unitPrice: '300', source: { type: 'PriceListEntry', id: ENTRY } }, net: { unitPrice: '290', reasonCode: 'lower' }, currency: 'EUR' })).toEqual([{ path: 'body/net/reasonCode', message: 'A manual net names its reason code (SAL-175).' }])
  })

  it('checks a stored waterfall as the database does', () => {
    const steps: WaterfallStep[] = [
      { kind: 'LIST', unitPrice: '430', source: { type: 'PriceListEntry', id: ENTRY } },
      { kind: 'MANUAL', delta: '-10', unitPrice: '420', reasonCode: 'VOLUME' },
      { kind: 'NET', unitPrice: '420' },
    ]
    expect(stepsProblem(steps, '420', '430')).toBeNull()
    expect(stepsProblem(steps, '421', '430')).toBe("NET 420 is not the line's unit price 421")
    expect(stepsProblem(steps, '420', '440')).toBe("step 1 (LIST) starts at 430, not at the line's list price 440")
    expect(stepsProblem([steps[0], { kind: 'MANUAL', delta: '-10', unitPrice: '420' }, steps[2]], '420', null)).toBe('step 2: a manual change of the price names its reason code (SAL-175)')
    expect(stepsProblem([steps[0], { kind: 'MANUAL', delta: '-10', unitPrice: '419', reasonCode: 'VOLUME' }, steps[2]], '420', null)).toBe('step 2 (MANUAL): 430 - 10 makes 420, not 419')
    expect(stepsProblem([steps[0], { kind: 'NET', unitPrice: '430', extra: 1 } as never], '430', null)).toMatch(/does not know/)
    expect(stepsProblem([{ kind: 'BREAK', delta: '-1', unitPrice: '1', source: { type: 'PriceBreak', id: BREAK } }, steps[2]], '420', null)).toMatch(/^the waterfall starts with LIST/)
    expect(stepsProblem('nope', '1', null)).toBe('the waterfall is a list of steps')
  })

  it('says why this price, in words', () => {
    const steps: WaterfallStep[] = [
      { kind: 'LIST', unitPrice: '430', source: { type: 'PriceListEntry', id: ENTRY }, label: 'SEED-PL-P1, version 1' },
      // As a seed or an older writer stores it: six places, said at the currency's two.
      { kind: 'MANUAL', delta: '-10.000000', unitPrice: '420.000000', reasonCode: 'VOLUME' },
      { kind: 'SIZE_SURCHARGE', sizes: { '56': '20' }, source: { type: 'SizeSurcharge', id: SURCHARGE }, label: 'Size 56' },
      { kind: 'NET', unitPrice: '420' },
    ]
    const why = explainWaterfall(steps, 'EUR', (code) => (code === 'VOLUME' ? 'Volume' : null))
    expect(why.sentence).toBe('List price (SEED-PL-P1, version 1) 430.00; Manual change (Volume) − 10.00 = 420.00; Size surcharge (Size 56): size 56 + 20.00; Net 420.00.')
    expect(why.rows.map((row) => [row.kind, row.amount])).toEqual([
      ['LIST', '430'],
      ['MANUAL', '-10.000000'],
      ['SIZE_SURCHARGE', null],
      ['NET', '420'],
    ])
  })
})

describe('a price from the cost (SAL-173)', () => {
  it('earns at least the margin asked: cost ÷ (1 − margin), rounded up to the cent', () => {
    expect(suggestedPriceOf({ unitCost: '300', marginPct: '25', currency: 'EUR' })).toEqual({ unitPrice: '400', netUnitPrice: '400', marginPct: '25' })
    expect(suggestedPriceOf({ unitCost: '301.333333', marginPct: '20', currency: 'EUR' })).toEqual({ unitPrice: '376.67', netUnitPrice: '376.67', marginPct: '20' })
    expect(suggestedPriceOf({ unitCost: '100', marginPct: '20', currency: 'EUR', onBasis: (net) => listPriceOnBasis(net, 'GROSS', '22.00') })).toEqual({ unitPrice: '152.5', netUnitPrice: '125', marginPct: '20' })
  })
  it('says why there is none', () => {
    expect(suggestedPriceOf({ unitCost: null, marginPct: '20', currency: 'EUR' })).toEqual({ problem: 'The line has no complete cost yet: a price is suggested once its cost sheet is complete.' })
    expect(suggestedPriceOf({ unitCost: '100', marginPct: '100', currency: 'EUR' })).toEqual({ problem: 'The margin to earn is from 0 to below 100 percent, at most 4 decimals.' })
  })
  it('starts a waterfall from the revision it was costed from', () => {
    const result = built(buildWaterfall({ start: { kind: 'SUGGESTED', unitPrice: '400', source: { type: 'StyleRevision', id: REVISION } }, discount: { pct: '2.5' }, currency: 'EUR' }))
    expect(result.steps.map((step) => [step.kind, step.unitPrice])).toEqual([
      ['SUGGESTED', '400'],
      ['DISCOUNT', '390'],
      ['NET', '390'],
    ])
    expect(result.adjustmentReason).toBeNull()
  })
})

describe('the margin floor of the person quoting (SAL-189)', () => {
  const floors = { sales: '25.0000', owner: '10.0000' }
  it('is the lowest floor of their listed roles, else the company floor', () => {
    expect(floorFor(floors, ['sales'], '20')).toEqual({ marginFloorPct: '25', source: 'ROLE', roleKey: 'sales' })
    expect(floorFor(floors, ['owner', 'sales'], '20')).toEqual({ marginFloorPct: '10', source: 'ROLE', roleKey: 'owner' })
    expect(floorFor(floors, ['planner'], '20')).toEqual({ marginFloorPct: '20', source: 'COMPANY', roleKey: null })
    expect(floorFor(null, ['sales'], '20')).toEqual({ marginFloorPct: '20', source: 'COMPANY', roleKey: null })
  })
  it('asks a step-up only when a change lets more quotes through', () => {
    expect(lowersAFloor(floors, { ...floors, sales: '22' }, '20')).toBe(true)
    expect(lowersAFloor(floors, { ...floors, sales: '30' }, '20')).toBe(false)
    expect(lowersAFloor(null, { finance: '15' }, '20')).toBe(true)
    expect(lowersAFloor(null, { finance: '35' }, '20')).toBe(false)
    expect(lowersAFloor(floors, { owner: '10.0000' }, '20')).toBe(true)
    expect(lowersAFloor(floors, { sales: '25' }, '20')).toBe(false)
  })
  it('checks floors as typed', () => {
    expect(floorsProblems({ sales: '25', owner: '101', 'Bad Key': '5' }).map((issue) => issue.path)).toEqual(['body/floors/owner', 'body/floors/Bad Key'])
    expect(floorsProblems(null)).toEqual([])
  })
  it('holds the version to it: the floor rule breaks under the role floor, not under the company floor', () => {
    const line = { seq: 10, unitPrice: '100', listUnitPrice: null, sizes: [{ size: '52', quantity: 10, unitPrice: null }], costAmount: 78_000 }
    const treatment = taxable(22)
    const company = priceVersion({ basis: 'NET', currency: 'EUR', treatment, lines: [line], depositPct: null, rules: { marginFloorPct: '20', discountLimitPct: '15' } })
    const sales = priceVersion({ basis: 'NET', currency: 'EUR', treatment, lines: [line], depositPct: null, rules: { marginFloorPct: '25', discountLimitPct: '15', marginFloorRole: 'sales' } })
    expect(company.marginFloorBreached).toBe(false)
    expect(sales.marginFloorBreached).toBe(true)
    expect(sales.marginFloorRole).toBe('sales')
  })
})

describe('fees (SAL-181)', () => {
  it('a fee line sells its own pieces at its own price, with a cost of 0', () => {
    const treatment = taxable(22)
    const priced = priceVersion({
      basis: 'NET',
      currency: 'EUR',
      treatment,
      lines: [
        { seq: 10, unitPrice: '470', listUnitPrice: null, sizes: [{ size: '52', quantity: 8, unitPrice: null }], costAmount: 300_000 },
        { seq: 20, unitPrice: '500', listUnitPrice: null, sizes: [], costAmount: 0, quantity: 1 },
      ],
      depositPct: null,
      rules: { marginFloorPct: '20', discountLimitPct: '15' },
    })
    expect(priced.lines.map((line) => [line.seq, line.quantity, line.netAmount, line.marginPct])).toEqual([
      [10, 8, 376_000, '20.2128'],
      [20, 1, 50_000, '100'],
    ])
    expect(priced.netAmount).toBe(426_000)
    expect(isPriced({ unitPrice: '0', sizes: [] })).toBe(false)
    expect(isPriced({ unitPrice: '500', sizes: [] })).toBe(true)
  })
  it('checks a fee as typed', () => {
    expect(feeProblems({ feeKind: 'DEVELOPMENT', unitPrice: '0', quantity: 0 }).map((issue) => issue.path)).toEqual(['body/unitPrice', 'body/quantity'])
    expect(feeProblems({ feeKind: 'SAMPLE', unitPrice: '150', quantity: 2 })).toEqual([])
  })
  it('never holds the order back: nothing of it to ship, the totals and states the goods only', () => {
    const progress = orderProgress({
      lines: [
        { id: 'goods', seq: 10, quantity: 2, sizes: [{ size: '52', quantity: 2 }] },
        { id: 'fee', seq: 20, quantity: 1, sizes: [] },
      ],
      inWorkOrders: [],
      released: [{ lineId: 'goods', size: '52', quantity: 2 }],
      shipped: [{ lineId: 'goods', size: '52', quantity: 2 }],
      invoiced: [],
      fees: new Set(['fee']),
    })
    expect(progress.shipped).toBe('ALL')
    expect(progress.released).toBe(true)
    expect(progress.totals.ordered).toBe(2)
    expect(progress.rows.find((row) => row.lineId === 'fee')).toMatchObject({ ordered: 1, toShip: 0, shipped: 0 })
  })
})
