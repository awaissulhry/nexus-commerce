import type { ImportJob, ImportRow, Importer } from '../../../../admin/import/api'
import { blankDraft, emptyWizard } from '../../../../admin/import/model'
import type { SheetImport } from '../../../../products/styles/import/sheet-import'
import type { OrderRow } from '../../api'
import { at, COMPANY, LINE_BLK, LINE_RED, LIST_ROWS, ORDER_ID, ROLES, TODAY, type Role } from '../../_demo/fixtures'
import type { ListDepthModel } from '../../list-depth/use-list-depth'
import { weekColumns } from '../../week/model'
import type { WeekModel } from '../../week/use-promise-week'
import type { Approval, Changes, Confirmation, DepositKinds, Freeze, Materials, OrderDepth, OrderMilestone, PricedPreview, PromiseLine, RowDepth, TechPack } from '../api'
import { depthCanOf, PRICED_EMPTY, type DepthCan, type Forecast } from '../model'
import type { OrderDepthModel } from '../use-order-depth'

/**
 * Made-up data for the B-W2b-323 cases of SCR-038 (the list's priority and season, Set priority, By promise week), SCR-039 (the
 * order studio's depth), SCR-429 (Import orders) and SCR-430 (the confirmation tab): the invented company and order of the
 * orders' demo (SO-2026-0088, black and red lines of DEMO-JKT-01). No real customer, supplier or person. Exports no
 * designScreen.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

/** What each demo role holds of the depth's rights (the orders' demo roles, with the reads W2b-5 gives them). */
const EXTRA: Record<Role, readonly string[]> = {
  owner: ['planning.view', 'planning.promise.view', 'sales.settings.manage', 'sales.inquiries.view', 'imports.view', 'imports.run', 'imports.apply'],
  sales: ['planning.promise.view', 'sales.inquiries.view', 'imports.view', 'imports.run', 'imports.apply'],
  finance: ['sales.settings.manage'],
  manager: ['planning.view', 'planning.promise.view'],
}
export const permissionsOf = (role: Role): string[] => [...ROLES[role], ...EXTRA[role]]
export const depthCan = (role: Role): DepthCan => depthCanOf(permissionsOf(role))

// ---- the order studio ------------------------------------------------------------------------------------------------------------

export function orderDepth(over: Partial<OrderDepth> = {}): OrderDepth {
  return {
    orderId: ORDER_ID,
    number: 'SO-2026-0088',
    status: 'IN_PRODUCTION',
    priority: { level: 'URGENT', urgentReason: 'Il cliente apre il negozio il 1° dicembre.', number: 0 },
    season: { id: uid('5353', 1), code: 'FW27', name: 'Autunno-inverno 2027', status: 'OPEN' },
    waiting: null,
    confirmation: { versions: 2, sentAt: at(29, 10, 5), sentVersion: 2 },
    sameQuote: [],
    ...over,
  }
}

const verdict = (field: Freeze['order']['fields'][number]['field'], state: Freeze['order']['fields'][number]['state'], frozenFrom: Freeze['order']['fields'][number]['frozenFrom'] = null) => ({ field, state, frozenFrom })

/** Black 48 and 50 cut (a priced change); red not started; prices frozen from release. */
export const FREEZE_CUT: Freeze = {
  orderId: ORDER_ID,
  number: 'SO-2026-0088',
  rules: 9,
  order: { stage: 'CUT', on: '2026-10-27', fields: [verdict('DELIVERY_DATE', 'OPEN'), verdict('SHIP_TO', 'OPEN')] },
  lines: [
    {
      lineId: LINE_BLK,
      seq: 10,
      stage: 'CUT',
      on: '2026-10-27',
      fields: [verdict('COLOURWAY', 'CHANGE_REQUEST', 'CUT'), verdict('OPTION', 'OPEN'), verdict('PRICE', 'CHANGE_REQUEST', 'RELEASED')],
      sizes: [
        { size: '48', stage: 'CUT', on: '2026-10-27', locked: true, state: 'CHANGE_REQUEST' },
        { size: '50', stage: 'CUT', on: '2026-10-27', locked: true, state: 'CHANGE_REQUEST' },
        { size: '52', stage: 'RELEASED', on: '2026-10-26', locked: false, state: 'OPEN' },
        { size: '54', stage: 'RELEASED', on: '2026-10-26', locked: false, state: 'OPEN' },
      ],
    },
    {
      lineId: LINE_RED,
      seq: 20,
      stage: null,
      on: null,
      fields: [verdict('COLOURWAY', 'OPEN'), verdict('OPTION', 'OPEN'), verdict('PRICE', 'OPEN')],
      sizes: ['50', '52', '54'].map((size) => ({ size, stage: null, on: null, locked: false, state: 'OPEN' as const })),
    },
  ],
}

