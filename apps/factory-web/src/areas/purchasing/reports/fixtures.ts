import { createElement } from 'react'
import { defaultSectionLayout } from '@nexus/ui/patterns'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_SITES, rolePermissions } from '../../../shell/design-data'
import { scopeOf } from '../../../shell/scope/scope-model'
import { inShell, PREFIX, uid } from '../../quality/_shared/fixtures'
import type { ChasePreview, Late, LateRow, Spend, SpendFigures, SpendGroupRow, SpendLines } from './api'
import { chaseGroupsOf, reportsAddressOf, reportsCan, sectionSpecs } from './model'
import { ReportsView, type Read, type ReportsModel } from './view/ReportsView'

/**
 * SCR-255 — Purchasing reports with made-up suppliers, orders and figures only ("Demo" names, DEMO- numbers, invented amounts):
 * the month's spend by supplier with the cost grain (sample orders apart), by category, over two months (the pivot), the planner
 * without the cost grain (counts only), the POs behind a bar (and for the planner), the late lines ranked by the customer orders
 * they put at risk with the chain of the first, a reason picked, rows selected (and held without the right to send), the chase of
 * one order, of two, and its outcome, several currencies, each panel's states (loading, one failed while the other stands, nothing
 * placed, no late line, the orders not in the role), Arrange, half widths, the keys, offline, no right.
 */

const COMPANY = { id: DEMO_COMPANIES[0].id, code: 'DEMO', name: DEMO_COMPANIES[0].name }
const SITE = { id: DEMO_SITES[0].id, code: 'DN', name: DEMO_SITES[0].name }
const FROM = '2026-11-01'
const TO = '2026-11-12'
export const NOW = '2026-11-12T07:42:00.000Z'
const head = { company: COMPANY, site: SITE, from: FROM, to: TO, today: TO, asOf: NOW }
const SCOPE_ONE = scopeOf({ company: DEMO_COMPANIES[0], sites: DEMO_SITES, chosen: SITE.id })

const figures = (production: number, samples: number, orders: number, lines: number, sampleOrders = 0, sampleLines = 0): SpendFigures => ({
  byCurrency: [{ currency: 'EUR', production, samples }],
  production,
  samples,
  currency: 'EUR',
  mixedCurrencies: false,
  orders,
  lines,
  sampleOrders,
  sampleLines,
})
const month = (key: string, production: number, samples = 0, orders = 1) => ({ month: key, production, samples, currency: 'EUR', orders, lines: orders, sampleOrders: samples > 0 ? 1 : 0, sampleLines: samples > 0 ? 1 : 0 })
const group = (n: number, code: string | null, name: string, share: string | null, body: SpendFigures, months = [month('2026-11', body.production ?? 0, body.samples ?? 0, body.orders)]): SpendGroupRow => ({
  key: code === null ? name : uid('3501', n),
  code,
  name,
  share,
  ...body,
  months,
})

