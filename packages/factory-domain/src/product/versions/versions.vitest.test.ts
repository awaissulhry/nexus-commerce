import { describe, expect, it } from 'vitest'
import { compareSpecs, differsOf, differsWords, type BomLineFacts, type SpecSnapshot, type StepFacts } from './compare'
import { driftOf, driftWords, newerSpecOf } from './drift'
import { databaseLockWords, isLocked, lockedRefusal } from './lock'

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const LEATHER = ID(901)
const LINING = ID(902)
const THREAD = ID(903)
const CUT = ID(801)
const SEW = ID(802)

const line = (over: Partial<BomLineFacts> & Pick<BomLineFacts, 'id' | 'seq' | 'itemId'>): BomLineFacts => ({
  item: over.itemId === LEATHER ? 'LEA-001 Cowhide' : over.itemId === LINING ? 'LIN-200 Mesh' : 'THR-530 Thread',
  placement: null,
  colourwayId: null,
  colourway: null,
  qty: '1.0000',
  uom: 'M2',
  wastagePct: '0.0000',
  sizeDependent: false,
  sizes: {},
  colourDependent: false,
  colours: [],
  itemColour: null,
  supplier: null,
  section: null,
  parentSeq: null,
  subAssembly: null,
  customerSupplied: null,
  issueToSubcontract: false,
  sourceKey: null,
  option: null,
  routingSeq: null,
  mtm: null,
  alternates: [],
  note: null,
  ...over,
})

const step = (over: Partial<StepFacts> & Pick<StepFacts, 'id' | 'seq' | 'operationId'>): StepFacts => ({
  code: over.operationId === CUT ? 'CUT' : 'SEW',
  name: over.operationId === CUT ? 'Cut leather' : 'Sew',
  workCentreKind: over.operationId === CUT ? 'CUTTING' : 'SEWING',
  standardMinutes: '10.000',
  basicMinutes: null,
  personalPct: null,
  fatiguePct: null,
  delayPct: null,
  timeVersion: null,
  setupMinutes: null,
  waitMinutes: null,
  moveMinutes: null,
  scanRequired: true,
  parallelGroup: null,
  instructions: null,
  sizes: [],
  colourways: [],
  options: [],
  checkpoint: null,
  sizeTimes: {},
  settings: [],
  workshop: null,
  transitDays: null,
  ...over,
})

const revision = (id: string, number: number, minutes: string) => ({
  id,
  revision: number,
  status: number === 1 ? 'OBSOLETE' : 'RELEASED',
  labelTemplate: 'LBL-01 r1',
  plannedHideYieldPct: '75.0000',
  outputQuantity: 1,
  outputUom: 'PCS',
  releasedColourways: [],
  releasedSizes: [],
  minutesPerGarment: minutes,
})

const before: SpecSnapshot = {
  revision: revision(ID(1), 1, '20'),
  bom: [
    line({ id: ID(11), seq: 10, itemId: LEATHER, uom: 'FT2', sizeDependent: true, sizes: { '50': '40.0000', '52': '42.0000', '54': '44.0000' }, section: 'SHELL' }),
    line({ id: ID(12), seq: 20, itemId: LINING, qty: '1.2000', uom: 'M' }),
  ],
  routing: [step({ id: ID(21), seq: 10, operationId: CUT }), step({ id: ID(22), seq: 20, operationId: SEW })],
  measurements: { status: 'APPROVED', baseSize: '52', gradeRule: null, points: [{ pointId: ID(31), point: 'CHEST_W Chest width', uom: 'CM', seq: 1, values: { '50': { nominal: '54.00', minus: '0.50', plus: '1.00' }, '52': { nominal: '56.00', minus: '0.50', plus: '1.00' } } }] },
  protectors: [],
  pieces: [{ id: ID(41), seq: 1, name: 'Front panel', quantity: 2, line: '10 · LEA-001', minGrade: 'A', grain: 'ALONG', sizes: [], note: null }],
}

