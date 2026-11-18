import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { canOf, inShell, PREFIX, type Role } from '../_shared/fixtures'
import { NOTE_TARGETS, noteModel } from '../_shared/notes/fixtures'
import type { Issues, Overview, OverviewRow, UrgentRow } from './api'
import { overviewTermsOf, type OverviewTerms } from './model'
import { OverviewView, type OverviewModel } from './view/OverviewView'

/**
 * F-PR-04 — Production › Overview with made-up data only (two made-up customers, "Brand Alpha" and "Brand Beta", a work order made
 * before the one-customer rule, a sample of no customer; every figure worked out by hand): the six tiles, Exceptions by customer with
 * the mixed row and the Total, WIP by stage × customer (a stage the floor does not count is "—"), Most urgent "3 of 7 · Show all"
 * with its row ⋯ Ask the supervisor, the open issues. The cases: the production unit (every customer), a person limited to Brand Beta
 * (PW-01: only Beta's rows, the Total = Beta's, no mixed row), one customer picked, Only mine, nothing in production, loading, the
 * read failed, the note dialog open over one work order, Ask held (no threads.post) or failed, the issues' own states.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const ALPHA = { id: uid('6a6a', 1), code: 'BR-ALPHA', name: 'Brand Alpha' }
export const BETA = { id: uid('6a6a', 2), code: 'BR-BETA', name: 'Brand Beta' }
const SITE = { id: uid('2222', 1), code: 'STAB-N' }

type Figures = Omit<OverviewRow, 'kind' | 'customer'>

const figures = (over: {
  workOrders: number
  pieces: number
  late?: number
  atRisk?: number
  blocked?: number
  waitingOn?: Partial<OverviewRow['waitingOn']>
  blockedBy?: Partial<OverviewRow['blockedBy']>
  customerUrgent?: number
  requests?: OverviewRow['requests']
  stages?: Partial<OverviewRow['wip']['stages']>
  sewingNotCounted?: number
}): Figures => ({
  inProduction: { workOrders: over.workOrders, pieces: over.pieces },
  late: over.late ?? 0,
  atRisk: over.atRisk ?? 0,
  blocked: over.blocked ?? 0,
  waitingOn: { US: 0, BRAND: 0, SUPPLIER: 0, WORKSHOP: 0, ...over.waitingOn },
  blockedBy: { HOLD: 0, CUSTOMER: 0, MATERIAL: 0, GATE: 0, NEEDS_SPLIT: 0, ...over.blockedBy },
  customerUrgent: over.customerUrgent ?? 0,
  requests: over.requests ?? { waiting: 0, toAnswer: 0 },
  wip: { stages: { NOT_RELEASED: 0, RELEASED: 0, CUTTING: 0, SEWING: 0, AT_WORKSHOP: 0, QUALITY: 0, FINISHED: 0, ON_HOLD: 0, ...over.stages }, sewingNotCounted: over.sewingNotCounted ?? 0 },
})

const ALPHA_ROW: OverviewRow = {
  kind: 'CUSTOMER',
  customer: ALPHA,
  ...figures({
    workOrders: 14,
    pieces: 1240,
    late: 2,
    atRisk: 3,
    blocked: 2,
    waitingOn: { US: 8, BRAND: 2, SUPPLIER: 1, WORKSHOP: 1 },
    blockedBy: { HOLD: 1, CUSTOMER: 2, MATERIAL: 1, GATE: 1 },
    customerUrgent: 2,
    requests: { waiting: 2, toAnswer: 2 },
    stages: { NOT_RELEASED: 200, RELEASED: 120, CUTTING: 300, SEWING: 380, AT_WORKSHOP: 60, QUALITY: 90, FINISHED: 40, ON_HOLD: 50 },
  }),
}
const BETA_ROW: OverviewRow = {
  kind: 'CUSTOMER',
  customer: BETA,
  ...figures({
    workOrders: 6,
    pieces: 420,
    late: 1,
    atRisk: 1,
    blocked: 1,
    waitingOn: { US: 3, BRAND: 1, WORKSHOP: 1 },
    blockedBy: { CUSTOMER: 1 },
    requests: { waiting: 2, toAnswer: 1 },
    // One started work order of Beta's counts no sewing here: Sewing and Quality are "—".
    stages: { NOT_RELEASED: 60, RELEASED: 40, CUTTING: 100, SEWING: null, AT_WORKSHOP: 80, QUALITY: null, FINISHED: 0, ON_HOLD: 0 },
    sewingNotCounted: 1,
  }),
}
const MIXED_ROW: OverviewRow = { kind: 'MIXED', customer: null, ...figures({ workOrders: 1, pieces: 24, waitingOn: { US: 1 }, blockedBy: { NEEDS_SPLIT: 1 }, stages: { RELEASED: 24 } }) }
const NONE_ROW: OverviewRow = { kind: 'NO_CUSTOMER', customer: null, ...figures({ workOrders: 1, pieces: 6, stages: { NOT_RELEASED: 6 } }) }

/** The Total of these rows, as the API adds it up (the screen never does: it draws `overall`). */
function totalOf(rows: readonly OverviewRow[]): OverviewRow {
  const add = <K extends string>(pick: (row: OverviewRow) => Record<K, number | null>): Record<K, number | null> => {
    const out = {} as Record<K, number | null>
    for (const row of rows) {
      for (const [key, value] of Object.entries(pick(row)) as [K, number | null][]) {
        const before = out[key]
        out[key] = value === null ? (before ?? null) : (before ?? 0) + value
      }
    }
    return out
  }
  const sum = (pick: (row: OverviewRow) => number) => rows.reduce((total, row) => total + pick(row), 0)
  return {
    kind: 'ALL',
    customer: null,
    inProduction: { workOrders: sum((row) => row.inProduction.workOrders), pieces: sum((row) => row.inProduction.pieces) },
    late: sum((row) => row.late),
    atRisk: sum((row) => row.atRisk),
    blocked: sum((row) => row.blocked),
    waitingOn: add((row) => row.waitingOn) as OverviewRow['waitingOn'],
    blockedBy: add((row) => row.blockedBy) as OverviewRow['blockedBy'],
    customerUrgent: sum((row) => row.customerUrgent),
    requests: { waiting: sum((row) => row.requests.waiting), toAnswer: sum((row) => row.requests.toAnswer) },
    wip: { stages: add((row) => row.wip.stages) as OverviewRow['wip']['stages'], sewingNotCounted: sum((row) => row.wip.sewingNotCounted) },
  }
}

