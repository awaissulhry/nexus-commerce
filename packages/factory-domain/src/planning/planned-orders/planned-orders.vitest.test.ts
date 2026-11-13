import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import type { ExplodeLine, ExplodeRevision } from '../../product/bom-structure/explode'
import type { EffectFacts } from '../../product/options/rules'
import { decimalOf } from '../../product/units/units'
import type { PlanInput, PlanItem, PlanOrderLine } from '../explode'
import { configuredRevision, effectLineId, garmentNeeds, shareKey, type GarmentSource } from './explosion'
import { planLevelled, type Garments } from './multilevel'
import { PLANNING_PLANNED_CONVERT } from './permissions'
import { convertProblem, firmProblem, inHouseDays, keptByRun, openCells, outsideWorkOf, proposeWork, sizeGroupsOf, sizeGroupWords, workOrderLinesOf } from './rules'

/* Planned work and subcontract orders (B-W2b-293). Every id, code and number here is made up. */

const PCS = { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' } as const
const METRE = { baseUom: 'M', purchaseUom: 'ROLL', purchaseFactor: '50', consumptionUom: 'M', consumptionFactor: '1' } as const
const UNITS: Record<string, typeof PCS | typeof METRE> = { shell: METRE, mesh: METRE, airflow: METRE, thread: METRE, liner: PCS, pocket: PCS, wadding: METRE, protector: PCS, label: PCS }

const line = (id: string, itemId: string, qty: string, fields: Partial<ExplodeLine> = {}): ExplodeLine => ({
  id,
  seq: 10,
  itemId,
  qty,
  uom: UNITS[itemId]!.baseUom,
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
  ...fields,
})

const revision = (id: string, code: string, lines: ExplodeLine[]): ExplodeRevision => ({
  styleId: `style-${code}`,
  code,
  styleStatus: 'ACTIVE',
  revisionId: id,
  revision: 1,
  status: 'RELEASED',
  sizes: ['48', '50', '52'],
  colourways: [{ id: `cw-${code}`, code: 'BLK', status: 'ACTIVE' }],
  outputQuantity: 1,
  outputUom: 'PCS',
  lines,
})

// A jacket: a shell, a mesh lining only without perforation, a liner we make (its wadding and a pocket kit, a phantom,
// with a protector), the customer's label.
const POCKET = revision('rev-pocket', 'POCKET', [line('p1', 'protector', '1')])
const LINER = revision('rev-liner', 'LINER', [line('l1', 'wadding', '0.8', { seq: 10 }), line('l2', 'pocket', '1', { seq: 20, subAssemblyRevisionId: 'rev-pocket' })])
const JACKET = revision('rev-jkt', 'JKT', [
  line('j1', 'shell', '2', { seq: 10, sizeDependent: true, sizes: [{ size: '48', qty: '1.9' }, { size: '50', qty: '2' }, { size: '52', qty: '2.1' }] }),
  line('j2', 'mesh', '1.5', { seq: 20 }),
  line('j3', 'liner', '1', { seq: 30, subAssemblyRevisionId: 'rev-liner' }),
  line('j4', 'label', '1', { seq: 40, customerSupplied: true }),
  line('j5', 'thread', '3', { seq: 50, optionValueId: 'opt-name' }),
])
const REVISIONS = new Map([JACKET, LINER, POCKET].map((entry) => [entry.revisionId, entry]))

const source = (fields: Partial<GarmentSource> = {}): GarmentSource => ({
  top: JACKET,
  revisions: REVISIONS,
  unitsOf: (itemId) => UNITS[itemId],
  codeOf: (itemId) => itemId.toUpperCase(),
  chosen: new Set(),
  effects: [],
  isPhantom: (itemId) => itemId === 'pocket',
  ...fields,
})
const at = { orderLineId: 'ol-1', size: '50', colourwayId: 'cw-JKT', colourwayCode: 'BLK' }
const quantities = (needs: readonly { itemId: string; quantity: { toFixed(scale: number): string } }[]) => Object.fromEntries(needs.map((need) => [need.itemId, need.quantity.toFixed(4)]))

const effect = (id: string, kind: EffectFacts['kind'], fields: Partial<EffectFacts>): EffectFacts => ({
  id,
  valueId: 'opt-perf',
  kind,
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
  ...fields,
})

describe('the multi-level explosion for planning (MR1:01, PLN-079)', () => {
  it('walks every level: the liner is a part to make and its wadding is needed; the phantom pocket passes its protector through; the customer’s label is never planned; an option line only when chosen', () => {
    const { needs, components } = garmentNeeds(source(), at, new Map())
    expect(quantities(needs)).toEqual({ shell: '2.0000', mesh: '1.5000', wadding: '0.8000', protector: '1.0000', liner: '1.0000' })
    expect(components).toEqual([{ itemId: 'liner', itemColourId: null, level: 1 }])
    const named = garmentNeeds(source({ chosen: new Set(['opt-name']) }), { ...at, size: '52' }, new Map())
    expect(quantities(named.needs)).toMatchObject({ shell: '2.1000', thread: '3.0000' })
  })

  it('a pocket that is not a phantom is a part to make of its own', () => {
    const { needs, components } = garmentNeeds(source({ isPhantom: () => false }), at, new Map())
    expect(quantities(needs)).toMatchObject({ pocket: '1.0000', protector: '1.0000' })
    expect(components.map((entry) => entry.itemId)).toEqual(['liner', 'pocket'])
  })

  it('what is below a made part follows the share of it still to make', () => {
    const half = new Map([[shareKey('ol-1', '50', 'liner', null), decimalOf('0.5')]])
    const { needs } = garmentNeeds(source(), at, half)
    expect(quantities(needs)).toMatchObject({ liner: '1.0000', wadding: '0.4000', protector: '0.5000', shell: '2.0000' })
  })
})

describe('option effects per size (MR1:02)', () => {
  it('BOM_REMOVE leaves a material out, BOM_REPLACE puts another in, BOM_ADD adds one per size', () => {
    const effects = [
      effect('e-remove', 'BOM_REMOVE', { targetItemId: 'mesh' }),
      effect('e-add', 'BOM_ADD', { itemId: 'thread', qty: '5', uom: 'M', sizeQuantities: { '48': '4.5', '52': '5.5' } }),
    ]
    const chosen = new Set(['opt-perf'])
    const configured = configuredRevision(JACKET, chosen, effects)
    expect(configured.lines.map((entry) => entry.id)).toEqual(['j1', 'j3', 'j4', 'j5', effectLineId('e-add')])
    expect(quantities(garmentNeeds(source({ chosen, effects }), { ...at, size: '48' }, new Map()).needs)).toMatchObject({ thread: '4.5000' })
    expect(quantities(garmentNeeds(source({ chosen, effects }), at, new Map()).needs)).toMatchObject({ thread: '5.0000' })
    expect(garmentNeeds(source({ chosen, effects }), at, new Map()).needs.some((need) => need.itemId === 'mesh')).toBe(false)
    const replaced = garmentNeeds(source({ chosen, effects: [effect('e-rep', 'BOM_REPLACE', { targetItemId: 'mesh', itemId: 'airflow', qty: '1.7', uom: 'M' })] }), at, new Map())
    expect(quantities(replaced.needs)).toMatchObject({ airflow: '1.7000' })
    expect(replaced.needs.some((need) => need.itemId === 'mesh')).toBe(false)
    // An effect of a value the line did not choose does nothing.
    expect(configuredRevision(JACKET, new Set(), effects)).toBe(JACKET)
  })
})

describe('the run netted level by level (MR1:01)', () => {
  const item = (id: string, sourcing: PlanItem['sourcing']): PlanItem => ({ id, code: id.toUpperCase(), sourcing, units: UNITS[id]!, defaultSupplierId: sourcing === 'MAKE' ? null : 'supplier' })
  const orderLine: PlanOrderLine = { orderId: 'so-1', orderNumber: 'SO-1', orderLineId: 'ol-1', lineSeq: 10, styleId: 'style-JKT', colourwayId: 'cw-JKT', revisionId: 'rev-jkt', sizes: [{ size: '50', pieces: 4 }], dueDate: '2026-12-10', partyId: 'customer' }
  const input = (stock: PlanInput['stock']): PlanInput => ({
    runDate: '2026-11-12',
    orderLines: [orderLine],
    revisions: [{ id: 'rev-jkt', lines: JACKET.lines.filter((entry) => !entry.customerSupplied).map((entry) => ({ ...entry, placement: null, supplierId: null, note: null })) }],
    items: [item('shell', 'BUY'), item('mesh', 'BUY'), item('liner', 'MAKE'), item('wadding', 'BUY'), item('protector', 'BUY'), item('pocket', 'MAKE'), item('thread', 'BUY')],
    workOrderCells: [],
    workOrderIssues: [],
    stock,
    lots: [],
    purchases: [],
  })
  const garments: Garments = { sourceOf: (id) => (id === 'ol-1' ? source() : null), colourwayCodeOf: () => 'BLK' }
  const netOf = (plan: ReturnType<typeof planLevelled>, itemId: string) => plan.requirements.find((entry) => entry.itemId === itemId)?.netQuantity

  it('without stock of the liner, its wadding is bought for every garment (one pass)', () => {
    const plan = planLevelled(input([]), garments)
    expect(netOf(plan, 'liner')).toBe('4.0000')
    expect(netOf(plan, 'wadding')).toBe('3.2000')
    expect(netOf(plan, 'protector')).toBe('4.0000')
    expect(plan.passes).toBe(1)
  })

  it('3 made liners in stock: only 1 is made, so only its wadding and protector are bought', () => {
    const plan = planLevelled(input([{ itemId: 'liner', itemColourId: null, lotId: null, quantity: '3', hides: 0 }]), garments)
    expect(netOf(plan, 'liner')).toBe('1.0000')
    expect(netOf(plan, 'wadding')).toBe('0.8000')
    expect(netOf(plan, 'protector')).toBe('1.0000')
    expect(plan.passes).toBe(2)
  })

  it('without garments it is W1’s run (one level)', () => {
    const plan = planLevelled(input([]), null)
    expect(netOf(plan, 'wadding')).toBeUndefined()
    expect(netOf(plan, 'liner')).toBe('4.0000')
  })
})

describe('the size-run rule (PLN-068)', () => {
  it('one grid keeps every size; size groups split by the site’s groups, a size in no group on its own', () => {
    expect(sizeGroupsOf(['46', '48', '50', '56'], 'ONE_GRID', [])).toEqual([{ codes: ['46', '48', '50', '56'], words: null }])
    // A group keeps its own words whatever sizes the run has.
    expect(sizeGroupsOf(['46', '48', '50', '56'], 'SIZE_GROUPS', [['44', '46', '48'], ['50', '52', '54']])).toEqual([
      { codes: ['46', '48'], words: '44-48' },
      { codes: ['50'], words: '50-54' },
      { codes: ['56'], words: '56' },
    ])
    expect(sizeGroupWords(['46', '48'], 'SIZE_GROUPS')).toBe('46-48')
    expect(sizeGroupWords(['50'], 'SIZE_GROUPS')).toBe('50')
    expect(sizeGroupWords(['46', '48'], 'ONE_GRID')).toBeNull()
  })
})

describe('planned work orders from the demand (PLN-067, PLN-069, PLN-089)', () => {
  const lineOf = (id: string, fields: Partial<PlanOrderLine> = {}): PlanOrderLine => ({ orderId: `so-${id}`, orderNumber: `SO-${id}`, orderLineId: `ol-${id}`, lineSeq: 10, styleId: 'style-JKT', colourwayId: 'cw-BLK', revisionId: 'rev-1', sizes: [{ size: '48', pieces: 2 }, { size: '50', pieces: 4 }, { size: '52', pieces: 2 }], dueDate: '2026-12-10', ...fields })
  const lines = [lineOf('1'), lineOf('2', { sizes: [{ size: '50', pieces: 1 }] }), lineOf('3', { revisionId: 'rev-2' }), lineOf('4', { madeToMeasure: true, sizes: [{ size: '50', pieces: 1 }] })]
  const own = (id: string) => (id === 'ol-3' ? 'rev-2' : null)

  it('to make = ordered − on work orders − pegged by kept planned orders; made-to-measure units are W1’s', () => {
    const cells = openCells(lines, own, [{ orderLineId: 'ol-1', size: '50', pieces: 3 }], [{ orderId: 'so-1', orderLineId: 'ol-1', size: '52', pieces: 2 }])
    expect(cells.map((cell) => `${cell.line.orderLineId}:${cell.size}:${cell.pieces}`)).toEqual(['ol-1:48:2', 'ol-1:50:1', 'ol-2:50:1', 'ol-3:48:2', 'ol-3:50:4', 'ol-3:52:2'])
  })

  it('one planned order per style, named revision, colourway and due date; split by size groups; SUBCONTRACT when a workshop does steps', () => {
    const cells = openCells(lines, own, [], [])
    const outside = (revisionId: string) => (revisionId === 'rev-2' ? outsideWorkOf([{ seq: 10, supplierId: null, transitDays: null }, { seq: 20, supplierId: 'ws-1', transitDays: 3 }, { seq: 30, supplierId: 'ws-1', transitDays: 1 }, { seq: 40, supplierId: 'ws-2', transitDays: 2 }], () => ({ usable: true, why: null })) : null)
    const grid = proposeWork({ cells, runDate: '2026-11-12', rule: 'ONE_GRID', groups: [], sizesOf: () => ['48', '50', '52'], outsideOf: outside })
    expect(grid.map((row) => [row.kind, row.styleRevisionId, row.sizes.map((size) => `${size.size}x${size.quantity}`).join(' '), row.quantity, row.partyId, row.operationSeqs.join(',')])).toEqual([
      ['MAKE', null, '48x2 50x5 52x2', 9, null, ''],
      ['SUBCONTRACT', 'rev-2', '48x2 50x4 52x2', 8, 'ws-1', '20,30'],
    ])
    // B-W2b-306 (PLN-083): each demand says the day it is needed (the row's key day).
    expect(grid[0]!.demand.map(({ needDate: _needDate, ...entry }) => entry)).toEqual([
      { orderId: 'so-1', orderLineId: 'ol-1', size: '48', pieces: 2 },
      { orderId: 'so-1', orderLineId: 'ol-1', size: '50', pieces: 4 },
      { orderId: 'so-1', orderLineId: 'ol-1', size: '52', pieces: 2 },
      { orderId: 'so-2', orderLineId: 'ol-2', size: '50', pieces: 1 },
    ])
    expect(grid[0]!.demand.every((entry) => entry.needDate === grid[0]!.dueDate)).toBe(true)
    expect(grid[1]!.transitDays).toBe(4)
    const split = proposeWork({ cells, runDate: '2026-11-12', rule: 'SIZE_GROUPS', groups: [['48', '50'], ['52', '54']], sizesOf: () => ['48', '50', '52'], outsideOf: () => null })
    expect(split.map((row) => `${row.sizeGroup}:${row.quantity}`)).toEqual(['48-50:7', '52-54:2', '48-50:6', '52-54:2'])
    // A workshop that may not get work: the order is made in-house.
    const held = proposeWork({ cells, runDate: '2026-11-12', rule: 'ONE_GRID', groups: [], sizesOf: () => ['48', '50', '52'], outsideOf: () => outsideWorkOf([{ seq: 20, supplierId: 'ws-9', transitDays: 1 }], () => ({ usable: false, why: 'WS-9 is blocked.' })) })
    expect(held.every((row) => row.kind === 'MAKE')).toBe(true)
    // B-W2b-365: the outside work of the cells each planned order makes: a workshop step only for size 52 goes out with that group only.
    const forSize52 = (_revisionId: string, mine: readonly { readonly size: string }[]) => (mine.some((cell) => cell.size === '52') ? outsideWorkOf([{ seq: 20, supplierId: 'ws-1', transitDays: 2 }], () => ({ usable: true, why: null })) : null)
    const bySize = proposeWork({ cells: cells.filter((cell) => cell.line.orderLineId === 'ol-1'), runDate: '2026-11-12', rule: 'SIZE_GROUPS', groups: [['48', '50'], ['52', '54']], sizesOf: () => ['48', '50', '52'], outsideOf: forSize52 })
    expect(bySize.map((row) => [row.sizeGroup, row.kind, row.operationSeqs.join(',')])).toEqual([
      ['48-50', 'MAKE', ''],
      ['52-54', 'SUBCONTRACT', '20'],
    ])
  })

  it('a work order of the demand, the lead time, and what holds a row', () => {
    expect(workOrderLinesOf([{ orderId: 'so-1', orderLineId: 'ol-1', size: '48', pieces: 2 }, { orderId: 'so-1', orderLineId: 'ol-1', size: '50', pieces: 4 }, { orderId: 'so-2', orderLineId: 'ol-2', size: '50', pieces: 1 }])).toEqual([
      { salesOrderLineId: 'ol-1', sizes: [{ size: '48', quantity: 2 }, { size: '50', quantity: 4 }] },
      { salesOrderLineId: 'ol-2', sizes: [{ size: '50', quantity: 1 }] },
    ])
    expect(inHouseDays([{ standardMinutes: '60', outside: false }, { standardMinutes: '600', outside: true }], 9)).toBe(2)
    expect(inHouseDays([], 9)).toBe(1)
    expect(convertProblem({ status: 'CONVERTED', demand: [], workOrderNumber: 'WO-9' })).toContain('WO-9')
    expect(convertProblem({ status: 'PLANNED', demand: [] })).toContain('stock')
    expect(convertProblem({ status: 'PLANNED', demand: [{ orderId: 'a', orderLineId: 'b', size: '50', pieces: 1 }] })).toBeNull()
    expect(firmProblem({ status: 'PLANNED', firm: true }, true)).toContain('firm already')
    // B-W2b-306 (PLN-076): a protected row is no longer kept whole (the run rewrites its other fields); a firm one is.
    expect(keptByRun({ status: 'PLANNED', firm: false, protectedFields: ['dueDate'] })).toBe(false)
    expect(keptByRun({ status: 'PLANNED', firm: true, protectedFields: [] })).toBe(true)
    expect(keptByRun({ status: 'CONVERTED', firm: true, protectedFields: [] })).toBe(false)
  })
})

describe('the catalogues', () => {
  it('declares planning.planned.convert for the planner and the production manager, and the three events', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(PLANNING_PLANNED_CONVERT)).toBe(true)
    const holds = (key: string) => ROLE_TEMPLATES.find((role) => role.key === key)?.permissions.includes(PLANNING_PLANNED_CONVERT)
    expect(holds('planner')).toBe(true)
    expect(holds('production_manager')).toBe(true)
    expect(holds('read_only')).toBe(false)
    for (const type of ['planned_work_orders.planned', 'planned_work_order.converted', 'planned_work_order.firmed']) expect(EVENT_CATALOGUE.find(type, 1)).toBeDefined()
  })
})
