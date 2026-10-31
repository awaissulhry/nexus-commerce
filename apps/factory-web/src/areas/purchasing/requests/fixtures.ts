import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, COLOURS, inShell, MATERIALS, PREFIX, ROLES, SITE, SITE_SOUTH, SUPPLIERS, TIME_ZONE, uid, type Role } from '../../_shared/buying/fixtures'
import { phrase } from '../../_shared/buying/model'
import type { BuyRequest, ConvertPreview, Converted, RequestCounts, RequestDetail } from './api'
import { NO_FILTERS, requestsCan, type DraftModel, type Filters, type RejectModel, type RequestsModel } from './model'
import { RequestsView } from './view/RequestsView'

/**
 * SCR-236 — Requests to buy (design purchasing.requests) with made-up data only: an invented company ("Officina Demo"),
 * its sites, suppliers and materials (areas/_shared/buying/fixtures). The tiles, the queue of plan lines and reorder points
 * (open, held with the reason, in a PO, rejected), grouped by supplier or need week, the selection with Draft POs · Reject
 * · Export (held with the reason), the Request detail (netting, rounding, approved suppliers, on order, history), Draft POs
 * for n (cards per supplier and site, open draft or new, held requests first, no right, refused, done), Reject with
 * reason, live updates, offline, and the states. Roles: Owner, Buyer (with costs), Planner (rejects, no costs, does not
 * draft), Warehouse and Read-only (read, no money), Sales (no access).
 */

export interface Case {
  role: Role
  model: RequestsModel
}

const RUN = uid('8181', 1)
const RUN_AT = at(29, 6, 30)
const id = (kind: 'plan' | 'reorder', n: number) => `${kind}:${uid(kind === 'plan' ? '8282' : '8383', n)}`

type Over = Partial<BuyRequest> & { n: number }
const sup = (key: keyof typeof SUPPLIERS) => ({ id: SUPPLIERS[key].id, code: SUPPLIERS[key].code, name: SUPPLIERS[key].legalName, status: SUPPLIERS[key].status })
const item = (key: keyof typeof MATERIALS, crVi = false) => ({ ...MATERIALS[key], requiresCrViTest: crVi })

function plan(over: Over): BuyRequest {
  const { n, ...rest } = over
  return {
    id: id('plan', n),
    kind: 'PLAN',
    refId: uid('8282', n),
    version: 3,
    status: 'OPEN',
    companyId: SITE.companyId,
    siteId: SITE.id,
    site: { code: SITE.code, name: SITE.name },
    item: item('leather', true),
    colour: COLOURS.black,
    needDate: '2026-11-09',
    needWeek: '2026-W46',
    orderBy: { date: '2026-11-02', leadTimeDays: 5, passed: false, closedDaysSkipped: 2 },
    quantity: '420',
    uom: 'FT2',
    baseQuantity: '420',
    baseUom: 'FT2',
    estimatedHides: 8,
    quantityFrom: 'SOURCE',
    rounding: [
      { rule: 'MINIMUM', quantity: '400' },
      { rule: 'MULTIPLE', quantity: '420' },
    ],
    supplier: sup('tannery'),
    supplierFrom: 'SOURCE',
    sourceId: uid('8484', 1),
    approvedSuppliers: 2,
    supplierArticleCode: 'ART-NAP-12',
    supplierColourCode: 'N01',
    currency: 'EUR',
    unitPrice: '4.200000',
    expectedAmount: 176400,
    hold: null,
    warnings: [],
    plan: {
      runId: RUN,
      runStatus: 'DONE',
      runStartedAt: RUN_AT,
      trigger: 'MANUAL',
      why: 'need − usable − on order = short',
      grossQuantity: '520',
      usableStock: '60',
      heldStock: '35',
      onOrder: '62',
      netQuantity: '398',
      suggestedQuantity: '398',
      suggestedUom: 'FT2',
      orders: [{ id: uid('9191', 1), number: 'SO-DEMO-0101' }],
      workOrders: ['WO-DEMO-0221', 'WO-DEMO-0225'],
      firm: false,
      decidedAt: null,
      setAside: null,
      purchaseOrder: null,
    },
    reorder: null,
    ...rest,
  }
}