/** The same order further on: black 48 and 50 finished (frozen for good). */
export const FREEZE_FINISHED: Freeze = {
  ...FREEZE_CUT,
  order: { ...FREEZE_CUT.order, stage: 'FINISHED', on: '2026-10-29' },
  lines: FREEZE_CUT.lines.map((line) => (line.lineId === LINE_BLK ? { ...line, stage: 'FINISHED' as const, sizes: line.sizes.map((size) => (size.locked ? { ...size, stage: 'FINISHED' as const, state: 'BLOCKED' as const } : size)) } : line)),
}

export const FREEZE_NONE: Freeze = { ...FREEZE_CUT, rules: 0, order: { stage: null, on: null, fields: [] }, lines: FREEZE_CUT.lines.map((line) => ({ ...line, stage: null, on: null, fields: [], sizes: line.sizes.map((size) => ({ ...size, stage: null, on: null, locked: false, state: 'OPEN' as const })) })) }

const DIFF_ONE_MORE = { lines: [{ change: 'CHANGED' as const, lineId: LINE_BLK, seq: 10, styleId: uid('7777', 1), colourwayId: uid('7979', 1), piecesBefore: 8, piecesAfter: 9, sizes: [{ size: '50', before: 2, after: 3 }], priceChanged: false }], netAmountBefore: 624000, netAmountAfter: 669000 }

export const CHANGES: Changes = {
  orderId: ORDER_ID,
  number: 'SO-2026-0088',
  waitingForYes: null,
  reapprovalNeededAt: at(30, 11, 5),
  changes: [
    {
      id: uid('8282', 3),
      revision: 3,
      reason: 'Il cliente chiede una giacca nera in più in 50.',
      createdAt: at(30, 11, 5),
      createdBy: 'Anna Esempio',
      priced: true,
      diff: DIFF_ONE_MORE,
      parts: [{ label: 'Una giacca in più in 50, tagliata a parte', orderLineId: LINE_BLK, amount: 45000 }],
      feeAmount: 2500,
      changeAmount: 47500,
      deposit: { id: uid('3131', 7), kind: 'ACCONTO', amount: 14250, pct: '30.0000', status: 'OPEN', dueDate: '2026-11-06' },
      yes: { state: 'NOT_ASKED', taskId: null, reason: null },
      customer: { decision: 'WAITING', requestId: uid('9191', 1), answeredAt: null },
      putBack: { may: true },
    },
    {
      id: uid('8282', 2),
      revision: 2,
      reason: 'Prezzo rivisto della giacca rossa.',
      createdAt: at(29, 15, 40),
      createdBy: 'Anna Esempio',
      priced: true,
      diff: { lines: [{ change: 'CHANGED' as const, lineId: LINE_RED, seq: 20, styleId: uid('7777', 1), colourwayId: uid('7979', 2), piecesBefore: 6, piecesAfter: 6, sizes: [], priceChanged: true }], netAmountBefore: 624000, netAmountAfter: 630000 },
      parts: [{ label: 'Prezzo nuovo rosso', orderLineId: LINE_RED, amount: 6000 }],
      feeAmount: null,
      changeAmount: 6000,
      deposit: null,
      yes: { state: 'TURNED_DOWN', taskId: uid('9292', 1), reason: 'Margine sotto la soglia.' },
      customer: { decision: 'NOT_ASKED', requestId: null, answeredAt: null },
      putBack: { may: true },
    },
    { id: uid('8282', 1), revision: 1, reason: 'Codice ordine del cliente corretto.', createdAt: at(28, 9, 10), createdBy: 'Anna Esempio', priced: false, diff: { lines: [] }, parts: [], feeAmount: null, changeAmount: 0, deposit: null, yes: { state: 'NOT_ASKED', taskId: null, reason: null }, customer: { decision: 'NOT_NEEDED', requestId: null, answeredAt: null }, putBack: { may: false } },
  ],
}
export const CHANGES_WAITING_YES: Changes = { ...CHANGES, waitingForYes: { taskId: uid('9292', 4), since: at(30, 11, 6) }, changes: CHANGES.changes.map((change) => (change.revision === 3 ? { ...change, yes: { state: 'WAITING' as const, taskId: uid('9292', 4), reason: null } } : change)) }
export const CHANGES_NONE: Changes = { ...CHANGES, reapprovalNeededAt: null, changes: [CHANGES.changes[2]!] }