const SUPPLIERS: SpendGroupRow[] = [
  group(1, 'DEMO-CON-01', 'Conceria Demo Alfa', '58.4', figures(1_842_600, 0, 4, 7)),
  group(2, 'DEMO-TES-02', 'Tessitura Demo Beta', '21.7', figures(684_300, 48_000, 3, 5, 1, 2)),
  group(3, 'DEMO-PRO-03', 'Protezioni Demo Gamma', '12.9', figures(406_500, 0, 2, 2)),
  group(4, 'DEMO-MIN-04', 'Minuteria Demo Delta', '7.0', figures(221_100, 12_500, 2, 6, 1, 1)),
]
export const SPEND: Spend = {
  ...head,
  sight: { orders: true, values: true },
  by: 'supplier',
  months: ['2026-11'],
  companyCurrency: 'EUR',
  all: figures(3_154_500, 60_500, 11, 20, 2, 3),
  groups: SUPPLIERS,
  more: 0,
  complete: true,
}
const BY_CATEGORY: Spend = {
  ...SPEND,
  by: 'category',
  groups: [
    group(11, null, 'LEATHER', '61.2', figures(1_930_600, 0, 4, 6)),
    group(12, null, 'TEXTILE', '18.3', figures(577_300, 48_000, 3, 4, 1, 2)),
    group(13, null, 'PROTECTOR', '12.9', figures(406_500, 0, 2, 2)),
    group(14, null, 'HARDWARE', '7.6', figures(240_100, 12_500, 2, 8, 1, 1)),
  ],
}
const TWO_MONTHS: Spend = {
  ...SPEND,
  from: '2026-10-01',
  months: ['2026-10', '2026-11'],
  all: figures(5_402_900, 60_500, 19, 33, 2, 3),
  groups: [
    group(1, 'DEMO-CON-01', 'Conceria Demo Alfa', '61.5', figures(3_322_600, 0, 7, 12), [month('2026-10', 1_480_000, 0, 3), month('2026-11', 1_842_600, 0, 4)]),
    group(2, 'DEMO-TES-02', 'Tessitura Demo Beta', '20.8', figures(1_124_300, 48_000, 6, 9, 1, 2), [month('2026-10', 440_000, 0, 3), month('2026-11', 684_300, 48_000, 3)]),
    group(3, 'DEMO-PRO-03', 'Protezioni Demo Gamma', '11.5', figures(621_500, 0, 3, 3), [month('2026-10', 215_000, 0, 1), month('2026-11', 406_500, 0, 2)]),
    group(4, 'DEMO-MIN-04', 'Minuteria Demo Delta', '6.2', figures(334_500, 12_500, 3, 9, 1, 1), [month('2026-10', 113_400, 0, 1), month('2026-11', 221_100, 12_500, 2)]),
  ],
}
const MIXED: Spend = {
  ...SPEND,
  all: { ...SPEND.all, byCurrency: [{ currency: 'EUR', production: 2_748_000, samples: 60_500 }, { currency: 'USD', production: 441_000, samples: 0 }], production: null, samples: null, currency: null, mixedCurrencies: true },
  groups: [SUPPLIERS[0]!, SUPPLIERS[1]!, { ...SUPPLIERS[2]!, share: null, byCurrency: [{ currency: 'USD', production: 441_000, samples: 0 }], production: 441_000, currency: 'USD', months: [{ ...month('2026-11', 441_000, 0, 2), currency: 'USD' }] }, SUPPLIERS[3]!],
}

/** What a reader without the cost grain receives: the server drops every amount (and the share). */
function noAmounts(answer: Spend): Spend {
  const strip = (body: SpendFigures): SpendFigures => ({ ...body, byCurrency: body.byCurrency.map((entry) => ({ currency: entry.currency })), production: undefined, samples: undefined })
  return {
    ...answer,
    sight: { orders: true, values: false },
    all: strip(answer.all),
    groups: [...answer.groups]
      .sort((a, b) => b.orders - a.orders || b.sampleOrders - a.sampleOrders)
      .map((entry) => ({ ...strip(entry), key: entry.key, code: entry.code, name: entry.name, share: null, months: entry.months.map((item) => ({ ...item, production: undefined, samples: undefined })) })),
  }
}

