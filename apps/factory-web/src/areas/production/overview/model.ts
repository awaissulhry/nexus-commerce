import type { Tone } from '@nexus/ui/primitives'
import { partyOf, PARTY_KEY } from '../_shared/customer/model'
import type { Phrase } from '../_shared/model'
import { blockedKeyOf, healthCellOf, listAddress, termsOf, waitingInputOf, type HealthCell, type ListTerms } from '../work-orders/list/model'
import { markKeyOf } from '../../_shared/production-supervisor/model'
import { WIP_STAGES, type IssueRow, type Issues, type Overview, type OverviewRow, type UrgentRow, type WipStage } from './api'

/**
 * F-PR-04 — Production › Overview without a screen (production plan §1 "Production › Overview: all brands on one page — waiting on
 * us, waiting on a brand, late, at risk, blocked, work in progress by stage, brand requests to answer. Every number opens the working
 * list", §5; 06-tree A.1; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we,
 * as the production unit, should be able to see it all. And manage it all as well."). The read is B-PR-33's GET /production/overview
 * (walled by customer in the API); this file reads the page's address, and turns each figure into a door: the Work orders list's
 * address with the same filter (B-PR-33 lists them: `?waitingOn=`, `?risk=`, `?blockedBy=`, `?gate=true`, `?mixed=true`,
 * `?customerUrgency=`, `?party=`, `?supervisor=me`, the state views), or Home › Approvals for the customer requests.
 *
 * The screen never adds customers up: every row and the Total are the API's (`overall`), so a person limited to some customers only
 * ever sees their sums (PW-01). Pure: no React, no API.
 */

/** The page's company-free address. */
export const OVERVIEW_PATH = '/production/overview'
/** Most urgent: rows on the page ("10 of N · Show all"). */
export const URGENT_LIMIT = 10
/** Open issues: rows read at first, then 50 more per "Show more", at most the API's 200. */
export const ISSUES_LIMIT = 10
export const ISSUES_STEP = 50
export const ISSUES_MAX = 200

interface Params {
  get(name: string): string | null
}

// ---- the address -----------------------------------------------------------------------------------------------------------

export interface OverviewTerms {
  /** The one customer (`?party=`, the Production pages' filter), or null for every customer the person may see. */
  readonly party: string | null
  /** "Only mine" (`?supervisor=me`): the orders I supervise, carried to every Work orders door. */
  readonly mine: boolean
}

export function overviewTermsOf(params: Params | null | undefined): OverviewTerms {
  return { party: partyOf(params), mine: params?.get('supervisor') === 'me' }
}

/** The page's address with these terms (the customer filter and Only mine kept in the address: a reload or a link keeps them). */
export function overviewAddress(path: string, terms: OverviewTerms): string {
  const query = new URLSearchParams()
  if (terms.party) query.set(PARTY_KEY, terms.party)
  if (terms.mine) query.set('supervisor', 'me')
  const text = query.toString()
  return `${path}${text ? `?${text}` : ''}`
}

/** The API read of these terms. */
export function overviewQueryOf(terms: OverviewTerms): { readonly partyId?: string; readonly supervisor?: 'me'; readonly limit: number } {
  return { ...(terms.party ? { partyId: terms.party } : {}), ...(terms.mine ? { supervisor: 'me' as const } : {}), limit: URGENT_LIMIT }
}

// ---- the doors ---------------------------------------------------------------------------------------------------------------

/** Whose figure a door opens: one customer, the mixed work orders made before the rule, the work of no customer, or the Total. */
export type RowScope = { readonly kind: 'CUSTOMER'; readonly partyId: string } | { readonly kind: 'MIXED' } | { readonly kind: 'NO_CUSTOMER' } | { readonly kind: 'ALL' }

export function scopeOf(row: Pick<OverviewRow, 'kind' | 'customer'>): RowScope {
  if (row.kind === 'CUSTOMER' && row.customer) return { kind: 'CUSTOMER', partyId: row.customer.id }
  if (row.kind === 'MIXED') return { kind: 'MIXED' }
  if (row.kind === 'NO_CUSTOMER') return { kind: 'NO_CUSTOMER' }
  return { kind: 'ALL' }
}