export const MATERIALS: Materials = {
  orderId: ORDER_ID,
  number: 'SO-2026-0088',
  partyId: uid('6666', 2),
  rows: [
    { id: uid('5454', 1), orderLineId: LINE_BLK, seq: 1, item: { id: uid('7676', 1), code: 'ETI-DEMO-01', name: 'Etichetta marchio cliente' }, colour: null, uom: 'pz', expected: '8.0000', expectedBySize: { '48': '2.0000', '50': '2.0000', '52': '2.0000', '54': '2.0000' }, received: '10.0000', used: '4.0000', returned: '0.0000', left: '6.0000', note: null, version: 2 },
    { id: uid('5454', 2), orderLineId: LINE_RED, seq: 1, item: { id: uid('7676', 2), code: 'ZIP-DEMO-07', name: 'Zip in metallo del cliente' }, colour: { id: uid('7979', 2), code: 'RED', name: 'Rosso' }, uom: 'pz', expected: '6.0000', expectedBySize: { '50': '2.0000', '52': '2.0000', '54': '2.0000' }, received: '2.0000', used: '3.0000', returned: '0.0000', left: '0.0000', note: null, version: 1 },
  ],
  notPlanned: [],
  lots: [
    { id: uid('7575', 1), code: 'LOT-CLI-0012', itemId: uid('7676', 1), itemColourId: null, siteId: uid('1212', 1), onHand: '6.0000', receiptId: uid('7474', 1), receiptNumber: 'GR-2026-0031', receivedAt: at(26, 9) },
    { id: uid('7575', 2), code: 'LOT-CLI-0013', itemId: uid('7676', 2), itemColourId: uid('7979', 2), siteId: uid('1212', 1), onHand: '0.0000', receiptId: uid('7474', 2), receiptNumber: 'GR-2026-0034', receivedAt: at(27, 14) },
  ],
  problems: [],
  empty: null,
}
export const MATERIALS_EMPTY: Materials = { ...MATERIALS, rows: [], lots: [], empty: { en: 'x', it: 'x' } }
export const MATERIALS_NOT_PLANNED: Materials = { ...MATERIALS, notPlanned: [{ orderLineId: LINE_RED, bomLineId: uid('6363', 4), item: { id: uid('7676', 3), code: 'PEL-DEMO-03', name: 'Pelle del cliente, fiore' }, colour: null, uom: 'm²', expected: '4.8000' }] }

const version = (n: number, sent: boolean) => ({ id: uid('8383', n), version: n, number: `SO-2026-0088 v${n}`, language: 'it', fileId: uid('8484', n), createdAt: at(28 + n, 9, 30), createdBy: 'Anna Esempio', sent })
export const CONFIRMATION_SENT: Confirmation = { orderId: ORDER_ID, number: 'SO-2026-0088', status: 'IN_PRODUCTION', orderVersion: 7, sentAt: at(30, 10, 5), sentVersion: 2, upToDate: true, mayMake: true, versions: [version(2, true), version(1, false)] }
export const CONFIRMATION_OUTDATED: Confirmation = { ...CONFIRMATION_SENT, upToDate: false }
export const CONFIRMATION_NONE: Confirmation = { ...CONFIRMATION_SENT, sentAt: null, sentVersion: null, upToDate: null, versions: [] }
export const CONFIRMATION_WAITING: Confirmation = { ...CONFIRMATION_NONE, status: 'PENDING_APPROVAL', mayMake: false }

