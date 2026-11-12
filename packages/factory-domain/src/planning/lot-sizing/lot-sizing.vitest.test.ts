import { describe, expect, it } from 'vitest'
import { decimalOf } from '../../product/units/units'
import type { BomLineData } from '../../product/bom/rules'
import { planRequirements, type PlanInput, type PlanItem, type PlanOrderLine } from '../explode'
import { proposeWork, type OpenCell } from '../planned-orders/rules'
import { lotRuleOf, lotsWords, needsOfPegging, nextLotOf, plannedLots, type LotRule } from './lots'
import { changedRules, EMPTY_ITEM_RULES, itemRuleProblems, itemRuleWords, mergeItemRules, scrapYieldFactor } from './parameters'
import { planLevelOf, sizeSplitByLevel } from './plan-level'
import { withScrapYield } from './scrap'
import { mergeSizeRun, sizeRunProblems } from './size-run'

/**
 * The planning rules per item (B-W2b-318; PLN-006 lot sizing, PLN-008 plan level, PLN-081 scrap and yield, PLN-068's
 * size-run setting). Every code and number is made up.
 */

const rule = (fields: Partial<LotRule> & Pick<LotRule, 'lotSizing'>): LotRule => ({ fixedLotQty: null, lotPeriodDays: null, minOrderQty: null, orderMultiple: null, maxOrderQty: null, ...fields })
const needs = [
  { day: '2026-11-20', quantity: '120' },
  { day: '2026-11-24', quantity: '80' },
  { day: '2026-12-05', quantity: '300' },
]
const brief = (lots: ReturnType<typeof plannedLots>) => lots.map((lot) => `${lot.date} ${lot.quantity}`)

describe('lot sizing (PLN-006): the net need by day becomes the orders the plan suggests', () => {
  it('lot for lot is one order of the whole need on the first day short (W1)', () => {
    expect(brief(plannedLots(null, needs))).toEqual(['2026-11-20 500.0000'])
    expect(plannedLots(null, [])).toEqual([])
  })

  it('FIXED orders lots of the fixed quantity as the days use them up; what a lot leaves stays for the next days', () => {
    const lots = plannedLots(rule({ lotSizing: 'FIXED', fixedLotQty: '150.0000' }), needs)
    expect(brief(lots)).toEqual(['2026-11-20 150.0000', '2026-11-24 150.0000', '2026-12-05 150.0000', '2026-12-05 150.0000'])
    expect(lots.reduce((sum, lot) => sum + Number(lot.quantity), 0)).toBe(600)
    expect(lots[0]!.covers).toEqual({ from: '2026-11-20', to: '2026-11-23' })
  })

  it('MIN_MAX orders as much of what is still to come as the maximum allows, at least the minimum, in steps', () => {
    expect(brief(plannedLots(rule({ lotSizing: 'MIN_MAX', minOrderQty: '600.0000' }), needs))).toEqual(['2026-11-20 600.0000'])
    expect(brief(plannedLots(rule({ lotSizing: 'MIN_MAX', maxOrderQty: '200.0000', orderMultiple: '50.0000' }), needs))).toEqual(['2026-11-20 200.0000', '2026-12-05 200.0000', '2026-12-05 100.0000'])
  })

  it('PERIOD orders the need of each period from the first day short', () => {
    const lots = plannedLots(rule({ lotSizing: 'PERIOD', lotPeriodDays: 7 }), needs)
    expect(brief(lots)).toEqual(['2026-11-20 200.0000', '2026-12-05 300.0000'])
    expect(lots[0]!.covers).toEqual({ from: '2026-11-20', to: '2026-11-26' })
  })

  it('reads a row only with the ORDERS method and its number; the run suggests the next lot', () => {
    const row = { method: 'ORDERS', lotSizing: 'FIXED', fixedLotQty: '150', lotPeriodDays: null, minOrderQty: null, orderMultiple: null, maxOrderQty: null }
    expect(lotRuleOf(row)).toMatchObject({ lotSizing: 'FIXED', fixedLotQty: '150.0000' })
    expect(lotRuleOf({ ...row, method: 'REORDER_POINT' })).toBeNull()
    expect(lotRuleOf({ ...row, lotSizing: 'LOT_FOR_LOT' })).toBeNull()
    expect(lotRuleOf({ ...row, lotSizing: 'MIN_MAX' })).toBeNull()
    expect(lotRuleOf({ ...row, lotSizing: 'PERIOD', lotPeriodDays: 14 })).toMatchObject({ lotSizing: 'PERIOD', lotPeriodDays: 14 })
    const coverage = needs.map((need) => ({ day: need.day, short: need.quantity, uncovered: '0', supplies: [], part: {} as never }))
    expect(needsOfPegging({ coverage })).toEqual([
      { day: '2026-11-20', quantity: '120.0000' },
      { day: '2026-11-24', quantity: '80.0000' },
      { day: '2026-12-05', quantity: '300.0000' },
    ])
    expect(needsOfPegging({ coverage }, 'UNCOVERED')).toEqual([])
    expect(nextLotOf(lotRuleOf(row), { coverage })).toBe('150.0000')
    expect(nextLotOf(null, { coverage })).toBeNull()
    expect(lotsWords(lotRuleOf(row), plannedLots(lotRuleOf(row), needs), 'FT2')).toMatch(/^4 orders in fixed lots of 150.0000 FT2: 150.0000 FT2 on 2026-11-20/)
  })
})

