import { describe, expect, it } from 'vitest'
import type { BomLineData } from '../../product/bom/rules'
import type { EffectFacts } from '../../product/options/rules'
import type { CostingMaterial } from '../inputs'
import { changesProblems, entryEffect, orderLineEffect, priceChangePct, stableJson } from '../mass-update/rules'
import { alterationProblems, alterationSteps, mtmCostOf, scaledLines } from '../mtm-cost/rules'
import { chosenTotal, configured, optionCosts, typedDeltaProblems, type GarmentWithOptions, type OptionValueCostFacts } from '../option-cost/rules'
import { componentsOf, type ComponentFacts } from '../sheet-components/components'
import { splitBySize } from '../sheet-components/split'
import { rolledLineOf } from './rules'

/**
 * Cost in depth (B-W2b-423) on a made-up jacket in sizes 50 and 52: a lining of 2 m (2.2 m in 52) at 3.00 per m, sewing 50
 * minutes at 0.40 per minute (100 %), no overhead, no uplift, no packaging — so 26.00 a garment in 50 (6.00 + 20.00; 28.00 with a
 * trim of 2.00 on the configurable one). A removable
 * liner sub-assembly at 12.50 a piece; options: a panel (0.5 m of lining + an operation of 10 minutes), a trim (its own BOM line
 * of 1 piece at 2.00, 5 typed minutes), a typed material delta (7.50 EUR, with a lining left out), one in USD. Every figure by hand.
 */