export const TECH_PACK: TechPack = {
  inquiry: {
    id: uid('9393', 1),
    number: 'INQ-2026-0014',
    techPack: {
      version: 'TP FW27 rev C',
      files: [
        { named: { id: uid('9494', 1), originalName: 'scheda-tecnica-giacca.pdf', contentType: 'application/pdf', sizeBytes: 482_113, status: 'AVAILABLE', versionNo: 3 }, current: { id: uid('9494', 1), originalName: 'scheda-tecnica-giacca.pdf', contentType: 'application/pdf', sizeBytes: 482_113, status: 'AVAILABLE', versionNo: 3 }, newer: false },
        { named: { id: uid('9494', 2), originalName: 'tabella-misure.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 31_402, status: 'AVAILABLE', versionNo: 1 }, current: { id: uid('9494', 3), originalName: 'tabella-misure.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 33_118, status: 'AVAILABLE', versionNo: 2 }, newer: true },
      ],
    },
  },
}

const milestone = (id: string, kind: OrderMilestone['kind'], state: OrderMilestone['state'], target: string | null, actual: string | null, extra: Partial<OrderMilestone> = {}): OrderMilestone => ({ id, kind, gateKind: null, label: null, target, actual, state, late: null, ...extra })
export const MILESTONES = {
  milestones: [
    milestone(`gate:${uid('9595', 1)}`, 'GATE', 'DONE', '2026-10-20', '2026-10-19', { gateKind: 'SAMPLE_APPROVED' }),
    milestone(`gate:${uid('9595', 2)}`, 'GATE', 'DONE', '2026-10-22', '2026-10-24', { gateKind: 'LEATHER_APPROVED', late: 2 }),
    milestone(`start:${ORDER_ID}`, 'START', 'DONE', '2026-10-26', '2026-10-26'),
    milestone(`ship:${ORDER_ID}`, 'SHIP', 'TO_COME', '2026-12-15', null),
  ],
  next: `ship:${ORDER_ID}`,
  late: 1,
}

export const FORECASTS: ReadonlyMap<string, Forecast> = new Map([
  [LINE_BLK, { finish: '2026-12-09', source: 'BOARD' as const, slackDays: 6, risk: 'ON_TIME' as const }],
  [LINE_RED, { finish: '2026-12-29', source: 'WORK_ORDER_DUE' as const, slackDays: -7, risk: 'AT_RISK' as const }],
])

const request = (over: Partial<Approval['requests'][number]> = {}): Approval['requests'][number] => ({ id: uid('9696', 1), status: 'PENDING', requestedAt: at(29, 11), requestedBy: 'Anna Esempio', approver: 'Amministrazione', dueAt: null, decidedAt: null, decidedBy: null, reason: null, mine: true, ...over })
export const APPROVAL_PENDING: Approval = { orderId: ORDER_ID, number: 'SO-2026-0088', status: 'PENDING_APPROVAL', waiting: true, reasons: [{ reason: 'REQUEST_PENDING' }], creditHold: null, requests: [request()], may: { ask: false, withdraw: true } }
export const APPROVAL_NOBODY: Approval = { ...APPROVAL_PENDING, reasons: [{ reason: 'NO_REQUEST' }], requests: [], may: { ask: true, withdraw: false } }
export const APPROVAL_CREDIT: Approval = { ...APPROVAL_PENDING, reasons: [{ reason: 'REQUEST_PENDING' }, { reason: 'CREDIT_HOLD' }], creditHold: { checkId: uid('9797', 1), requestTaskId: uid('9696', 2) }, requests: [request({ mine: false, requestedBy: 'Luca Prova' })], may: { ask: false, withdraw: false } }

