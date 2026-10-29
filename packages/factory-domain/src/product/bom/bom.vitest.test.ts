import { describe, expect, it } from 'vitest'
import { copyLines } from './copy'
import { diffBoms } from './diff'
import { decimalOf, roundTo } from '../units/units'
import { colourIn, exactRequirements, lineBySize, lineNeed, netQuantity, requirements, withWastage } from './requirements'
import { bomIssues, editRefusal, hideYieldProblem, inRangeOrder, nextSeq, obsoleteRefusal, planLine, releaseRefusal, sizeDependentQty, type BomLineData, type BomMaterial, type BomStyle } from './rules'

/**
 * The BOM's rules and math (B-W1-13; features PRD-043, PRD-076, PRD-079, PRD-082, PRD-100). The wastage cases are the
 * old factory app's (apps/factory: EPQ.4 "material = sqm × (1 + wastage) × rate", "requiredLeatherSqm folds wastage and
 * qty"), ported to decimals. Every code and name is made up.
 */

const ROUND = { scale: 4, rounding: 'HALF_UP' } as const
const ids = { BLK: 'cw-blk', RED: 'cw-red', OLD: 'cw-old' }

const leather: BomMaterial = {
  id: 'item-leather',
  code: 'LEA-1',
  kind: 'LEATHER',
  status: 'ACTIVE',
  // Counted in ft², bought by the hide (52.5 ft²), cut in dm².
  units: { baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'DM2', consumptionFactor: '0.10763910' },
  colours: [
    { id: 'lea-blk', code: 'BLK', status: 'ACTIVE' },
    { id: 'lea-red', code: 'RED', status: 'ACTIVE' },
    { id: 'lea-tan', code: 'TAN', status: 'ARCHIVED' },
  ],
}
const lining: BomMaterial = {
  id: 'item-lining',
  code: 'LIN-1',
  kind: 'LINING',
  status: 'ACTIVE',
  units: { baseUom: 'M', purchaseUom: 'ROLL', purchaseFactor: '50', consumptionUom: 'M', consumptionFactor: '1' },
  colours: [{ id: 'lin-gry', code: 'GRY', status: 'ACTIVE' }],
}
const protector: BomMaterial = {
  id: 'item-protector',
  code: 'PRO-1',
  kind: 'PROTECTOR',
  status: 'ACTIVE',
  units: { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' },
  colours: [],
}
const MATERIALS = new Map([leather, lining, protector].map((material) => [material.id, material]))

const style: BomStyle = {
  sizes: ['50', '52', '54'],
  baseSize: '52',
  colourways: [
    { id: ids.BLK, code: 'BLK', status: 'ACTIVE' },
    { id: ids.RED, code: 'RED', status: 'ACTIVE' },
    { id: ids.OLD, code: 'OLD', status: 'ARCHIVED' },
  ],
}

const planned = (current: Parameters<typeof planLine>[0], change: Parameters<typeof planLine>[1], material: BomMaterial = leather) => {
  const plan = planLine(current, change, material, style, 10)
  if (!plan.ok) throw new Error(JSON.stringify(plan.issues))
  return plan.line
}
const refused = (current: Parameters<typeof planLine>[0], change: Parameters<typeof planLine>[1], material: BomMaterial = leather) => {
  const plan = planLine(current, change, material, style, 10)
  if (plan.ok) throw new Error('expected a refusal')
  return plan.issues
}
const asData = (id: string, line: ReturnType<typeof planned>): BomLineData => ({ id, ...line })

/** The seed jacket's BOM: leather per size with 12 % in ft², grey lining in metres with 5 %, two protectors. */
const leatherLine = asData(
  'l-10',
  planned(null, {
    itemId: leather.id,
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
      { colourwayId: ids.BLK, itemColourId: 'lea-blk' },
      { colourwayId: ids.RED, itemColourId: 'lea-red' },
    ],
    placement: 'Outer shell',
  }),
)
const liningLine = asData('l-20', planned(null, { itemId: lining.id, qty: '1.8', wastagePct: '5', itemColourId: 'lin-gry', seq: 20 }, lining))
const protectorLine = asData('l-30', planned(null, { itemId: protector.id, qty: '2', seq: 30 }, protector))
const JACKET = [leatherLine, liningLine, protectorLine]