const ID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`
const CO = ID(1)
const STYLE = ID(2)
const CW = ID(3)
const LIN = ID(10)
const TRIM = ID(11)
const LINER = ID(12)
const L1 = ID(20)
const L2 = ID(21)
const L3 = ID(22)
const L4 = ID(23)
const SEW = ID(30)
const OP_PANEL = ID(31)
const V = { PANEL: ID(40), TRIM: ID(41), TYPED: ID(42), USD: ID(43) }
const G = ID(50)

const PCS = { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' } as const
const M = { baseUom: 'M', purchaseUom: 'M', purchaseFactor: '1', consumptionUom: 'M', consumptionFactor: '1' } as const
const material = (over: Partial<CostingMaterial> & Pick<CostingMaterial, 'id' | 'code' | 'kind' | 'units'>): CostingMaterial => ({ name: over.code, standardCost: null, currency: 'EUR', priceAsOf: null, ...over })
const MATERIALS = new Map<string, CostingMaterial>([
  [LIN, material({ id: LIN, code: 'LIN', kind: 'LINING', standardCost: '3', units: M })],
  [TRIM, material({ id: TRIM, code: 'TRIM', kind: 'TRIM', standardCost: '2', units: PCS })],
  // A component we make: no standard price (W1 would list it missing); the roll-up costs it.
  [LINER, material({ id: LINER, code: 'LINER', kind: 'COMPONENT', standardCost: null, units: PCS })],
])
const bomLine = (over: Partial<BomLineData> & Pick<BomLineData, 'id' | 'seq' | 'itemId' | 'qty' | 'uom'>): BomLineData => ({
  placement: null,
  wastagePct: '0',
  sizeDependent: false,
  colourDependent: false,
  itemColourId: null,
  colourwayId: null,
  supplierId: null,
  note: null,
  sizes: [],
  colours: [],
  ...over,
})
const LINING = bomLine({ id: L1, seq: 10, itemId: LIN, qty: '2', uom: 'M', sizeDependent: true, sizes: [{ size: '50', qty: '2' }, { size: '52', qty: '2.2' }] })

const facts = (over: Partial<ComponentFacts> = {}): ComponentFacts => ({
  currency: 'EUR',
  companyId: CO,
  on: '2026-11-14',
  styleId: STYLE,
  sizes: ['50', '52'],
  colourwayId: CW,
  lines: [LINING],
  materials: MATERIALS,
  steps: [{ id: ID(60), seq: 10, operationId: SEW, code: 'SEW', name: 'Sew', workCentreKind: 'SEWING', standardMinutes: '50' }],
  subcontracts: new Map(),
  workshops: new Map(),
  rates: [{ id: ID(70), companyId: null, workCentreKind: 'SEWING', costPerMinute: '0.4', currency: 'EUR', plannedEfficiencyPct: '100', validFrom: '2026-01-01', status: 'ACTIVE' }],
  ratesWithOverhead: new Set(),
  overheadRules: [],
  settingsOverhead: null,
  leatherBases: [],
  gradeShares: new Map(),
  uplifts: [],
  pieceRate: { on: false, siteId: null, problem: null, candidates: [] },
  packaging: { defaults: [], types: new Map(), sizeScaleId: null, sizeSeqs: new Map() },
  piecesPerCarton: null,
  ...over,
})
const totalOf = (components: ReturnType<typeof componentsOf>, sizes: readonly string[], size: string) => splitBySize(components.lines, sizes, components.missing).find((entry) => entry.size === size)!

describe('the multi-level roll-up (FIN-019, KS4:02)', () => {
  const target = { styleId: ID(80), code: 'SEED-LNR', styleStatus: 'ACTIVE' as const, revisionId: ID(81), revision: 2, status: 'RELEASED' as const, sizes: ['50', '52'], colourways: [{ id: ID(82), code: 'BLK', status: 'ACTIVE' as const }], outputQuantity: 1, outputUom: 'PCS' as const }
  const costs = new Map([
    ['50', { size: '50', categories: [], knownTotal: '12.5', total: '12.5', missing: [] }],
    ['52', { size: '52', categories: [], knownTotal: '9', total: null, missing: ['No rate.'] }],
  ])

  it('costs a sub-assembly line at the sub-assembly own cost per batch, size by size, and says what cannot be rolled up', () => {
    const rolled = rolledLineOf({ line: { id: L2, seq: 40, uom: 'PCS', itemCode: 'LINER' }, units: PCS, target, parentSizes: ['50', '52'], parentColourwayCode: 'BLK', costs })
    expect(rolled.colourway).toEqual({ id: ID(82), code: 'BLK' })
    expect(rolled.bySize.get('50')).toEqual({ ok: true, subSize: '50', batchesPerBaseUnit: '1', perBatch: '12.5', perBaseUnit: '12.5' })
    expect(rolled.bySize.get('52')).toMatchObject({ ok: false, code: 'INCOMPLETE' })
    const red = rolledLineOf({ line: { id: L2, seq: 40, uom: 'PCS', itemCode: 'LINER' }, units: PCS, target, parentSizes: ['50'], parentColourwayCode: 'RED', costs: new Map([['50', costs.get('50')!]]) })
    // The only active colourway serves any parent colourway.
    expect(red.bySize.get('50')).toMatchObject({ ok: true })
    const two = rolledLineOf({ line: { id: L2, seq: 40, uom: 'PCS', itemCode: 'LINER' }, units: PCS, target: { ...target, colourways: [...target.colourways, { id: ID(83), code: 'WHT', status: 'ACTIVE' as const }] }, parentSizes: ['50'], parentColourwayCode: 'RED', costs })
    expect(two.bySize.get('50')).toMatchObject({ ok: false, code: 'COLOURWAY' })
  })

  it('writes the rolled line as a MATERIAL line of the component, never at a standard price and never with overhead on it again', () => {
    const rolled = rolledLineOf({ line: { id: L2, seq: 40, uom: 'PCS', itemCode: 'LINER' }, units: PCS, target, parentSizes: ['50', '52'], parentColourwayCode: 'BLK', costs })
    const withLiner = facts({
      lines: [LINING, bomLine({ id: L2, seq: 40, itemId: LINER, qty: '2', uom: 'PCS' })],
      rolledUp: new Map([[L2, rolled]]),
      settingsOverhead: { id: ID(90), companyId: CO, overheadPct: '10', updatedAt: '2026-11-01T00:00:00.000Z' },
    })
    const result = componentsOf(withLiner)
    const liner = result.lines.filter((line) => line.sourceRecordId === L2)
    expect(liner).toHaveLength(1)
    expect(liner[0]).toMatchObject({ category: 'MATERIAL', source: 'BOM_LINE', itemId: LINER, size: '50', quantity: '2', uom: 'PCS', unitCost: '12.5', cost: '25' })
    expect(result.missing.map((entry) => entry.code)).toEqual(['SUB_ASSEMBLY_COST'])
    expect(result.missing[0]).toMatchObject({ size: '52', recordId: L2 })
    // Overhead 10 % on the lining (6.00) and the labour (20.00) only: 2.60, not on the liner's 25.00.
    const overhead = result.lines.find((line) => line.category === 'OVERHEAD' && line.size === '50') ?? result.lines.find((line) => line.category === 'OVERHEAD')
    expect(overhead?.cost).toBe('2.6')
    expect(totalOf(result, ['50', '52'], '50').total).toBe('53.6')
  })
})

describe("an option's own cost (FIN-018, KS4:01)", () => {
  const effect = (over: Partial<EffectFacts> & Pick<EffectFacts, 'id' | 'valueId' | 'kind'>): EffectFacts => ({
    itemId: null,
    itemColourId: null,
    targetItemId: null,
    qty: null,
    uom: null,
    sizeQuantities: null,
    section: null,
    operationId: null,
    minutes: null,
    priceDelta: null,
    currency: null,
    pricePct: null,
    note: null,
    ...over,
  })
  const garment: GarmentWithOptions = {
    facts: facts({ lines: [LINING, bomLine({ id: L4, seq: 20, itemId: TRIM, qty: '1', uom: 'PCS' }), bomLine({ id: L3, seq: 30, itemId: TRIM, qty: '1', uom: 'PCS' })] }),
    parts: { lines: new Map([[L3, V.TRIM]]), steps: new Map() },
    effects: [
      effect({ id: ID(100), valueId: V.PANEL, kind: 'BOM_ADD', itemId: LIN, qty: '0.5', uom: 'M' }),
      effect({ id: ID(101), valueId: V.PANEL, kind: 'OPERATION_ADD', operationId: OP_PANEL, minutes: '10' }),
      effect({ id: ID(102), valueId: V.PANEL, kind: 'PRICE', priceDelta: '20', currency: 'EUR' }),
      effect({ id: ID(103), valueId: V.TYPED, kind: 'BOM_REMOVE', targetItemId: LIN }),
    ],
    operations: new Map([[OP_PANEL, { id: OP_PANEL, code: 'PANEL', name: 'Set a panel', workCentreKind: 'SEWING', standardMinutes: '8' }]]),
  }
  const value = (id: string, code: string, over: Partial<OptionValueCostFacts> = {}): OptionValueCostFacts => ({ id, groupId: G, code, name: code, materialDelta: null, materialDeltaCurrency: null, minutesDelta: null, ...over })
  const values = [value(V.PANEL, 'PANEL'), value(V.TRIM, 'TRIM', { minutesDelta: '5' }), value(V.TYPED, 'TYPED', { materialDelta: '7.5', materialDeltaCurrency: 'EUR' }), value(V.USD, 'USD', { materialDelta: '3', materialDeltaCurrency: 'USD' })]

  it('leaves the option-only parts out of the garment without options', () => {
    const none = configured(garment, new Set())
    expect(none.facts.lines.map((line) => line.id)).toEqual([L1, L4])
    expect(totalOf(componentsOf(none.facts), ['50', '52'], '50').total).toBe('28')
  })

  it('costs each value against the garment without options; a typed delta takes the place of its part', () => {
    const { values: costs } = optionCosts(garment, values)
    const at = (id: string, size: string) => costs.find((cost) => cost.valueId === id)!.bySize.find((entry) => entry.size === size)!
    // The panel: 0.5 m × 3.00 = 1.50 material; 10 minutes × 0.40 = 4.00 making.
    expect(at(V.PANEL, '50')).toEqual({ size: '50', material: '1.5', making: '4', total: '5.5' })
    // The trim: its own line 2.00; its 5 typed minutes at the garment's 0.40 a minute = 2.00.
    expect(at(V.TRIM, '52')).toEqual({ size: '52', material: '2', making: '2', total: '4' })
    expect(costs.find((cost) => cost.valueId === V.TRIM)).toMatchObject({ material: { source: 'DERIVED' }, making: { source: 'TYPED', minutesTyped: '5' } })
    // Typed 7.50 replaces the lining left out (−6.00 / −6.60).
    expect(at(V.TYPED, '52')).toEqual({ size: '52', material: '7.5', making: '0', total: '7.5' })
    // Another currency: not converted, said.
    const usd = costs.find((cost) => cost.valueId === V.USD)!
    expect(usd.complete).toBe(false)
    expect(usd.missing.join(' ')).toContain('USD')
    expect(chosenTotal(costs, [V.PANEL, V.TRIM], ['50', '52'])).toEqual(new Map([['50', '9.5'], ['52', '9.5']]))
    expect(chosenTotal(costs, [V.PANEL, V.USD], ['50']).get('50')).toBeNull()
  })

  it('refuses a typed delta the database would refuse, in words', () => {
    expect(typedDeltaProblems({ materialDelta: '0', materialDeltaCurrency: 'EUR', minutesDelta: null }).map((issue) => issue.path)).toEqual(['materialDelta'])
    expect(typedDeltaProblems({ materialDelta: '5', materialDeltaCurrency: null, minutesDelta: '20000' }).map((issue) => issue.path)).toEqual(['materialDeltaCurrency', 'minutesDelta'])
    expect(typedDeltaProblems({ materialDelta: '-2.5', materialDeltaCurrency: 'EUR', minutesDelta: '-1.5' })).toEqual([])
  })
})

describe("a made-to-measure unit's cost (FIN-017)", () => {
  it('adds the scaled lines, the alteration minutes and the options to the base size', () => {
    const base = facts()
    const scaled = scaledLines(base.lines, [{ lineId: L1, baseQty: '2', unitQty: '2.2', scaled: { pointCode: 'chest' } }], '50')
    expect(scaled.scaled).toBe(1)
    expect(scaled.lines[0]!.sizes).toEqual([{ size: '50', qty: '2.2' }, { size: '52', qty: '2.2' }])
    const scaledFacts = { ...base, lines: scaled.lines }
    const altered = { ...scaledFacts, steps: [...scaledFacts.steps, ...alterationSteps([{ workCentreKind: 'SEWING', minutes: '15' }])] }
    const cost = mtmCostOf({ sizes: base.sizes, baseSize: '50', base: componentsOf(base), scaled: componentsOf(scaledFacts), altered: componentsOf(altered), options: '3', optionMissing: [] })
    // 26.00 + 0.2 m × 3.00 + 15 minutes × 0.40 + 3.00
    expect(cost).toMatchObject({ baseSize: '50', base: '26', extraMaterial: '0.6', alteration: '6', options: '3', total: '35.6', complete: true })
    expect(mtmCostOf({ sizes: base.sizes, baseSize: '50', base: componentsOf(base), scaled: componentsOf(base), altered: componentsOf(base), options: null, optionMissing: ['x'] })).toMatchObject({ total: null, complete: false, missing: ['x'] })
    expect(alterationProblems([{ workCentreKind: 'SEWING', minutes: '0' }]).map((issue) => issue.path)).toEqual(['alterations/0/minutes'])
  })
})

describe('the mass cost update (FIN-022)', () => {
  it('checks the changes and works out the effect on margins by hand', () => {
    expect(changesProblems([]).map((issue) => issue.path)).toEqual(['changes'])
    expect(changesProblems([{ itemId: LIN, newPrice: '3.3' }, { itemId: LIN, newPrice: 'x' }]).map((issue) => issue.path)).toEqual(['changes/1/itemId', 'changes/1/newPrice'])
    expect(priceChangePct('4', '4.4')).toBe('10')
    expect(entryEffect('100', '60', '5')).toEqual({ costBefore: '60', costAfter: '65', marginBefore: '40', marginAfter: '35', marginMove: '-5' })
    // 100.00 net, 60.00 cost; 2 pieces of 50 at +1.50 and 1 of 52 at +2.00: +5.00.
    expect(orderLineEffect({ currency: 'EUR' as never, net: 10000, cost: 6000, pieces: [{ size: '50', quantity: 2 }, { size: '52', quantity: 1 }], delta: new Map([['50', '1.5'], ['52', '2']]) })).toEqual({
      costMove: 500,
      costAfter: 6500,
      marginBefore: '40',
      marginAfter: '35',
      marginMove: '-5',
    })
    expect(orderLineEffect({ currency: 'EUR' as never, net: 10000, cost: 6000, pieces: [{ size: '54', quantity: 1 }], delta: new Map([['50', '1.5']]) }).costAfter).toBeNull()
    expect(stableJson({ b: 1, a: [{ d: null, c: '2' }] })).toBe('{"a":[{"c":"2","d":null}],"b":1}')
  })
})