const after: SpecSnapshot = {
  revision: revision(ID(2), 2, '24.5'),
  bom: [
    // Leather: size 52 moved, and a section is now named elsewhere: changed.
    line({ id: ID(111), seq: 10, itemId: LEATHER, uom: 'FT2', sizeDependent: true, sizes: { '50': '40', '52': '43.5', '54': '44' }, section: 'SHELL' }),
    // Lining: the same (decimals written another way).
    line({ id: ID(112), seq: 20, itemId: LINING, qty: '1.2', uom: 'M' }),
    // Thread: new.
    line({ id: ID(113), seq: 30, itemId: THREAD, qty: '5', uom: 'M', issueToSubcontract: true, alternates: [{ priority: 1, item: 'THR-531', itemColour: null, qty: null, allowedWhen: 'WHEN_SHORT', certificateCheck: false }] }),
  ],
  routing: [
    step({ id: ID(121), seq: 10, operationId: CUT, standardMinutes: '14.000', basicMinutes: '12.500', personalPct: '5', fatiguePct: '4', delayPct: '3', timeVersion: 1, checkpoint: 'INL-FIRST' }),
    step({ id: ID(122), seq: 20, operationId: SEW, sizeTimes: { '54': '4.000' } }),
  ],
  measurements: { status: 'APPROVED', baseSize: '52', gradeRule: 'GR-1', points: [{ pointId: ID(31), point: 'CHEST_W Chest width', uom: 'CM', seq: 1, values: { '50': { nominal: '54.00', minus: '0.50', plus: '1.00' }, '52': { nominal: '56.50', minus: '0.50', plus: '1.50' } } }] },
  protectors: [{ id: ID(51), seq: 1, pocket: 'SHOULDER', item: 'PRO-300', standard: 'EN 1621-1', level: '2', sizes: [], positionNote: null }],
  pieces: [
    { id: ID(141), seq: 1, name: 'Front panel', quantity: 2, line: '10 · LEA-001', minGrade: 'B', grain: 'ALONG', sizes: [], note: null },
    { id: ID(142), seq: 2, name: 'Sleeve', quantity: 2, line: '10 · LEA-001', minGrade: null, grain: 'ANY', sizes: [], note: null },
  ],
}

const range = ['50', '52', '54']