describe('a BOM line (PRD-076, PRD-079, PRD-043, PRD-100)', () => {
  it('takes the material consumption unit, 0 % wastage and the next place by default', () => {
    const line = planned(null, { itemId: lining.id, qty: '1.8', itemColourId: 'lin-gry' }, lining)
    expect(line).toMatchObject({ seq: 10, uom: 'M', qty: '1.8', wastagePct: '0', sizeDependent: false, colourDependent: false, sizes: [], colours: [] })
    expect(nextSeq([{ seq: 10 }, { seq: 25 }])).toBe(30)
    expect(nextSeq([])).toBe(10)
  })

  it('refuses an archived material, a unit it does not convert and wastage above 60 %', () => {
    const issues = refused(null, { itemId: leather.id, uom: 'M', qty: '1', wastagePct: '61', itemColourId: 'lea-blk' }, { ...leather, status: 'ARCHIVED' })
    expect(issues.map((issue) => issue.path)).toEqual(['itemId', 'uom', 'wastagePct'])
    expect(issues[1]!.message).toMatch(/does not convert m to its base unit ft²: use .*FT2/)
    expect(planned(null, { itemId: leather.id, uom: 'HIDE', qty: '1', wastagePct: '60', itemColourId: 'lea-blk' }).uom).toBe('HIDE')
  })

  it('needs one quantity above 0 when the line is not size-dependent', () => {
    expect(refused(null, { itemId: protector.id }, protector)).toEqual([{ path: 'qty', message: 'Say how much one garment takes.' }])
    expect(refused(null, { itemId: protector.id, qty: '0' }, protector)).toEqual([{ path: 'qty', message: 'The quantity is above 0.' }])
    expect(refused(null, { itemId: protector.id, qty: '2', sizes: [{ size: '52', qty: '2' }] }, protector)[0]!.path).toBe('sizes')
  })

  it('keeps a size-dependent line per size of the range, in range order, its own quantity the base size one', () => {
    expect(leatherLine.sizes).toEqual([
      { size: '50', qty: '43' },
      { size: '52', qty: '45' },
      { size: '54', qty: '47.5' },
    ])
    expect(leatherLine.qty).toBe('45')
    expect(sizeDependentQty([{ size: '54', qty: '47.5' }], style)).toBe('47.5')
    expect(sizeDependentQty([], style)).toBe('0')
    expect(inRangeOrder([{ size: '99' }, { size: '54' }, { size: '50' }], style.sizes).map((row) => row.size)).toEqual(['50', '54', '99'])
  })

  it('merges the size grid: a quantity sets a size, 0 says the size does not use it, null clears it', () => {
    const line = planned(leatherLine, { sizes: [{ size: '50', qty: '0' }, { size: '54', qty: null }] })
    expect(line.sizes).toEqual([
      { size: '50', qty: '0' },
      { size: '52', qty: '45' },
    ])
    const issues = refused(leatherLine, { sizes: [{ size: '58', qty: '50' }, { size: '50', qty: '1' }, { size: '50', qty: '2' }], qty: '3' })
    expect(issues.map((issue) => issue.path)).toEqual(['qty', 'sizes/58', 'sizes/50'])
    expect(issues[1]!.message).toBe("Size 58 is not in the style's range (50, 52, 54).")
    // A size of an older range is cleared without a refusal.
    expect(planned({ ...leatherLine, sizes: [...leatherLine.sizes, { size: '58', qty: '50' }] }, { sizes: [{ size: '58', qty: null }] }).sizes.map((row) => row.size)).toEqual(['50', '52', '54'])
  })

  it('fills every size with the quantity when a line becomes size-dependent, and keeps the base size one when it stops', () => {
    expect(planned(liningLine, { sizeDependent: true }, lining).sizes).toEqual(style.sizes.map((size) => ({ size, qty: '1.8' })))
    const flat = planned(leatherLine, { sizeDependent: false })
    expect(flat).toMatchObject({ sizeDependent: false, qty: '45', sizes: [] })
  })

  it('needs a colour grid of the material colours on a colour-dependent line, and one colour otherwise', () => {
    expect(leatherLine.colours).toEqual([
      { colourwayId: ids.BLK, itemColourId: 'lea-blk' },
      { colourwayId: ids.RED, itemColourId: 'lea-red' },
    ])
    const issues = refused(leatherLine, {
      itemColourId: 'lea-blk',
      colours: [
        { colourwayId: ids.RED, itemColourId: 'lea-tan' },
        { colourwayId: ids.OLD, itemColourId: 'lea-blk' },
        { colourwayId: 'cw-other', itemColourId: 'lea-blk' },
        { colourwayId: ids.BLK, itemColourId: 'lin-gry' },
      ],
    })
    expect(issues).toEqual([
      { path: 'itemColourId', message: 'A colour-dependent line takes its colour per colourway: send colours.' },
      { path: `colours/${ids.RED}`, message: 'Colour TAN of LEA-1 is archived.' },
      { path: `colours/${ids.OLD}`, message: 'Colourway OLD is archived.' },
      { path: 'colours/cw-other', message: 'No such colourway of this style.' },
      { path: `colours/${ids.BLK}`, message: 'Not a colour of LEA-1.' },
    ])
    expect(planned(leatherLine, { colours: [{ colourwayId: ids.RED, itemColourId: null }] }).colours).toEqual([{ colourwayId: ids.BLK, itemColourId: 'lea-blk' }])
    expect(refused(null, { itemId: protector.id, qty: '2', colourDependent: true }, protector)[0]!.message).toBe('PRO-1 has no colours: it cannot change colour with the colourway.')
  })

  it('copies the one colour into every active colourway when a line becomes colour-dependent', () => {
    expect(planned(liningLine, { colourDependent: true }, lining).colours).toEqual([
      { colourwayId: ids.BLK, itemColourId: 'lin-gry' },
      { colourwayId: ids.RED, itemColourId: 'lin-gry' },
    ])
  })

  it('names the colour directly on a line of one colourway (PRD-100), never through the grid', () => {
    const red = planned(null, { itemId: lining.id, qty: '0.4', colourwayId: ids.RED, itemColourId: 'lin-gry' }, lining)
    expect(red).toMatchObject({ colourwayId: ids.RED, itemColourId: 'lin-gry' })
    expect(refused(null, { itemId: leather.id, qty: '1', colourwayId: ids.RED, colourDependent: true, colours: [{ colourwayId: ids.RED, itemColourId: 'lea-red' }] })[0]!.path).toBe('colourDependent')
    expect(refused(null, { itemId: lining.id, qty: '1', colourwayId: ids.OLD }, lining)[0]!.message).toBe('Colourway OLD is archived.')
  })

  it('drops the old colours when the material changes and keeps an archived material on a line that only changes its quantity', () => {
    const moved = planned(liningLine, { itemId: protector.id, uom: 'PCS', qty: '2' }, protector)
    expect(moved).toMatchObject({ itemId: protector.id, itemColourId: null, uom: 'PCS', qty: '2', wastagePct: '5' })
    // The unit is never changed behind the office's back: 1.8 m of lining is not 1.8 protectors.
    expect(refused(liningLine, { itemId: protector.id }, protector)).toEqual([{ path: 'uom', message: 'PRO-1 does not convert m to its base unit pz: use PCS, PAIR.' }])
    expect(planned(protectorLine, { qty: '3' }, { ...protector, status: 'ARCHIVED' }).qty).toBe('3')
  })
})