const DRILL: SpendLines = {
  ...head,
  sight: { orders: true, values: true },
  by: 'supplier',
  key: SUPPLIERS[1]!.key,
  code: 'DEMO-TES-02',
  name: 'Tessitura Demo Beta',
  figures: figures(684_300, 48_000, 3, 5, 1, 2),
  lines: [
    { lineId: uid('3502', 1), seq: 10, purchaseOrderId: uid('3503', 1), number: 'DEMO-PO-0418', status: 'CONFIRMED', kind: 'production', placedOn: '2026-11-10', supplier: { id: SUPPLIERS[1]!.key, code: 'DEMO-TES-02', name: 'Tessitura Demo Beta' }, item: { id: uid('3504', 1), code: 'DEMO-TXT-CORDURA', name: 'Tessuto tecnico demo' }, category: 'TEXTILE', colour: { code: 'NER', name: 'Nero' }, quantity: '220.0000', uom: 'M', ended: null, spend: 396_000, currency: 'EUR' },
    { lineId: uid('3502', 2), seq: 20, purchaseOrderId: uid('3503', 1), number: 'DEMO-PO-0418', status: 'CONFIRMED', kind: 'production', placedOn: '2026-11-10', supplier: { id: SUPPLIERS[1]!.key, code: 'DEMO-TES-02', name: 'Tessitura Demo Beta' }, item: { id: uid('3504', 2), code: 'DEMO-LIN-MESH', name: 'Fodera rete demo' }, category: 'LINING', colour: null, quantity: '150.0000', uom: 'M', ended: null, spend: 135_000, currency: 'EUR' },
    { lineId: uid('3502', 3), seq: 10, purchaseOrderId: uid('3503', 2), number: 'DEMO-PO-0409', status: 'CLOSED', kind: 'production', placedOn: '2026-11-04', supplier: { id: SUPPLIERS[1]!.key, code: 'DEMO-TES-02', name: 'Tessitura Demo Beta' }, item: { id: uid('3504', 3), code: 'DEMO-MEM-01', name: 'Membrana demo' }, category: 'MEMBRANE', colour: null, quantity: '90.0000', uom: 'M2', ended: 'CLOSED_SHORT', spend: 153_300, currency: 'EUR' },
    { lineId: uid('3502', 4), seq: 10, purchaseOrderId: uid('3503', 3), number: 'DEMO-PO-0412', status: 'SENT', kind: 'samples', placedOn: '2026-11-06', supplier: { id: SUPPLIERS[1]!.key, code: 'DEMO-TES-02', name: 'Tessitura Demo Beta' }, item: { id: uid('3504', 1), code: 'DEMO-TXT-CORDURA', name: 'Tessuto tecnico demo' }, category: 'TEXTILE', colour: { code: 'ROS', name: 'Rosso' }, quantity: '6.0000', uom: 'M', ended: null, spend: 48_000, currency: 'EUR' },
  ],
  more: 0,
}