const urgent = (n: number, customer: typeof ALPHA, over: Partial<UrgentRow>): UrgentRow => ({
  id: uid('9a9a', n),
  number: `WO-${String(300 + n).padStart(4, '0')}`,
  status: 'IN_PROGRESS',
  kind: 'SIZE_GRID',
  siteId: SITE.id,
  siteCode: SITE.code,
  style: { code: 'JK-210', name: 'Giacca Rider demo' },
  partyId: customer.id,
  customer,
  mixedCustomers: false,
  dueDate: '2026-11-20',
  daysLate: 0,
  pieces: 100,
  risk: { state: 'AT_RISK', daysLate: null, plannedEnd: '2026-11-24', planAfterDue: true, raised: null, blockedBy: null },
  waitingOn: { on: 'US', since: '2026-11-17T08:00:00.000Z' },
  supervisor: 'SOMEONE_ELSE',
  customerUrgency: null,
  urgentRank: null,
  gate: false,
  ...over,
})

const URGENT: UrgentRow[] = [
  urgent(11, ALPHA, { dueDate: '2026-11-15', daysLate: 3, risk: { state: 'LATE', daysLate: 3, plannedEnd: '2026-11-21', planAfterDue: true, raised: null, blockedBy: null }, supervisor: 'ME', customerUrgency: 'URGENT', urgentRank: 1 }),
  urgent(12, BETA, { style: { code: 'PT-110', name: 'Pantalone demo' }, waitingOn: { on: 'BRAND', since: '2026-11-16T09:30:00.000Z' }, risk: { state: 'AT_RISK', daysLate: null, plannedEnd: '2026-11-24', planAfterDue: true, raised: null, blockedBy: 'CUSTOMER' } }),
  urgent(13, ALPHA, { style: { code: 'SH-020', name: 'Gilet demo' }, dueDate: '2026-11-25', risk: { state: 'AT_RISK', daysLate: null, plannedEnd: '2026-11-23', planAfterDue: false, raised: 'MATERIAL_LATE', blockedBy: null }, supervisor: 'NOT_SET', status: 'RELEASED' }),
]