describe('compare any two revisions (PRD-168, PRD-085, VS1:01)', () => {
  const sections = compareSpecs(before, after, range)
  const of = (id: string) => sections.find((entry) => entry.id === id)!

  it('gives every part as a VersionCompare section, in order', () => {
    expect(sections.map((entry) => entry.id)).toEqual(['revision', 'bom', 'routing', 'measurements', 'protectors', 'pieces'])
    for (const entry of sections) {
      expect(entry.fields.length).toBeGreaterThan(0)
      for (const row of entry.lines) expect(row.before ?? row.after).not.toBeNull()
    }
  })

  it('matches BOM lines by material: a size moved, the same line written another way, a new line', () => {
    const bom = of('bom')
    expect(bom.summary).toEqual({ added: 1, removed: 0, changed: 1, unchanged: 1 })
    const leather = bom.lines.find((row) => row.id === ID(111))!
    expect(leather.before!.sizes).toEqual({ '50': '40', '52': '42', '54': '44' })
    expect(leather.after!.sizes!['52']).toBe('43.5')
    // A size-dependent line's own quantity follows its sizes.
    expect(leather.after!.fields.qty).toBeNull()
    const thread = bom.lines.find((row) => row.id === ID(113))!
    expect(thread.before).toBeNull()
    expect(thread.after!.fields).toMatchObject({ qty: '5', uom: 'M', issueToSubcontract: '✓', alternates: '1. THR-531 WHEN_SHORT' })
    expect(bom.sizes).toEqual(range)
    expect(bom.totals).toEqual([{ id: 'lines', label: 'Lines', before: '2', after: '3' }])
  })

  it('says the routing: minutes with allowances, the SMV version, the checkpoint and the extra minutes per size', () => {
    const routing = of('routing')
    expect(routing.summary).toEqual({ added: 0, removed: 0, changed: 2, unchanged: 0 })
    const cut = routing.lines.find((row) => row.id === ID(121))!
    expect(cut.after!.fields).toMatchObject({ standardMinutes: '14', allowances: '12.5 + 5/4/3 %', timeVersion: 'v1', checkpoint: 'INL-FIRST' })
    expect(cut.before!.fields.allowances).toBeNull()
    const sew = routing.lines.find((row) => row.id === ID(122))!
    expect(sew.after!.sizes).toEqual({ '54': '4' })
    expect(routing.totals[0]).toEqual({ id: 'minutesPerGarment', label: 'Minutes per garment', before: '20', after: '24.5' })
  })

  it('compares the measurement spec per point and size, with its tolerance', () => {
    const measurements = of('measurements')
    expect(measurements.summary.changed).toBe(1)
    const chest = measurements.lines[0]!
    expect(chest.before!.sizes).toEqual({ '50': '54', '52': '56' })
    expect(chest.after!.sizes!['52']).toBe('56.5')
    expect(chest.before!.fields.tolerance).toBe('0.5 / 1')
    expect(chest.after!.fields.tolerance).toBe('50: 0.5 / 1; 52: 0.5 / 1.5')
    expect(measurements.totals[0]).toEqual({ id: 'spec', label: 'Spec', before: 'APPROVED · base 52', after: 'APPROVED · base 52 · GR-1' })
  })

  it('includes the pattern pieces (VS1:01) and the protectors', () => {
    const pieces = of('pieces')
    expect(pieces.summary).toEqual({ added: 1, removed: 0, changed: 1, unchanged: 0 })
    expect(pieces.lines.find((row) => row.label === 'Front panel')!.after!.fields.minGrade).toBe('B')
    expect(pieces.totals.find((total) => total.id === 'perGarment')).toMatchObject({ before: '2', after: '4' })
    expect(of('protectors').summary.added).toBe(1)
  })

  it('names the parts that differ, in words', () => {
    const differs = differsOf(sections)
    expect(differs.map((entry) => entry.section)).toEqual(['bom', 'routing', 'measurements', 'protectors', 'pieces'])
    expect(differsWords(differs)).toBe(
      'BOM: 1 added, 1 changed · Routing and minutes: 2 changed · Measurement spec: 1 changed · Protector placement: 1 added · Pattern pieces: 1 added, 1 changed',
    )
    const same = compareSpecs(before, before, range)
    expect(differsOf(same)).toEqual([])
    expect(differsWords([])).toBe('the same spec')
  })

  it('removes a line whose material changed, and adds the new one', () => {
    const swapped: SpecSnapshot = { ...after, bom: [line({ id: ID(211), seq: 20, itemId: THREAD })] }
    const bom = compareSpecs(before, swapped, range).find((entry) => entry.id === 'bom')!
    expect(bom.summary).toEqual({ added: 1, removed: 2, changed: 0, unchanged: 0 })
    expect(bom.lines.filter((row) => row.after === null).map((row) => row.id)).toEqual([ID(11), ID(12)])
  })
})