export const DEPOSIT_KINDS_OFF: DepositKinds = {
  companyId: COMPANY,
  kinds: [
    { kind: 'ACCONTO', available: true },
    { kind: 'CAPARRA', available: true },
    { kind: 'CAPARRA_PENITENZIALE', available: false },
  ],
  caparraPenitenziale: { on: false, source: 'NONE' },
}

export const PRICED_PREVIEW: PricedPreview = {
  ok: true,
  problems: [],
  revision: 4,
  version: 7,
  diff: DIFF_ONE_MORE,
  parts: [{ label: 'x', orderLineId: LINE_BLK, amount: 45000 }],
  feeAmount: 2500,
  changeAmount: 47500,
  deposit: { amount: 14250, pct: '30.0000', kind: 'ACCONTO', growthAmount: 47500 },
  yes: 'WOULD_ASK',
  stage: { stage: 'CUT' },
}
export const PRICED_BLOCKED: PricedPreview = { ...PRICED_PREVIEW, ok: false, problems: [{ path: 'body/lines/10/SIZE_QUANTITY' }], parts: [], feeAmount: null, changeAmount: null, deposit: null, yes: null }

/** The order studio's depth with every part read (override one part for a case). */
export function depthModel(role: Role, over: Partial<OrderDepthModel> = {}): OrderDepthModel {
  const can = depthCan(role)
  const price = can.price
  return {
    can,
    depth: { value: orderDepth(), problem: null },
    approval: null,
    freeze: { value: FREEZE_CUT, problem: null },
    changes: { value: price ? CHANGES : stripMoney(CHANGES), problem: null },
    materials: { value: MATERIALS, problem: null },
    confirmation: { value: CONFIRMATION_SENT, problem: null },
    confirmationPdf: { value: demoPdfUrl(), problem: null },
    techPack: can.inquiries ? { value: TECH_PACK, problem: null } : null,
    milestones: can.planning ? { value: MILESTONES, problem: null } : null,
    forecasts: can.promise ? { value: FORECASTS, problem: null } : null,
    seasons: null,
    depositKinds: DEPOSIT_KINDS_OFF,
    dialog: null,
    busy: false,
    problem: null,
    notice: null,
    priced: null,
    send: null,
    ...over,
  }
}

/** A priced change open on the black line's one more jacket in 50. */
export function pricedOpen(preview: PricedPreview = PRICED_PREVIEW): NonNullable<OrderDepthModel['priced']> {
  return { amendment: { lines: [{ id: LINE_BLK, sizes: [{ size: '50', quantity: 3 }] }] }, draft: { ...PRICED_EMPTY, labels: { [LINE_BLK]: 'Una giacca in più in 50, tagliata a parte' }, fee: '25,00', reason: 'Il cliente chiede una giacca nera in più.' }, preview: { phase: 'ready', value: preview, problem: null } }
}

function stripMoney(changes: Changes): Changes {
  return { ...changes, changes: changes.changes.map(({ parts: _parts, feeAmount: _fee, changeAmount: _change, ...change }) => ({ ...change, deposit: change.deposit ? { ...change.deposit, amount: undefined } : null })) }
}

// ---- the list --------------------------------------------------------------------------------------------------------------------

const LEVELS: Record<string, RowDepth['priority']['level']> = { '0088': 'URGENT', '0087': 'HIGH', '0083': 'HIGH', '0079': 'URGENT', '0070': 'LOW' }
export const ROWS_DEPTH: ReadonlyMap<string, RowDepth> = new Map(
  LIST_ROWS.map((row) => {
    const level = LEVELS[row.number.slice(-4)] ?? 'NORMAL'
    return [row.id, { orderId: row.id, number: row.number, priority: { level, urgentReason: level === 'URGENT' ? 'Apertura negozio del cliente.' : null, number: 0 }, season: row.number.endsWith('0070') ? null : { id: uid('5353', 1), code: row.number.endsWith('0071') ? 'SS26' : 'FW27' }, waitingForYes: false, requestPending: false, confirmationSentAt: null }] as const
  }),
)