describe('what a draft BOM lacks before its release', () => {
  const check = (lines: BomLineData[], materials: ReadonlyMap<string, BomMaterial> = MATERIALS, on: BomStyle = style, yieldPct: string | null = '75') =>
    bomIssues(lines, on, materials, { plannedHideYieldPct: yieldPct })

  it('passes the jacket and refuses an empty BOM, an empty range and a style without colourways', () => {
    expect(check(JACKET)).toEqual({ blockers: [], warnings: [] })
    expect(check([], MATERIALS, { sizes: [], baseSize: null, colourways: [] }).blockers.map((issue) => issue.code)).toEqual(['NO_LINES', 'NO_SIZE_RANGE', 'NO_ACTIVE_COLOURWAY'])
  })

  it('needs a quantity for every size of the range (PRD-079) and a colour for every active colourway (PRD-043)', () => {
    const missing = { ...leatherLine, sizes: leatherLine.sizes.filter((row) => row.size !== '54'), colours: leatherLine.colours.filter((cell) => cell.colourwayId !== ids.RED) }
    expect(check([missing]).blockers).toEqual([
      { code: 'SIZE_QUANTITY_MISSING', lineId: 'l-10', size: '54', colourwayId: null, message: 'Line 10 (LEA-1): no quantity for size 54 (0 if the size does not use it).' },
      { code: 'COLOUR_MISSING', lineId: 'l-10', size: null, colourwayId: ids.RED, message: 'Line 10 (LEA-1): no LEA-1 colour for colourway RED.' },
    ])
    const zero = { ...leatherLine, sizes: style.sizes.map((size) => ({ size, qty: '0' })) }
    expect(check([zero]).blockers.map((issue) => issue.code)).toEqual(['SIZE_QUANTITIES_ALL_ZERO'])
    const outside = { ...leatherLine, sizes: [...leatherLine.sizes, { size: '58', qty: '50' }] }
    expect(check([outside]).blockers.map((issue) => [issue.code, issue.size])).toEqual([['SIZE_OUTSIDE_RANGE', '58']])
  })

  it('refuses what was archived since it was chosen: the material, a colour; and a coloured material without a colour', () => {
    const archived = new Map(MATERIALS)
    archived.set(lining.id, { ...lining, status: 'ARCHIVED', colours: [{ id: 'lin-gry', code: 'GRY', status: 'ARCHIVED' }] })
    expect(check([liningLine], archived).blockers.map((issue) => issue.code)).toEqual(['MATERIAL_ARCHIVED', 'COLOUR_ARCHIVED'])
    expect(check([{ ...liningLine, itemColourId: null }]).blockers.map((issue) => issue.message)).toEqual(['Line 20 (LIN-1): LIN-1 comes in colours; choose one, or make the line colour-dependent.'])
    // A colourway that is archived needs no colour.
    expect(check([leatherLine], MATERIALS, { ...style, colourways: [...style.colourways, { id: 'cw-new', code: 'NEW', status: 'ARCHIVED' }] }).blockers).toEqual([])
  })

  it('warns about leather without wastage, a revision without a planned hide yield, and a line of an archived colourway (PRD-082)', () => {
    const { blockers, warnings } = check([{ ...leatherLine, wastagePct: '0' }, { ...liningLine, colourwayId: ids.OLD }], MATERIALS, style, null)
    expect(blockers).toEqual([])
    expect(warnings.map((warning) => warning.code)).toEqual(['LEATHER_WITHOUT_WASTAGE', 'LINE_OF_ARCHIVED_COLOURWAY', 'NO_PLANNED_HIDE_YIELD'])
    expect(hideYieldProblem('75')).toBeNull()
    expect(hideYieldProblem('0')).toMatch(/above 0/)
    expect(hideYieldProblem('100.0001')).toMatch(/at most 100/)
  })

  it('says when a revision cannot be edited, released or made obsolete (A1 §2.5)', () => {
    expect(editRefusal({ revision: 1, status: 'DRAFT' }, 'DRAFT')).toBeNull()
    expect(editRefusal({ revision: 1, status: 'RELEASED' }, 'ACTIVE')).toBe('Revision 1 is released: its BOM is frozen. Copy it into a new draft to change it.')
    expect(editRefusal({ revision: 2, status: 'DRAFT' }, 'ARCHIVED')).toMatch(/archived/)
    expect(releaseRefusal({ revision: 1, status: 'OBSOLETE' }, 'ACTIVE')).toBe('Revision 1 is obsolete: only a draft is released.')
    expect(releaseRefusal({ revision: 1, status: 'DRAFT' }, 'DRAFT')).toBeNull()
    expect(obsoleteRefusal({ revision: 1, status: 'DRAFT' }, 'ACTIVE')).toBeNull()
    expect(obsoleteRefusal({ revision: 1, status: 'RELEASED' }, 'ACTIVE')).toMatch(/release the revision that replaces it/)
    expect(obsoleteRefusal({ revision: 1, status: 'RELEASED' }, 'ARCHIVED')).toBeNull()
  })
})