const ROWS = [ALPHA_ROW, BETA_ROW]
const overview = (over: Partial<Overview> = {}): Overview => {
  const customers = over.customers ?? ROWS
  const mixed = over.mixed === undefined ? MIXED_ROW : over.mixed
  const noCustomer = over.noCustomer === undefined ? NONE_ROW : over.noCustomer
  const overall = over.overall ?? totalOf([...customers, ...(mixed ? [mixed] : []), ...(noCustomer ? [noCustomer] : [])])
  return {
    asOf: '2026-11-18T09:42:00.000Z',
    today: '2026-11-18',
    filter: { siteId: null, partyId: null, supervisor: null },
    everyCustomer: true,
    tiles: {
      waitingOnUs: overall.waitingOn.US,
      waitingOnCustomer: overall.waitingOn.BRAND,
      waitingOnSupplier: overall.waitingOn.SUPPLIER,
      waitingOnWorkshop: overall.waitingOn.WORKSHOP,
      late: overall.late,
      atRisk: overall.atRisk,
      blocked: overall.blocked,
      customerRequests: overall.requests.toAnswer,
    },
    requests: { waiting: overall.requests.waiting, toAnswer: overall.requests.toAnswer, byKind: [{ kind: 'RUSH', open: 1, countered: 0 }] },
    mostUrgent: { items: URGENT, count: 7, nextCursor: 'risk~1~2026-11-25~x' },
    live: { events: ['workorder.changed', 'brand_production.health_changed'] },
    ...over,
    customers,
    mixed,
    noCustomer,
    overall,
  }
}

const issue = (n: number, customer: typeof ALPHA, over: Partial<Issues['issues'][number]> = {}): Issues['issues'][number] => ({
  id: uid('1e1e', n),
  source: 'BRAND',
  status: 'OPEN',
  note: null,
  record: { type: 'SalesOrder', id: uid('5a5a', n), label: `SO-DEMO-${String(140 + n).padStart(4, '0')}` },
  salesOrder: { id: uid('5a5a', n), number: `SO-DEMO-${String(140 + n).padStart(4, '0')}` },
  customer: { id: customer.id, name: customer.name },
  raisedAt: '2026-11-16T10:00:00.000Z',
  dueOn: '2026-11-17',
  escalation: null,
  task: { id: uid('7e7e', n), status: 'OPEN', assignee: 'SOMEONE_ELSE' },
  mine: false,
  ...over,
})

const ISSUES: Issues = {
  asOf: '2026-11-18T09:42:00.000Z',
  counts: { open: 5, noReplyYet: 1, escalated: 1, mine: 1 },
  issues: [
    issue(1, ALPHA, { escalation: { step: 1, at: '2026-11-18T07:00:00.000Z' } }),
    issue(2, BETA, { note: 'NO_REPLY_YET', task: { id: uid('7e7e', 2), status: 'DONE', assignee: 'ME' }, mine: true, dueOn: '2026-11-19' }),
    issue(3, ALPHA, { source: 'OFFICE', record: { type: 'WorkOrder', id: uid('9a9a', 11), label: 'WO-0311' }, salesOrder: null, dueOn: '2026-11-19', task: { id: uid('7e7e', 3), status: 'OPEN', assignee: 'NOT_SET' } }),
  ],
  more: true,
  live: { events: ['production_issue.raised'] },
}

const EVERY = { options: [ALPHA, BETA], party: null, everyCustomer: true, names: true }

export interface OverviewCase {
  readonly role: Role
  readonly overview: OverviewModel
}

const model = (role: Role, over: Partial<OverviewModel> = {}, terms: OverviewTerms = overviewTermsOf(null)): OverviewCase => ({
  role,
  overview: {
    prefix: PREFIX,
    can: canOf(role),
    terms,
    names: true,
    overview: { value: overview(), problem: null },
    issues: { value: ISSUES, problem: null },
    asOf: '2026-11-18T09:42:00.000Z',
    now: Date.parse('2026-11-18T09:42:00.000Z'),
    live: 'live',
    customers: EVERY,
    noteCan: true,
    asking: null,
    notice: null,
    note: null,
    ...over,
  },
})

/** PW-01's limited person (customer Beta only): the API's answer holds Beta alone, its Total = Beta's, no mixed or no-customer row. */
export const LIMITED_ANSWER: Overview = overview({
  everyCustomer: false,
  customers: [BETA_ROW],
  mixed: null,
  noCustomer: null,
  mostUrgent: { items: URGENT.filter((row) => row.partyId === BETA.id), count: 2, nextCursor: null },
})
export const LIMITED_ISSUES: Issues = { ...ISSUES, counts: { open: 1, noReplyYet: 1, escalated: 0, mine: 1 }, issues: ISSUES.issues.filter((row) => row.customer.id === BETA.id), more: false }
export const EVERY_ANSWER: Overview = overview()

const ONE_TARGET = { workOrders: [NOTE_TARGETS.workOrders[0]!], salesOrders: [NOTE_TARGETS.salesOrders[0]!], withoutOrder: 0 }

function OverviewDesign({ model: item }: { model: OverviewCase }) {
  return inShell('/production/overview', createElement(OverviewView, { model: item.overview }), item.role)
}