function reorder(over: Over): BuyRequest {
  const { n, ...rest } = over
  return {
    ...plan({ n }),
    id: id('reorder', n),
    kind: 'REORDER',
    refId: uid('8383', n),
    version: 2,
    item: item('zip'),
    colour: null,
    needDate: '2026-11-05',
    needWeek: '2026-W45',
    orderBy: { date: '2026-10-29', leadTimeDays: 7, passed: false, closedDaysSkipped: 0 },
    quantity: '200',
    uom: 'PCS',
    baseQuantity: '200',
    baseUom: 'PCS',
    estimatedHides: null,
    quantityFrom: 'SOURCE',
    rounding: [
      { rule: 'LOT_SIZE', quantity: '150' },
      { rule: 'MULTIPLE', quantity: '200' },
    ],
    supplier: sup('protector'),
    supplierFrom: 'SITE',
    approvedSuppliers: 1,
    supplierArticleCode: 'ZP-60',
    supplierColourCode: null,
    unitPrice: '1.850000',
    expectedAmount: 37000,
    plan: null,
    reorder: { method: 'REORDER_POINT', position: '22', usable: '40', onOrder: '0', reserved: '18', level: '24', triggered: true, quantity: '150', why: 'position at or below the point', note: null },
    ...rest,
  }
}

const LEATHER = plan({ n: 1 })
const LINING = plan({
  n: 2,
  item: item('lining'),
  colour: COLOURS.grey,
  needDate: '2026-11-06',
  needWeek: '2026-W45',
  orderBy: { date: '2026-10-27', leadTimeDays: 8, passed: true, closedDaysSkipped: 0 },
  quantity: '120',
  uom: 'M',
  baseQuantity: '120',
  baseUom: 'M',
  estimatedHides: null,
  quantityFrom: 'PLAN',
  rounding: [],
  supplier: sup('fabric'),
  supplierFrom: 'DEFAULT',
  approvedSuppliers: 0,
  sourceId: null,
  supplierArticleCode: null,
  supplierColourCode: null,
  unitPrice: '6.500000',
  expectedAmount: 78000,
  warnings: [{ code: 'ORDER_BY_PASSED', message: 'x' }],
})
const PROTECTOR = plan({
  n: 3,
  item: item('protector'),
  colour: null,
  needDate: '2026-11-18',
  needWeek: '2026-W47',
  orderBy: { date: '2026-11-04', leadTimeDays: 10, passed: false, closedDaysSkipped: 0 },
  quantity: '48',
  uom: 'PCS',
  baseQuantity: '48',
  baseUom: 'PCS',
  estimatedHides: null,
  quantityFrom: 'FIRM',
  rounding: [],
  supplier: sup('protector'),
  supplierFrom: 'FIRM',
  approvedSuppliers: 1,
  unitPrice: '9.900000',
  expectedAmount: 47520,
  plan: { ...LEATHER.plan!, firm: true, workOrders: [], orders: [{ id: uid('9191', 2), number: 'SO-DEMO-0104' }], grossQuantity: '48', usableStock: '0', heldStock: '0', onOrder: '0', netQuantity: '48', suggestedQuantity: '48', suggestedUom: 'PCS' },
})
const ZIP = reorder({ n: 1 })
const RED = plan({ n: 4, colour: COLOURS.red, supplier: null, supplierFrom: null, sourceId: null, approvedSuppliers: 2, unitPrice: null, expectedAmount: null, currency: null, hold: { code: 'NO_SUPPLIER', message: 'x' }, needDate: '2026-11-12', needWeek: '2026-W46' })
const PROSPECT = plan({
  n: 5,
  colour: COLOURS.grey,
  supplier: sup('prospect'),
  supplierFrom: 'CHOSEN',
  unitPrice: null,
  expectedAmount: null,
  needDate: '2026-11-20',
  needWeek: '2026-W47',
  warnings: [
    { code: 'SUPPLIER_PROSPECT', message: 'x' },
    { code: 'NO_PRICE', message: 'x' },
  ],
})
const CONVERTED = plan({ n: 6, status: 'CONVERTED', item: item('lining'), colour: COLOURS.black, quantity: '80', uom: 'M', baseQuantity: '80', baseUom: 'M', estimatedHides: null, supplier: sup('fabric'), plan: { ...LEATHER.plan!, decidedAt: at(29, 9, 12), purchaseOrder: { id: uid('9292', 7), number: 'PO-DEMO-0007', status: 'DRAFT' } } })
const SET_ASIDE = plan({ n: 7, status: 'SET_ASIDE', colour: COLOURS.red, plan: { ...LEATHER.plan!, decidedAt: at(29, 10, 5), setAside: { reason: 'CUSTOMER_SUPPLIES', note: 'Il cliente porta la pelle rossa.' } } })
const BLOCKED = reorder({
  n: 2,
  item: item('protector'),
  supplier: sup('blocked'),
  siteId: SITE_SOUTH.id,
  site: { code: SITE_SOUTH.code, name: SITE_SOUTH.name },
  hold: { code: 'SUPPLIER_BLOCKED', message: 'x' },
  reorder: { method: 'MIN_MAX', position: '30', usable: '30', onOrder: '0', reserved: '0', level: '40', triggered: true, quantity: '70', why: 'below min', note: 'Scorta per le riparazioni.' },
  quantity: '70',
  rounding: [{ rule: 'UP_TO_MAXIMUM', quantity: '70' }],
})

