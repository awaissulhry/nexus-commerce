import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../shell/design-data'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import { SITES } from '../board/fixtures'
import type { LeatherNeed, LeatherProtectors, LeatherYield, NeedRow, ProtectorRow, YieldRow } from './api'
import { leatherCan, type LeatherControls } from './model'
import type { LeatherModel } from './view-model'
import { LeatherView } from './view/LeatherView'

/**
 * SCR-252 Leather & cut plan with made-up data: an invented site, styles ("JKT-DEMO-07 Giacca Demo"), leathers ("DEMO-LEA-01
 * Nappa"), lots ("LOT-DEMO-221"), protectors ("DEMO-PRT-03"), orders ("SO-DEMO-1043"). Nothing here is a real company, supplier,
 * person or number. Drawn inside the Office shell with the role's navigation; the role decides what is held.
 */

const uid = (block: string, n: number) => `0190f0e3-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number, minute = 0, month = 11) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
const SITE = SITES[0]!
const SITE_VIEW = { id: SITE.id, code: SITE.code, name: SITE.name, timeZone: 'Europe/Rome' }
export const RUN = { id: uid('5501', 1), finishedAt: at(16, 6, 2), orderLines: 9 }
const LEATHER = { id: uid('7171', 1), code: 'DEMO-LEA-01', name: 'Nappa bovina 1,2 mm', baseUom: 'FT2', thicknessMinMm: '1.10', thicknessMaxMm: '1.30' }
const BLACK = { id: uid('7272', 1), code: 'BLK', name: 'Nero' }
const STYLE = { id: uid('6161', 1), code: 'JKT-DEMO-07', name: 'Giacca Demo Strada' }
const STYLE2 = { id: uid('6161', 2), code: 'JKT-DEMO-12', name: 'Giacca Demo Pista' }
const STYLE3 = { id: uid('6161', 3), code: 'PNT-DEMO-03', name: 'Pantalone Demo' }
const lot = (n: number, code: string, shade: string, free: string, count: number, ordersOwn = false) => ({ key: `${uid('8181', n)}|${shade}`, lotId: uid('8181', n), lotCode: code, shadeLabel: shade, free, count, ordersOwn })
const L221 = lot(1, 'LOT-DEMO-221', '2', '412.0000', 8)
const L230 = lot(2, 'LOT-DEMO-230', '3', '188.0000', 4)
const L244 = lot(3, 'LOT-DEMO-244', '2', '96.0000', 2)

const sizes = (pairs: [string, number, string, string][]) => pairs.map(([size, pieces, area, issued]) => ({ size, pieces, area, issued }))

function needRow(n: number, over: Partial<NeedRow>): NeedRow {
  return {
    id: `${uid('9101', n)}:${LEATHER.id}:${BLACK.id}`,
    order: { id: uid('9001', n), number: `SO-DEMO-10${40 + n}` },
    orderLine: { id: uid('9101', n), seq: 10, dueDate: `2026-12-${String(n + 3).padStart(2, '0')}` },
    style: STYLE,
    revision: { id: uid('6262', 1), revision: 3, status: 'RELEASED' },
    colourway: { id: uid('6363', 1), code: 'BLK', name: 'Nero' },
    item: LEATHER,
    colour: BLACK,
    requirement: { id: uid('5502', 1), version: 1, decision: 'OPEN', suggestedQuantity: '14.0000', suggestedUom: 'HIDE' },
    sizes: sizes([
      ['48', 4, '201.6000', '0.0000'],
      ['50', 6, '313.2000', '0.0000'],
      ['52', 4, '218.4000', '0.0000'],
    ]),
    parts: [
      {
        part: 'Outer shell',
        sizes: [
          { size: '48', area: '160.0000' },
          { size: '50', area: '252.0000' },
          { size: '52', area: '176.0000' },
        ],
      },
      {
        part: 'Collar',
        sizes: [
          { size: '48', area: '41.6000' },
          { size: '50', area: '61.2000' },
          { size: '52', area: '42.4000' },
        ],
      },
    ],
    pieces: 14,
    area: '733.2000',
    issued: '0.0000',
    reserved: '0.0000',
    toFind: '733.2000',
    netArea: '654.6429',
    lossPct: '10.71',
    lossSource: 'BOM',
    hides: 14,
    gradeMix: [
      { code: 'A', pct: '58.00', area: '403.6000' },
      { code: 'B', pct: '30.00', area: '208.8000' },
      { code: null, pct: '12.00', area: '83.6000' },
    ],
    workOrders: [],
    heldLots: [],
    feasibility: 'MUST_BUY',
    best: L221,
    split: null,
    buy: { area: '321.2000', hides: 7, lotCode: 'LOT-DEMO-221', shadeLabel: '2' },
    proposal: null,
    lots: [L221, L230, L244],
    demand: { workOrderId: null, salesOrderLineId: uid('9101', n) },
    currency: 'EUR',
    ...over,
  }
}

const FITS = needRow(1, {
  feasibility: 'FITS',
  sizes: sizes([
    ['48', 2, '100.8000', '0.0000'],
    ['50', 2, '104.4000', '0.0000'],
  ]),
  parts: [{ part: 'Outer shell', sizes: [{ size: '48', area: '100.8000' }, { size: '50', area: '104.4000' }] }],
  pieces: 4,
  area: '205.2000',
  toFind: '205.2000',
  netArea: '183.2143',
  hides: 4,
  buy: null,
  proposal: { hideIds: [uid('8282', 1), uid('8282', 2), uid('8282', 3), uid('8282', 4)], count: 4, area: '208.6000' },
  workOrders: [{ id: uid('9301', 1), number: 'WO-DEMO-0042' }],
  demand: { workOrderId: uid('9301', 1), salesOrderLineId: null },
})
const SPLIT = needRow(2, {
  style: STYLE2,
  feasibility: 'SPLIT',
  area: '540.0000',
  toFind: '540.0000',
  hides: 11,
  sizes: sizes([
    ['46', 3, '150.0000', '0.0000'],
    ['48', 3, '160.0000', '0.0000'],
    ['50', 2, '110.0000', '0.0000'],
    ['52', 2, '120.0000', '0.0000'],
  ]),
  pieces: 10,
  parts: [{ part: 'Outer shell', sizes: [{ size: '46', area: '150.0000' }, { size: '48', area: '160.0000' }, { size: '50', area: '110.0000' }, { size: '52', area: '120.0000' }] }],
  split: [
    { lotKey: L221.key, lotId: L221.lotId, lotCode: L221.lotCode, shadeLabel: '2', sizes: ['46', '48', '50'], area: '420.0000' },
    { lotKey: L230.key, lotId: L230.lotId, lotCode: L230.lotCode, shadeLabel: '3', sizes: ['52'], area: '120.0000' },
  ],
  buy: { area: '128.0000', hides: 3, lotCode: 'LOT-DEMO-221', shadeLabel: '2' },
})
const MUST_BUY = needRow(3, { style: STYLE3, colourway: { id: uid('6363', 2), code: 'BRN', name: 'Testa di moro' } })
const ASK = needRow(4, {
  feasibility: 'ASK_CUSTOMER',
  area: '160.0000',
  issued: '60.0000',
  reserved: '50.0000',
  toFind: '50.0000',
  hides: 1,
  heldLots: [
    { lotCode: 'LOT-DEMO-221', shadeLabel: '2' },
    { lotCode: 'LOT-DEMO-230', shadeLabel: '3' },
  ],
  lots: [{ ...L221, ordersOwn: true }, L230],
  best: { ...L221, ordersOwn: true },
  buy: null,
  workOrders: [{ id: uid('9301', 2), number: 'WO-DEMO-0045' }],
  demand: { workOrderId: uid('9301', 2), salesOrderLineId: null },
})
const COVERED = needRow(5, { style: STYLE2, feasibility: 'COVERED', area: '98.0000', issued: '50.0000', reserved: '48.0000', toFind: '0.0000', hides: 0, buy: null, heldLots: [{ lotCode: 'LOT-DEMO-244', shadeLabel: '2' }], lots: [{ ...L244, ordersOwn: true }], best: { ...L244, ordersOwn: true } })
const NEED_ROWS = [FITS, SPLIT, MUST_BUY, ASK, COVERED]
const NEED: LeatherNeed = { site: SITE_VIEW, run: RUN, rule: 'ORDER', rows: NEED_ROWS }
const withValue = (rows: readonly NeedRow[]): NeedRow[] => rows.map((row, index) => ({ ...row, value: [86_184, 226_800, 307_944, 21_000, 0][index] ?? null }))

const protector = (n: number, over: Partial<ProtectorRow>): ProtectorRow => ({
  id: `p-${n}`,
  order: { id: uid('9001', n), number: `SO-DEMO-10${40 + n}` },
  orderLine: { id: uid('9101', n), seq: 10, dueDate: `2026-12-${String(n + 3).padStart(2, '0')}` },
  style: STYLE,
  colourway: { id: uid('6363', 1), code: 'BLK', name: 'Nero' },
  placement: 'Shoulder pockets',
  sizes: [
    { size: '48', pieces: 2 },
    { size: '50', pieces: 2 },
  ],
  item: { id: uid('7373', 1), code: 'DEMO-PRT-03', name: 'Protezione spalla livello 2', baseUom: 'PCS' },
  needed: '8.0000',
  certificate: { id: uid('7474', 1), number: 'CERT-DEMO-1621-07', standard: 'EN 1621-1:2012', validTo: '2027-06-30' },
  lots: { count: 2, available: '140.0000', withCertificate: 2 },
  state: 'OK',
  substitutes: [],
  ...over,
})
const PROTECTOR_ROWS: ProtectorRow[] = [
  protector(1, {}),
  protector(2, { style: STYLE2, placement: 'Elbows', item: { id: uid('7373', 2), code: 'DEMO-PRT-05', name: 'Protezione gomito livello 1', baseUom: 'PCS' }, certificate: null, state: 'NO_CERTIFICATE', substitutes: [{ id: uid('7373', 1), code: 'DEMO-PRT-03', name: 'Protezione spalla livello 2' }] }),
  protector(3, { certificate: { id: uid('7474', 2), number: 'CERT-DEMO-1621-02', standard: 'EN 1621-1:2012', validTo: '2026-12-01' }, state: 'EXPIRES_BEFORE_DUE', orderLine: { id: uid('9101', 3), seq: 20, dueDate: '2026-12-10' } }),
  protector(4, { style: STYLE3, placement: 'Back', item: { id: uid('7373', 4), code: 'DEMO-PRT-09', name: 'Paraschiena livello 2', baseUom: 'PCS' }, needed: '12.0000', lots: { count: 1, available: '6.0000', withCertificate: 0 }, state: 'SHORT', substitutes: [{ id: uid('7373', 1), code: 'DEMO-PRT-03', name: 'Protezione spalla livello 2' }, { id: uid('7373', 2), code: 'DEMO-PRT-05', name: 'Protezione gomito livello 1' }] }),
]
const PROTECTORS: LeatherProtectors = { site: SITE_VIEW, run: RUN, rows: PROTECTOR_ROWS }

const yieldRow = (over: Partial<YieldRow>): YieldRow => ({
  style: STYLE,
  revision: { id: uid('6262', 1), revision: 3 },
  draft: null,
  hides: 7,
  cuts: 9,
  plannedArea: '612.0000',
  actualArea: '640.5000',
  uom: 'FT2',
  plannedLossPct: '12.00',
  plannedSource: 'STYLE',
  actualLossPct: '14.20',
  trend: [
    { workOrder: 'WO-DEMO-0031', lossPct: '12.60' },
    { workOrder: 'WO-DEMO-0035', lossPct: '13.40' },
    { workOrder: 'WO-DEMO-0038', lossPct: '14.80' },
    { workOrder: 'WO-DEMO-0042', lossPct: '15.10' },
  ],
  proposal: { state: 'PROPOSED', fromPct: '12.00', toPct: '14.00', cuts: 9 },
  lastDecision: null,
  currency: 'EUR',
  ...over,
})
const DRIFT = yieldRow({})
const DRIFT_DRAFT = yieldRow({ style: STYLE2, draft: { id: uid('6262', 9), revision: 4, version: 6 }, actualLossPct: '9.70', plannedLossPct: '13.04', plannedSource: 'BOM', proposal: { state: 'PROPOSED', fromPct: '13.04', toPct: '10.00', cuts: 12 }, cuts: 12, hides: 10 })
const IN_LINE = yieldRow({ style: STYLE3, actualLossPct: '12.40', proposal: { state: 'IN_LINE', fromPct: '12.00', toPct: '12.00', cuts: 6 }, cuts: 6 })
const TOO_FEW = yieldRow({ style: { id: uid('6161', 4), code: 'GLV-DEMO-01', name: 'Guanto Demo' }, cuts: 3, hides: 2, trend: [{ workOrder: 'WO-DEMO-0050', lossPct: '18.00' }], actualLossPct: '18.00', proposal: { state: 'TOO_FEW', fromPct: '15.00', toPct: null, cuts: 3 } })
const YIELD_ROWS = [DRIFT, DRIFT_DRAFT, IN_LINE, TOO_FEW]
const YIELD: LeatherYield = { site: SITE_VIEW, from: at(19, 23, 0, 5), minCuts: 5, driftPoints: '1.00', maxLossPct: '37.50', rows: YIELD_ROWS }

export interface LeatherCase {
  model: LeatherModel
  permissions: readonly string[]
}

function inShell(page: ReactNode, permissions: readonly string[]): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissions)),
    path: '/planning/leather',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/planning/leather' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

function LeatherDesign({ model }: { model: LeatherCase }) {
  return inShell(createElement(LeatherView, { model: model.model }), model.permissions)
}

/** The planner with the reserve, Draft PO and note rights a planning office usually has beside the template (made up). */
const PLANNER = [...rolePermissions('planner'), 'planning.leather.manage', 'inventory.reserve', 'threads.post']
const OWNER = [...rolePermissions('owner'), 'planning.leather.manage', 'money.cost']

function make(over: Partial<LeatherModel> = {}, permissions: readonly string[] = PLANNER): LeatherCase {
  const controls: LeatherControls = { site: SITE.id, tile: null, feas: 'all', q: '', open: null, ...(over.controls ?? {}) }
  return {
    permissions,
    model: {
      prefix: '/w/DEMO',
      can: leatherCan(permissions),
      seesCost: permissions.includes('money.cost'),
      sites: { status: 'ready', value: [SITE] },
      siteId: SITE.id,
      need: { status: 'ready', value: NEED },
      protectors: { status: 'ready', value: PROTECTORS },
      yields: { status: 'ready', value: YIELD },
      live: 'live',
      updates: 0,
      running: false,
      acting: null,
      notice: null,
      dialog: null,
      timeZone: 'Europe/Rome',
      ...over,
      controls,
    },
  }
}

const open = (row: NeedRow) => ({ controls: { site: SITE.id, tile: null, feas: 'all' as const, q: '', open: row.id } })

export const designScreen = defineDesignScreen<LeatherCase>({
  screen: 'SCR-252',
  title: 'Leather & cut plan',
  view: LeatherDesign,
  cases: [
    { id: 'planner', label: 'The planner: need per order, protectors, yield', model: make(), note: 'Tiles are saved filters; the pill opens the shade drawer (Enter too); b drafts the PO of a Must buy line; Accept / Dismiss on a proposal.' },
    { id: 'tile-orders', label: 'Tile Orders needing leather pressed', model: make({ controls: { site: SITE.id, tile: 'orders', feas: 'all', q: '', open: null } }) },
    { id: 'tile-shade', label: 'Tile Cannot be cut from one shade pressed', model: make({ controls: { site: SITE.id, tile: 'shade', feas: 'all', q: '', open: null } }) },
    { id: 'tile-protectors', label: 'Tile Protectors without a valid certificate pressed', model: make({ controls: { site: SITE.id, tile: 'protectors', feas: 'all', q: '', open: null } }) },
    { id: 'tile-drift', label: 'Tile Styles whose yield drifted pressed', model: make({ controls: { site: SITE.id, tile: 'drift', feas: 'all', q: '', open: null } }) },
    { id: 'filter-split', label: 'One shade filter: Split by garment', model: make({ controls: { site: SITE.id, tile: null, feas: 'SPLIT', q: '', open: null } }) },
    { id: 'search-empty', label: 'A search that matches nothing', model: make({ controls: { site: SITE.id, tile: null, feas: 'all', q: 'zzz', open: null } }) },
    { id: 'drawer-fits', label: 'Drawer: fits one shade — reserve 4 hides of LOT-DEMO-221', model: make(open(FITS)) },
    { id: 'drawer-split', label: 'Drawer: split by garment (46–50 from LOT-DEMO-221, 52 from LOT-DEMO-230)', model: make(open(SPLIT)) },
    { id: 'drawer-buy', label: 'Drawer: must buy 321 ft² of shade 2', model: make(open(MUST_BUY)) },
    { id: 'drawer-ask', label: 'Drawer: the order holds two shade lots — ask the customer', model: make(open(ASK)) },
    { id: 'drawer-covered', label: 'Drawer: covered, nothing to choose', model: make(open(COVERED)) },
    { id: 'drawer-reserved', label: 'Drawer: after Reserve the hides', model: make({ ...open(FITS), drawerNotice: { tone: 'success', key: 'notice.reserved', params: { count: 4, lot: 'LOT-DEMO-221' } } }) },
    { id: 'drawer-refused', label: 'Drawer: reserve refused (another shade lot)', model: make({ ...open(SPLIT), drawerNotice: { tone: 'danger', key: 'refusal.shade' } }) },
    { id: 'drawer-held', label: 'Drawer held: a planner without reserve, Draft PO or note rights', model: make(open(SPLIT), [...rolePermissions('planner'), 'planning.leather.manage']) },
    { id: 'accept', label: 'Change cutting loss for style JKT-DEMO-07 (no draft revision)', model: make({ dialog: { kind: 'accept', styleId: STYLE.id, busy: false, problem: null } }) },
    { id: 'accept-draft', label: 'Change cutting loss into the draft revision 4', model: make({ dialog: { kind: 'accept', styleId: STYLE2.id, busy: false, problem: null } }) },
    { id: 'accept-moved', label: 'Accept refused: the proposal moved', model: make({ dialog: { kind: 'accept', styleId: STYLE.id, busy: false, problem: 'refusal.moved' } }) },
    { id: 'accepted', label: 'After Accept: recorded, waits for a draft revision', model: make({ notice: { tone: 'success', key: 'notice.acceptedRecorded', params: { style: STYLE.code } }, yields: { status: 'ready', value: { ...YIELD, rows: [{ ...DRIFT, proposal: { ...DRIFT.proposal, state: 'ACCEPTED' }, lastDecision: { decision: 'ACCEPTED', toPct: '14.00', cuts: 9, at: at(16, 9, 30), reason: null, revision: null } }, ...YIELD_ROWS.slice(1)] } } }) },
    { id: 'dismiss', label: 'Dismiss with a reason: held until 3 characters', model: make({ dialog: { kind: 'dismiss', styleId: STYLE.id, reason: 'no', busy: false, problem: null } }) },
    { id: 'dismissed', label: 'A dismissed proposal stays quiet', model: make({ yields: { status: 'ready', value: { ...YIELD, rows: [{ ...DRIFT, proposal: { ...DRIFT.proposal, state: 'DISMISSED' }, lastDecision: { decision: 'DISMISSED', toPct: '14.00', cuts: 9, at: at(15, 16, 0), reason: 'New knife since week 46 (made up).', revision: null } }, ...YIELD_ROWS.slice(1)] } } }) },
    { id: 'cost', label: 'With the cost grain (owner): the value columns', model: make({ need: { status: 'ready', value: { ...NEED, rows: withValue(NEED_ROWS) } }, yields: { status: 'ready', value: { ...YIELD, rows: YIELD_ROWS.map((row, index) => ({ ...row, extraLossValue: [23_940, 0, 0, 0][index] ?? null })) } } }, OWNER), note: 'Purchase prices and values only for money.cost; the planner and the warehouse never get the columns.' },
    { id: 'new-run', label: 'A newer run finished: Show', model: make({ updates: 1 }) },
    { id: 'running', label: 'Run plan now is going', model: make({ running: true }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: make({ dialog: { kind: 'keys' } }) },
    { id: 'keyboard', label: 'Keyboard: the keys sit in the footer icon', model: make({ focusRow: 1, keysOpen: true }) },
    { id: 'selection', label: 'Selection: Export 2', model: make({ selected: [FITS.id, SPLIT.id] }) },
    { id: 'no-run', label: 'First day: no plan run at this site yet', model: make({ need: { status: 'ready', value: { ...NEED, run: null, rows: [] } }, protectors: { status: 'ready', value: { ...PROTECTORS, run: null, rows: [] } }, yields: { status: 'ready', value: { ...YIELD, rows: [] } } }) },
    { id: 'empty', label: 'No open order needs leather; no cuts to learn from', model: make({ need: { status: 'ready', value: { ...NEED, rows: [] } }, protectors: { status: 'ready', value: { ...PROTECTORS, rows: [] } }, yields: { status: 'ready', value: { ...YIELD, rows: [] } } }) },
    { id: 'loading', label: 'Loading: tiles say —, sections skeleton', model: make({ need: { status: 'loading' }, protectors: { status: 'loading' }, yields: { status: 'loading' }, live: 'connecting' }) },
    { id: 'error', label: 'Couldn’t load each section (the others stay)', model: make({ need: { status: 'error', problem: 'error.offline' }, yields: { status: 'error', problem: 'error.failed' }, live: 'offline' }), note: 'A failed read is never drawn as empty; the protectors still show.' },
    { id: 'two-sites', label: 'Two sites: picked in the band', model: make({ sites: { status: 'ready', value: SITES } }) },
    { id: 'read-only', label: 'Production manager: reads; Accept and Dismiss held with the reason', model: make({}, rolePermissions('production_manager')) },
    { id: 'no-permission', label: 'Sales: no planning.view — the page says so', model: make({}, rolePermissions('sales')) },
  ],
})

export const FIXTURES = { NEED, PROTECTORS, YIELD, FITS, SPLIT, MUST_BUY, ASK, COVERED, DRIFT, DRIFT_DRAFT, IN_LINE, TOO_FEW }
