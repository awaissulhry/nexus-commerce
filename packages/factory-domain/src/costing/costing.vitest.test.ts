import { describe, expect, it } from 'vitest'
import type { BomLineData } from '../product/bom/rules'
import type { CostCellView } from './contracts'
import { diffCostCells } from './diff'
import { pickOverhead, pickRate, type CostingMaterial, type LabourRate, type OverheadRule } from './inputs'
import { labourRateMachine, overheadProblems, rateProblems } from './rates'
import { costSheet, exactCell, exactCells, prepareSheet, quantityCost, type CostFacts, type CostingStep } from './sheet'

/**
 * The style cost sheet (B-W1-16; FIN-001, FIN-002, FIN-004), on a made-up jacket like the product seed's: leather in ft²
 * per size with 12 % waste at 4.20/ft² (bought by the 52.5 ft² hide), a lining at 3.10/m with 5 % waste, two
 * protectors at 6.50; cut 14, sew 96.5, inspect 8, pack 3.5 minutes; made-up rates per kind of work centre; 10 %
 * overhead. Every expected figure is worked out by hand in the test.
 */

const CW = { BLK: '00000000-0000-7000-8000-0000000000b1', RED: '00000000-0000-7000-8000-0000000000b2' }
const CO = { A: '00000000-0000-7000-8000-00000000c0a1', B: '00000000-0000-7000-8000-00000000c0b1' }
const ITEM = { LEA: '00000000-0000-7000-8000-0000000001ea', LIN: '00000000-0000-7000-8000-00000000011e', PRO: '00000000-0000-7000-8000-0000000001f0' }
const LINE = { LEA: '00000000-0000-7000-8000-000000000010', LIN: '00000000-0000-7000-8000-000000000020', PRO: '00000000-0000-7000-8000-000000000030' }