describe('released data is locked (PRD-167)', () => {
  it('locks everything but a draft, in words per part', () => {
    expect(isLocked({ status: 'DRAFT' })).toBe(false)
    expect(lockedRefusal({ revision: 3, status: 'DRAFT' }, 'BomLine')).toBeNull()
    expect(lockedRefusal({ revision: 2, status: 'RELEASED' }, 'BomLine')).toBe('Revision 2 is released and locked: its BOM cannot change. Start a new revision (a copy of it, as a draft) to change it.')
    expect(lockedRefusal({ revision: 2, status: 'RELEASED' })).toBe('Revision 2 is released and locked: it cannot change. Start a new revision (a copy of it, as a draft) to change it.')
    expect(lockedRefusal({ revision: 1, status: 'OBSOLETE' }, 'PatternPiece')).toBe('Revision 1 is obsolete and kept as it was: its pattern pieces cannot change. Start a new revision from the released one to change the spec.')
  })

  it("says the database's refusal in the same words", () => {
    const id = '0190f1f2-0000-7000-8000-000000000001'
    expect(databaseLockWords(`product: revision ${id} is RELEASED; its "MeasurementSpecValue" rows never change, a change is a new revision`)).toEqual({
      revisionId: id,
      message: 'This revision is released and locked: its measurement spec cannot change. Start a new revision (a copy of it, as a draft) to change it.',
    })
    expect(databaseLockWords(`product: revision ${id} is OBSOLETE; it never changes, a change is a new revision`, 4)!.message).toBe(
      'Revision 4 is obsolete and kept as it was: it cannot change. Start a new revision from the released one to change the spec.',
    )
    expect(databaseLockWords('product: a row of "BomLine" never moves to another revision')).toBeNull()
    expect(databaseLockWords('period lock: closed')).toBeNull()
  })
})

describe('a newer spec for a work order (PRD-195) and drift (PRD-194)', () => {
  const r = (n: number, status = 'RELEASED') => ({ id: ID(n), revision: n, status })

  it('shows no banner while the work order is on the spec in force', () => {
    expect(newerSpecOf({ pinned: r(2), released: r(2), decision: null })).toMatchObject({ state: 'CURRENT', banner: false, newPages: false })
    expect(newerSpecOf({ pinned: null, released: r(2), decision: null }).state).toBe('NO_REVISION')
    expect(newerSpecOf({ pinned: r(3, 'DRAFT'), released: r(2), decision: null }).state).toBe('NOT_RELEASED')
  })

  it('shows the banner for a newer revision and keeps the old pages until the office decides', () => {
    const waiting = newerSpecOf({ pinned: r(1, 'OBSOLETE'), released: r(2), decision: null })
    expect(waiting).toEqual({
      state: 'NEWER_RELEASED',
      banner: true,
      newPages: false,
      message: 'A newer spec exists: revision 2. This work order is made to revision 1. Keep to revision 1 until the office decides.',
    })
    expect(newerSpecOf({ pinned: r(1, 'OBSOLETE'), released: r(2), decision: { disposition: 'FINISH_OLD', changeOrder: 'ECO-2026-0001' } })).toMatchObject({ newPages: false })
    const rework = newerSpecOf({ pinned: r(1, 'OBSOLETE'), released: r(2), decision: { disposition: 'REWORK', changeOrder: 'ECO-2026-0001' } })
    expect(rework.newPages).toBe(true)
    expect(rework.message).toContain('Decided in ECO-2026-0001: rework to revision 2; the new pages apply.')
    expect(newerSpecOf({ pinned: r(1, 'OBSOLETE'), released: null, decision: null })).toMatchObject({ state: 'WITHDRAWN', banner: true, newPages: false })
  })

  it('says a line on another revision, and how it differs', () => {
    expect(driftOf(r(1), r(1))).toBe('SAME')
    expect(driftOf(r(1), r(2))).toBe('DIFFERENT')
    expect(driftOf(null, r(2))).toBe('NO_REVISION')
    expect(driftOf(r(1), null)).toBe('NO_RELEASED')
    expect(driftWords('ORDER', 'SO-0002', 10, 1, 2, 'the spec in force', 'BOM: 1 changed')).toBe('Order SO-0002 line 10 is on revision 1; revision 2 is the spec in force: BOM: 1 changed.')
    expect(driftWords('WORK_ORDER', 'WO-0001', null, 1, 2, 'the spec in force', 'the same spec')).toBe('Work order WO-0001 is on revision 1; revision 2 is the spec in force: the same spec.')
  })
})
