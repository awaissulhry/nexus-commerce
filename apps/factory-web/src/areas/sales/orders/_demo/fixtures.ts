import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { VersionsAnswer } from '../../quotes/api'
import type { DepositRequest, Order, OrderBoard, OrderLine, OrderRow, OrderStatus, OrderWorkOrder, Progress, SdiStatus, Settlement } from '../api'
import { abilitiesOf, type OrderAbilities } from '../model'

/**
 * Made-up sales orders for the design cases of SCR-038 and SCR-039 (B-W1-25 part 2): an invented company, customers
 * ("Moto Demo S.r.l.", "Esempio Racing S.p.A.", "Squadra Fittizia S.r.l."), style "DEMO-JKT-01", people ("Sara
 * Vendite", "Fiona Conti") and numbers; every figure worked out by hand (8 × 450 + 6 × 440 = 6,240.00 net, VAT 22 %
 * 1,372.80, gross 7,612.80, deposit 30 % of the gross 2,283.84). Nothing here is a real company, person, order or
 * number. Design-only (a fixtures file: only fixtures and tests import it); it exports no `designScreen`, so the design
 * index skips it.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-10-29'
export const at = (day: number, hour: number, minute = 0, month = 10) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = DEMO_COMPANIES[0].id

// ---- roles ---------------------------------------------------------------------------------------------------------------------

const COMMON = ['home.view', 'threads.read', 'threads.post', 'files.read', 'files.upload']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, ...COMMON, 'quotes.view', 'quotes.manage', 'orders.view', 'orders.manage', 'orders.close', 'payments.view', 'payments.record', 'invoices.view', 'invoices.manage', 'invoices.issue', 'workorders.view', 'workorders.manage', 'money.price', 'money.cost', 'money.margin', 'email.send'],
  sales: [...COMMON, 'parties.view', 'quotes.view', 'quotes.manage', 'orders.view', 'orders.manage', 'invoices.view', 'payments.view', 'workorders.view', 'money.price', 'money.margin', 'email.send'],
  finance: [...COMMON, 'parties.view', 'quotes.view', 'orders.view', 'orders.close', 'payments.view', 'payments.record', 'invoices.view', 'invoices.manage', 'invoices.issue', 'money.price', 'money.cost', 'money.margin', 'email.send'],
  /** The production manager follows orders read-only (no money) and makes their work orders. */
  manager: [...COMMON, 'orders.view', 'workorders.view', 'workorders.manage', 'workorders.release'],
} as const
export type Role = keyof typeof ROLES
export const canOf = (role: Role): OrderAbilities => abilitiesOf(ROLES[role])

/** The Office shell around a page at this address (the role's navigation). */
export function inShell(path: string, page: ReactNode, role: Role = 'sales'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

/** What an API answer holds for a role: money fields only with their grains (absent, never zero). */
export function forRole<T>(value: T, role: Role): T {
  const can = canOf(role)
  const drop = new Set<string>([
    ...(can.price ? [] : ['unitPrice', 'netAmount', 'vatAmount', 'grossAmount', 'amount', 'paidAmount', 'grossTotal', 'openAmount', 'invoicedAmount', 'creditedAmount', 'balanceDueAmount']),
    ...(can.cost ? [] : ['unitCost', 'costAmount']),
    ...(can.margin ? [] : ['marginPct']),
  ])
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !drop.has(key)).map(([key, inner]) => [key, walk(inner)]))
    return item
  }
  return walk(value) as T
}

// ---- the list ------------------------------------------------------------------------------------------------------------------

const PARTIES = [
  { id: uid('6666', 1), name: 'Moto Demo S.r.l.' },
  { id: uid('6666', 2), name: 'Esempio Racing S.p.A.' },
  { id: uid('6666', 3), name: 'Squadra Fittizia S.r.l.' },
]

const row = (n: number, status: OrderStatus, extra: Partial<OrderRow> = {}): OrderRow => ({
  id: uid('5151', n),
  number: `SO-2026-${String(n).padStart(4, '0')}`,
  companyId: COMPANY,
  partyId: PARTIES[n % 3]!.id,
  partyName: PARTIES[n % 3]!.name,
  customerRef: n % 2 === 0 ? `PO-ESEMPIO-${n}` : null,
  status,
  deposit: { state: 'PAID', dueDate: null },
  lineCount: 2,
  units: 14,
  shippedUnits: 0,
  orderDate: '2026-10-12',
  requestedDate: '2026-12-10',
  promiseDate: '2026-12-15',
  daysLate: status === 'SHIPPED' || status === 'CLOSED' || status === 'CANCELLED' ? null : 0,
  currency: 'EUR',
  netAmount: 624000,
  grossAmount: 761280,
  quote: { id: uid('4141', n), number: `Q-2026-${String(n + 100).padStart(4, '0')}`, versionId: uid('4242', n), revision: 1 },
  version: 3,
  updatedAt: at(29, 8, 10),
  ...extra,
})