describe('what one garment needs (PRD-082: leather area per size plus hide wastage)', () => {
  it('adds the wastage on top: 2.4 m² + 8 % is 2.592 m², ten garments 25.92 m² (the old app, exact)', () => {
    expect(withWastage('2.4', '8').toFixed()).toBe('2.592')
    expect(roundTo(withWastage('2.4', '8').times(10), ROUND).toFixed()).toBe('25.92')
    expect(withWastage('3', '0').toFixed()).toBe('3')
    // A line a size does not use (0) asks for nothing; one without a quantity for the size is not counted.
    expect(netQuantity({ sizeDependent: true, qty: '0', sizes: [{ size: '50', qty: '0' }] }, '50')!.toFixed()).toBe('0')
    expect(netQuantity({ sizeDependent: true, qty: '0', sizes: [] }, '50')).toBeNull()
  })

  it('converts to the base unit exactly, rounding once: 250 dm² + 10 % is 29.6008 ft²', () => {
    const need = lineNeed({ sizeDependent: false, qty: '250', sizes: [], wastagePct: '10', uom: 'DM2' }, '52', leather.units)!
    expect(need.gross.toFixed()).toBe('275')
    // 275 dm² = 2.75 m² = 29.600753… ft² (the exact ratio, never the stored factor).
    expect(need.base.toDecimalPlaces(4).toFixed()).toBe('29.6008')
    expect(lineNeed({ sizeDependent: false, qty: '1', sizes: [], wastagePct: '0', uom: 'KG' }, '52', leather.units)).toBeNull()
  })

  it('gives each line per size: before and with wastage in its unit, and in the base unit', () => {
    expect(lineBySize(leatherLine, style.sizes, leather.units, ROUND)).toEqual([
      { size: '50', qty: '43', gross: '48.16', base: '48.16' },
      { size: '52', qty: '45', gross: '50.4', base: '50.4' },
      { size: '54', qty: '47.5', gross: '53.2', base: '53.2' },
    ])
    expect(lineBySize({ ...leatherLine, sizes: [{ size: '50', qty: '43' }] }, style.sizes, leather.units, ROUND)[1]).toEqual({ size: '52', qty: null, gross: null, base: null })
  })

  it('explodes the jacket per colourway and size: leather in its colourway colour, the grey lining and two protectors everywhere', () => {
    const rows = requirements(JACKET, { sizes: style.sizes, colourwayIds: [ids.BLK, ids.RED] }, (itemId) => MATERIALS.get(itemId)?.units, ROUND)
    const of = (colourwayId: string, size: string) => rows.filter((row) => row.colourwayId === colourwayId && row.size === size).map((row) => [row.itemId, row.itemColourId, row.uom, row.quantity])
    expect(of(ids.BLK, '50')).toEqual([
      [leather.id, 'lea-blk', 'FT2', '48.16'],
      [lining.id, 'lin-gry', 'M', '1.89'],
      [protector.id, null, 'PCS', '2'],
    ])
    expect(of(ids.RED, '54')).toEqual([
      [leather.id, 'lea-red', 'FT2', '53.2'],
      [lining.id, 'lin-gry', 'M', '1.89'],
      [protector.id, null, 'PCS', '2'],
    ])
    expect(rows).toHaveLength(18)
  })

  it('sums two lines of one material in one colour exactly, rounds once, and leaves out a colourway a line is not for', () => {
    const pocket = asData('l-40', planned(null, { itemId: lining.id, qty: '0.33333', wastagePct: '5', colourwayId: ids.RED, itemColourId: 'lin-gry', seq: 40 }, lining))
    const style2 = { sizes: ['52'], colourwayIds: [ids.BLK, ids.RED] }
    const exact = exactRequirements([liningLine, pocket], style2, (itemId) => MATERIALS.get(itemId)?.units)
    expect(exact.map((row) => [row.colourwayId, row.quantity.toFixed(), row.lineIds])).toEqual([
      [ids.BLK, '1.89', ['l-20']],
      [ids.RED, '2.2399965', ['l-20', 'l-40']],
    ])
    expect(requirements([liningLine, pocket], style2, (itemId) => MATERIALS.get(itemId)?.units, ROUND)[1]!.quantity).toBe('2.24')
    // A purchase need rounds up, once, after the sum: 3 garments need 6.72 m, never 6.7199.
    expect(roundTo(decimalOf('2.2399965').times(3), { scale: 4, rounding: 'UP' }).toFixed()).toBe('6.72')
    expect(colourIn(pocket, ids.BLK)).toBeUndefined()
    expect(colourIn(leatherLine, ids.OLD)).toBeUndefined()
  })
})