const BLANK: ListTerms = termsOf(null, ['table'])

/**
 * The Work orders list's address for one figure: the row's scope (its customer, `mixed`, `noCustomer`; the Total keeps the page's
 * customer filter), "Only mine" (`supervisor=me`) and the figure's own filter. The list's default sort (risk) is written, as the
 * list writes it itself.
 */
export function workOrdersDoor(prefix: string, scope: RowScope, filter: Partial<ListTerms>, terms: OverviewTerms): string {
  const party = scope.kind === 'CUSTOMER' ? scope.partyId : scope.kind === 'ALL' ? terms.party : null
  return listAddress(`${prefix}/production/work-orders`, {
    ...BLANK,
    party,
    mixed: scope.kind === 'MIXED',
    noCustomer: scope.kind === 'NO_CUSTOMER',
    supervisor: terms.mine ? 'me' : null,
    ...filter,
  })
}

/** Home › Approvals' customer requests (the one place they are answered): the Customer requests tile and the Requests column. */
export const approvalsDoor = (prefix: string): string => `${prefix}/home/approvals?kind=ORDER_CHANGE_REQUEST`

/** A figure and where it opens: a number above 0 is a door; 0 is said plainly (a door to an empty list is no help). */
export interface Door {
  readonly value: number
  readonly href: string | null
}

const door = (value: number, href: string): Door => ({ value, href: value > 0 ? href : null })

// ---- the tiles -----------------------------------------------------------------------------------------------------------------

export const TILE_IDS = ['waitingOnUs', 'waitingOnCustomer', 'late', 'atRisk', 'blocked', 'customerRequests'] as const
export type TileId = (typeof TILE_IDS)[number]

/** The filter each tile opens Work orders with (Customer requests opens Home › Approvals). */
export const TILE_FILTERS: Readonly<Record<Exclude<TileId, 'customerRequests'>, Partial<ListTerms>>> = {
  waitingOnUs: { waitingOn: 'US' },
  waitingOnCustomer: { waitingOn: 'BRAND' },
  late: { risk: 'LATE' },
  atRisk: { risk: 'AT_RISK' },
  blocked: { risk: 'BLOCKED' },
}

export interface OverviewTile {
  readonly id: TileId
  /** null: not read yet ("—", never 0). */
  readonly value: number | null
  /** Always a door (a tile is a link, even at 0: the list then says it is empty). */
  readonly href: string
}

/** The six tiles (06-tree A.1 O-OV-tiles): waiting on us, waiting on the customer, late, at risk, blocked, customer requests. */
export function tilesOf(answer: Overview | null, prefix: string, terms: OverviewTerms): OverviewTile[] {
  const all: RowScope = { kind: 'ALL' }
  return TILE_IDS.map((id): OverviewTile => {
    const value = answer ? answer.tiles[id] : null
    return { id, value, href: id === 'customerRequests' ? approvalsDoor(prefix) : workOrdersDoor(prefix, all, TILE_FILTERS[id], terms) }
  })
}

// ---- exceptions by customer ----------------------------------------------------------------------------------------------------

/** The columns of Exceptions by customer, in order (the API's figures; each opens Work orders with its filter). */
export const EXCEPTION_COLUMNS = ['inProduction', 'late', 'atRisk', 'blocked', 'onUs', 'onCustomer', 'onSupplier', 'onWorkshop', 'onHold', 'gate', 'split', 'urgent', 'requests'] as const
export type ExceptionColumn = (typeof EXCEPTION_COLUMNS)[number]