const blocked = (n: number, wo: [string, string, number] | null, so: [string, string, number] | null) => ({
  kind: so ? 'SALES_ORDER' : 'WORK_ORDER',
  workOrder: wo ? { id: uid('3505', n), number: wo[0], status: 'RELEASED', dueDate: wo[1] } : null,
  salesOrder: so ? { id: uid('3506', n), number: so[0], promiseDate: so[1] } : null,
  size: null,
  demandDate: wo?.[1] ?? so?.[1] ?? TO,
  quantity: '42.0000',
  lateBy: Math.max(wo?.[2] ?? 0, so?.[2] ?? 0),
})
const lateRow = (n: number, over: Partial<LateRow>): LateRow => ({
  lineId: uid('3507', n),
  seq: 10,
  purchaseOrderId: uid('3508', n),
  number: `DEMO-PO-04${String(n).padStart(2, '0')}`,
  status: 'CONFIRMED',
  revision: 1,
  version: 3,
  companyId: COMPANY.id,
  siteId: SITE.id,
  partyId: SUPPLIERS[0]!.key,
  supplierName: 'Conceria Demo Alfa',
  item: { code: 'DEMO-LEA-NAPPA', name: 'Pelle nappa demo' },
  colour: { code: 'NER', name: 'Nero' },
  baseUom: 'FT2',
  outstandingBase: '420.0000',
  needDate: '2026-11-09',
  confirmedDate: '2026-11-09',
  expectedDate: '2026-11-09',
  nextDelivery: null,
  daysLate: 3,
  confirmedLaterBy: 0,
  confirmBy: null,
  reasons: ['LATE'],
  blocks: { entries: [], salesOrdersAtRisk: 0, workOrdersAtRisk: 0, earliestPromise: null },
  ...over,
})
const LATE_ROWS: LateRow[] = [
  lateRow(1, {
    blocks: { entries: [blocked(1, ['DEMO-WO-0231', '2026-11-11', 1], null), blocked(2, null, ['DEMO-SO-1043', '2026-11-18', 0]), blocked(3, null, ['DEMO-SO-1047', '2026-11-14', 2])], salesOrdersAtRisk: 1, workOrdersAtRisk: 1, earliestPromise: '2026-11-14' },
  }),
  lateRow(2, {
    number: 'DEMO-PO-0418',
    partyId: SUPPLIERS[1]!.key,
    supplierName: 'Tessitura Demo Beta',
    item: { code: 'DEMO-TXT-CORDURA', name: 'Tessuto tecnico demo' },
    baseUom: 'M',
    needDate: '2026-11-20',
    confirmedDate: '2026-11-27',
    expectedDate: '2026-11-27',
    daysLate: 0,
    confirmedLaterBy: 7,
    reasons: ['CONFIRMED_LATE'],
    blocks: { entries: [blocked(4, ['DEMO-WO-0240', '2026-11-21', 6], ['DEMO-SO-1052', '2026-11-30', 0])], salesOrdersAtRisk: 0, workOrdersAtRisk: 1, earliestPromise: null },
  }),
  lateRow(3, { number: 'DEMO-PO-0421', status: 'SENT', partyId: SUPPLIERS[2]!.key, supplierName: 'Protezioni Demo Gamma', item: { code: 'DEMO-PRT-L2', name: 'Protezione spalla demo' }, colour: null, baseUom: 'PCS', needDate: '2026-11-25', confirmedDate: null, expectedDate: '2026-11-25', daysLate: 0, reasons: ['NOT_CONFIRMED'], confirmBy: '2026-11-10T09:00:00.000Z' }),
  lateRow(4, { number: 'DEMO-PO-0402', partyId: SUPPLIERS[3]!.key, supplierName: 'Minuteria Demo Delta', item: { code: 'DEMO-ZIP-08', name: 'Cerniera demo' }, colour: null, baseUom: 'PCS', needDate: '2026-11-05', confirmedDate: '2026-11-05', expectedDate: '2026-11-05', daysLate: 7 }),
]
export const LATE: Late = {
  today: TO,
  complete: true,
  tiles: { late: 2, notConfirmed: 1, confirmedLate: 1, atRisk: 2, salesOrdersAtRisk: 1 },
  plans: [{ siteId: SITE.id, runId: uid('3509', 1), finishedAt: '2026-11-12T05:00:00.000Z' }],
  rows: LATE_ROWS,
  nextCursor: null,
}

const PREVIEW: ChasePreview = {
  orderId: LATE_ROWS[0]!.purchaseOrderId,
  version: 3,
  allowed: true,
  why: null,
  lines: [{ lineId: LATE_ROWS[0]!.lineId, seq: 10, label: 'Line 10 · DEMO-LEA-NAPPA Pelle nappa demo Nero', needDate: '2026-11-09', confirmedDate: '2026-11-09', expectedDate: '2026-11-09', daysLate: 3, confirmedLaterBy: 0, reasons: ['LATE'] }],
  recipient: { contactId: uid('3510', 1), name: 'Ufficio ordini Demo', email: 'ordini@example.com' },
  language: 'it',
  subject: 'Sollecito: ordine di acquisto DEMO-PO-0401',
  body: "Gentile Ufficio ordini Demo,\n\nle scriviamo per le righe del nostro ordine di acquisto DEMO-PO-0401 qui sotto:\n\n- Line 10 · DEMO-LEA-NAPPA Pelle nappa demo Nero: in ritardo: attesa per il 09/11/2026\n\nCi può dire quando arriveranno?",
}

const ready = <T>(value: T): Read<T> => ({ status: 'ready', value })
const loading = <T>(): Read<T> => ({ status: 'loading' })
const failed = <T>(): Read<T> => ({ status: 'error', problem: 'problem.read' })