export const OPEN_ROWS: BuyRequest[] = [ZIP, LINING, LEATHER, RED, PROTECTOR, PROSPECT, BLOCKED]
export const ALL_ROWS: BuyRequest[] = [...OPEN_ROWS, CONVERTED, SET_ASIDE]
export const COUNTS: RequestCounts = { asOf: at(30, 8, 15), open: 7, needWithin14Days: 5, waitingApproval: null, convertedToday: 1 }

const withoutCost = (row: BuyRequest): BuyRequest => {
  const { unitPrice: _price, expectedAmount: _amount, ...rest } = row
  return rest as BuyRequest
}

export const DETAIL_LEATHER: RequestDetail = {
  request: LEATHER,
  sources: [
    { id: uid('8484', 1), partyId: SUPPLIERS.tannery.id, supplier: { code: SUPPLIERS.tannery.code, name: SUPPLIERS.tannery.legalName, status: 'ACTIVE' }, preference: 'PRIMARY', purchaseUom: 'FT2', unitPrice: '4.200000', currency: 'EUR', minOrderQty: '400', orderMultiple: '20', leadTimeDays: 5, supplierArticleCode: 'ART-NAP-12' },
    { id: uid('8484', 2), partyId: SUPPLIERS.prospect.id, supplier: { code: SUPPLIERS.prospect.code, name: SUPPLIERS.prospect.legalName, status: 'PROSPECT' }, preference: 'BACKUP', purchaseUom: 'FT2', unitPrice: null, currency: 'EUR', minOrderQty: null, orderMultiple: null, leadTimeDays: null, supplierArticleCode: null },
  ],
  onOrder: [],
}
const DETAIL_ZIP: RequestDetail = { request: ZIP, sources: [{ ...DETAIL_LEATHER.sources[0]!, id: uid('8484', 3), partyId: SUPPLIERS.protector.id, supplier: { code: SUPPLIERS.protector.code, name: SUPPLIERS.protector.legalName, status: 'ACTIVE' }, purchaseUom: 'PCS', unitPrice: '1.850000', minOrderQty: '50', orderMultiple: '50', leadTimeDays: 7, supplierArticleCode: 'ZP-60' }], onOrder: [{ purchaseOrderId: uid('9292', 3), number: 'PO-DEMO-0003', status: 'SENT', openQuantity: '0' }] }
const DETAIL_RED: RequestDetail = { request: RED, sources: DETAIL_LEATHER.sources, onOrder: [] }
const DETAIL_CONVERTED: RequestDetail = { request: CONVERTED, sources: [], onOrder: [] }