/** Each column's figure of a row and the Work orders filter it opens with (Requests: Home › Approvals). */
const COLUMN_RULES: Readonly<Record<Exclude<ExceptionColumn, 'requests'>, { readonly value: (row: OverviewRow) => number; readonly filter: Partial<ListTerms> }>> = {
  inProduction: { value: (row) => row.inProduction.workOrders, filter: {} },
  late: { value: (row) => row.late, filter: { risk: 'LATE' } },
  atRisk: { value: (row) => row.atRisk, filter: { risk: 'AT_RISK' } },
  blocked: { value: (row) => row.blocked, filter: { risk: 'BLOCKED' } },
  onUs: { value: (row) => row.waitingOn.US, filter: { waitingOn: 'US' } },
  onCustomer: { value: (row) => row.waitingOn.BRAND, filter: { waitingOn: 'BRAND' } },
  onSupplier: { value: (row) => row.waitingOn.SUPPLIER, filter: { waitingOn: 'SUPPLIER' } },
  onWorkshop: { value: (row) => row.waitingOn.WORKSHOP, filter: { waitingOn: 'WORKSHOP' } },
  onHold: { value: (row) => row.blockedBy.HOLD, filter: { blockedBy: 'HOLD' } },
  gate: { value: (row) => row.blockedBy.GATE, filter: { gate: true } },
  split: { value: (row) => row.blockedBy.NEEDS_SPLIT, filter: { mixed: true } },
  urgent: { value: (row) => row.customerUrgent, filter: { customerUrgency: 'URGENT' } },
}

/** A row's name: the customer (its name with parties.view, else its code), or the mixed / no-customer / Total words. */
export type RowLabel = { readonly kind: 'customer'; readonly text: string; readonly partyId: string } | { readonly kind: 'mixed' } | { readonly kind: 'none' } | { readonly kind: 'total' }

export function labelOf(row: Pick<OverviewRow, 'kind' | 'customer'>, names: boolean): RowLabel {
  if (row.kind === 'CUSTOMER' && row.customer) return { kind: 'customer', text: names ? row.customer.name : row.customer.code, partyId: row.customer.id }
  if (row.kind === 'MIXED') return { kind: 'mixed' }
  if (row.kind === 'NO_CUSTOMER') return { kind: 'none' }
  return { kind: 'total' }
}

export interface ExceptionRow {
  readonly id: string
  readonly label: RowLabel
  readonly total: boolean
  readonly pieces: number
  readonly cells: Readonly<Record<ExceptionColumn, Door>>
  /** Requests: every one that waits (OPEN or COUNTERED), beside the ones this reader answers (the cell's figure). */
  readonly requestsWaiting: number
}

/** The rows the API gave, in its order: each customer, the mixed ones, the work of no customer — then its Total (`overall`). */
export function rowsOf(answer: Overview): readonly OverviewRow[] {
  return [...answer.customers, ...(answer.mixed ? [answer.mixed] : []), ...(answer.noCustomer ? [answer.noCustomer] : []), answer.overall]
}

const rowId = (row: OverviewRow): string => (row.kind === 'CUSTOMER' && row.customer ? row.customer.id : row.kind)

/**
 * Exceptions by customer (06-tree A.1 O-OV-brands): one row per customer the API gave, the mixed work orders made before the rule,
 * the work of no customer, then the Total — every figure as the API sent it (the Total is `overall`, never a sum made here).
 */
export function exceptionRows(answer: Overview, prefix: string, terms: OverviewTerms, names: boolean): ExceptionRow[] {
  return rowsOf(answer).map((row) => {
    const scope = scopeOf(row)
    const cells = Object.fromEntries(
      EXCEPTION_COLUMNS.map((column): [ExceptionColumn, Door] => {
        if (column === 'requests') return [column, door(row.requests.toAnswer, approvalsDoor(prefix))]
        const rule = COLUMN_RULES[column]
        return [column, door(rule.value(row), workOrdersDoor(prefix, scope, rule.filter, terms))]
      }),
    ) as Record<ExceptionColumn, Door>
    return { id: rowId(row), label: labelOf(row, names), total: row.kind === 'ALL', pieces: row.inProduction.pieces, cells, requestsWaiting: row.requests.waiting }
  })
}