export function listDepth(role: Role, over: Partial<ListDepthModel> = {}): ListDepthModel {
  return { can: depthCan(role), rows: ROWS_DEPTH, failed: false, saves: new Map(), dialog: null, ...over }
}

// ---- By promise week ------------------------------------------------------------------------------------------------------------

const named = (block: string, n: number, code: string, name: string) => ({ id: uid(block, n), code, name })
const promiseLine = (orderNumber: string, orderN: number, customer: string, position: number | null, level: string, sizes: Array<[string, number, string | null]>): PromiseLine => ({
  id: uid('7171', orderN * 10),
  seq: 10,
  order: { id: uid('5151', orderN), number: orderNumber, status: 'IN_PRODUCTION', priorityLevel: level, backlogPosition: position },
  customer: named('6666', orderN % 3, `CLI-${orderN}`, customer),
  style: named('7777', 1, 'DEMO-JKT-01', 'Giacca pelle demo'),
  colourway: named('7979', 1, 'BLK', 'Nero'),
  sizes: sizes.map(([size, open, current]) => ({ size, ordered: open, shipped: 0, open, current, finish: current, finishSource: 'BOARD' as const, slackDays: current && current < TODAY ? -3 : 2, risk: current === null ? ('NOT_PROMISED' as const) : current < TODAY ? ('LATE' as const) : ('ON_TIME' as const) })),
  current: sizes[0]?.[2] ?? null,
  finish: null,
  finishSource: 'BOARD',
  slackDays: null,
  risk: null,
})

export const PROMISE_LINES: PromiseLine[] = [
  promiseLine('SO-2026-0083', 83, 'Esempio Racing S.p.A.', 2, 'HIGH', [['48', 2, '2026-10-24'], ['50', 2, '2026-10-24']]),
  promiseLine('SO-2026-0088', 88, 'Moto Demo S.r.l.', 1, 'URGENT', [['48', 2, '2026-11-03'], ['50', 2, '2026-11-03'], ['52', 2, '2026-11-12']]),
  promiseLine('SO-2026-0084', 84, 'Squadra Fittizia S.r.l.', 3, 'NORMAL', [['50', 16, '2026-11-05'], ['52', 16, '2026-11-20']]),
  promiseLine('SO-2026-0081', 81, 'Esempio Racing S.p.A.', 4, 'NORMAL', [['54', 4, '2026-11-20']]),
  promiseLine('SO-2026-0086', 86, 'Moto Demo S.r.l.', null, 'LOW', [['50', 6, null]]),
]

export function weekModel(state: WeekModel['state'] = { status: 'ready', columns: weekColumns(PROMISE_LINES, TODAY), complete: true, asOf: at(29, 9, 42), today: TODAY }, sites = [{ id: uid('1212', 1), code: 'PLT', name: 'Stabilimento Demo' }]): WeekModel {
  return { state, sites, siteId: sites[0]?.id ?? null }
}

// ---- Import orders ---------------------------------------------------------------------------------------------------------------

const IMPORTER: Importer = { key: 'sales.orders', label: 'Sales orders', description: null, columns: [], keyColumns: ['order', 'style', 'colour', 'size'], maxRows: 1000 }