export const LIST_ROWS: OrderRow[] = [
  row(88, 'CONFIRMED', { deposit: { state: 'OPEN', dueDate: '2026-11-04' }, orderDate: '2026-10-28' }),
  row(87, 'CONFIRMED', { deposit: { state: 'OPEN', dueDate: '2026-10-26' }, units: 30, netAmount: 1260000, grossAmount: 1537200, promiseDate: '2026-12-01' }),
  row(86, 'CONFIRMED', { deposit: { state: 'NOT_NEEDED', dueDate: null }, units: 6, lineCount: 1, netAmount: 270000, grossAmount: 329400 }),
  row(84, 'IN_PRODUCTION', { units: 64, lineCount: 4, netAmount: 2880000, grossAmount: 3513600, promiseDate: '2026-11-20' }),
  row(83, 'IN_PRODUCTION', { promiseDate: '2026-10-24', daysLate: 5 }),
  row(81, 'READY', { units: 20, netAmount: 900000, grossAmount: 1098000, promiseDate: '2026-11-05' }),
  row(79, 'PARTLY_SHIPPED', { units: 40, shippedUnits: 24, netAmount: 1800000, grossAmount: 2196000, promiseDate: '2026-10-20', daysLate: 9 }),
  row(76, 'SHIPPED', { shippedUnits: 14, promiseDate: '2026-10-15' }),
  row(71, 'CLOSED', { shippedUnits: 14, promiseDate: '2026-09-30' }),
  row(70, 'CANCELLED', { deposit: { state: 'NOT_NEEDED', dueDate: null }, customerRef: null }),
]
export const OPEN_ROWS = LIST_ROWS.filter((entry) => ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'].includes(entry.status))

export const BOARD: OrderBoard = {
  byStatus: [
    { status: 'CONFIRMED', count: 3 },
    { status: 'IN_PRODUCTION', count: 2 },
    { status: 'READY', count: 1 },
    { status: 'PARTLY_SHIPPED', count: 1 },
    { status: 'SHIPPED', count: 1 },
    { status: 'CLOSED', count: 12 },
    { status: 'CANCELLED', count: 1 },
  ],
  lanes: ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED'],
  tiles: [
    { key: 'late', count: 2, filter: { late: 'true' } },
    { key: 'waitingForDeposit', count: 2, filter: { deposit: 'OPEN' } },
    { key: 'inProduction', count: 2, filter: { status: 'IN_PRODUCTION' } },
    { key: 'readyToShip', count: 1, filter: { status: 'READY' } },
  ],
  asOf: at(29, 9, 42),
}

// ---- the record ----------------------------------------------------------------------------------------------------------------

export const ORDER_ID = uid('5151', 88)
const QUOTE_ID = uid('4141', 88)
const VERSION_ID = uid('4242', 88)
export const DEPOSIT_ID = uid('3131', 1)
export const TD02_ID = uid('2121', 1)
export const PEOPLE = { sales: uid('3333', 11), finance: uid('3333', 12) }

const progress = (ordered: number, made: Partial<Progress> = {}): Progress => ({ ordered, inWorkOrders: 0, made: null, released: 0, shipped: 0, invoiced: '0', toShip: ordered, ...made })

type Stage = 'new' | 'production' | 'partly' | 'shipped'

/** A size's progress at a stage of the order (in work orders → released → shipped). */
function sizeAt(quantity: number, stage: Stage): Progress {
  if (stage === 'new') return progress(quantity)
  if (stage === 'production') return progress(quantity, { inWorkOrders: quantity, released: Math.floor(quantity / 2) })
  if (stage === 'partly') {
    const shipped = Math.ceil(quantity / 2)
    return progress(quantity, { inWorkOrders: quantity, released: quantity, shipped, toShip: quantity - shipped, invoiced: String(shipped) })
  }
  return progress(quantity, { inWorkOrders: quantity, released: quantity, shipped: quantity, toShip: 0, invoiced: String(quantity) })
}

function line(seq: number, colour: { id: string; code: string; name: string }, sizes: Array<[string, number]>, price: string, stage: Stage, extra: Partial<OrderLine> = {}): OrderLine {
  const quantity = sizes.reduce((sum, [, n]) => sum + n, 0)
  const net = Math.round(Number(price) * 100) * quantity
  const rows = sizes.map(([size, n]) => ({ size, quantity: n, unitPrice: null, progress: sizeAt(n, stage) }))
  const total = rows.reduce<Progress>(
    (sum, entry) => ({
      ordered: sum.ordered + entry.progress.ordered,
      inWorkOrders: sum.inWorkOrders + entry.progress.inWorkOrders,
      made: null,
      released: sum.released + entry.progress.released,
      shipped: sum.shipped + entry.progress.shipped,
      invoiced: String(Number(sum.invoiced) + Number(entry.progress.invoiced)),
      toShip: sum.toShip + entry.progress.toShip,
    }),
    progress(0, { toShip: 0 }),
  )
  return {
    id: uid('7171', seq),
    seq,
    kind: 'SIZE_GRID',
    styleId: uid('7777', 1),
    style: { code: 'DEMO-JKT-01', name: 'Giacca pelle demo' },
    styleRevisionId: uid('7878', 3),
    styleRevision: { revision: 3, status: 'RELEASED' },
    colourwayId: colour.id,
    colourway: { code: colour.code, name: colour.name },
    measurementProfileId: null,
    baseSize: null,
    description: null,
    note: null,
    quantity,
    unitPrice: price,
    netAmount: net,
    vatRatePct: '22.00',
    vatNature: null,
    vatAmount: Math.round(net * 0.22),
    unitCost: price === '450' ? '291.2' : '286.4',
    costAmount: Math.round((price === '450' ? 291.2 : 286.4) * 100) * quantity,
    requestedDate: null,
    promiseDate: null,
    priority: null,
    siteId: null,
    version: 1,
    sizes: rows,
    progress: total,
    ...extra,
  }
}

const BLK = { id: uid('7979', 1), code: 'BLK', name: 'Nero' }
const RED = { id: uid('7979', 2), code: 'RED', name: 'Rosso' }

export function deposit(over: Partial<DepositRequest> = {}): DepositRequest {
  return {
    id: DEPOSIT_ID,
    quoteVersionId: VERSION_ID,
    orderId: ORDER_ID,
    kind: 'ACCONTO',
    depositPct: '30',
    currency: 'EUR',
    amount: 228384,
    dueDate: '2026-11-04',
    fiscalDocument: 'TD02',
    fiscalRule: 'DEPOSIT_IT_GOODS',
    status: 'OPEN',
    paidAt: null,
    createdAt: at(28, 15),
    paidAmount: 0,
    link: null,
    ...over,
  }
}

export const SENT_LINK = { sentAt: at(28, 16, 5), to: 'acquisti@moto-demo.example.com', expiresAt: at(27, 16, 5, 11), state: 'LIVE' as const }
export const PAID = deposit({ status: 'PAID', paidAt: at(29, 9, 12), paidAmount: 228384, link: SENT_LINK })
export const TD02 = { id: TD02_ID, number: 'FA-2026-00031', docType: 'TD02', status: 'ISSUED', issueDate: '2026-10-29', depositRequestId: DEPOSIT_ID }

const actionsFor = (status: OrderStatus, settled: boolean): Order['actions'] => {
  const actions: Order['actions'] = []
  if (status !== 'CLOSED' && status !== 'CANCELLED') actions.push({ action: 'changePromise', allowed: true, needsReason: true, held: null })
  if (status === 'IN_PRODUCTION') actions.push({ action: 'markReady', allowed: true, needsReason: true, held: null })
  if (status === 'CONFIRMED') actions.push({ action: 'cancel', allowed: true, needsReason: true, held: null })
  if (status === 'SHIPPED') actions.push({ action: 'close', allowed: true, needsReason: !settled, held: settled ? null : 'Not settled.' })
  return actions
}

const STAGE: Record<OrderStatus, Stage> = { CONFIRMED: 'new', IN_PRODUCTION: 'production', READY: 'production', PARTLY_SHIPPED: 'partly', SHIPPED: 'shipped', CLOSED: 'shipped', CANCELLED: 'new' }

/** SO-2026-0088 for Moto Demo S.r.l. at a state, with the parts of its chain that state has. */
export function order(status: OrderStatus = 'CONFIRMED', over: Partial<Order> & { settled?: boolean } = {}): Order {
  const { settled = false, ...rest } = over
  const stage = STAGE[status]
  const lines = [line(10, BLK, [['48', 2], ['50', 2], ['52', 2], ['54', 2]], '450', stage), line(20, RED, [['50', 2], ['52', 2], ['54', 2]], '440', stage, status === 'CONFIRMED' ? {} : { promiseDate: '2026-12-22' })]
  const sum = (pick: (entry: Progress) => number) => lines.reduce((total, entry) => total + pick(entry.progress), 0)
  const shippedLater = stage === 'partly' || stage === 'shipped'
  return {
    id: ORDER_ID,
    number: 'SO-2026-0088',
    companyId: COMPANY,
    partyId: PARTIES[1]!.id,
    party: { code: 'MOTO-DEMO', legalName: 'Moto Demo S.r.l.' },
    customerRef: 'PO-ESEMPIO-88',
    status,
    orderDate: '2026-10-28',
    currency: 'EUR',
    language: 'it',
    taxMode: 'IT_B2B',
    priceBasis: 'NET',
    paymentTerms: 'Bonifico 30 gg d.f.',
    requestedDate: '2026-12-10',
    promiseDate: '2026-12-15',
    originalPromiseDate: status === 'CONFIRMED' ? '2026-12-15' : '2026-12-08',
    daysLate: status === 'SHIPPED' || status === 'CLOSED' || status === 'CANCELLED' ? null : 0,
    priority: 0,
    noWithdrawal: false,
    depositRequired: true,
    netAmount: 624000,
    vatAmount: 137280,
    grossAmount: 761280,
    costAmount: 404800,
    marginPct: '35.1282',
    cancelReason: status === 'CANCELLED' ? 'Il cliente ha ritirato l’ordine prima della produzione.' : null,
    closedAt: status === 'CLOSED' ? at(29, 11) : null,
    version: 4,
    createdAt: at(28, 15),
    updatedAt: at(29, 9, 12),
    createdById: null,
    lines,
    progress: { ordered: sum((entry) => entry.ordered), inWorkOrders: sum((entry) => entry.inWorkOrders), made: null, released: sum((entry) => entry.released), shipped: sum((entry) => entry.shipped), invoiced: String(sum((entry) => Number(entry.invoiced))), toShip: sum((entry) => entry.toShip) },
    chain: {
      quote: { id: QUOTE_ID, number: 'Q-2026-0188', versionId: VERSION_ID, revision: 2 },
      depositRequests: [status === 'CONFIRMED' ? deposit() : PAID],
      workOrders:
        stage === 'new'
          ? []
          : [
              { id: uid('9191', 21), number: 'WO-00021', status: stage === 'production' ? 'IN_PROGRESS' : 'COMPLETED', siteId: uid('2222', 1), releasedAt: at(30, 8) },
              { id: uid('9191', 22), number: 'WO-00022', status: stage === 'production' ? 'RELEASED' : 'COMPLETED', siteId: uid('2222', 1), releasedAt: at(30, 9) },
            ],
      shipments: shippedLater
        ? [
            { id: uid('8181', 1), number: 'SH-2026-0041', status: 'DELIVERED', shippedAt: at(12, 10, 0, 11), deliveredAt: at(14, 11, 0, 11) },
            ...(stage === 'shipped' ? [{ id: uid('8181', 2), number: 'SH-2026-0047', status: 'SHIPPED', shippedAt: at(20, 10, 0, 11), deliveredAt: null }] : []),
          ]
        : [],
      invoices: [
        ...(status === 'CONFIRMED' ? [] : [TD02]),
        ...(shippedLater ? [{ id: uid('2121', 2), number: 'FA-2026-00052', docType: 'TD01', status: 'DELIVERED', issueDate: '2026-11-12', depositRequestId: null }] : []),
      ],
    },
    promiseHistory:
      status === 'CONFIRMED'
        ? []
        : [
            { at: at(30, 14), actorId: PEOPLE.sales, from: '2026-12-15', to: '2026-12-22', lineIds: [uid('7171', 20)], reason: 'Il rosso chiede un secondo bagno di colore.' },
            { at: at(29, 10), actorId: PEOPLE.sales, from: '2026-12-08', to: '2026-12-15', lineIds: [], reason: 'La pelle nera arriva una settimana dopo.' },
          ],
    people: [
      { id: PEOPLE.sales, name: 'Sara Vendite' },
      { id: PEOPLE.finance, name: 'Fiona Conti' },
    ],
    settlement: { settled, missing: settled ? [] : status === 'SHIPPED' ? [{ code: 'BALANCE_DUE', message: '' }, { code: 'AT_SDI', message: '' }] : [{ code: 'NOT_SHIPPED', message: '' }, { code: 'NO_INVOICE', message: '' }], source: 'invoicing' },
    actions: actionsFor(status, settled),
    ...rest,
  }
}

export const WORK_ORDERS: OrderWorkOrder[] = [
  { id: uid('9191', 21), number: 'WO-00021', status: 'IN_PROGRESS', styleCode: 'DEMO-JKT-01', styleName: 'Giacca pelle demo', colourways: ['BLK'], siteCode: 'STAB-N', pieces: 8, progress: { cut: 8, bundled: 8, sewn: 5, finished: 2 }, dueDate: '2026-12-05', daysLate: 0 },
  { id: uid('9191', 22), number: 'WO-00022', status: 'RELEASED', styleCode: 'DEMO-JKT-01', styleName: 'Giacca pelle demo', colourways: ['RED'], siteCode: 'STAB-N', pieces: 6, progress: { cut: 0, bundled: 0, sewn: 0, finished: 0 }, dueDate: '2026-12-12', daysLate: 0 },
]

export function sdi(code: SdiStatus['state']['code'], action: SdiStatus['state']['next']['action'], canSend = false): SdiStatus {
  return { invoiceId: TD02_ID, number: TD02.number, issueDate: TD02.issueDate, invoiceStatus: code === 'NOT_SENT' ? 'ISSUED' : code === 'DELIVERED' ? 'DELIVERED' : 'SENT', version: 2, state: { code, next: { action } }, canSend, sends: [] }
}

export const SETTLEMENT_OPEN: Settlement = { settled: false, gaps: ['NOT_SHIPPED', 'NO_INVOICE'], invoices: [{ id: TD02_ID, docType: 'TD02', number: TD02.number, status: 'ISSUED', grossTotal: 228384, paidAmount: 228384, openAmount: 0 }], invoicedAmount: 0, creditedAmount: 0, paidAmount: 0, balanceDueAmount: 0 }
export const SETTLEMENT_SHIPPED: Settlement = {
  settled: false,
  gaps: ['BALANCE_DUE'],
  invoices: [
    { id: TD02_ID, docType: 'TD02', number: TD02.number, status: 'DELIVERED', grossTotal: 228384, paidAmount: 228384, openAmount: 0 },
    { id: uid('2121', 2), docType: 'TD01', number: 'FA-2026-00052', status: 'DELIVERED', grossTotal: 532896, paidAmount: 0, openAmount: 532896 },
  ],
  invoicedAmount: 761280,
  creditedAmount: 0,
  paidAmount: 228384,
  balanceDueAmount: 532896,
}

export const VERSIONS: VersionsAnswer = {
  people: [{ id: PEOPLE.sales, name: 'Sara Vendite' }],
  versions: [
    {
      id: VERSION_ID,
      revision: 2,
      documentNumber: 'Q-2026-0188/2',
      status: 'ACCEPTED',
      currency: 'EUR',
      netAmount: 624000,
      grossAmount: 761280,
      depositAmount: 228384,
      validUntil: '2026-11-27',
      firmOffer: false,
      changeNote: null,
      createdAt: at(26, 9),
      createdById: PEOPLE.sales,
      sentAt: at(27, 10),
      sentById: PEOPLE.sales,
      closedAt: at(28, 15),
      decisionNote: null,
      documentSha256: '3f6c0e8a2b9d41c7a5e0f1d2c3b4a59687e6d5c4b3a2918f7e6d5c4b3a291807',
      termsVersion: 'CGV-2026-01',
      document: { fileId: uid('1919', 1), name: 'Q-2026-0188-v2.pdf', sha256: '3f6c0e8a2b9d41c7a5e0f1d2c3b4a59687e6d5c4b3a2918f7e6d5c4b3a291807', sizeBytes: 182_311, status: 'AVAILABLE' },
      links: [],
      acceptance: { id: uid('1818', 1), channel: 'LINK', signerName: 'Anna Esempio', emailCheck: 'MATCHED', documentSha256: '3f6c0e8a2b9d41c7a5e0f1d2c3b4a59687e6d5c4b3a2918f7e6d5c4b3a291807', documentMatches: true, termsVersion: 'CGV-2026-01', noWithdrawalAccepted: false, acceptedAt: at(28, 15) },
      deposit: null,
    },
  ],
}

// ---- the record panels on an order -------------------------------------------------------------------------------------------

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

export function panelsModel(): RecordPanelsViewModel {
  return { ...conversation, record: { type: 'SalesOrder', id: ORDER_ID, companyId: COMPANY, siteId: null }, title: 'SO-2026-0088 · Moto Demo S.r.l.', party: null }
}