export const BUYER = [...rolePermissions('buyer'), 'purchasing.reports.view', 'purchasing.view', 'purchasing.send', 'money.cost']
export const PLANNER = rolePermissions('planner')
const specs = sectionSpecs((id) => id)

function model(over: Partial<ReportsModel> = {}, permissions: readonly string[] = BUYER, search = ''): ReportsModel {
  return {
    prefix: PREFIX,
    can: reportsCan(permissions),
    address: reportsAddressOf(new URLSearchParams(search)),
    scope: SCOPE_ONE,
    range: { from: FROM, to: TO },
    today: TO,
    spend: ready(SPEND),
    late: ready(LATE),
    lateMore: [],
    lateMoreBusy: false,
    lateCursor: null,
    live: 'live',
    asOf: NOW,
    layout: defaultSectionLayout(specs),
    specs,
    arranging: false,
    measure: 'production',
    drill: null,
    chainLine: null,
    selected: [],
    chase: null,
    ...over,
  }
}

function ReportsDesign({ model: value }: { model: ReportsModel }) {
  return inShell('/purchasing/reports', createElement(ReportsView, { model: value }), 'owner')
}

const halfLayout = { order: ['spend', 'late'], widths: { spend: 'half' as const, late: 'half' as const } }
const two = [LATE_ROWS[0]!.lineId, LATE_ROWS[1]!.lineId]
const plannerSpend = noAmounts(SPEND)