describe('a new revision from a frozen one, and what changed (A1 §2.5)', () => {
  it('copies every line, size and grid cell under new ids, in BOM order', () => {
    let next = 0
    const copied = copyLines([protectorLine, leatherLine, liningLine], () => `new-${++next}`)
    expect(copied.map((line) => [line.id, line.itemId, line.seq])).toEqual([
      ['new-1', leather.id, 10],
      ['new-2', lining.id, 20],
      ['new-3', protector.id, 30],
    ])
    expect(copied[0]).toMatchObject({ sizes: leatherLine.sizes, colours: leatherLine.colours, wastagePct: '12', uom: 'FT2' })
    expect(copied[0]!.sizes).not.toBe(leatherLine.sizes)
  })

  it('matches lines by material, placement and colourway, and lists added, removed and changed lines', () => {
    let next = 0
    const copy = copyLines(JACKET, () => `r2-${++next}`)
    const [leatherCopy, liningCopy] = copy
    const changedLeather = { ...leatherCopy!, wastagePct: '15.0000', sizes: [{ size: '50', qty: '43.0000' }, { size: '52', qty: '46' }, { size: '54', qty: '47.5' }] }
    const zip = asData('r2-9', planned(null, { itemId: protector.id, qty: '1', placement: 'Front zip', seq: 40 }, protector))
    const diff = diffBoms({ plannedHideYieldPct: '75', labelTemplateId: null, lines: JACKET }, { plannedHideYieldPct: '78.5', labelTemplateId: null, lines: [changedLeather, liningCopy!, zip] })
    expect(diff.revision).toEqual([{ field: 'plannedHideYieldPct', from: '75', to: '78.5' }])
    expect(diff.added.map((line) => line.id)).toEqual(['r2-9'])
    expect(diff.removed.map((line) => line.id)).toEqual(['l-30'])
    expect(diff.unchanged).toBe(1)
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]).toMatchObject({ fields: [{ field: 'wastagePct', from: '12', to: '15' }], sizes: [{ size: '52', from: '45', to: '46' }], colours: [] })
  })

  it('shows a line that stopped changing colour with the colourway, and a removed size', () => {
    const flat = { ...leatherLine, id: 'x', colourDependent: false, colours: [], itemColourId: 'lea-blk', sizes: leatherLine.sizes.slice(0, 2) }
    const diff = diffBoms({ plannedHideYieldPct: null, labelTemplateId: null, lines: [leatherLine] }, { plannedHideYieldPct: null, labelTemplateId: null, lines: [flat] })
    expect(diff.changed[0]).toMatchObject({
      fields: [
        { field: 'colourDependent', from: true, to: false },
        { field: 'itemColourId', from: null, to: 'lea-blk' },
      ],
      sizes: [{ size: '54', from: '47.5', to: null }],
      colours: [
        { colourwayId: ids.BLK, from: 'lea-blk', to: null },
        { colourwayId: ids.RED, from: 'lea-red', to: null },
      ],
    })
  })
})
