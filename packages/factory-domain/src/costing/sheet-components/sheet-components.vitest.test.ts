import { describe, expect, it } from 'vitest'
import type { RateCandidate } from '../../people/earnings/rules'
import type { BomLineData } from '../../product/bom/rules'
import type { OverheadRuleFacts } from '../overhead-rules/rules'
import type { CostingMaterial, LabourRate } from '../inputs'
import { componentsOf, numbered, type ComponentFacts } from './components'
import { databaseComponentRefusal } from './refusals'
import { gradeMixOf, landedPct, leatherBasisProblems, leatherKey, pickLeatherBasis, pickMaterialUplift, pickWorkshopUplift, pieceRateSite, upliftFigureProblems, upliftKey, usableFactor, type LeatherBasisFacts, type UpliftFacts } from './rules'
import { ledgerGroupOf, splitBySize, workOrderSplit } from './split'

/**
 * The cost sheet's components (B-W2b-418) on a made-up jacket in sizes 50 and 52: leather 40 / 44 ft² net at 4.00 per ft²
 * (BOM wastage 10 %), bought with an 80 % yield and the mix A 50 / B 50 (usable 90 % and 70 %: 80 % usable), so 62.5 / 68.75
 * ft²; a lining 2 m with 5 % waste at 3.00; cutting 10 minutes at 0.50, sewing 50 minutes at 0.40 ÷ 80 %; an embroidery a
 * workshop does at 2.50 per piece with 0.80 out and 0.70 back; leather freight 3 % and insurance 0.5 %, linings freight 5 %; a
 * polybag 0.05 and a carton 1.20 for 12 garments; overhead 20 % of labour and 2.00 per garment. Every figure worked by hand.
 */