export const designScreen = defineDesignScreen<ReportsModel>({
  screen: 'SCR-255',
  title: 'Purchasing reports (Purchasing)',
  view: ReportsDesign,
  holdsPage: true,
  cases: [
    { id: 'report', label: 'The month with amounts (buyer, cost grain)', model: model(), note: 'Spend by supplier with sample orders apart, the pivot below; the late lines ranked by the customer orders they put at risk, the chain of the first.' },
    { id: 'by-category', label: 'Spend by category', model: model({ spend: ready(BY_CATEGORY) }, BUYER, 'by=category') },
    { id: 'two-months', label: 'Two months (the pivot by month)', model: model({ spend: ready(TWO_MONTHS), range: { from: '2026-10-01', to: TO }, address: { from: '2026-10-01', to: TO, by: 'supplier', reason: null } }, BUYER, 'from=2026-10-01') },
    { id: 'samples', label: 'Bars: sample orders', model: model({ measure: 'samples' }) },
    { id: 'planner', label: 'Planner (no cost grain): counts only', model: model({ spend: ready(plannerSpend), measure: 'orders' }, PLANNER), note: 'Bars and the table count orders and lines; no amount anywhere; chasing is held (no right to send).' },
    { id: 'mixed-currencies', label: 'An order in another currency without a rate', model: model({ spend: ready(MIXED) }), note: 'Its amount stays in its currency, never added: the total lists each currency.' },
    { id: 'drill', label: 'POs behind this bar', model: model({ drill: { key: SUPPLIERS[1]!.key, read: ready(DRILL) } }), note: 'The lines that make Tessitura Demo Beta\'s number; J / K open the next and the previous bar.' },
    { id: 'drill-planner', label: 'POs behind a bar (no cost grain)', model: model({ spend: ready(plannerSpend), measure: 'orders', drill: { key: SUPPLIERS[1]!.key, read: ready({ ...DRILL, sight: { orders: true, values: false }, figures: { ...DRILL.figures, production: undefined, samples: undefined, byCurrency: [{ currency: 'EUR' }] }, lines: DRILL.lines.map((line) => ({ ...line, spend: undefined })) }) } }, PLANNER) },
    { id: 'drill-category', label: 'POs behind a category bar (the list is held)', model: model({ spend: ready(BY_CATEGORY), drill: { key: 'TEXTILE', read: ready({ ...DRILL, by: 'category', key: 'TEXTILE', code: null, name: 'TEXTILE' }) } }, BUYER, 'by=category') },
    { id: 'drill-loading', label: 'POs behind a bar: reading', model: model({ drill: { key: SUPPLIERS[0]!.key, read: loading() } }) },
    { id: 'reason', label: 'Late lines: confirmed later than needed', model: model({ late: ready({ ...LATE, rows: [LATE_ROWS[1]!] }), address: { from: null, to: null, by: 'supplier', reason: 'CONFIRMED_LATE' } }, BUYER, 'reason=CONFIRMED_LATE') },
    { id: 'chain', label: 'The chain of a line confirmed later than needed', model: model({ chainLine: LATE_ROWS[1]!.lineId }) },
    { id: 'selected', label: 'Lines selected: Chase 2 orders', model: model({ selected: two }) },
    { id: 'selected-held', label: 'Lines selected without the right to send (held)', model: model({ spend: ready(plannerSpend), measure: 'orders', selected: [] }, PLANNER), note: 'The rows cannot be selected: their boxes say why (the right to send purchase orders).' },
    { id: 'chase-one', label: 'Chase one order (preview in the supplier’s language)', model: model({ chase: { groups: [{ orderId: LATE_ROWS[0]!.purchaseOrderId, number: LATE_ROWS[0]!.number, supplierName: LATE_ROWS[0]!.supplierName, version: 3, lineIds: [], seqs: [] }], preview: ready(PREVIEW), message: '', busy: false, results: null } }) },
    { id: 'chase-many', label: 'Chase the selected lines of two orders', model: model({ selected: two, chase: { groups: chaseGroupsOf(LATE_ROWS, two), preview: null, message: 'Ci servono entro venerdì.', busy: false, results: null } }) },
    {
      id: 'chase-sent',
      label: 'Chase sent (one refused, in words)',
      model: model({ chase: { groups: chaseGroupsOf(LATE_ROWS, two), preview: null, message: '', busy: false, results: [{ orderId: LATE_ROWS[0]!.purchaseOrderId, number: LATE_ROWS[0]!.number, ok: true, words: 'ordini@example.com' }, { orderId: LATE_ROWS[1]!.purchaseOrderId, number: LATE_ROWS[1]!.number, ok: false, words: 'chase.problem.changed' }] } }),
    },
    { id: 'chase-nothing', label: 'Chase held: nothing to chase', model: model({ chase: { groups: [{ orderId: LATE_ROWS[0]!.purchaseOrderId, number: LATE_ROWS[0]!.number, supplierName: LATE_ROWS[0]!.supplierName, version: 3, lineIds: [], seqs: [] }], preview: ready({ ...PREVIEW, allowed: false, why: 'Choose an active contact with an e-mail: the chase goes to them.', recipient: null }), message: '', busy: false, results: null } }) },
    { id: 'loading', label: 'Loading (skeletons)', model: model({ spend: loading(), late: loading(), asOf: null }) },
    { id: 'error', label: 'One panel failed, the other stands', model: model({ spend: failed() }), note: 'The panel says what failed and Try again.' },
    { id: 'empty', label: 'No spend, no late lines', model: model({ spend: ready({ ...SPEND, groups: [], all: figures(0, 0, 0, 0) }), late: ready({ ...LATE, rows: [], tiles: { late: 0, notConfirmed: 0, confirmedLate: 0, atRisk: 0, salesOrdersAtRisk: 0 } }) }) },
    { id: 'orders-not-in-role', label: 'The page without the orders’ view', model: model({ spend: ready({ ...SPEND, sight: { orders: false, values: false }, groups: [], all: figures(0, 0, 0, 0) }), late: { status: 'idle' } }, ['home.view', 'purchasing.reports.view']), note: 'Each panel says the purchase orders are not in the role.' },
    { id: 'arrange', label: 'Arrange panels', model: model({ arranging: true }) },
    { id: 'half-widths', label: 'Panels at half width', model: model({ layout: halfLayout }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: model({ keysOpen: true }) },
    { id: 'offline', label: 'Offline (live off)', model: model({ live: 'offline' }) },
    { id: 'no-permission', label: 'No right (sales)', model: model({}, rolePermissions('sales')) },
  ],
})