describe('the rules per item: exactness in words, merging, what each does', () => {
  it('says each rule the guard holds, with the field', () => {
    expect(itemRuleProblems(EMPTY_ITEM_RULES, 'LEATHER')).toEqual([])
    const paths = (values: Partial<typeof EMPTY_ITEM_RULES>, kind = 'LEATHER') => itemRuleProblems({ ...EMPTY_ITEM_RULES, ...values }, kind).map((problem) => problem.path)
    expect(paths({ lotSizing: 'FIXED' })).toEqual(['body/fixedLotQty'])
    expect(paths({ fixedLotQty: '10' })).toEqual(['body/fixedLotQty'])
    expect(paths({ lotSizing: 'PERIOD', lotPeriodDays: 400 })).toEqual(['body/lotPeriodDays'])
    expect(paths({ planLevel: 'SKU' })).toEqual(['body/planLevel'])
    expect(paths({ planLevel: 'SKU' }, 'FINISHED')).toEqual([])
    expect(paths({ scrapPct: '100' })).toEqual(['body/scrapPct'])
    expect(paths({ yieldPct: '0' })).toEqual(['body/yieldPct'])
    expect(paths({ delayDays: 367 })).toEqual(['body/delayDays'])
    expect(itemRuleProblems({ ...EMPTY_ITEM_RULES, planLevel: 'STYLE' }, 'TRIM')[0]!.message).toBe('Only a finished garment or a component is planned by style, colour or size; a material is planned per colour.')
  })

  it('a change of lot sizing clears the old method’s number it does not name; values are stored with their decimals', () => {
    const fixed = mergeItemRules(null, { lotSizing: 'FIXED', fixedLotQty: '150', scrapPct: '5' })
    expect(fixed).toEqual({ values: { ...EMPTY_ITEM_RULES, lotSizing: 'FIXED', fixedLotQty: '150.0000', scrapPct: '5.00' }, cleared: [] })
    const period = mergeItemRules(fixed.values, { lotSizing: 'PERIOD', lotPeriodDays: 14 })
    expect(period).toEqual({ values: { ...EMPTY_ITEM_RULES, lotSizing: 'PERIOD', lotPeriodDays: 14, scrapPct: '5.00' }, cleared: ['fixedLotQty'] })
    expect(changedRules(fixed.values, period.values)).toEqual(['lotSizing', 'fixedLotQty', 'lotPeriodDays'])
  })

  it('says what the rules do', () => {
    const facts = { method: 'ORDERS', itemKind: 'LEATHER', uom: 'FT2', minOrderQty: null, orderMultiple: null, maxOrderQty: null }
    const words = itemRuleWords({ ...EMPTY_ITEM_RULES, lotSizing: 'FIXED', fixedLotQty: '150.0000', scrapPct: '5.00', yieldPct: '90.00', delayDays: 2 }, facts)
    expect(words.lotSizing).toBe('Each order brings 150 FT2, as many as the need takes.')
    expect(words.scrapYield).toBe('The need is multiplied by 1.1667 (5 % scrap, 90 % yield), on top of the BOM’s wastage.')
    expect(words.delay).toMatch(/^2 days between arrival and use/)
    expect(itemRuleWords({ ...EMPTY_ITEM_RULES, lotSizing: 'FIXED', fixedLotQty: '150.0000' }, { ...facts, method: 'MIN_MAX' }).lotSizing).toMatch(/read only when the item is planned by its orders/)
    expect(itemRuleWords(EMPTY_ITEM_RULES, facts)).toEqual({ lotSizing: null, planLevel: null, scrapYield: null, delay: null })
  })
})