const draftRef = (n: number, lines: number) => ({ id: uid('9292', n), number: `PO-DEMO-000${n}`, lineCount: lines })
export const PREVIEW: ConvertPreview = {
  cards: [
    {
      companyId: SITE.companyId,
      siteId: SITE.id,
      site: { code: SITE.code, name: SITE.name },
      supplier: sup('tannery'),
      currency: 'EUR',
      into: 'EXISTING',
      draft: draftRef(4, 2),
      openDraft: null,
      lines: [{ requestId: LEATHER.id, item: { id: LEATHER.item.id, code: LEATHER.item.code, name: LEATHER.item.name }, colour: COLOURS.black, quantity: '420', uom: 'FT2', needDate: '2026-11-09', unitPrice: '4.200000', expectedAmount: 176400, warnings: [] }],
      expectedAmount: 176400,
      mayDraft: true,
    },
    {
      companyId: SITE.companyId,
      siteId: SITE.id,
      site: { code: SITE.code, name: SITE.name },
      supplier: sup('fabric'),
      currency: 'EUR',
      into: 'NEW',
      draft: null,
      openDraft: draftRef(5, 4),
      lines: [{ requestId: LINING.id, item: { id: LINING.item.id, code: LINING.item.code, name: LINING.item.name }, colour: COLOURS.grey, quantity: '120', uom: 'M', needDate: '2026-11-06', unitPrice: '6.500000', expectedAmount: 78000, warnings: [{ code: 'ORDER_BY_PASSED', message: 'x' }] }],
      expectedAmount: 78000,
      mayDraft: true,
    },
    {
      companyId: SITE.companyId,
      siteId: SITE.id,
      site: { code: SITE.code, name: SITE.name },
      supplier: sup('protector'),
      currency: 'EUR',
      into: 'NEW',
      draft: null,
      openDraft: null,
      lines: [
        { requestId: ZIP.id, item: { id: ZIP.item.id, code: ZIP.item.code, name: ZIP.item.name }, colour: null, quantity: '200', uom: 'PCS', needDate: '2026-11-05', unitPrice: '1.850000', expectedAmount: 37000, warnings: [] },
        { requestId: PROTECTOR.id, item: { id: PROTECTOR.item.id, code: PROTECTOR.item.code, name: PROTECTOR.item.name }, colour: null, quantity: '48', uom: 'PCS', needDate: '2026-11-18', unitPrice: '9.900000', expectedAmount: 47520, warnings: [] },
      ],
      expectedAmount: 84520,
      mayDraft: true,
    },
  ],
  held: [],
}
const RESULT: Converted = {
  orders: [
    { id: uid('9292', 4), number: 'PO-DEMO-0004', created: false, companyId: SITE.companyId, siteId: SITE.id, supplierId: SUPPLIERS.tannery.id, lineIds: [uid('9393', 1)], lineCount: 3 },
    { id: uid('9292', 8), number: 'PO-DEMO-0008', created: true, companyId: SITE.companyId, siteId: SITE.id, supplierId: SUPPLIERS.fabric.id, lineIds: [uid('9393', 2)], lineCount: 1 },
    { id: uid('9292', 9), number: 'PO-DEMO-0009', created: true, companyId: SITE.companyId, siteId: SITE.id, supplierId: SUPPLIERS.protector.id, lineIds: [uid('9393', 3), uid('9393', 4)], lineCount: 2 },
  ],
  lines: [LEATHER, LINING, ZIP, PROTECTOR].map((row, index) => ({ requestId: row.id, purchaseOrderId: uid('9292', [4, 8, 9, 9][index]!), purchaseOrderLineId: uid('9393', index + 1) })),
}

const DRAFT_IDS = [LEATHER.id, LINING.id, ZIP.id, PROTECTOR.id]
const draftOf = (over: Partial<DraftModel> = {}): DraftModel => ({ requestIds: DRAFT_IDS, suppliers: {}, preview: { status: 'ready', value: PREVIEW }, into: {}, busy: false, problem: null, result: null, ...over })
const rejectOf = (over: Partial<RejectModel> = {}): RejectModel => ({ requestIds: [LEATHER.id, LINING.id], reason: '', note: '', busy: false, problem: null, ...over })

function base(role: Role, over: Partial<RequestsModel> = {}): RequestsModel {
  const can = requestsCan(ROLES[role])
  const rows = over.rows ?? { items: OPEN_ROWS, more: false, matching: OPEN_ROWS.length, problem: null }
  return {
    prefix: PREFIX,
    can,
    view: 'open',
    filters: NO_FILTERS,
    counts: { value: COUNTS, problem: null },
    sites: [SITE, SITE_SOUTH],
    asOf: at(30, 8, 15),
    live: 'live',
    offline: false,
    updates: 0,
    notice: null,
    detail: null,
    draft: null,
    reject: null,
    timeZone: TIME_ZONE,
    ...over,
    rows: can.cost ? rows : { ...rows, items: rows.items?.map(withoutCost) ?? null },
  }
}
const make = (role: Role, over: Partial<RequestsModel> = {}): Case => ({ role, model: base(role, over) })
const rowsOf = (items: BuyRequest[] | null, problem: string | null = null) => ({ items, more: false, matching: items?.length ?? null, problem })
const filters = (over: Partial<Filters>): Filters => ({ ...NO_FILTERS, ...over })
const detail = (requestId: string, value: RequestDetail | null, status: 'ready' | 'loading' | 'error' = 'ready', supplierId: string | null = null): RequestsModel['detail'] => ({
  requestId,
  detail: status === 'ready' && value ? { status: 'ready', value } : status === 'error' ? { status: 'error', problem: 'problem.offline' } : { status: 'loading' },
  supplierId,
})
const SELECTED = [ZIP.id, LINING.id, LEATHER.id]