export const designScreen = defineDesignScreen<OverviewCase>({
  screen: 'SCR-069-overview',
  title: 'Production › Overview (F-PR-04)',
  view: OverviewDesign,
  cases: [
    { id: 'overview', label: 'Production manager: every customer — tiles, exceptions with the Total, WIP by stage, Most urgent 3 of 7, open issues', model: model('manager'), note: 'Every number opens Work orders with its filter; Customer requests opens Home › Approvals; a 0 is said plainly.' },
    { id: 'owner', label: 'Owner', model: model('owner') },
    {
      id: 'limited',
      label: 'PW-01 · a person limited to Brand Beta: only Beta’s rows, the Total is Beta’s, no mixed row',
      model: model('manager', { names: false, overview: { value: LIMITED_ANSWER, problem: null }, issues: { value: LIMITED_ISSUES, problem: null }, customers: { options: [BETA], party: null, everyCustomer: false, names: false } }),
      note: 'Customers by code (no parties.view). Nothing of Brand Alpha anywhere.',
    },
    {
      id: 'one-customer',
      label: 'Customer: Brand Alpha picked — its row and its Total; every door carries ?party=',
      model: model('manager', { overview: { value: overview({ customers: [ALPHA_ROW], mixed: null, noCustomer: null, filter: { siteId: null, partyId: ALPHA.id, supervisor: null } }), problem: null }, customers: { ...EVERY, party: ALPHA.id } }, { party: ALPHA.id, mine: false }),
    },
    {
      id: 'mine',
      label: 'Only mine: the orders I supervise; every door carries ?supervisor=me',
      model: model('manager', { overview: { value: overview({ customers: [{ ...ALPHA_ROW, ...figures({ workOrders: 2, pieces: 180, late: 1, waitingOn: { US: 2 }, stages: { SEWING: 120, QUALITY: 60 } }) }], mixed: null, noCustomer: null, mostUrgent: { items: [URGENT[0]!], count: 1, nextCursor: null }, filter: { siteId: null, partyId: null, supervisor: 'me' } }), problem: null } }, { party: null, mine: true }),
    },
    { id: 'empty', label: 'Nothing in production and nothing waiting (New work order for a manager)', model: model('manager', { overview: { value: overview({ customers: [], mixed: null, noCustomer: null, overall: { kind: 'ALL', customer: null, ...figures({ workOrders: 0, pieces: 0 }) }, mostUrgent: { items: [], count: 0, nextCursor: null } }), problem: null }, issues: { value: { ...ISSUES, counts: { open: 0, noReplyYet: 0, escalated: 0, mine: 0 }, issues: [], more: false }, problem: null } }) },
    { id: 'empty-mine', label: 'Only mine with nothing of mine', model: model('manager', { overview: { value: overview({ customers: [], mixed: null, noCustomer: null, overall: { kind: 'ALL', customer: null, ...figures({ workOrders: 0, pieces: 0 }) }, mostUrgent: { items: [], count: 0, nextCursor: null } }), problem: null } }, { party: null, mine: true }) },
    { id: 'nothing-urgent', label: 'Most urgent: nothing late or at risk', model: model('manager', { overview: { value: overview({ mostUrgent: { items: [], count: 0, nextCursor: null } }), problem: null } }) },
    { id: 'loading', label: 'Loading', model: model('manager', { overview: { value: null, problem: null }, issues: { value: null, problem: null }, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'The read failed: in words, with Try again', model: model('manager', { overview: { value: null, problem: 'error.offline' }, issues: { value: null, problem: 'error.offline' }, live: 'offline' }) },
    { id: 'no-permission', label: 'No right to see work orders: the API refused', model: model('sales', { overview: { value: null, problem: 'error.forbidden' }, issues: { value: null, problem: 'error.forbidden' } }) },
    { id: 'ask-open', label: 'Most urgent ⋯ Ask the supervisor: THE note dialog over WO-0301', model: model('manager', { note: noteModel({ from: 'band', targets: ONE_TARGET, answer: null }) }), note: 'The same dialog as the work order band (F-PR-22).' },
    { id: 'ask-held', label: 'Ask the supervisor held: the role writes no office notes (threads.post)', model: model('manager', { noteCan: false }), note: 'Open a row’s ⋯: the item says why.' },
    { id: 'ask-failed', label: 'Ask the supervisor: the work order could not be read', model: model('manager', { notice: 'error.offline' }) },
    { id: 'issues-error', label: 'Open issues: the read failed, with Try again', model: model('manager', { issues: { value: null, problem: 'error.offline' } }) },
    { id: 'issues-none', label: 'Open issues: none', model: model('manager', { issues: { value: { ...ISSUES, counts: { open: 0, noReplyYet: 0, escalated: 0, mine: 0 }, issues: [], more: false }, problem: null } }) },
  ],
})