/** Nothing in production and nothing waiting for this reader (the empty state). */
export const nothingOpen = (answer: Overview): boolean => answer.customers.length === 0 && !answer.mixed && !answer.noCustomer && answer.overall.inProduction.workOrders === 0

// ---- WIP by stage × customer ---------------------------------------------------------------------------------------------------

/** The state view of Work orders a stage's cell opens: drafts, released, held; the started stages are the work in progress. */
export const STAGE_VIEW: Readonly<Record<WipStage, ListTerms['view']>> = {
  NOT_RELEASED: 'DRAFT',
  RELEASED: 'RELEASED',
  CUTTING: 'IN_PROGRESS',
  SEWING: 'IN_PROGRESS',
  AT_WORKSHOP: 'IN_PROGRESS',
  QUALITY: 'IN_PROGRESS',
  FINISHED: 'IN_PROGRESS',
  ON_HOLD: 'ON_HOLD',
}

/** A stage's pieces: a door; null = the floor does not count that stage there ("—", never a made-up 0). */
export type StageCell = { readonly counted: false } | ({ readonly counted: true } & Door)

export interface WipRow {
  readonly id: string
  readonly label: RowLabel
  readonly total: boolean
  /** The pieces of its open work orders (the row's whole), a door to them. */
  readonly pieces: Door
  readonly stages: Readonly<Record<WipStage, StageCell>>
  /** Started work orders whose sewing the floor does not count. */
  readonly sewingNotCounted: number
}

/** WIP by stage × customer (06-tree A.1 O-OV-wip): pieces per row and stage, held work in its own On hold column, then the Total. */
export function wipRows(answer: Overview, prefix: string, terms: OverviewTerms, names: boolean): WipRow[] {
  return rowsOf(answer).map((row) => {
    const scope = scopeOf(row)
    const stages = Object.fromEntries(
      WIP_STAGES.map((stage): [WipStage, StageCell] => {
        const value = row.wip.stages[stage]
        return [stage, value === null ? { counted: false } : { counted: true, ...door(value, workOrdersDoor(prefix, scope, { view: STAGE_VIEW[stage] }, terms)) }]
      }),
    ) as Record<WipStage, StageCell>
    return {
      id: rowId(row),
      label: labelOf(row, names),
      total: row.kind === 'ALL',
      pieces: door(row.inProduction.pieces, workOrdersDoor(prefix, scope, {}, terms)),
      stages,
      sewingNotCounted: row.wip.sewingNotCounted,
    }
  })
}

// ---- Most urgent ---------------------------------------------------------------------------------------------------------------

export interface UrgentLine {
  readonly id: string
  readonly number: string
  readonly href: string
  readonly customer: RowLabel
  readonly style: string
  readonly dueDate: string | null
  readonly daysLate: number | null
  readonly health: HealthCell
  /** Who it waits on, for the shared chip (the Work orders list's own rule). */
  readonly waiting: ReturnType<typeof waitingInputOf>
  /** The Blocked by words key (`blocked.<code>`), or null. */
  readonly blockedKey: string | null
  /** The supervisor for the reader (`mark.<ME|SOMEONE_ELSE|NOT_SET>` of production-supervisor), or null: no customer. */
  readonly supervisorKey: string | null
}

/** One Most urgent row, said as the Work orders list says its cells (the same helpers). */
export function urgentLineOf(row: UrgentRow, prefix: string, names: boolean): UrgentLine {
  const customer: RowLabel = row.customer ? { kind: 'customer', text: names ? row.customer.name : row.customer.code, partyId: row.customer.id } : row.mixedCustomers ? { kind: 'mixed' } : { kind: 'none' }
  const waiting = waitingInputOf({ waitingOn: row.waitingOn, risk: row.risk, status: row.status })
  return {
    id: row.id,
    number: row.number,
    href: `${prefix}/production/work-orders/${encodeURIComponent(row.id)}`,
    customer,
    style: `${row.style.code} · ${row.style.name}`,
    dueDate: row.dueDate,
    daysLate: row.daysLate,
    health: healthCellOf({ risk: row.risk, dueDate: row.dueDate, status: row.status }),
    waiting,
    blockedKey: blockedKeyOf({ risk: row.risk }),
    supervisorKey: markKeyOf(row.supervisor),
  }
}