function RequestsDesign({ model }: { model: Case }) {
  return inShell('/purchasing/requests', createElement(RequestsView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-236',
  title: 'Requests to buy (the queue, a request, Draft POs for n, Reject with reason)',
  view: RequestsDesign,
  cases: [
    // ---- the queue ----
    { id: 'open', label: 'Open requests with values (buyer)', model: make('buyer'), note: 'Plan lines and reorder points in one queue. A held row says why on its box; the value column is the cost grain.' },
    { id: 'group-supplier', label: 'Grouped by supplier', model: make('buyer', { filters: filters({ group: 'supplier' }) }), note: 'Group ▾: the rows sorted by supplier, the group’s name and count on its first row.' },
    { id: 'group-week', label: 'Grouped by need week', model: make('buyer', { filters: filters({ group: 'week' }) }) },
    { id: 'selected', label: 'Three selected: Draft POs · Reject · Export', model: make('buyer', { selected: SELECTED }), note: 'The toolbar swaps to the bulk actions. Reject is held: a reorder point cannot be rejected.' },
    { id: 'selected-plan', label: 'Plan rows selected: Reject allowed', model: make('buyer', { selected: [LEATHER.id, LINING.id] }) },
    { id: 'tile-need14', label: 'Tile: need date within 14 days', model: make('buyer', { view: 'need14', rows: rowsOf([ZIP, LINING, LEATHER, RED]) }) },
    { id: 'view-held', label: 'Rows ▾: open, cannot be drafted now', model: make('buyer', { view: 'held', rows: rowsOf([RED, BLOCKED]) }) },
    { id: 'tile-converted', label: 'Tile: converted (in a purchase order)', model: make('buyer', { view: 'converted', rows: rowsOf([CONVERTED]) }) },
    { id: 'view-rejected', label: 'Rows ▾: rejected', model: make('buyer', { view: 'setAside', rows: rowsOf([SET_ASIDE]) }) },
    { id: 'kind-reorder', label: 'Kind ▾: reorder points only', model: make('buyer', { filters: filters({ kind: 'REORDER' }), rows: rowsOf([ZIP, BLOCKED]) }) },
    { id: 'updates', label: 'Live: 3 updates waiting', model: make('buyer', { updates: 3 }) },
    { id: 'notice-drafted', label: 'After Draft POs: the drafts made', model: make('buyer', { rows: rowsOf([RED, PROSPECT, BLOCKED]), notice: { tone: 'success', words: phrase('notice.drafted', { lines: 4, count: 3 }), orders: RESULT.orders.map((order) => ({ id: order.id, number: order.number })) } }) },
    { id: 'offline', label: 'Offline: Draft POs held', model: make('buyer', { offline: true, live: 'offline', selected: SELECTED }) },
    { id: 'empty', label: 'No open requests', model: make('buyer', { rows: rowsOf([]), counts: { value: { ...COUNTS, open: 0, needWithin14Days: 0, convertedToday: 0 }, problem: null } }) },
    { id: 'no-match', label: 'Nothing matches the search', model: make('buyer', { filters: filters({ q: 'velluto' }), rows: rowsOf([]) }) },
    { id: 'loading', label: 'Loading (tiles —, skeleton rows)', model: make('buyer', { rows: rowsOf(null), counts: { value: null, problem: null }, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'Couldn’t load requests', model: make('buyer', { rows: rowsOf(null, 'problem.offline') }) },
    { id: 'tiles-error', label: 'Couldn’t load the tiles (the list still shows)', model: make('buyer', { counts: { value: null, problem: 'problem.read' } }) },
    { id: 'keys', label: 'The keys in the footer’s info icon', model: make('buyer', { keysOpen: true }) },
    { id: 'help', label: 'Keyboard shortcuts (?)', model: make('buyer', { helpOpen: true }) },
    // ---- a request ----
    { id: 'detail-plan', label: 'Request: a plan line (netting, rounding, approved suppliers)', model: make('buyer', { detail: detail(LEATHER.id, DETAIL_LEATHER) }), note: 'J / K walk the rows; b drafts this one; the source record opens in a new tab.' },
    { id: 'detail-picked', label: 'Request: another approved supplier picked', model: make('buyer', { detail: detail(LEATHER.id, DETAIL_LEATHER, 'ready', SUPPLIERS.prospect.id) }) },
    { id: 'detail-reorder', label: 'Request: a reorder point (position, on order)', model: make('buyer', { detail: detail(ZIP.id, DETAIL_ZIP) }) },
    { id: 'detail-held', label: 'Request: held — no supplier yet', model: make('buyer', { detail: detail(RED.id, DETAIL_RED) }) },
    { id: 'detail-converted', label: 'Request: already in a purchase order', model: make('buyer', { view: 'converted', rows: rowsOf([CONVERTED]), detail: detail(CONVERTED.id, DETAIL_CONVERTED) }) },
    { id: 'detail-loading', label: 'Request: loading', model: make('buyer', { detail: detail(LEATHER.id, null, 'loading') }) },
    { id: 'detail-error', label: 'Request: couldn’t load', model: make('buyer', { detail: detail(LEATHER.id, null, 'error') }) },
    // ---- Draft POs for n ----
    { id: 'draft-ready', label: 'Draft POs for 4: three cards (add to a draft, or new)', model: make('buyer', { selected: DRAFT_IDS, draft: draftOf() }), note: 'One card per supplier and site; RadioCard between its open draft and a new one. Nothing is sent.' },
    { id: 'draft-new-picked', label: 'Draft POs: the fabric lines into its open draft', model: make('buyer', { draft: draftOf({ into: { [`${SUPPLIERS.fabric.id}|${SITE.id}`]: 'existing' } }) }) },
    { id: 'draft-loading', label: 'Draft POs: reading the preview', model: make('buyer', { draft: draftOf({ preview: { status: 'loading' } }) }) },
    {
      id: 'draft-held',
      label: 'Draft POs: two requests held (the batch waits)',
      model: make('buyer', {
        draft: draftOf({
          requestIds: [...DRAFT_IDS, RED.id, BLOCKED.id],
          preview: {
            status: 'ready',
            value: {
              ...PREVIEW,
              held: [
                { requestId: RED.id, code: 'NO_SUPPLIER', message: 'x' },
                { requestId: BLOCKED.id, code: 'SUPPLIER_BLOCKED', message: 'x' },
              ],
            },
          },
        }),
      }),
      note: 'Confirm is held: the API refuses the whole batch while one is held. “Leave them out” reads the preview again.',
    },
    { id: 'draft-no-right', label: 'Draft POs: no right for one site', model: make('buyer', { draft: draftOf({ preview: { status: 'ready', value: { ...PREVIEW, cards: PREVIEW.cards.map((card, index) => (index === 2 ? { ...card, mayDraft: false } : card)) } } }) }) },
    { id: 'draft-refused', label: 'Draft POs: refused (changed meanwhile)', model: make('buyer', { draft: draftOf({ problem: phrase('refused.changed') }) }) },
    { id: 'draft-busy', label: 'Draft POs: drafting', model: make('buyer', { draft: draftOf({ busy: true }) }) },
    { id: 'draft-done', label: 'Draft POs: the drafts made', model: make('buyer', { draft: draftOf({ result: RESULT }) }) },
    // ---- Reject with reason ----
    { id: 'reject', label: 'Reject 2 with reason: pick a reason', model: make('buyer', { selected: [LEATHER.id, LINING.id], reject: rejectOf() }) },
    { id: 'reject-other', label: 'Reject: another reason needs a note', model: make('buyer', { reject: rejectOf({ reason: 'OTHER' }) }) },
    { id: 'reject-ready', label: 'Reject: ready', model: make('buyer', { reject: rejectOf({ reason: 'STOCK_NOT_IN_SYSTEM', note: 'Contate ieri in magazzino.' }) }) },
    // ---- roles ----
    { id: 'owner', label: 'Owner: everything, with costs', model: make('owner') },
    { id: 'planner', label: 'Planner: no costs; rejects, does not draft', model: make('planner', { selected: [LEATHER.id, LINING.id] }), note: 'No value or price column (not even —). Draft POs held: purchasing.manage.' },
    { id: 'warehouse', label: 'Warehouse: reads, no money, nothing to do', model: make('warehouse', { selected: [LEATHER.id] }) },
    { id: 'read-only', label: 'Read-only', model: make('readOnly', { detail: detail(LEATHER.id, { ...DETAIL_LEATHER, request: withoutCost(LEATHER), sources: DETAIL_LEATHER.sources.map(({ unitPrice: _price, ...rest }) => rest) }) }) },
    { id: 'no-access', label: 'Sales: no access (purchasing.view)', model: make('sales') },
  ],
})