describe('scrap and yield on top of the BOM’s wastage (PLN-081)', () => {
  const LEATHER = { baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'FT2', consumptionFactor: '1' } as const
  const items: PlanItem[] = [{ id: 'leather', code: 'LEA-100', sourcing: 'BUY', units: LEATHER, defaultSupplierId: 'tannery' }]
  const bomLine: BomLineData = { id: 'bl-10', seq: 10, itemId: 'leather', qty: '50', uom: 'FT2', placement: null, wastagePct: '10', sizeDependent: false, colourDependent: false, itemColourId: null, colourwayId: null, supplierId: null, note: null, sizes: [], colours: [] }
  const line: PlanOrderLine = { orderId: 'so-1', orderNumber: 'SO-1', orderLineId: 'ol-1', lineSeq: 10, styleId: 'style-1', colourwayId: 'cw-blk', revisionId: 'rev-1', sizes: [{ size: '52', pieces: 3 }], dueDate: '2026-12-01', partyId: 'party-1' }
  const input = (fields: Partial<PlanInput> = {}): PlanInput => ({ runDate: '2026-11-01', orderLines: [line], revisions: [{ id: 'rev-1', lines: [bomLine] }], items, workOrderCells: [], workOrderIssues: [], stock: [], lots: [], purchases: [], ...fields })

  it('is (1 + scrap) ÷ yield; none or 1 changes nothing', () => {
    expect(scrapYieldFactor('5', '90')!.toFixed(6)).toBe('1.166667')
    expect(scrapYieldFactor(null, null)).toBeNull()
    expect(scrapYieldFactor('0.00', '100.00')).toBeNull()
    const need = { itemId: 'leather', itemColourId: null, quantity: decimalOf('55'), lineIds: ['bl-10'] }
    expect(withScrapYield(undefined, line, '52', [need])).toEqual([need])
  })

  it('multiplies the material’s need (its own factor and its garment’s) before the run rounds; none: W1 exactly', () => {
    const plain = planRequirements(input())
    expect(plain.requirements[0]).toMatchObject({ grossQuantity: '165.0000', suggestedQuantity: '4.0000', suggestedUom: 'HIDE' })
    const scrapped = planRequirements(input({ scrapYield: { itemFactor: (itemId) => (itemId === 'leather' ? scrapYieldFactor('10', null) : null), garmentFactor: () => scrapYieldFactor(null, '50') } }))
    // 50 ft² × 1.1 (BOM wastage) × 1.1 (the leather's scrap) ÷ 0.5 (the garment's yield) × 3 = 363.
    expect(scrapped.requirements[0]).toMatchObject({ grossQuantity: '363.0000', netQuantity: '363.0000', suggestedQuantity: '7.0000' })
  })

  it('lot sizing sizes the run’s suggestion: the next lot, then the supplier’s rounding', () => {
    const plan = planRequirements(input({ lotSizing: () => rule({ lotSizing: 'FIXED', fixedLotQty: '400.0000' }) }))
    // 165 ft² short → one lot of 400 ft² → 7.62 hides → 8 whole hides.
    expect(plan.requirements[0]).toMatchObject({ netQuantity: '165.0000', suggestedQuantity: '8.0000', suggestedUom: 'HIDE' })
  })
})