const ID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`
const CO = ID(1)
const STYLE = ID(2)
const CW = ID(3)
const LEA = ID(10)
const LIN = ID(11)
const L1 = ID(20)
const L2 = ID(21)
const OP = { CUT: ID(30), SEW: ID(31), EMB: ID(32) }
const STEP = { CUT: ID(40), SEW: ID(41), EMB: ID(42) }
const WORKSHOP = ID(50)
const ON = '2026-11-14'

const material = (over: Partial<CostingMaterial> & Pick<CostingMaterial, 'id' | 'code' | 'kind' | 'units'>): CostingMaterial => ({ name: over.code, standardCost: null, currency: 'EUR', priceAsOf: null, ...over })
const MATERIALS = new Map<string, CostingMaterial>([
  [LEA, material({ id: LEA, code: 'LEA', kind: 'LEATHER', standardCost: '4', units: { baseUom: 'FT2', purchaseUom: 'FT2', purchaseFactor: '1', consumptionUom: 'FT2', consumptionFactor: '1' } })],
  [LIN, material({ id: LIN, code: 'LIN', kind: 'LINING', standardCost: '3', units: { baseUom: 'M', purchaseUom: 'M', purchaseFactor: '1', consumptionUom: 'M', consumptionFactor: '1' } })],
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
const LINES = [
  bomLine({ id: L1, seq: 10, itemId: LEA, qty: '42', uom: 'FT2', wastagePct: '10', sizeDependent: true, sizes: [{ size: '50', qty: '40' }, { size: '52', qty: '44' }] }),
  bomLine({ id: L2, seq: 20, itemId: LIN, qty: '2', uom: 'M', wastagePct: '5' }),
]
const rate = (id: number, kind: LabourRate['workCentreKind'], costPerMinute: string, plannedEfficiencyPct = '100'): LabourRate => ({ id: ID(id), companyId: null, workCentreKind: kind, costPerMinute, currency: 'EUR', plannedEfficiencyPct, validFrom: '2026-01-01', status: 'ACTIVE' })
const basis = (over: Partial<LeatherBasisFacts>): LeatherBasisFacts => ({ id: ID(60), companyId: null, itemId: LEA, styleId: null, areaUnit: 'FT2', expectedYieldPct: '80', gradeMix: { A: '50', B: '50' }, validFrom: '2026-01-01', status: 'ACTIVE', ...over })
const uplift = (over: Partial<UpliftFacts> & Pick<UpliftFacts, 'id' | 'target'>): UpliftFacts => ({
  companyId: null,
  itemId: null,
  itemKind: null,
  partyId: null,
  source: 'TYPED',
  freightPct: null,
  dutyPct: null,
  insurancePct: null,
  transportOutPerPiece: null,
  transportBackPerPiece: null,
  currency: null,
  validFrom: '2026-01-01',
  status: 'ACTIVE',
  ...over,
})
const rule = (over: Partial<OverheadRuleFacts> & Pick<OverheadRuleFacts, 'id' | 'basis' | 'value'>): OverheadRuleFacts => ({ companyId: null, workCentreKind: null, currency: null, periodStart: '2026-01-01', periodEnd: null, status: 'ACTIVE', ...over })
const P = { BAG: ID(70), CARTON: ID(71) }

const facts = (over: Partial<ComponentFacts> = {}): ComponentFacts => ({
  currency: 'EUR',
  companyId: CO,
  on: ON,
  styleId: STYLE,
  sizes: ['50', '52'],
  colourwayId: CW,
  lines: LINES,
  materials: MATERIALS,
  steps: [
    { id: STEP.CUT, seq: 10, operationId: OP.CUT, code: 'CUT', name: 'Cut panels', workCentreKind: 'CUTTING', standardMinutes: '10' },
    { id: STEP.SEW, seq: 20, operationId: OP.SEW, code: 'SEW', name: 'Sew body', workCentreKind: 'SEWING', standardMinutes: '50' },
    { id: STEP.EMB, seq: 30, operationId: OP.EMB, code: 'EMB', name: 'Embroider logo', workCentreKind: 'SEWING', standardMinutes: '5' },
  ],
  subcontracts: new Map([[STEP.EMB, { supplierId: WORKSHOP, pricePerPiece: '2.5' }]]),
  workshops: new Map([[WORKSHOP, { id: WORKSHOP, name: 'Made-up Embroidery', termsInForce: false }]]),
  rates: [rate(80, 'CUTTING', '0.5'), rate(81, 'SEWING', '0.4', '80')],
  ratesWithOverhead: new Set(),
  overheadRules: [rule({ id: ID(90), companyId: CO, basis: 'PERCENT_OF_LABOUR', value: '20' }), rule({ id: ID(91), basis: 'PER_UNIT', value: '2', currency: 'EUR' })],
  settingsOverhead: null,
  leatherBases: [basis({})],
  gradeShares: new Map([[LEA, { grades: new Map([['A', '90'], ['B', '70']]), itemRules: new Map() }]]),
  uplifts: [
    uplift({ id: ID(100), companyId: CO, target: 'MATERIAL', itemId: LEA, freightPct: '3', dutyPct: '0', insurancePct: '0.5' }),
    uplift({ id: ID(101), target: 'CATEGORY', itemKind: 'LINING', freightPct: '5' }),
    uplift({ id: ID(102), companyId: CO, target: 'WORKSHOP', partyId: WORKSHOP, transportOutPerPiece: '0.8', transportBackPerPiece: '0.7', currency: 'EUR' }),
  ],
  pieceRate: { on: false, siteId: null, problem: null, candidates: [] },
  packaging: {
    defaults: [
      { id: ID(110), packagingTypeId: P.BAG, kind: 'POLYBAG', styleId: STYLE, sizeScaleId: null, fromSeq: null, toSeq: null },
      { id: ID(111), packagingTypeId: P.CARTON, kind: 'CARTON', styleId: STYLE, sizeScaleId: null, fromSeq: null, toSeq: null },
    ],
    types: new Map([
      [P.BAG, { id: P.BAG, name: 'Polybag', kind: 'POLYBAG', costPerUnit: '0.05', costCurrency: 'EUR' }],
      [P.CARTON, { id: P.CARTON, name: 'Export carton', kind: 'CARTON', costPerUnit: '1.2', costCurrency: 'EUR' }],
    ]),
    sizeScaleId: null,
    sizeSeqs: new Map(),
  },
  piecesPerCarton: 12,
  ...over,
})

const brief = (lines: ReturnType<typeof componentsOf>['lines']) => lines.map((line) => [line.category, line.source, line.size, line.quantity, line.unitCost, line.cost, line.pct])

describe('the components of a cost sheet', () => {
  it('cost every component, write a line once for every size when it is the same, and split each size by category', () => {
    const { lines, missing, warnings } = componentsOf(facts())
    expect(missing).toEqual([])
    expect(brief(lines)).toEqual([
      // Leather: 40 ÷ (0.8 × 0.8) = 62.5 ft², 44 ÷ 0.64 = 68.75 ft² at 4.00 (the yield replaces the 10 % wastage).
      ['LEATHER', 'BOM_LINE', '50', '62.5', '4', '250', null],
      ['LEATHER', 'BOM_LINE', '52', '68.75', '4', '275', null],
      // Lining: 2 × 1.05 = 2.1 m at 3.00, the same in every size.
      ['MATERIAL', 'BOM_LINE', null, '2.1', '3', '6.3', null],
      // Labour: 10 min × 0.50; 50 min × 0.40 ÷ 80 % = 0.50 a minute (the workshop's step is no labour here).
      ['LABOUR', 'ROUTING', null, '10', '0.5', '5', null],
      ['LABOUR', 'ROUTING', null, '50', '0.5', '25', null],
      // The workshop: its fee and one visit there and back.
      ['SUBCONTRACT', 'ROUTING', null, '1', '2.5', '2.5', null],
      ['SUBCONTRACT', 'UPLIFT', null, '1', '0.8', '0.8', null],
      ['SUBCONTRACT', 'UPLIFT', null, '1', '0.7', '0.7', null],
      // Freight 3 % and insurance 0.5 % on the leather of each size; 5 % on the lining.
      ['FREIGHT', 'UPLIFT', '50', '1', '7.5', '7.5', '3'],
      ['FREIGHT', 'UPLIFT', '52', '1', '8.25', '8.25', '3'],
      ['FREIGHT', 'UPLIFT', '50', '1', '1.25', '1.25', '0.5'],
      ['FREIGHT', 'UPLIFT', '52', '1', '1.375', '1.375', '0.5'],
      ['FREIGHT', 'UPLIFT', null, '1', '0.315', '0.315', '5'],
      // A polybag and 1.20 ÷ 12 of the carton.
      ['PACKAGING', 'PACKAGING', null, '1', '0.05', '0.05', null],
      ['PACKAGING', 'PACKAGING', null, '1', '0.1', '0.1', null],
      // 20 % of 5.00 and of 25.00; 2.00 a garment (the every-kind per-garment rule once, not per kind).
      ['OVERHEAD', 'OVERHEAD_RULE', null, '1', '1', '1', '20'],
      ['OVERHEAD', 'OVERHEAD_RULE', null, '1', '5', '5', '20'],
      ['OVERHEAD', 'OVERHEAD_RULE', null, '1', '2', '2', null],
    ])
    expect(lines[0]!.note).toMatch(/80 % yield × 80 % usable by the grade mix A 50 \/ B 50/)
    expect(warnings.map((warning) => warning.code)).toEqual(['NO_WRITTEN_TERMS'])
    const split = splitBySize(lines, ['50', '52'], missing)
    // 250 + 6.3 + 30 + 4 + 7.5 + 1.25 + 0.315 + 0.15 + 8; 275 + 6.3 + 30 + 4 + 8.25 + 1.375 + 0.315 + 0.15 + 8.
    expect(split.map((size) => [size.size, size.total, size.complete])).toEqual([
      ['50', '307.515', true],
      ['52', '333.39', true],
    ])
    expect(split[0]!.categories).toEqual([
      { category: 'MATERIAL', amount: '6.3' },
      { category: 'LEATHER', amount: '250' },
      { category: 'LABOUR', amount: '30' },
      { category: 'OVERHEAD', amount: '8' },
      { category: 'SUBCONTRACT', amount: '4' },
      { category: 'FREIGHT', amount: '9.065' },
      { category: 'PACKAGING', amount: '0.15' },
    ])
    expect(numbered(lines.slice(0, 3), new Set([20])).map((line) => line.seq)).toEqual([10, 30, 40])
  })

  it('without a basis, leather keeps the BOM area with its wastage and says so; without a rule, overhead is the settings percent', () => {
    const { lines, warnings } = componentsOf(facts({ leatherBases: [], overheadRules: [], settingsOverhead: { id: ID(120), companyId: null, overheadPct: '10', updatedAt: null } }))
    expect(brief(lines).slice(0, 2)).toEqual([
      ['LEATHER', 'BOM_LINE', '50', '44', '4', '176', null],
      ['LEATHER', 'BOM_LINE', '52', '48.4', '4', '193.6', null],
    ])
    expect(warnings.map((warning) => warning.code)).toContain('NO_LEATHER_BASIS')
    // 10 % of (176 + 6.3 + 30) and of (193.6 + 6.3 + 30).
    expect(brief(lines.filter((line) => line.category === 'OVERHEAD'))).toEqual([
      ['OVERHEAD', 'COSTING_SETTINGS', '50', '1', '21.23', '21.23', '10'],
      ['OVERHEAD', 'COSTING_SETTINGS', '52', '1', '22.99', '22.99', '10'],
    ])
  })

  it('cost an operation at its piece rate when it has one in every size; the others by their minutes, with words', () => {
    const candidate: RateCandidate = { entryId: ID(130), operationId: OP.CUT, sizeBand: 'ALL', ratePerPiece: '4.2', standardMinutes: null, currency: 'EUR', status: 'PUBLISHED', effectiveFrom: '2026-11-01', effectiveTo: null, styleId: null, lineId: null }
    const { lines, warnings } = componentsOf(facts({ pieceRate: { on: true, siteId: ID(140), problem: null, candidates: [candidate] } }))
    const labour = lines.filter((line) => line.category === 'LABOUR' || line.category === 'OVERHEAD')
    expect(brief(labour)).toEqual([
      ['LABOUR', 'PIECE_RATE', null, '1', '4.2', '4.2', null],
      ['LABOUR', 'ROUTING', null, '50', '0.5', '25', null],
      // 20 % of the piece rate 4.20 = 0.84.
      ['OVERHEAD', 'OVERHEAD_RULE', null, '1', '0.84', '0.84', '20'],
      ['OVERHEAD', 'OVERHEAD_RULE', null, '1', '5', '5', '20'],
      ['OVERHEAD', 'OVERHEAD_RULE', null, '1', '2', '2', null],
    ])
    expect(labour[0]!.sourceRecordType).toBe('PieceRateEntry')
    expect(warnings.map((warning) => warning.code)).toContain('NO_PIECE_RATE')
    // Piece-rate labour on, but several sites pay: named in words, every step by its minutes.
    const several = componentsOf(facts({ pieceRate: { on: true, siteId: null, problem: 'SEVERAL_SITES', candidates: [] } }))
    expect(several.warnings.map((warning) => warning.code)).toContain('PIECE_RATE_SITE')
    expect(several.lines.filter((line) => line.source === 'PIECE_RATE')).toEqual([])
  })

  it('list what is missing in words and leave its lines out (never a 0)', () => {
    const { lines, missing } = componentsOf(
      facts({
        rates: [rate(80, 'CUTTING', '0.5')],
        subcontracts: new Map([[STEP.EMB, { supplierId: WORKSHOP, pricePerPiece: null }]]),
        piecesPerCarton: null,
        overheadRules: [rule({ id: ID(92), companyId: CO, basis: 'PER_MACHINE_HOUR', value: '3', currency: 'EUR', workCentreKind: 'CUTTING' })],
      }),
    )
    expect(missing.map((entry) => entry.code)).toEqual(['LABOUR_RATE', 'SUBCONTRACT_FEE', 'CARTON_PIECES', 'OVERHEAD_FIGURE'])
    expect(missing.every((entry) => !/\d+\.\d/.test(entry.message))).toBe(true)
    expect(lines.some((line) => line.workCentreKind === 'SEWING' && line.category === 'LABOUR')).toBe(false)
    expect(splitBySize(lines, ['50', '52'], missing).every((size) => size.total === null && !size.complete)).toBe(true)
  })
})

describe('the inputs the components read', () => {
  it('choose the most specific basis and uplift in force, and work the usable share of a grade mix', () => {
    const own = basis({ id: ID(61), companyId: CO, styleId: STYLE, validFrom: '2026-06-01' })
    const later = basis({ id: ID(62), validFrom: '2026-12-01' })
    const archived = basis({ id: ID(63), companyId: CO, status: 'ARCHIVED' })
    expect(pickLeatherBasis([basis({}), own, later, archived], LEA, STYLE, CO, ON)?.id).toBe(ID(61))
    expect(pickLeatherBasis([basis({}), later, archived], LEA, STYLE, CO, ON)?.id).toBe(ID(60))
    expect(pickLeatherBasis([later], LEA, STYLE, CO, ON)).toBeNull()
    expect(usableFactor({ A: '70', B: '30' }, { grades: new Map([['A', '85'], ['B', '72']]), itemRules: new Map([['A', '88']]) }).factor?.toFixed(4)).toBe('0.8320')
    expect(usableFactor({ Z: '100' }, { grades: new Map(), itemRules: new Map() })).toMatchObject({ factor: null, unknown: ['Z'] })
    const uplifts = facts().uplifts
    expect(pickMaterialUplift(uplifts, { itemId: LEA, kind: 'LEATHER' }, CO, ON)?.id).toBe(ID(100))
    expect(pickMaterialUplift(uplifts, { itemId: LIN, kind: 'LINING' }, CO, ON)?.id).toBe(ID(101))
    expect(pickMaterialUplift(uplifts, { itemId: LEA, kind: 'LEATHER' }, ID(9), ON)).toBeNull()
    expect(pickWorkshopUplift(uplifts, WORKSHOP, CO, ON)?.id).toBe(ID(102))
  })

  it('check a basis and an uplift in words, build their keys, read a landed percent', () => {
    expect(leatherBasisProblems({ expectedYieldPct: '0', gradeMix: { A: '60', B: '30' } }).map((problem) => problem.path)).toEqual(['body/expectedYieldPct', 'body/gradeMix'])
    expect(leatherBasisProblems({ expectedYieldPct: '82.5', gradeMix: { A: '70.5', B: '29.5' } })).toEqual([])
    expect(gradeMixOf({ a: '60', b: '40' })).toEqual({ A: '60.0000', B: '40.0000' })
    expect(leatherKey(LEA, null, CO)).toBe(`leather:${LEA}:all:${CO}`)
    expect(upliftKey(null, { target: 'CATEGORY', itemKind: 'TRIM' })).toBe('uplift:all:kind:TRIM')
    expect(upliftFigureProblems('WORKSHOP', { freightPct: '3' }).map((problem) => problem.path)).toEqual(['body/freightPct', 'body/transportOutPerPiece', 'body/currency'])
    expect(upliftFigureProblems('MATERIAL', { freightPct: '101' }).map((problem) => problem.path)).toEqual(['body/freightPct'])
    expect(upliftFigureProblems('MATERIAL', { freightPct: '3', dutyPct: '4.25' })).toEqual([])
    expect(landedPct(1234, 50000)).toBe('2.468')
    expect(landedPct(10, 0)).toBeNull()
    expect(pieceRateSite([ID(1)], null)).toEqual({ siteId: ID(1), problem: null })
    expect(pieceRateSite([ID(1), ID(2)], null).problem).toBe('SEVERAL_SITES')
    expect(pieceRateSite([ID(1)], ID(2)).problem).toBe('NOT_PAYING')
  })

  it('read the database’s refusals back in words', () => {
    expect(databaseComponentRefusal(`costing: the lines of cost sheet ${ID(5)} are written only while it is a DRAFT (an approved sheet is locked: a change is a new version)`)).toEqual({
      code: 'NOT_DRAFT',
      message: 'The lines of cost sheet are written only while it is a DRAFT (an approved sheet is locked: a change is a new version).',
    })
    expect(databaseComponentRefusal('costing: piece-rate labour is switched on only for a company with piece pay ON at one of its sites (GATE-PIECE-PAY)')?.code).toBe('PIECE_PAY_OFF')
    expect(databaseComponentRefusal(`costing: overhead rule ${ID(5)} overlaps another active rule`)).toBeNull()
  })
})

describe('the split from the sheet through the actuals to the margin', () => {
  it('plan a work order by category, compare it with its ledger by kind and name the margin part', () => {
    const { lines } = componentsOf(facts())
    expect(ledgerGroupOf('PACKAGING', 'BOM_LINE')).toBe('MATERIAL')
    expect(ledgerGroupOf('PACKAGING', 'PACKAGING')).toBe('NONE')
    const split = workOrderSplit(
      [{ size: '50', quantity: 2, lines }, { size: '52', quantity: 1, lines }],
      [
        { kind: 'MATERIAL', amount: 80000, itemKind: 'LEATHER' },
        { kind: 'MATERIAL', amount: 2000, itemKind: 'LINING' },
        { kind: 'SCRAP', amount: 500, itemKind: 'LEATHER' },
        { kind: 'LABOUR', amount: 9500, itemKind: null },
        { kind: 'OVERHEAD', amount: 2000, itemKind: null },
        { kind: 'COMPLETION', amount: -90000, itemKind: null },
      ],
      'EUR',
    )
    const planned = Object.fromEntries(split.groups.map((group) => [group.ledgerGroup, [group.planned, group.actual, group.marginPart]]))
    // Material: leather 2 × 250 + 275 = 775, lining 3 × 6.30 = 18.90, freight 2 × 9.065 + 9.94 = 28.07 → 821.97.
    expect(planned.MATERIAL).toEqual([82197, 82500, 'MATERIAL'])
    expect(planned.LABOUR).toEqual([9000, 9500, 'LABOUR'])
    // Overhead 3 × 8.00; outside operations 3 × 4.00; the packaging master's 3 × 0.15 on no ledger.
    expect(planned.OVERHEAD).toEqual([2400, 2000, 'OVERHEAD'])
    expect(planned.SUBCONTRACT).toEqual([1200, 0, 'SUBCONTRACT'])
    expect(planned.NONE).toEqual([45, 0, null])
    expect(split.materialActual).toEqual({ leather: 80500, material: 2000, packaging: 0 })
    expect([split.planned, split.actual, split.difference, split.notOnLedger]).toEqual([94797, 94000, -797, 45])
  })
})