const material = (over: Partial<CostingMaterial> & Pick<CostingMaterial, 'id' | 'code' | 'kind'>): CostingMaterial => ({
  name: over.code,
  units: { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' },
  standardCost: null,
  currency: 'EUR',
  priceAsOf: '2026-10-01T08:00:00.000Z',
  ...over,
})
const MATERIALS = new Map<string, CostingMaterial>([
  [ITEM.LEA, material({ id: ITEM.LEA, code: 'LEA', kind: 'LEATHER', standardCost: '4.2', units: { baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'FT2', consumptionFactor: '1' } })],
  [ITEM.LIN, material({ id: ITEM.LIN, code: 'LIN', kind: 'LINING', standardCost: '3.1', units: { baseUom: 'M', purchaseUom: 'ROLL', purchaseFactor: '50', consumptionUom: 'M', consumptionFactor: '1' } })],
  [ITEM.PRO, material({ id: ITEM.PRO, code: 'PRO', kind: 'PROTECTOR', standardCost: '6.5' })],
])

const line = (over: Partial<BomLineData> & Pick<BomLineData, 'id' | 'seq' | 'itemId' | 'qty' | 'uom'>): BomLineData => ({
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
const LINES: BomLineData[] = [
  line({
    id: LINE.LEA,
    seq: 10,
    itemId: ITEM.LEA,
    qty: '45',
    uom: 'FT2',
    wastagePct: '12',
    sizeDependent: true,
    sizes: [
      { size: '50', qty: '43' },
      { size: '52', qty: '45' },
      { size: '54', qty: '47.5' },
    ],
    colourDependent: true,
    colours: [
      { colourwayId: CW.BLK, itemColourId: '00000000-0000-7000-8000-00000000c010' },
      { colourwayId: CW.RED, itemColourId: '00000000-0000-7000-8000-00000000c011' },
    ],
  }),
  line({ id: LINE.LIN, seq: 20, itemId: ITEM.LIN, qty: '1.8', uom: 'M', wastagePct: '5' }),
  line({ id: LINE.PRO, seq: 30, itemId: ITEM.PRO, qty: '2', uom: 'PCS' }),
]
const STEPS: CostingStep[] = [
  { id: '00000000-0000-7000-8000-0000000005c1', workCentreKind: 'CUTTING', standardMinutes: '14' },
  { id: '00000000-0000-7000-8000-0000000005c2', workCentreKind: 'SEWING', standardMinutes: '96.5' },
  { id: '00000000-0000-7000-8000-0000000005c3', workCentreKind: 'INSPECTION', standardMinutes: '8' },
  { id: '00000000-0000-7000-8000-0000000005c4', workCentreKind: 'PACKING', standardMinutes: '3.5' },
]
let rateSeq = 0
const rate = (over: Partial<LabourRate> & Pick<LabourRate, 'workCentreKind' | 'costPerMinute'>): LabourRate => ({
  id: `00000000-0000-7000-8000-0000000000${String(++rateSeq).padStart(2, '0')}`,
  companyId: null,
  currency: 'EUR',
  plannedEfficiencyPct: '100',
  validFrom: '2026-01-01',
  status: 'ACTIVE',
  ...over,
})
const RATES: LabourRate[] = [
  rate({ workCentreKind: 'CUTTING', costPerMinute: '0.5' }),
  rate({ workCentreKind: 'SEWING', costPerMinute: '0.4', plannedEfficiencyPct: '80' }),
  rate({ workCentreKind: 'INSPECTION', costPerMinute: '0.45' }),
  rate({ workCentreKind: 'PACKING', costPerMinute: '0.3' }),
]
const OVERHEAD: OverheadRule = { id: '00000000-0000-7000-8000-0000000000e1', companyId: null, overheadPct: '10', updatedAt: '2026-10-02T08:00:00.000Z' }

const FACTS: CostFacts = {
  currency: 'EUR',
  companyId: CO.A,
  on: '2026-10-29',
  sizes: ['50', '52', '54'],
  colourwayIds: [CW.BLK, CW.RED],
  lines: LINES,
  materials: MATERIALS,
  steps: STEPS,
  rates: RATES,
  overheads: [OVERHEAD],
}
const with_ = (over: Partial<CostFacts>): CostFacts => ({ ...FACTS, ...over })
const cellOf = (sheet: ReturnType<typeof costSheet>, colourwayId: string, size: string) => sheet.cells.find((cell) => cell.colourwayId === colourwayId && cell.size === size)!

describe('the cost per garment of each size (FIN-001, FIN-002, FIN-004)', () => {
  // Labour, the same in every size: cut 14 × 0.50 = 7; sew 96.5 × 0.40 ÷ 0.80 = 48.25; inspect 8 × 0.45 = 3.60;
  // pack 3.5 × 0.30 = 1.05; together 59.90.
  // Size 52: leather 45 × 1.12 = 50.4 ft² × 4.20 = 211.68; lining 1.8 × 1.05 = 1.89 m × 3.10 = 5.859; protectors 2 × 6.50
  // = 13; material 230.539; + labour 59.90 = 290.439; overhead 10 % = 29.0439; cost 319.4829.
  // Size 50: leather 43 × 1.12 = 48.16 × 4.20 = 202.272; material 221.131; 281.031 × 1.1 = 309.1341.
  // Size 54: leather 47.5 × 1.12 = 53.2 × 4.20 = 223.44; material 242.299; 302.199 × 1.1 = 332.4189.
  const sheet = costSheet(FACTS)

  it('adds material from the BOM by size, labour from the minutes and overhead, for every colourway × size', () => {
    expect(sheet.complete).toBe(true)
    expect(sheet.missing).toEqual([])
    expect(sheet.cells.map((cell) => [cell.colourwayId === CW.BLK ? 'BLK' : 'RED', cell.size, cell.total])).toEqual([
      ['BLK', '50', '309.1341'],
      ['BLK', '52', '319.4829'],
      ['BLK', '54', '332.4189'],
      ['RED', '50', '309.1341'],
      ['RED', '52', '319.4829'],
      ['RED', '54', '332.4189'],
    ])
    const cell = cellOf(sheet, CW.BLK, '52')
    expect(cell).toMatchObject({ complete: true, missing: [], minutes: '122', knownTotal: '319.4829', total: '319.4829' })
    expect(cell.material).toMatchObject({ complete: true, amount: '230.539' })
    expect(cell.material.byCategory).toEqual([
      { category: 'LEATHER', complete: true, amount: '211.68' },
      { category: 'MATERIALS', complete: true, amount: '18.859' },
    ])
    expect(cell.material.lines.map((entry) => [entry.code, entry.qty, entry.uom, entry.baseQuantity, entry.baseUom, entry.unitCost, entry.amount])).toEqual([
      ['LEA', '45', 'FT2', '50.4', 'FT2', '4.2', '211.68'],
      ['LIN', '1.8', 'M', '1.89', 'M', '3.1', '5.859'],
      ['PRO', '2', 'PCS', '2', 'PCS', '6.5', '13'],
    ])
    expect(cell.labour).toMatchObject({ complete: true, amount: '59.9' })
    expect(cell.labour.lines.map((entry) => [entry.workCentreKind, entry.minutes, entry.costPerMinute, entry.plannedEfficiencyPct, entry.amount])).toEqual([
      ['CUTTING', '14', '0.5', '100', '7'],
      ['SEWING', '96.5', '0.4', '80', '48.25'],
      ['INSPECTION', '8', '0.45', '100', '3.6'],
      ['PACKING', '3.5', '0.3', '100', '1.05'],
    ])
    expect(cell.overhead).toEqual({ overheadPct: '10', base: '290.439', amount: '29.0439' })
  })

  it('draws the waterfall from material to the cost, each step adding up to the total', () => {
    const cell = cellOf(sheet, CW.RED, '54')
    expect(cell.waterfall.map((step) => [step.step, step.category ?? step.workCentreKind, step.amount, step.runningTotal])).toEqual([
      ['MATERIAL', 'LEATHER', '223.44', '223.44'],
      ['MATERIAL', 'MATERIALS', '18.859', '242.299'],
      ['LABOUR', 'CUTTING', '7', '249.299'],
      ['LABOUR', 'SEWING', '48.25', '297.549'],
      ['LABOUR', 'INSPECTION', '3.6', '301.149'],
      ['LABOUR', 'PACKING', '1.05', '302.199'],
      ['OVERHEAD', null, '30.2199', '332.4189'],
    ])
    expect(cell.waterfall.every((step) => step.complete)).toBe(true)
  })

  it('rounds each figure once from its exact value: an efficiency that does not divide evenly never drifts', () => {
    // Cut 14 × 0.50 ÷ 0.85 = 8.2352941176…; sew 96.5 × 0.40 ÷ 0.85 = 45.4117647058…; together 53.6470588235…;
    // with the material 230.539: 284.1860588235… → 284.186059.
    const rates = [rate({ workCentreKind: 'CUTTING', costPerMinute: '0.5', plannedEfficiencyPct: '85' }), rate({ workCentreKind: 'SEWING', costPerMinute: '0.4', plannedEfficiencyPct: '85' })]
    const cell = cellOf(costSheet(with_({ steps: STEPS.slice(0, 2), rates, overheads: [] })), CW.BLK, '52')
    expect(cell.labour.lines.map((entry) => entry.amount)).toEqual(['8.235294', '45.411765'])
    expect(cell.labour.amount).toBe('53.647059')
    expect(cell.total).toBe('284.186059')
    expect(cell.waterfall.at(-1)!.runningTotal).toBe(cell.total)
  })

  it('adds a ROUNDING step when the shown steps would not add up to the shown total', () => {
    // Three categories of 0.4 × 0.000001 = 0.0000004 each: each step shows 0, the total 0.0000012 shows 0.000001.
    const tiny = (id: string, kind: CostingMaterial['kind']) => material({ id, code: kind, kind, standardCost: '0.000001' })
    const ids = ['00000000-0000-7000-8000-0000000002a1', '00000000-0000-7000-8000-0000000002a2', '00000000-0000-7000-8000-0000000002a3']
    const materials = new Map([tiny(ids[0]!, 'LEATHER'), tiny(ids[1]!, 'LINING'), tiny(ids[2]!, 'TRIM')].map((entry) => [entry.id, entry]))
    const lines = ids.map((itemId, index) => line({ id: `00000000-0000-7000-8000-0000000003a${index}`, seq: (index + 1) * 10, itemId, qty: '0.4', uom: 'PCS' }))
    const cell = cellOf(costSheet(with_({ lines, materials, steps: STEPS.slice(0, 1), rates: [rate({ workCentreKind: 'CUTTING', costPerMinute: '0' })], overheads: [] })), CW.BLK, '50')
    expect(cell.total).toBe('0.000001')
    expect(cell.waterfall.map((step) => [step.step, step.amount, step.runningTotal])).toEqual([
      ['MATERIAL', '0', '0'],
      ['MATERIAL', '0', '0'],
      ['MATERIAL', '0', '0'],
      ['LABOUR', '0', '0'],
      ['ROUNDING', '0.000001', '0.000001'],
    ])
  })

  it('costs a hide-bought leather through its area factor, whatever unit the line is in', () => {
    // 0.5 HIDE × 52.5 ft² = 26.25 ft² × 4.20 = 110.25; 400 dm² = 4 m² = 4 ÷ 0.09290304 = 43.0556416… ft² × 4.20 = 180.8336950…
    const lines = [line({ id: LINE.LEA, seq: 10, itemId: ITEM.LEA, qty: '0.5', uom: 'HIDE' }), line({ id: LINE.LIN, seq: 20, itemId: ITEM.LEA, qty: '400', uom: 'DM2' })]
    const cell = cellOf(costSheet(with_({ lines })), CW.BLK, '52')
    expect(cell.material.lines.map((entry) => [entry.uom, entry.baseQuantity, entry.amount])).toEqual([
      ['HIDE', '26.25', '110.25'],
      ['DM2', '43.0556', '180.833695'],
    ])
    const inputs = costSheet(with_({ lines })).inputs.materials
    expect(inputs).toEqual([
      expect.objectContaining({ itemId: ITEM.LEA, source: 'STANDARD', baseUom: 'FT2', standardCost: '4.2', currency: 'EUR', asOf: '2026-10-01T08:00:00.000Z', purchaseUom: 'HIDE', standardCostPerPurchaseUnit: '220.5' }),
    ])
  })

  it('costs a colourway-only line in its colourway alone, and skips a size the line is 0 in', () => {
    const lines = [
      ...LINES,
      line({ id: '00000000-0000-7000-8000-000000000040', seq: 40, itemId: ITEM.PRO, qty: '1', uom: 'PCS', colourwayId: CW.RED }),
      line({ id: '00000000-0000-7000-8000-000000000050', seq: 50, itemId: ITEM.LIN, qty: '1', uom: 'M', sizeDependent: true, sizes: [{ size: '50', qty: '0' }, { size: '52', qty: '1' }, { size: '54', qty: '1' }] }),
    ]
    const result = costSheet(with_({ lines }))
    // RED 52: 230.539 + 6.50 (its own protector) + 3.10 (line 50) = 240.139; + 59.90 = 300.039; × 1.1 = 330.0429.
    // BLK 52: 230.539 + 3.10 = 233.639; + 59.90 = 293.539; × 1.1 = 322.8929. BLK 50: line 50 is 0 there, so 309.1341.
    expect(cellOf(result, CW.RED, '52').total).toBe('330.0429')
    expect(cellOf(result, CW.BLK, '52').total).toBe('322.8929')
    expect(cellOf(result, CW.BLK, '50').material.lines.map((entry) => entry.seq)).toEqual([10, 20, 30])
    expect(cellOf(result, CW.BLK, '50').total).toBe('309.1341')
  })
})

describe('a missing input is listed and the total is not complete, never a silent 0', () => {
  it('a material without a standard price', () => {
    const materials = new Map(MATERIALS)
    materials.set(ITEM.LIN, { ...MATERIALS.get(ITEM.LIN)!, standardCost: null })
    const sheet = costSheet(with_({ materials }))
    expect(sheet.complete).toBe(false)
    expect(sheet.missing).toEqual([
      { key: `MATERIAL_PRICE:${ITEM.LIN}`, code: 'MATERIAL_PRICE', itemId: ITEM.LIN, lineId: null, size: null, workCentreKind: null, message: 'LIN LIN has no standard purchase price.' },
    ])
    const cell = cellOf(sheet, CW.BLK, '52')
    // Known: 230.539 − 5.859 = 224.68 material; + 59.90 = 284.58; overhead on the known part 28.458; 313.038.
    expect(cell).toMatchObject({ complete: false, missing: [`MATERIAL_PRICE:${ITEM.LIN}`], total: null, knownTotal: '313.038' })
    expect(cell.material).toMatchObject({ complete: false, amount: '224.68' })
    expect(cell.material.lines[1]).toMatchObject({ code: 'LIN', baseQuantity: '1.89', unitCost: null, amount: null })
    expect(cell.material.byCategory).toContainEqual({ category: 'MATERIALS', complete: false, amount: '13' })
    expect(cell.waterfall.find((step) => step.category === 'MATERIALS')).toMatchObject({ complete: false })
    expect(cell.waterfall.find((step) => step.step === 'OVERHEAD')).toMatchObject({ complete: false })
    expect(sheet.inputs.materials.find((entry) => entry.itemId === ITEM.LIN)).toMatchObject({ standardCost: null, standardCostPerPurchaseUnit: null })
  })

  it('a material priced in another currency', () => {
    const materials = new Map(MATERIALS)
    materials.set(ITEM.PRO, { ...MATERIALS.get(ITEM.PRO)!, currency: 'USD' })
    const sheet = costSheet(with_({ materials }))
    expect(sheet.missing.map((entry) => [entry.code, entry.itemId])).toEqual([['MATERIAL_CURRENCY', ITEM.PRO]])
    expect(sheet.missing[0]!.message).toBe('PRO is priced in USD; this cost sheet is in EUR and has no exchange rate.')
    expect(sheet.cells.every((cell) => !cell.complete && cell.total === null)).toBe(true)
  })

  it('a kind of work centre without a rate, or with a rate in another currency', () => {
    const noSewing = costSheet(with_({ rates: RATES.filter((entry) => entry.workCentreKind !== 'SEWING') }))
    expect(noSewing.missing).toEqual([
      { key: 'LABOUR_RATE:SEWING', code: 'LABOUR_RATE', itemId: null, lineId: null, size: null, workCentreKind: 'SEWING', message: 'No cost per minute for SEWING work centres is in force on 2026-10-29.' },
    ])
    const cell = cellOf(noSewing, CW.BLK, '52')
    expect(cell).toMatchObject({ complete: false, total: null, missing: ['LABOUR_RATE:SEWING'] })
    expect(cell.labour).toMatchObject({ complete: false, amount: '11.65' })
    expect(cell.labour.lines[1]).toMatchObject({ workCentreKind: 'SEWING', minutes: '96.5', costPerMinute: null, amount: null })
    expect(noSewing.inputs.labour[1]).toMatchObject({ workCentreKind: 'SEWING', source: 'NONE', rateId: null, costPerMinute: null })
    expect(noSewing.cells.every((entry) => !entry.complete)).toBe(true)

    const dollars = costSheet(with_({ rates: RATES.map((entry) => (entry.workCentreKind === 'PACKING' ? { ...entry, currency: 'USD' } : entry)) }))
    expect(dollars.missing.map((entry) => entry.key)).toEqual(['LABOUR_CURRENCY:PACKING'])
  })

  it('a size-dependent line without a quantity for a size: that size alone', () => {
    const lines = [{ ...LINES[0]!, sizes: LINES[0]!.sizes.filter((entry) => entry.size !== '54') }, ...LINES.slice(1)]
    const sheet = costSheet(with_({ lines }))
    expect(sheet.missing).toEqual([
      { key: `BOM_QUANTITY:${LINE.LEA}:54`, code: 'BOM_QUANTITY', itemId: null, lineId: LINE.LEA, size: '54', workCentreKind: null, message: 'BOM line 10 (LEA) has no quantity for size 54.' },
    ])
    expect(sheet.cells.filter((cell) => !cell.complete).map((cell) => cell.size)).toEqual(['54', '54'])
    expect(cellOf(sheet, CW.BLK, '54').material.lines[0]).toMatchObject({ qty: null, baseQuantity: null, amount: null })
  })

  it('a line whose unit the material does not convert', () => {
    const lines = [line({ id: LINE.PRO, seq: 30, itemId: ITEM.PRO, qty: '1', uom: 'M' })]
    const sheet = costSheet(with_({ lines }))
    expect(sheet.missing.map((entry) => [entry.code, entry.lineId])).toEqual([['MATERIAL_UNIT', LINE.PRO]])
  })

  it('an empty BOM or an empty routing', () => {
    const empty = costSheet(with_({ lines: [], steps: [] }))
    expect(empty.missing.map((entry) => entry.code)).toEqual(['NO_BOM', 'NO_ROUTING'])
    expect(empty.cells.every((cell) => !cell.complete && cell.total === null && cell.knownTotal === '0')).toBe(true)
  })

  it('no overhead rule is no overhead line, not a missing input', () => {
    const sheet = costSheet(with_({ overheads: [] }))
    expect(sheet.complete).toBe(true)
    expect(cellOf(sheet, CW.BLK, '52')).toMatchObject({ overhead: null, total: '290.439' })
    expect(sheet.inputs.overhead).toEqual({ source: 'NONE', ruleId: null, companyId: null, overheadPct: null, updatedAt: null })
  })
})

describe('which rate and overhead apply (FIN-005)', () => {
  const tenantSew = rate({ workCentreKind: 'SEWING', costPerMinute: '0.4', validFrom: '2026-01-01' })
  const companySew = rate({ workCentreKind: 'SEWING', costPerMinute: '0.5', companyId: CO.A, validFrom: '2026-03-01' })
  const companyNext = rate({ workCentreKind: 'SEWING', costPerMinute: '0.55', companyId: CO.A, validFrom: '2026-11-01' })
  const companyOld = rate({ workCentreKind: 'SEWING', costPerMinute: '0.45', companyId: CO.A, validFrom: '2026-02-01' })
  const archived = rate({ workCentreKind: 'SEWING', costPerMinute: '0.9', companyId: CO.A, validFrom: '2026-10-01', status: 'ARCHIVED' })
  const all = [tenantSew, companySew, companyNext, companyOld, archived]

  it("the company's own rate in force wins over the tenant-wide one; a later, an older or an archived one does not", () => {
    expect(pickRate(all, 'SEWING', CO.A, '2026-10-29')).toBe(companySew)
    expect(pickRate(all, 'SEWING', CO.A, '2026-11-01')).toBe(companyNext)
    expect(pickRate(all, 'SEWING', CO.A, '2026-02-15')).toBe(companyOld)
    expect(pickRate(all, 'SEWING', CO.A, '2026-01-15')).toBe(tenantSew)
    expect(pickRate(all, 'SEWING', CO.B, '2026-10-29')).toBe(tenantSew)
    expect(pickRate(all, 'SEWING', null, '2026-10-29')).toBe(tenantSew)
    expect(pickRate(all, 'CUTTING', CO.A, '2026-10-29')).toBeNull()
    expect(pickRate(all, 'SEWING', CO.A, '2025-12-31')).toBeNull()
  })

  it("the company's overhead wins over the tenant's", () => {
    const company: OverheadRule = { ...OVERHEAD, id: '00000000-0000-7000-8000-0000000000e2', companyId: CO.A, overheadPct: '12' }
    expect(pickOverhead([OVERHEAD, company], CO.A)).toBe(company)
    expect(pickOverhead([OVERHEAD, company], CO.B)).toBe(OVERHEAD)
    expect(pickOverhead([company], null)).toBeNull()
  })

  it('names the rate it used, with its company and the day it is valid from', () => {
    const sheet = costSheet(with_({ rates: [...RATES.filter((entry) => entry.workCentreKind !== 'SEWING'), tenantSew, companySew, companyNext] }))
    expect(sheet.inputs.labour[1]).toEqual({
      workCentreKind: 'SEWING',
      steps: 1,
      minutes: '96.5',
      source: 'LABOUR_RATE',
      rateId: companySew.id,
      companyId: CO.A,
      costPerMinute: '0.5',
      currency: 'EUR',
      plannedEfficiencyPct: '100',
      validFrom: '2026-03-01',
    })
    expect(sheet.inputs.overhead).toEqual({ source: 'OVERHEAD_RULE', ruleId: OVERHEAD.id, companyId: null, overheadPct: '10', updatedAt: '2026-10-02T08:00:00.000Z' })
  })
})

describe('a quantity for a quote line (B-W1-21)', () => {
  const sheet = prepareSheet(FACTS)

  it('costs the quantity from the exact unit cost, rounded once to cents, with the minutes', () => {
    const row: CostCellView = quantityCost(exactCell(sheet, CW.BLK, '52'), 7, 'EUR')
    // 319.4829 × 7 = 2236.3803 → 223638 cents; 122 × 7 = 854 minutes.
    expect(row).toMatchObject({ quantity: 7, complete: true, unitCost: '319.4829', amount: 223638, minutes: '122', quantityMinutes: '854', materialCost: '230.539', labourCost: '59.9', overheadCost: '29.0439' })
  })

  it('rounds the amount once, from the exact unit cost × the quantity', () => {
    // Sew and cut at 85 %: unit 284.1860588235…; × 3 = 852.5581764705… → 85256 cents.
    const rates = [rate({ workCentreKind: 'CUTTING', costPerMinute: '0.5', plannedEfficiencyPct: '85' }), rate({ workCentreKind: 'SEWING', costPerMinute: '0.4', plannedEfficiencyPct: '85' })]
    const odd = prepareSheet(with_({ steps: STEPS.slice(0, 2), rates, overheads: [] }))
    expect(quantityCost(exactCell(odd, CW.BLK, '52'), 3, 'EUR')).toMatchObject({ unitCost: '284.186059', amount: 85256, quantityMinutes: '331.5' })
  })

  it('refuses a quantity whose amount no document can hold', () => {
    // 319.4829 × 999 999 ≈ 319 million: more cents than an Int holds.
    expect(() => quantityCost(exactCell(sheet, CW.BLK, '52'), 999_999, 'EUR')).toThrow('The cost of this quantity is too large for one document line.')
  })

  it('an incomplete cell has no unit cost and no amount', () => {
    // Size 50 without labour: material 221.131 + overhead 22.1131 = 243.2441 known.
    const missing = prepareSheet(with_({ rates: [] }))
    expect(quantityCost(exactCell(missing, CW.BLK, '50'), 10, 'EUR')).toMatchObject({ complete: false, unitCost: null, amount: null, knownUnitCost: '243.2441', quantityMinutes: '1220' })
  })
})

describe('two revisions compared', () => {
  it('lists the cells that changed, with the materials and minutes behind the change', () => {
    const from = exactCells(prepareSheet(FACTS))
    const lines = [{ ...LINES[0]!, sizes: LINES[0]!.sizes.map((entry) => (entry.size === '54' ? { size: '54', qty: '48' } : entry)) }, ...LINES.slice(1)]
    const steps = [...STEPS, { id: '00000000-0000-7000-8000-0000000005c5', workCentreKind: 'FINISHING' as const, standardMinutes: '5' }]
    const to = exactCells(prepareSheet(with_({ lines, steps, rates: [...RATES, rate({ workCentreKind: 'FINISHING', costPerMinute: '0.3' })] })))
    const diff = diffCostCells(from, to)
    expect(diff.unchanged).toBe(0)
    const big = diff.cells.find((cell) => cell.colourwayId === CW.BLK && cell.size === '54')!
    // Leather +0.5 ft² × 1.12 × 4.20 = +2.352; finishing 5 × 0.30 = +1.50; overhead +0.3852; total +4.2372.
    expect(big).toMatchObject({ materialCostChange: '2.352', labourCostChange: '1.5', overheadCostChange: '0.3852', totalChange: '4.2372' })
    expect(big.materials).toEqual([{ itemId: ITEM.LEA, code: 'LEA', from: { baseQuantity: '53.2', materialCost: '223.44' }, to: { baseQuantity: '53.76', materialCost: '225.792' } }])
    expect(big.labour).toEqual([{ workCentreKind: 'FINISHING', from: null, to: { minutes: '5', labourCost: '1.5' } }])
    const other = diff.cells.find((cell) => cell.colourwayId === CW.BLK && cell.size === '52')!
    expect(other).toMatchObject({ materialCostChange: '0', totalChange: '1.65', materials: [] })
  })

  it('counts the same cells as unchanged, and a change against an incomplete side is null', () => {
    const cells = exactCells(prepareSheet(FACTS))
    expect(diffCostCells(cells, cells)).toEqual({ cells: [], unchanged: 6 })
    const missing = exactCells(prepareSheet(with_({ rates: [] })))
    const diff = diffCostCells(cells, missing)
    expect(diff.cells).toHaveLength(6)
    expect(diff.cells[0]).toMatchObject({ labourCostChange: null, totalChange: null, materialCostChange: '0' })
  })
})

describe('the rates and overhead limits (the …_costing_guards limits)', () => {
  it('a rate: cost per minute 0 or more, efficiency above 0 and at most 200 %, an ISO currency, a calendar day', () => {
    expect(rateProblems({ costPerMinute: '0', currency: 'EUR', plannedEfficiencyPct: '200', validFrom: '2026-03-01' })).toEqual([])
    expect(rateProblems({ costPerMinute: '-0.1', currency: 'eur', plannedEfficiencyPct: '0', validFrom: '2026-02-30' }).map((issue) => issue.path)).toEqual([
      'costPerMinute',
      'currency',
      'plannedEfficiencyPct',
      'validFrom',
    ])
    expect(rateProblems({ plannedEfficiencyPct: '200.0001' }).map((issue) => issue.path)).toEqual(['plannedEfficiencyPct'])
    expect(rateProblems({ costPerMinute: '0.1234567' }).map((issue) => issue.path)).toEqual(['costPerMinute'])
  })

  it('an overhead from 0 to 100 %; an archived rate stays archived', () => {
    expect(overheadProblems('0')).toEqual([])
    expect(overheadProblems('100')).toEqual([])
    expect(overheadProblems('100.5')).toHaveLength(1)
    expect(overheadProblems('-1')).toHaveLength(1)
    expect(labourRateMachine.finals).toEqual(['ARCHIVED'])
  })
})