describe('plan by style, colour or size (PLN-008)', () => {
  const line = (fields: Partial<PlanOrderLine> = {}): PlanOrderLine => ({ orderId: 'so-1', orderNumber: 'SO-1', orderLineId: 'ol-1', lineSeq: 10, styleId: 'jkt', colourwayId: 'blk', revisionId: 'rev-1', sizes: [], dueDate: '2026-12-01', ...fields })
  const cells = (planLevel: PlanOrderLine['planLevel']): OpenCell[] =>
    ['48', '50', '52'].map((size, sizeIndex) => ({ line: line(planLevel ? { planLevel } : {}), ownRevisionId: null, size, sizeIndex, pieces: 2 }))
  const propose = (planLevel: PlanOrderLine['planLevel'], rule: 'ONE_GRID' | 'SIZE_GROUPS' = 'SIZE_GROUPS') =>
    proposeWork({ cells: cells(planLevel), runDate: '2026-11-12', rule, groups: [['48', '50'], ['52', '54']], sizesOf: () => ['48', '50', '52', '54'], outsideOf: () => null }).map((row) => `${row.sizeGroup ?? 'grid'}:${row.sizes.map((size) => size.size).join('/')}`)

  it('SKU makes each size an order; STYLE_COLOUR and STYLE one grid; none follows the site’s size-run rule', () => {
    expect(propose(null)).toEqual(['48-50:48/50', '52-54:52'])
    expect(propose('SKU')).toEqual(['48:48', '50:50', '52:52'])
    expect(propose('STYLE_COLOUR')).toEqual(['grid:48/50/52'])
    expect(propose('STYLE')).toEqual(['grid:48/50/52'])
    expect(sizeSplitByLevel(null, ['48'])).toBeNull()
  })

  it('the finest level set on a colourway’s SKUs wins', () => {
    expect(planLevelOf([null, 'STYLE', 'STYLE_COLOUR'])).toBe('STYLE_COLOUR')
    expect(planLevelOf(['STYLE_COLOUR', 'SKU'])).toBe('SKU')
    expect(planLevelOf([null, undefined])).toBeNull()
  })
})

describe('the size-run setting (PLN-068)', () => {
  it('one grid keeps no groups; size groups are 2-20 groups, each code in one group', () => {
    expect(sizeRunProblems({ sizeRunRule: 'ONE_GRID', sizeGroups: [] })).toEqual([])
    expect(sizeRunProblems({ sizeRunRule: 'SIZE_GROUPS', sizeGroups: [['48', '50'], ['52']] })).toEqual([])
    expect(sizeRunProblems({ sizeRunRule: 'ONE_GRID', sizeGroups: [['48']] }).map((problem) => problem.path)).toEqual(['body/sizeGroups'])
    expect(sizeRunProblems({ sizeRunRule: 'SIZE_GROUPS', sizeGroups: [['48']] }).map((problem) => problem.path)).toEqual(['body/sizeGroups'])
    expect(sizeRunProblems({ sizeRunRule: 'SIZE_GROUPS', sizeGroups: [['48', '50'], ['50']] })[0]!.message).toBe('Size 50 is in two groups: a size is in one group only.')
    expect(sizeRunProblems({ sizeRunRule: 'SIZE_GROUPS', sizeGroups: [['4 8'], ['50']] })[0]!.path).toBe('body/sizeGroups/0')
  })

  it('switching to one grid clears the groups it does not name', () => {
    expect(mergeSizeRun({ sizeRunRule: 'SIZE_GROUPS', sizeGroups: [['48'], ['50']] }, { sizeRunRule: 'ONE_GRID' })).toEqual({ sizeRunRule: 'ONE_GRID', sizeGroups: [] })
    expect(mergeSizeRun({ sizeRunRule: 'SIZE_GROUPS', sizeGroups: [['48'], ['50']] }, {})).toEqual({ sizeRunRule: 'SIZE_GROUPS', sizeGroups: [['48'], ['50']] })
  })
})