/** The orders import at one step: the sheet chosen, the dry run (orders it would make and the refused rows), applying, applied. */
export function demoOrdersImport(step: 'upload' | 'planned' | 'applying' | 'applied' | 'failed', rights: { run: boolean; apply: boolean } = { run: true, apply: true }): SheetImport {
  const draft = blankDraft('sales.orders', COMPANY, 'it')
  const job: ImportJob = {
    id: uid('4902', 1),
    companyId: COMPANY,
    importerKey: 'sales.orders',
    importerLabel: 'Sales orders',
    fileId: uid('4902', 11),
    fileName: 'ordini-demo.xlsx',
    fileStatus: 'AVAILABLE',
    sheetName: 'Ordini',
    encoding: 'utf-8',
    numberFormat: 'it',
    mapping: null,
    layout: {
      format: 'xlsx',
      sheet: 'Ordini',
      sheets: ['Ordini'],
      encoding: 'utf-8',
      delimiter: ';',
      headers: ['Ordine', 'Cliente', 'Modello', 'Colore', 'Taglia', 'Quantità', 'PO cliente', 'Priorità'],
      columns: [
        { index: 0, header: 'Ordine', column: 'order' },
        { index: 1, header: 'Cliente', column: 'customer' },
        { index: 2, header: 'Modello', column: 'style' },
        { index: 3, header: 'Colore', column: 'colour' },
        { index: 4, header: 'Taglia', column: 'size' },
        { index: 5, header: 'Quantità', column: 'quantity' },
        { index: 6, header: 'PO cliente', column: 'customerPo' },
        { index: 7, header: 'Priorità', column: 'priority' },
      ],
      ignored: [],
    },
    status: step === 'applied' ? 'APPLIED' : step === 'applying' ? 'APPLYING' : step === 'failed' ? 'FAILED' : 'PLANNED',
    mode: step === 'applied' || step === 'applying' ? 'APPLY' : 'DRY_RUN',
    rowCount: 9,
    createCount: 7,
    updateCount: 0,
    unchangedCount: 0,
    errorCount: 2,
    appliedCount: step === 'applied' ? 7 : 0,
    skippedCount: 0,
    issues: null,
    error: null,
    plannedAt: step === 'failed' ? null : at(29, 9, 2),
    applyRequestedAt: step === 'applied' || step === 'applying' ? at(29, 9, 4) : null,
    appliedAt: step === 'applied' ? at(29, 9, 5) : null,
    cancelledAt: null,
    version: step === 'applied' ? 5 : 3,
    createdAt: at(29, 9, 1),
    updatedAt: at(29, 9, 5),
    createdById: null,
  }
  const changes: ImportRow[] = [
    { rowNumber: 2, action: 'CREATE', key: '["ORD-DEMO-1","DEMO-JKT-01","BLK","48"]', recordId: null, errors: null, after: { customer: 'MOTO-DEMO', quantity: 2, customerPo: 'PO-DEMO-501' }, outcome: null, note: null, appliedAt: null },
    { rowNumber: 3, action: 'CREATE', key: '["ORD-DEMO-1","DEMO-JKT-01","BLK","50"]', recordId: null, errors: null, after: { customer: 'MOTO-DEMO', quantity: 3, customerPo: 'PO-DEMO-501' }, outcome: null, note: null, appliedAt: null },
  ]
  const refused: ImportRow[] = [
    { rowNumber: 7, action: 'ERROR', key: '["ORD-DEMO-3","DEMO-JKT-01","RED","58"]', recordId: null, errors: [{ column: 'size', message: 'The colourway is not made in this size.' }], outcome: null, note: null, appliedAt: null },
    { rowNumber: 8, action: 'ERROR', key: '["ORD-DEMO-4","DEMO-JKT-01","BLK","50"]', recordId: null, errors: [{ column: 'priority', message: 'URGENT needs its reason.' }], outcome: null, note: null, appliedAt: null },
  ]
  const wizard = step === 'upload' ? emptyWizard({ ...draft, file: { name: job.fileName, size: 12_288 } }) : { ...emptyWizard(draft, job), refused: { items: refused, problem: null }, changes: { items: step === 'planned' ? changes : [], problem: null } }
  return { wizard, importers: [IMPORTER], rights: { view: true, run: rights.run, apply: rights.apply, people: false }, companies: [{ id: COMPANY, name: 'Officina Demo S.r.l.' }] }
}

// ---- a made-up PDF ---------------------------------------------------------------------------------------------------------------

/** A one-page PDF saying it is made-up design data (bytes, no file store). */
export function demoPdf(title: string): Uint8Array {
  const text = `BT /F1 20 Tf 72 770 Td (${title}) Tj 0 -28 Td /F1 11 Tf (Made-up design data) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

/** The same PDF as a data address (the depth model keeps an address for the PdfViewer). */
export function demoPdfUrl(): string {
  const bytes = demoPdf('Conferma SO-2026-0088 v2')
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:application/pdf;base64,${typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64')}`
}

export type { OrderRow }