/** Most urgent's footer: "10 of 37 · Show all" (no silent cap), Show all = Work orders by risk with the page's filters. */
export function urgentFooter(answer: Overview, prefix: string, terms: OverviewTerms): { readonly shown: number; readonly count: number; readonly href: string } {
  return { shown: answer.mostUrgent.items.length, count: answer.mostUrgent.count, href: workOrdersDoor(prefix, { kind: 'ALL' }, {}, terms) }
}

// ---- open issues (B-PR-45) -----------------------------------------------------------------------------------------------------

export interface IssueLine {
  readonly id: string
  readonly record: { readonly label: string; readonly href: string }
  /** The customer's name with parties.view; else its code when the page knows it, else "—" (the issues read sends the name only). */
  readonly customer: string | null
  readonly source: IssueRow['source']
  readonly raisedAt: string
  readonly dueOn: string
  /** Past its due day (`today` is the overview's business day). */
  readonly overdue: boolean
  /** What the office reads beside it: no reply sent yet, escalated (to the backup, or to Owner and Admin), or waiting on us. */
  readonly state: Phrase
  readonly stateTone: Tone
  readonly taskKey: string | null
}

const recordHref = (prefix: string, record: IssueRow['record']): string =>
  record.type === 'WorkOrder' ? `${prefix}/production/work-orders/${encodeURIComponent(record.id)}` : `${prefix}/sales/orders/${encodeURIComponent(record.id)}`

/** The customer codes the page knows (the overview's rows), for a reader without parties.view. */
export function customerCodesOf(answer: Overview | null): ReadonlyMap<string, string> {
  return new Map((answer?.customers ?? []).flatMap((row) => (row.customer ? [[row.customer.id, row.customer.code] as const] : [])))
}

export function issueLineOf(issue: IssueRow, prefix: string, names: boolean, codes: ReadonlyMap<string, string>, today: string | null): IssueLine {
  const state: Phrase = issue.note === 'NO_REPLY_YET' ? { key: 'ovw.issues.state.noReply' } : issue.escalation ? { key: issue.escalation.step >= 2 ? 'ovw.issues.state.escalatedOwner' : 'ovw.issues.state.escalatedBackup' } : { key: 'ovw.issues.state.waiting' }
  return {
    id: issue.id,
    record: { label: issue.record.label, href: recordHref(prefix, issue.record) },
    customer: names ? issue.customer.name : (codes.get(issue.customer.id) ?? null),
    source: issue.source,
    raisedAt: issue.raisedAt,
    dueOn: issue.dueOn,
    overdue: today !== null && issue.dueOn < today,
    state,
    stateTone: issue.note === 'NO_REPLY_YET' || issue.escalation ? 'warning' : 'neutral',
    taskKey: issue.task ? markKeyOf(issue.task.assignee) : null,
  }
}

/** The issues section's figures and its "10 of 23" (the mine list counts the reader's own). */
export function issuesSummary(issues: Issues, mine: boolean): { readonly shown: number; readonly count: number; readonly more: boolean } {
  return { shown: issues.issues.length, count: mine ? issues.counts.mine : issues.counts.open, more: issues.more }
}

/** The next read's size after "Show more" (50 more, at most the API's 200). */
export const nextIssuesLimit = (limit: number): number => Math.min(ISSUES_MAX, limit + ISSUES_STEP)

// ---- live ---------------------------------------------------------------------------------------------------------------------

/** Whether a live change can move a figure here: the events the overview names, work orders and production, issues. */
export function overviewTouches(change: { readonly type: string }, events: readonly string[]): boolean {
  return events.includes(change.type) || change.type.startsWith('workorder.') || change.type.startsWith('production.') || change.type.startsWith('production_issue.')
}
