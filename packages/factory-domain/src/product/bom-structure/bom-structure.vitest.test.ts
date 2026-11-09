import { describe, expect, it } from 'vitest'
import type { ItemUnits } from '../units/units'
import { bomCheck, fromRelease, structureIssues, structureRefusalIssues, type StructureFacts, type StructureLine, type StructureMaterial } from './check'
import { changeStructureBody, explosionQuery, setLineStructureBody } from './contracts'
import { explodeExact, materialTotals, roundExplosion, type ExplodeLine, type ExplodeRevision } from './explode'
import {
  groupOrder,
  groupProblem,
  inGroupCircle,
  outputBatches,
  removeGroupRowProblem,
  sectionOf,
  subAssemblyCircle,
  subAssemblyColourway,
  subAssemblyProblems,
  subAssemblySize,
  type SubAssemblyTarget,
} from './rules'

const PCS: ItemUnits = { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' }
const M: ItemUnits = { baseUom: 'M', purchaseUom: 'M', purchaseFactor: '1', consumptionUom: 'M', consumptionFactor: '1' }

const liner = (over: Partial<SubAssemblyTarget> = {}): SubAssemblyTarget => ({
  styleId: 'S-LNR',
  code: 'LNR-01',
  styleStatus: 'ACTIVE',
  revisionId: 'R-LNR-1',
  revision: 1,
  status: 'RELEASED',
  sizes: ['50', '52', '54'],
  colourways: [{ id: 'CW-GRY', code: 'GRY', status: 'ACTIVE' }],
  outputQuantity: 1,
  outputUom: 'PCS',
  ...over,
})

describe('sections and group rows (PRD-077)', () => {
  it('shows a line not filed under its material kind, a filed one under its own', () => {
    expect(sectionOf(null, 'LEATHER')).toEqual({ section: 'SHELL', filed: false })
    expect(sectionOf(null, 'PROTECTOR')).toEqual({ section: 'PROTECTION', filed: false })
    expect(sectionOf('LINING', 'PADDING')).toEqual({ section: 'LINING', filed: true })
  })

  const lines = [
    { id: 'a', seq: 10, parentLineId: null },
    { id: 'b', seq: 15, parentLineId: 'a' },
    { id: 'c', seq: 16, parentLineId: 'b' },
    { id: 'd', seq: 20, parentLineId: null },
  ]

  it('refuses itself, a line of another revision and a circle, in words', () => {
    expect(groupProblem(lines, 'd', null)).toBeNull()
    expect(groupProblem(lines, 'd', 'a')).toBeNull()
    expect(groupProblem(lines, 'd', 'd')).toBe('Line 20 cannot be grouped under itself.')
    expect(groupProblem(lines, 'd', 'x')).toMatch(/not in this BOM/)
    expect(groupProblem(lines, 'a', 'c')).toBe('Line 10 cannot be grouped under line 16: line 16 is grouped under it (a circle). Ungroup line 16 first.')
  })

  it('reads a grouped BOM depth first and finds a circle', () => {
    expect(groupOrder(lines).map((entry) => [entry.line.seq, entry.depth])).toEqual([
      [10, 0],
      [15, 1],
      [16, 2],
      [20, 0],
    ])
    expect(inGroupCircle(lines, 'c')).toBe(false)
    const circle = [
      { id: 'a', seq: 10, parentLineId: 'b' },
      { id: 'b', seq: 20, parentLineId: 'a' },
    ]
    expect(inGroupCircle(circle, 'a')).toBe(true)
    expect(groupOrder(circle).map((entry) => entry.line.seq)).toEqual([10, 20])
  })

  it('keeps a group row while lines are grouped under it', () => {
    expect(removeGroupRowProblem(lines, 'a')).toBe('Line 10 is the group row of line 15: ungroup it (or remove it) first.')
    expect(removeGroupRowProblem(lines, 'd')).toBeNull()
  })
})

describe('sub-assemblies (PRD-078, PRD-106)', () => {
  const line = { seq: 40, styleId: 'S-JKT', uom: 'PCS' as const, customerSupplied: false, material: { code: 'CMP-500', kind: 'COMPONENT' as const, sourcing: 'MAKE' as const } }

  it('takes a component we make, in pieces, of another style, not obsolete', () => {
    expect(subAssemblyProblems(line, liner())).toEqual([])
    expect(subAssemblyProblems(line, liner({ status: 'DRAFT' }))).toEqual([])
    expect(subAssemblyProblems(line, liner({ styleId: 'S-JKT' }))[0]!.message).toMatch(/never its own sub-assembly/)
    expect(subAssemblyProblems(line, liner({ status: 'OBSOLETE' }))[0]!.message).toBe('Revision 1 of LNR-01 is obsolete: take its released revision (or its draft).')
    expect(subAssemblyProblems({ ...line, material: { code: 'LIN-200', kind: 'LINING', sourcing: 'BUY' } }, liner())[0]!.message).toMatch(/takes the COMPONENT we make/)
    expect(subAssemblyProblems({ ...line, uom: 'M' }, liner())[0]!.message).toMatch(/PCS, PAIR or SET/)
    expect(subAssemblyProblems({ ...line, customerSupplied: true }, liner())[0]!.message).toMatch(/sent by the customer/)
  })

  it('finds a circle of styles and a BOM deeper than 10 levels', () => {
    // JKT takes LNR; LNR takes PAD; naming JKT under PAD is a circle.
    const edges = [
      { fromRevisionId: 'R-JKT', fromStyleId: 'S-JKT', toRevisionId: 'R-LNR', toStyleId: 'S-LNR' },
      { fromRevisionId: 'R-LNR', fromStyleId: 'S-LNR', toRevisionId: 'R-PAD', toStyleId: 'S-PAD' },
    ]
    expect(subAssemblyCircle({ revisionId: 'R-PAD', styleId: 'S-PAD' }, { revisionId: 'R-JKT2', styleId: 'S-JKT' }, edges).circleStyleId).toBe('S-JKT')
    const fine = subAssemblyCircle({ revisionId: 'R-JKT', styleId: 'S-JKT' }, { revisionId: 'R-HMP', styleId: 'S-HMP' }, edges)
    expect(fine).toEqual({ circleStyleId: null, levels: 2 })
    // A chain of 10 revisions: one more level is too deep.
    const chain = Array.from({ length: 9 }, (_, index) => ({ fromRevisionId: `R${index}`, fromStyleId: `S${index}`, toRevisionId: `R${index + 1}`, toStyleId: `S${index + 1}` }))
    expect(subAssemblyCircle({ revisionId: 'R9', styleId: 'S9' }, { revisionId: 'RX', styleId: 'SX' }, chain).levels).toBe(11)
  })

  it('serves a size and a colourway of the parent with its own', () => {
    expect(subAssemblySize('52', liner())).toBe('52')
    expect(subAssemblySize('56', liner())).toBeNull()
    expect(subAssemblySize('56', liner({ sizes: ['TU'] }))).toBe('TU')
    expect(subAssemblyColourway('BLK', liner())).toEqual({ id: 'CW-GRY', code: 'GRY' })
    const two = liner({ colourways: [{ id: 'G', code: 'GRY', status: 'ACTIVE' }, { id: 'B', code: 'BLK', status: 'ACTIVE' }] })
    expect(subAssemblyColourway('BLK', two)).toEqual({ id: 'B', code: 'BLK' })
    expect(subAssemblyColourway('RED', two)).toBeNull()
  })

  it('counts the output: a pair on the line of a BOM that makes one piece is two batches', () => {
    expect(outputBatches('PCS', PCS, liner())!.toString()).toBe('1')
    expect(outputBatches('PAIR', PCS, liner())!.toString()).toBe('2')
    expect(outputBatches('PCS', PCS, liner({ outputQuantity: 1, outputUom: 'PAIR' }))!.toString()).toBe('0.5')
    expect(outputBatches('SET', PCS, liner())).toBeNull()
  })
})

describe('the BOM check (PRD-087)', () => {
  const material = (over: Partial<StructureMaterial> & { id: string; code: string }): StructureMaterial => ({ kind: 'TEXTILE', sourcing: 'BUY', status: 'ACTIVE', approval: 'APPROVED', isPpeComponent: false, units: M, ...over })
  const line = (over: Partial<StructureLine> & { id: string; seq: number; itemId: string }): StructureLine => ({
    uom: 'M',
    sizeDependent: false,
    sizes: [],
    colourwayId: null,
    section: null,
    parentLineId: null,
    subAssemblyRevisionId: null,
    customerSupplied: false,
    ...over,
  })
  const facts = (over: Partial<StructureFacts> = {}): StructureFacts => ({
    lines: [
      line({ id: 'L10', seq: 10, itemId: 'zip' }),
      line({ id: 'L30', seq: 30, itemId: 'pro', uom: 'PCS', section: 'PROTECTION' }),
      line({ id: 'L40', seq: 40, itemId: 'cmp', uom: 'PCS', sizeDependent: true, sizes: [{ size: '50', qty: '1' }, { size: '52', qty: '1' }, { size: '56', qty: '0' }], subAssemblyRevisionId: 'R-LNR-1' }),
    ],
    materials: new Map([
      ['zip', material({ id: 'zip', code: 'TRM-900', approval: 'BLOCKED' })],
      ['pro', material({ id: 'pro', code: 'PRO-300', kind: 'PROTECTOR', approval: 'PENDING', isPpeComponent: true, units: PCS })],
      ['cmp', material({ id: 'cmp', code: 'CMP-500', kind: 'COMPONENT', sourcing: 'MAKE', units: PCS })],
    ]),
    alternates: [
      { id: 'A1', lineId: 'L30', priority: 1, code: 'PRO-310', status: 'ACTIVE', approval: 'BLOCKED' },
      { id: 'A2', lineId: 'L30', priority: 2, code: 'PRO-320', status: 'ARCHIVED', approval: 'APPROVED' },
    ],
    style: { id: 'S-JKT', sizes: ['50', '52', '56'], colourways: [{ id: 'BLK', code: 'BLK', status: 'ACTIVE' }], ppe: true },
    subAssemblies: new Map([['R-LNR-1', liner({ status: 'DRAFT' })]]),
    circles: new Map([['L40', { circleStyleId: null, levels: 2 }]]),
    codeOf: (id) => id,
    ...over,
  })

  it('lists every structure problem in words with its cell', () => {
    const check = structureIssues(facts())
    expect(check.blockers.map((item) => [item.code, item.cell.lineId, item.cell.column, item.cell.alternateId ?? item.cell.size])).toEqual([
      ['MATERIAL_BLOCKED', 'L10', 'itemId', null],
      ['ALTERNATE_BLOCKED', 'L30', 'alternates', 'A1'],
      ['SUB_ASSEMBLY_NOT_RELEASED', 'L40', 'subAssembly', null],
    ])
    expect(check.blockers[2]!.message).toBe('Line 40 (CMP-500): it takes sub-assembly LNR-01 revision 1, which is a draft. Release LNR-01 revision 1 first, or take its released revision (no draft part under a released parent).')
    expect(check.warnings.map((item) => [item.code, item.cell.lineId])).toEqual([
      ['PPE_MATERIAL_NOT_APPROVED', 'L30'],
      ['ALTERNATE_ARCHIVED', 'L30'],
    ])
  })

  it('finds a size and a colourway the sub-assembly lacks, a unit that does not convert, a circle', () => {
    const lines = facts().lines.map((entry) => (entry.id === 'L40' ? { ...entry, sizes: [{ size: '50', qty: '1' }, { size: '52', qty: '1' }, { size: '56', qty: '1' }] } : entry))
    const two = liner({ colourways: [{ id: 'G', code: 'GRY', status: 'ACTIVE' }, { id: 'B', code: 'NAV', status: 'ACTIVE' }], outputUom: 'SET' })
    const check = structureIssues(facts({ lines, subAssemblies: new Map([['R-LNR-1', two]]), circles: new Map([['L40', { circleStyleId: 'S-JKT', levels: 3 }]]) }))
    const codes = check.blockers.filter((item) => item.cell.lineId === 'L40').map((item) => [item.code, item.cell.size ?? item.cell.colourwayId])
    expect(codes).toEqual([
      ['SUB_ASSEMBLY_CIRCLE', null],
      ['SUB_ASSEMBLY_UNIT', null],
      ['SUB_ASSEMBLY_SIZE_MISSING', '56'],
      ['SUB_ASSEMBLY_COLOURWAY_MISSING', 'BLK'],
    ])
    expect(check.blockers.find((item) => item.code === 'SUB_ASSEMBLY_SIZE_MISSING')!.message).toBe('Line 40 (CMP-500): LNR-01 has no size 56 (its range: 50, 52, 54). Add size 56 to LNR-01, or give line 40 0 in size 56.')
  })

  it('a size of 0 asks nothing of the sub-assembly; a material no longer made is said', () => {
    const check = structureIssues(facts({ subAssemblies: new Map([['R-LNR-1', liner()]]), materials: new Map([...facts().materials, ['cmp', material({ id: 'cmp', code: 'CMP-500', kind: 'COMPONENT', sourcing: 'BUY', units: PCS })]]) }))
    expect(check.blockers.filter((item) => item.cell.lineId === 'L40').map((item) => [item.code, item.cell.column])).toEqual([['SUB_ASSEMBLY_NOT_MADE', 'itemId']])
  })

  it("merges W1's findings with their cells, the revision's first, line by line, the routing last", () => {
    const release = {
      blockers: [
        { code: 'NO_STEPS' as const, lineId: null, size: null, colourwayId: null, stepId: null, message: 'No routing.' },
        { code: 'SIZE_QUANTITY_MISSING' as const, lineId: 'L40', size: '54', colourwayId: null, stepId: null, message: 'No 54.' },
        { code: 'COLOUR_MISSING' as const, lineId: 'L10', size: null, colourwayId: null, stepId: null, message: 'Choose a colour.' },
        { code: 'NO_SIZE_RANGE' as const, lineId: null, size: null, colourwayId: null, stepId: null, message: 'No range.' },
      ],
      warnings: [],
    }
    const seq = new Map([['L10', 10], ['L30', 30], ['L40', 40]])
    const check = bomCheck(release, structureIssues(facts()), (id) => seq.get(id))
    expect(check.blockers.map((item) => [item.code, item.cell.column])).toEqual([
      ['NO_SIZE_RANGE', 'style'],
      ['COLOUR_MISSING', 'itemColourId'],
      ['MATERIAL_BLOCKED', 'itemId'],
      ['ALTERNATE_BLOCKED', 'alternates'],
      ['SIZE_QUANTITY_MISSING', 'sizes'],
      ['SUB_ASSEMBLY_NOT_RELEASED', 'subAssembly'],
      ['NO_STEPS', 'routing'],
    ])
    expect(fromRelease({ code: 'COLOUR_MISSING', lineId: 'L10', size: null, colourwayId: 'BLK', stepId: null, message: 'x' }, 'BLOCKER').cell.column).toBe('colours')
    expect(structureRefusalIssues(structureIssues(facts()).blockers).map((issue) => issue.path)).toEqual(['lines/L10/itemId', 'lines/L30/alternates/A1', 'lines/L40/subAssembly'])
  })
})

describe('the multi-level explosion (PRD-078)', () => {
  const lineOf = (over: Partial<ExplodeLine> & { id: string; seq: number; itemId: string; qty: string }): ExplodeLine => ({
    uom: 'M',
    wastagePct: '0',
    sizeDependent: false,
    sizes: [],
    colourDependent: false,
    itemColourId: null,
    colourwayId: null,
    colours: [],
    subAssemblyRevisionId: null,
    customerSupplied: false,
    issueToSubcontract: false,
    optionValueId: null,
    ...over,
  })
  const jacket: ExplodeRevision = {
    ...liner({ styleId: 'S-JKT', code: 'JKT-05', revisionId: 'R-JKT', colourways: [{ id: 'BLK', code: 'BLK', status: 'ACTIVE' }] }),
    lines: [
      lineOf({ id: 'J10', seq: 10, itemId: 'leather', qty: '2', wastagePct: '10' }),
      lineOf({ id: 'J40', seq: 40, itemId: 'cmp', qty: '1', uom: 'PCS', subAssemblyRevisionId: 'R-LNR-1', optionValueId: 'LINER-YES' }),
      lineOf({ id: 'J50', seq: 50, itemId: 'label', qty: '1', uom: 'PCS', customerSupplied: true }),
    ],
  }
  const linerRevision: ExplodeRevision = {
    ...liner(),
    lines: [
      lineOf({ id: 'L10', seq: 10, itemId: 'lining', qty: '1.2', sizeDependent: true, sizes: [{ size: '50', qty: '1.1' }, { size: '52', qty: '1.2' }, { size: '54', qty: '1.3' }] }),
      lineOf({ id: 'L20', seq: 20, itemId: 'wadding', qty: '0.8', wastagePct: '5' }),
    ],
  }
  const units: Record<string, ItemUnits> = { leather: M, cmp: PCS, label: PCS, lining: M, wadding: M }
  const input = (options: string[]) => ({
    top: jacket,
    revisions: new Map([['R-LNR-1', linerRevision]]),
    unitsOf: (itemId: string) => units[itemId],
    codeOf: (itemId: string) => itemId.toUpperCase(),
    options: new Set(options),
  })

  it('walks the sub-assembly (depth first, in BOM order) into its own size and colourway when the option is chosen', () => {
    const exploded = roundExplosion(explodeExact(input(['LINER-YES']), { size: '54', colourwayId: 'BLK', colourwayCode: 'BLK' }), { scale: 4, rounding: 'HALF_UP' })
    expect(exploded.materials.map((row) => [row.level, row.itemId, row.quantity, row.customerSupplied, row.via.map((step) => step.lineId)])).toEqual([
      [1, 'leather', '2.2', false, []],
      [2, 'lining', '1.3', false, ['J40']],
      [2, 'wadding', '0.84', false, ['J40']],
      [1, 'label', '1', true, []],
    ])
    expect(exploded.subAssemblies.map((row) => [row.level, row.itemId, row.quantity, row.size, row.colourwayId, row.batches])).toEqual([[1, 'cmp', '1', '54', 'CW-GRY', '1']])
    expect(exploded.problems).toEqual([])
  })

  it('leaves the option line out when its option is not chosen; a pair asks twice; a missing size is a problem', () => {
    expect(explodeExact(input([]), { size: '50', colourwayId: 'BLK', colourwayCode: 'BLK' }).subAssemblies).toEqual([])
    const pair = { ...input(['LINER-YES']), top: { ...jacket, lines: [lineOf({ id: 'J40', seq: 40, itemId: 'cmp', qty: '1', uom: 'PAIR', subAssemblyRevisionId: 'R-LNR-1' })] } }
    const totals = materialTotals(explodeExact(pair, { size: '50', colourwayId: 'BLK', colourwayCode: 'BLK' }))
    expect(totals.map((row) => [row.itemId, row.quantity.toString(), row.levels])).toEqual([
      ['lining', '2.2', [2, 2]],
      ['wadding', '1.68', [2, 2]],
    ])
    const missing = explodeExact(input(['LINER-YES']), { size: '56', colourwayId: 'BLK', colourwayCode: 'BLK' })
    expect(missing.problems.map((problem) => problem.code)).toEqual(['SIZE'])
  })
})

describe('the contracts', () => {
  it('asks for at least one change and reads lists from the query', () => {
    expect(setLineStructureBody.safeParse({ version: 1 }).success).toBe(false)
    expect(setLineStructureBody.safeParse({ version: 1, section: 'LINING' }).success).toBe(true)
    expect(setLineStructureBody.safeParse({ version: 1, section: 'LINER' }).success).toBe(false)
    expect(changeStructureBody.safeParse({ version: 1, lineIds: [] , section: 'SHELL' }).success).toBe(false)
    expect(explosionQuery.parse({ sizes: '50, 52,52' })).toEqual({ sizes: ['50', '52'] })
    expect(explosionQuery.safeParse({ options: 'not-an-id' }).success).toBe(false)
  })
})
