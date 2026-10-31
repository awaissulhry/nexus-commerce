import { OUTCOMES_BY_DISPOSITION, STOCK_OUTCOMES, followUpOf } from '@nexus/factory-domain/sales/returns/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { problemKey } from '../../quality/_shared/model'
import type {
  ChecklistBody,
  DdtBody,
  DdtFreight,
  DdtTransportBy,
  DecisionLine,
  GoodsOutcome,
  HandMove,
  Issue,
  NewRepairBody,
  NewReturnBody,
  ParcelCondition,
  Person,
  PointResult,
  ReceiptBody,
  Repair,
  RepairAction,
  RepairKind,
  RepairListView,
  RepairRow,
  RepairStage,
  ReturnAction,
  ReturnableLine,
  ReturnDisposition,
  ReturnLine,
  ReturnListView,
  ReturnRow,
  ReturnStatus,
  Rma,
  SafetyState,
} from './api'

/**
 * The rules of Sales › Returns & repairs without a screen (SCR-111, SCR-112): what a person may do, the list's address
 * (one filter model: the tiles and Rows ▾ name the same views), the ONE grid over two sources (the RMAs of B-W2a-43 and
 * the repairs of B-W2a-57), each step held with its reason in OUR words (the API's held sentences are English: the
 * reason is read from the record's own facts), the API's refusals by place, the drafts of every dialog and what they
 * send. Pure: no React, no API client. Words are message keys of `sales-returns` (`quality:` for the shared ones).
 */

// ---- what a person may do ------------------------------------------------------------------------------------------------

export const RETURNS_PERMISSIONS = {
  view: 'sales.returns.view',
  manage: 'sales.returns.manage',
  receive: 'sales.returns.receive',
  inspect: 'sales.returns.inspect',
  decide: 'sales.returns.decide',
  repairsView: 'sales.repairs.view',
  repairsManage: 'sales.repairs.manage',
  repairsReceive: 'sales.repairs.receive',
  repairsCheck: 'sales.repairs.check',
  repairsShip: 'sales.repairs.ship',
  ddtIssue: 'shipping.ddt.issue',
  ordersManage: 'orders.manage',
  invoicesView: 'invoices.view',
  invoicesManage: 'invoices.manage',
  workOrdersView: 'workorders.view',
  workOrdersManage: 'workorders.manage',
  partiesView: 'parties.view',
  filesRead: 'files.read',
  filesUpload: 'files.upload',
  threadsRead: 'threads.read',
  people: 'tasks.manage',
  settingsView: 'quotes.view',
  price: 'money.price',
} as const

export type ReturnsAbility = keyof typeof RETURNS_PERMISSIONS
export type ReturnsCan = Readonly<Record<ReturnsAbility, boolean>>

export function returnsCan(permissions: readonly string[]): ReturnsCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(RETURNS_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as ReturnsCan
}

// ---- the list's address: one filter model -------------------------------------------------------------------------------

/** Rows ▾ (design returns.grid savedRows) and the tiles (returns.tiles): one set of named filters in `?view=`. */
export const AFTER_SALES_VIEWS = ['open', 'openReturns', 'openRepairs', 'toInspect', 'closed', 'all', 'waiting', 'inRepair', 'replacement', 'late'] as const
export type AfterSalesView = (typeof AFTER_SALES_VIEWS)[number]
export const ROW_VIEWS: readonly AfterSalesView[] = ['open', 'openReturns', 'openRepairs', 'toInspect', 'closed', 'all']
export const TILES = ['waiting', 'toInspect', 'inRepair', 'replacement'] as const
export type AfterSalesTile = (typeof TILES)[number]

export interface ListAddress {
  readonly view: AfterSalesView
  readonly q: string
}

export const DEFAULT_VIEW: AfterSalesView = 'open'

export function addressOf(params: { get(name: string): string | null } | null): ListAddress {
  const view = params?.get('view') ?? ''
  return { view: (AFTER_SALES_VIEWS as readonly string[]).includes(view) ? (view as AfterSalesView) : DEFAULT_VIEW, q: params?.get('q') ?? '' }
}

/** The address's query (the default view and an empty search are left out). */
export function queryOf(address: ListAddress, extra: Readonly<Record<string, string | null | undefined>> = {}): string {
  const search = new URLSearchParams()
  if (address.view !== DEFAULT_VIEW) search.set('view', address.view)
  if (address.q.trim()) search.set('q', address.q.trim())
  for (const [name, value] of Object.entries(extra)) if (value) search.set(name, value)
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const isFiltered = (address: ListAddress): boolean => address.view !== DEFAULT_VIEW || address.q.trim() !== ''

/** Which API list each view reads (null: that source has no rows in the view). */
export function sourcesOf(view: AfterSalesView): { returns: ReturnListView | null; repairs: RepairListView | null } {
  switch (view) {
    case 'open':
      return { returns: 'open', repairs: 'open' }
    case 'openReturns':
      return { returns: 'open', repairs: null }
    case 'openRepairs':
      return { returns: null, repairs: 'open' }
    case 'toInspect':
      return { returns: 'toInspect', repairs: null }
    case 'closed':
      return { returns: 'closed', repairs: 'closed' }
    case 'all':
      return { returns: 'all', repairs: 'all' }
    case 'waiting':
      return { returns: 'waiting', repairs: 'awaiting' }
    case 'inRepair':
      return { returns: null, repairs: 'inRepair' }
    case 'replacement':
      return { returns: 'replacement', repairs: null }
    case 'late':
      return { returns: 'late', repairs: null }
  }
}

// ---- one grid, two sources ----------------------------------------------------------------------------------------------

export type RowKind = 'RETURN' | RepairKind

/** One row of the grid: an RMA or a repair (design returns.grid columns). */
export interface AfterSalesRow {
  /** Unique across both sources: `rma:<id>` / `rep:<id>`. */
  readonly key: string
  readonly id: string
  readonly kind: RowKind
  readonly number: string
  readonly companyId: string
  readonly party: { readonly code: string; readonly legalName: string } | null
  readonly customerRef: string | null
  /** Order and invoice numbers (an RMA), or where a repair came from (an RMA, a complaint). */
  readonly order: string | null
  readonly invoices: readonly string[]
  readonly source: { readonly kind: 'RETURN' | 'COMPLAINT' | 'HAND'; readonly number: string | null } | null
  readonly units: number
  readonly receivedUnits: number
  /** An RMA's first reason; a repair's problem in the customer's words. */
  readonly reason: { readonly labelIt: string; readonly labelEn: string; readonly more: number } | null
  readonly problem: string | null
  readonly status: { readonly kind: 'RETURN'; readonly status: ReturnStatus } | { readonly kind: 'REPAIR'; readonly stage: RepairStage; readonly safety: SafetyState }
  readonly dispositions: readonly ReturnDisposition[]
  readonly receivedAt: string | null
  readonly deadline: string | null
  readonly late: boolean
  readonly currency: string | null
  /** Price grain; undefined without it, null for a repair (no money in W2a). */
  readonly credit: number | null | undefined
  readonly ownerId: string | null
  /** The newest first: an RMA's request, a repair's creation. */
  readonly at: string
}

export function returnRowOf(row: ReturnRow): AfterSalesRow {
  return {
    key: `rma:${row.id}`,
    id: row.id,
    kind: 'RETURN',
    number: row.number,
    companyId: row.companyId,
    party: row.party,
    customerRef: row.customerRef,
    order: row.salesOrder?.number ?? null,
    invoices: row.invoiceNumbers,
    source: null,
    units: row.units,
    receivedUnits: row.receivedUnits,
    reason: row.reason ? { labelIt: row.reason.labelIt, labelEn: row.reason.labelEn, more: Math.max(0, new Set(row.reasonCodes).size - 1) } : null,
    problem: null,
    status: { kind: 'RETURN', status: row.status },
    dispositions: [...new Set(row.dispositions)],
    receivedAt: row.receivedAt,
    deadline: row.goodsDueBy,
    late: row.late,
    currency: row.currency,
    credit: row.creditTotal,
    ownerId: row.ownerId,
    at: row.requestedAt,
  }
}

export function repairRowOf(row: RepairRow): AfterSalesRow {
  return {
    key: `rep:${row.id}`,
    id: row.id,
    kind: row.kind,
    number: row.number,
    companyId: row.companyId,
    party: row.party,
    customerRef: null,
    order: null,
    invoices: [],
    source: { kind: row.source, number: row.source === 'RETURN' ? row.returnNumber : row.source === 'COMPLAINT' ? row.complaintNumber : null },
    units: 1,
    receivedUnits: row.receivedAt ? 1 : 0,
    reason: null,
    problem: row.problem,
    status: { kind: 'REPAIR', stage: row.stage, safety: row.safety },
    dispositions: [],
    receivedAt: row.receivedAt,
    deadline: null,
    late: false,
    currency: null,
    credit: null,
    ownerId: row.ownerId,
    at: row.createdAt,
  }
}

/** Both sources in one list, newest first. */
export function mergedRows(returns: readonly ReturnRow[], repairs: readonly RepairRow[]): AfterSalesRow[] {
  return [...returns.map(returnRowOf), ...repairs.map(repairRowOf)].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.number.localeCompare(b.number)))
}

/** Where a row opens. */
export const rowHref = (prefix: string, row: Pick<AfterSalesRow, 'kind' | 'id'>): string =>
  row.kind === 'RETURN' ? `${prefix}/sales/returns/${encodeURIComponent(row.id)}` : `${prefix}/sales/returns/repairs/${encodeURIComponent(row.id)}`
export const returnHref = (prefix: string, id: string, query = ''): string => `${prefix}/sales/returns/${encodeURIComponent(id)}${query}`
export const repairHref = (prefix: string, id: string, query = ''): string => `${prefix}/sales/returns/repairs/${encodeURIComponent(id)}${query}`

/** A person's name, "you" for the reader, else null (the list never guesses). */
export function ownerName(people: readonly Person[], id: string | null, me: string): { key: string } | { name: string } | null {
  if (!id) return null
  if (id === me) return { key: 'row.you' }
  const found = people.find((person) => person.id === id)
  return found ? { name: found.name } : null
}

/** The status in words: a message key with its params. */
export function rowStatusWords(row: AfterSalesRow, today: string): { key: string; params?: Record<string, string | number> } {
  if (row.status.kind === 'RETURN') {
    const status = row.status.status
    if (status === 'AUTHORISED') return row.deadline ? (row.late ? { key: 'sub.late', params: { date: row.deadline } } : { key: 'sub.waitingBy', params: { date: row.deadline } }) : { key: 'sub.waiting' }
    if (status === 'RECEIVED') return { key: 'sub.received', params: { received: row.receivedUnits, count: row.units } }
    void today
    return { key: `sub.${status}` }
  }
  if (row.status.stage === 'REPAIRED') return { key: row.status.safety === 'FAILED' ? 'sub.repairedFailed' : row.status.safety === 'NOT_CHECKED' || row.status.safety === 'OUTDATED' ? 'sub.repairedToCheck' : 'sub.repairedReady' }
  return { key: `stage.${row.status.stage}` }
}

export const isOpenRow = (row: AfterSalesRow): boolean =>
  row.status.kind === 'RETURN' ? ['REQUESTED', 'AUTHORISED', 'RECEIVED', 'INSPECTED'].includes(row.status.status) : !['SHIPPED', 'CANCELLED'].includes(row.status.stage)

// ---- money (price grain) ------------------------------------------------------------------------------------------------

/** Minor units as a number of the currency (two decimals: the factory sells in euro). */
export const fromMinor = (minor: number): number => minor / 100

/** A typed amount ("12,50" or "12.50") as minor units, or null when it is not an amount. */
export function minorOf(text: string): number | null {
  const clean = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null
  return Math.round(Number(clean) * 100)
}

/** Minor units as typed text ("12.50"). */
export const minorText = (minor: number | null | undefined): string => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2))

// ---- CSV of a view (no price without the grain) ---------------------------------------------------------------------------

const csvCell = (value: string | number | null | undefined): string => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function rowsCsv(rows: readonly AfterSalesRow[], headers: readonly string[], kindWord: (row: AfterSalesRow) => string, statusWord: (row: AfterSalesRow) => string, price: boolean): string {
  const lines = [headers.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.number,
        kindWord(row),
        row.party?.legalName ?? '',
        [row.order, ...row.invoices].filter(Boolean).join(' '),
        row.units,
        statusWord(row),
        row.receivedAt?.slice(0, 10) ?? '',
        row.deadline ?? '',
        price && typeof row.credit === 'number' ? (row.credit / 100).toFixed(2) : '',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

// ---- the API's refusals in our words --------------------------------------------------------------------------------------

export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

const ABOVE_SOLD = /at most (\d+)/i
const SOLD = /(\d+) sold/i

/**
 * A refused write in words: a quantity above what was sold (the cell's refusal, with the numbers the API's sentence
 * carries), a stale version, a state that takes no such change, else the kind's words (`quality:problem.*`).
 */
export function refusalOf(error: unknown): Words {
  if (!isApiError(error)) return { key: `quality:${problemKey(error)}` }
  const quantity = error.issues.find((entry) => /^(body[./])?(lines[./]\d+[./])?quantity$/.test(issuePath(entry)))
  if (quantity) {
    return refusalOfMessage(quantity.message ?? '')
  }
  if (error.kind === 'conflict') return error.code === 'invalid_state' ? { key: 'refusal.state' } : { key: 'refusal.stale' }
  if (error.kind === 'invalid') {
    const paths = error.issues.map((entry) => issuePath(entry).replace(/\./g, '/'))
    if (paths.some((path) => path.startsWith('body/note'))) return { key: 'refusal.noteNeeded' }
    if (paths.some((path) => path.startsWith('body/ddt'))) return { key: 'refusal.ddtNeeded' }
    if (paths.some((path) => path.startsWith('body/companyId'))) return { key: 'refusal.followsGroup' }
    return { key: 'refusal.invalid' }
  }
  return { key: `quality:${problemKey(error)}` }
}

/** A preview's problems by place, in our words (the API's sentences are English; the place says what is missing). */
export function previewProblemWords(problems: readonly Issue[], kind: 'return' | 'repair'): Words[] {
  const seen = new Set<string>()
  const out: Words[] = []
  for (const entry of problems) {
    const path = entry.path
    let words: Words
    if (/quantity$/.test(path)) words = refusalOfMessage(entry.message)
    else if (/reasonCode$/.test(path)) words = { key: 'problem.reason' }
    else if (path === 'conflict' || path.endsWith('/serial')) words = { key: kind === 'repair' ? 'problem.repairExists' : 'problem.other' }
    else if (path.endsWith('returnLineId')) words = { key: 'problem.returnLine' }
    else if (path.endsWith('partyId')) words = { key: 'problem.customer' }
    else if (path.endsWith('siteId')) words = { key: 'problem.site' }
    else if (path.endsWith('problem')) words = { key: 'problem.problemWords' }
    else if (path.startsWith('company/numbering')) words = { key: kind === 'repair' ? 'problem.numberingRepair' : 'problem.numberingReturn' }
    else if (path === 'body/lines') words = { key: 'problem.noLines' }
    else words = { key: 'problem.other' }
    const id = `${words.key}|${JSON.stringify(words.params ?? {})}`
    if (!seen.has(id)) {
      seen.add(id)
      out.push(words)
    }
  }
  return out
}

function refusalOfMessage(message: string): Words {
  const max = ABOVE_SOLD.exec(message)?.[1]
  const sold = SOLD.exec(message)?.[1]
  return max !== undefined ? { key: 'refusal.aboveSoldMax', params: { max: Number(max), sold: sold !== undefined ? Number(sold) : '—' } } : { key: 'refusal.aboveSold' }
}

// ---- an RMA's steps, held with their reason (our words, from the record's facts) ------------------------------------------

const FINAL_RETURN: readonly ReturnStatus[] = ['CLOSED', 'REJECTED', 'CANCELLED']
const BEFORE_GOODS: readonly ReturnStatus[] = ['REQUESTED', 'AUTHORISED']

export function returnHeld(action: ReturnAction, rma: Pick<Rma, 'status' | 'lines' | 'replacementOrder' | 'actions'>): Words | null {
  const allowed = rma.actions.find((entry) => entry.action === action)?.allowed
  if (allowed) return null
  const final = FINAL_RETURN.includes(rma.status)
  const state = { key: `held.final.${rma.status}` }
  const received = rma.lines.filter((line) => line.receivedQuantity > 0)
  switch (action) {
    case 'editLines':
      return final ? state : BEFORE_GOODS.includes(rma.status) ? { key: 'held.notNow' } : { key: 'held.goodsArrived' }
    case 'receive':
      return final ? state : rma.status === 'REQUESTED' ? { key: 'held.authoriseFirst' } : rma.lines.every((line) => line.receivedQuantity >= line.quantity) ? { key: 'held.everyPiece' } : { key: 'held.notNow' }
    case 'inspect':
    case 'decide':
      if (final) return state
      if (received.length === 0) return { key: 'held.nothingArrived' }
      return action === 'decide' && received.every((line) => line.grade === null) ? { key: 'held.gradeFirst' } : { key: 'held.notNow' }
    case 'makeReplacement':
      if (rma.replacementOrder) return { key: 'held.replacementMade' }
      if (final && rma.status !== 'CLOSED') return state
      return received.some((line) => line.disposition === 'REPLACE') ? { key: 'held.notNow' } : { key: 'held.noReplace' }
    case 'issueReturnDdt':
      return received.length === 0 ? { key: 'held.nothingArrived' } : received.some((line) => line.disposition === 'RETURN_UNCHANGED' || line.goodsOutcome === 'BACK_TO_CUSTOMER') ? { key: 'held.notNow' } : { key: 'held.noBack' }
    case 'cancel':
      return final ? state : { key: 'held.closeInstead' }
    case 'close': {
      if (final) return state
      if (rma.status === 'REQUESTED') return { key: 'held.authoriseFirst' }
      const undecided = received.filter((line) => line.disposition === null).length
      return undecided > 0 ? { key: 'held.decideFirst', params: { count: undecided } } : { key: 'held.notNow' }
    }
  }
}

/** The record's step, held by the person's role first (which permission is missing), else by the record. */
export function returnStep(action: ReturnAction, rma: Rma, can: ReturnsCan, offline: boolean): Words | null {
  const right: Partial<Record<ReturnAction, ReturnsAbility[]>> = {
    editLines: ['manage'],
    receive: ['receive'],
    inspect: ['inspect'],
    decide: ['decide'],
    makeReplacement: ['decide', 'ordersManage'],
    issueReturnDdt: ['ddtIssue'],
    cancel: ['manage'],
    close: ['manage'],
  }
  const missing = (right[action] ?? []).find((ability) => !can[ability])
  if (missing) return { key: `held.right.${missing}` }
  if (offline) return { key: 'held.offline' }
  return returnHeld(action, rma)
}

// ---- a repair's steps, held with their reason ---------------------------------------------------------------------------

const RELEASED_WO = ['RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED']
const DONE_WO = ['COMPLETED', 'CLOSED']
const WORK_ORDER_STAGES: readonly RepairStage[] = ['AWAITING_GOODS', 'RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR']

export function repairHeld(action: RepairAction, repair: Pick<Repair, 'stage' | 'workOrder' | 'safety' | 'ddts' | 'actions'>): Words | null {
  const allowed = repair.actions.find((entry) => entry.action === action)?.allowed
  if (allowed) return null
  const stage = repair.stage
  const final = stage === 'SHIPPED' || stage === 'CANCELLED'
  const wo = repair.workOrder && repair.workOrder.status !== 'CANCELLED' ? repair.workOrder : null
  const stageWords = { key: 'held.repairStage', params: { stage: `stage.${stage}` } }
  if (final && action !== 'receive') return { key: `held.repairFinal.${stage}` }
  switch (action) {
    case 'edit':
      return { key: 'held.notNow' }
    case 'receive':
      return stage === 'CANCELLED' ? { key: 'held.repairFinal.CANCELLED' } : { key: 'held.garmentHere' }
    case 'estimate':
    case 'approve':
      return stageWords
    case 'makeWorkOrder':
      if (wo) return { key: 'held.oneWorkOrder', params: { number: wo.number } }
      return WORK_ORDER_STAGES.includes(stage) ? { key: 'held.notNow' } : stage === 'REPAIRED' ? { key: 'held.reopenFirst' } : stageWords
    case 'startRepair':
      if (stage === 'REPAIRED') return { key: 'held.reopenInstead' }
      if (!wo) return { key: 'held.makeWorkOrderFirst' }
      if (wo.status === 'DRAFT') return { key: 'held.releaseWorkOrder', params: { number: wo.number } }
      if (wo.status === 'ON_HOLD') return { key: 'held.workOrderOnHold', params: { number: wo.number } }
      return RELEASED_WO.includes(wo.status) ? stageWords : { key: 'held.notNow' }
    case 'finishRepair':
      if (stage !== 'IN_REPAIR') return stageWords
      if (!wo) return { key: 'held.makeWorkOrderFirst' }
      return DONE_WO.includes(wo.status) ? { key: 'held.notNow' } : { key: 'held.completeWorkOrder', params: { number: wo.number } }
    case 'reopenRepair':
      return { key: 'held.onlyRepaired' }
    case 'safetyCheck':
      return !repair.safety.required ? { key: 'held.noCheckNeeded' } : { key: 'held.checkAfterRepair' }
    case 'ship':
      if (stage === 'AWAITING_GOODS') return { key: 'held.shipNotArrived' }
      if (stage === 'APPROVED' || stage === 'IN_REPAIR') return { key: 'held.shipFinishFirst' }
      if (stage === 'REPAIRED') return { key: repair.safety.state === 'FAILED' ? 'held.shipFailed' : 'held.shipNotChecked' }
      if (wo && !DONE_WO.includes(wo.status)) return { key: 'held.cancelWorkOrderFirst', params: { number: wo.number } }
      return { key: 'held.notNow' }
    case 'cancel':
      if (stage === 'REPAIRED') return { key: 'held.cancelRepaired' }
      if (stage === 'RECEIVED' || stage === 'ESTIMATED') return { key: 'held.sendBackInstead' }
      if (wo) return DONE_WO.includes(wo.status) ? { key: 'held.workOrderDone', params: { number: wo.number } } : { key: 'held.cancelWorkOrderFirst', params: { number: wo.number } }
      if (repair.ddts.some((ddt) => ddt.live)) return { key: 'held.liveDdt' }
      return { key: 'held.notNow' }
  }
}

export function repairStep(action: RepairAction, repair: Repair, can: ReturnsCan, offline: boolean): Words | null {
  const right: Partial<Record<RepairAction, ReturnsAbility[]>> = {
    edit: ['repairsManage'],
    receive: ['repairsReceive'],
    estimate: ['repairsManage'],
    approve: ['repairsManage'],
    makeWorkOrder: ['workOrdersManage'],
    startRepair: ['repairsManage'],
    finishRepair: ['repairsManage'],
    reopenRepair: ['repairsManage'],
    safetyCheck: ['repairsCheck'],
    ship: ['repairsShip'],
    cancel: ['repairsManage'],
  }
  const missing = (right[action] ?? []).find((ability) => !can[ability])
  if (missing) return { key: `held.right.${missing}` }
  if (offline) return { key: 'held.offline' }
  return repairHeld(action, repair)
}

/** The hand move each work action makes, and the note it needs (a key) or null. */
export const MOVE_OF: Readonly<Record<'estimate' | 'approve' | 'startRepair' | 'finishRepair' | 'reopenRepair', HandMove>> = {
  estimate: 'ESTIMATED',
  approve: 'APPROVED',
  startRepair: 'IN_REPAIR',
  finishRepair: 'REPAIRED',
  reopenRepair: 'IN_REPAIR',
}

export function noteKeyOf(from: RepairStage, to: HandMove | 'SHIPPED'): string | null {
  if (to === 'ESTIMATED') return 'move.note.ESTIMATED'
  if (to === 'APPROVED') return 'move.note.APPROVED'
  if (from === 'REPAIRED' && to === 'IN_REPAIR') return 'move.note.REOPEN'
  if (to === 'SHIPPED' && (from === 'RECEIVED' || from === 'ESTIMATED')) return 'move.note.UNREPAIRED'
  return null
}

// ---- deciding (Inspection & decision) --------------------------------------------------------------------------------------

export interface DecisionDraft {
  readonly disposition: ReturnDisposition | ''
  readonly outcome: GoodsOutcome | ''
  /** Typed credit (price grain), empty = the default for the disposition. */
  readonly credit: string
}

export const EMPTY_DECISION: DecisionDraft = Object.freeze({ disposition: '', outcome: '', credit: '' })

/** The dispositions an office person picks from (REMAKE is refused in W2a: made to measure is deferred). */
export const PICKABLE_DISPOSITIONS: readonly ReturnDisposition[] = ['REPAIR', 'REPLACE', 'CREDIT_ONLY', 'RETURN_UNCHANGED', 'SCRAP']

/** Where the goods may go for a disposition, the usual one first. */
export const outcomesFor = (disposition: ReturnDisposition | ''): readonly GoodsOutcome[] => (disposition ? OUTCOMES_BY_DISPOSITION[disposition] : [])

/** The outcome a draft sends: the typed one when it fits, else the line's suggested one when it fits, else the first. */
export function outcomeOf(draft: DecisionDraft, line: Pick<ReturnLine, 'suggestedOutcome'>): GoodsOutcome | null {
  const options = outcomesFor(draft.disposition)
  if (options.length === 0) return null
  if (draft.outcome && options.includes(draft.outcome)) return draft.outcome
  if (line.suggestedOutcome && options.includes(line.suggestedOutcome)) return line.suggestedOutcome
  return options[0]!
}

/** The lines a decision sends (the drafts that name a disposition); a credit only with the price grain. */
export function decisionLinesOf(drafts: Readonly<Record<string, DecisionDraft>>, lines: readonly ReturnLine[], price: boolean): DecisionLine[] {
  const out: DecisionLine[] = []
  for (const line of lines) {
    const draft = drafts[line.id]
    if (!draft || !draft.disposition) continue
    const credit = price && draft.credit.trim() !== '' ? minorOf(draft.credit) : null
    out.push({ lineId: line.id, disposition: draft.disposition, goodsOutcome: outcomeOf(draft, line), ...(credit !== null ? { creditAmount: credit } : {}) })
  }
  return out
}

/** What is wrong with the drafts before the preview (keys per line). */
export function decisionDraftProblems(drafts: Readonly<Record<string, DecisionDraft>>, lines: readonly ReturnLine[], price: boolean): Words[] {
  const out: Words[] = []
  for (const line of lines) {
    const draft = drafts[line.id]
    if (!draft || !draft.disposition) continue
    if (price && draft.credit.trim() !== '') {
      const credit = minorOf(draft.credit)
      if (credit === null) out.push({ key: 'decide.problem.creditNumber', params: { seq: line.seq } })
      else if (typeof line.receivedValue === 'number' && credit > line.receivedValue) out.push({ key: 'decide.problem.creditOver', params: { seq: line.seq } })
    }
  }
  return out
}

/** The line's decision effect in words (money, stock and work in one line), our words from its facts. */
export function effectOf(decision: { disposition: ReturnDisposition; goodsOutcome: GoodsOutcome | null; creditAmount: number | null | undefined; place?: string | null }): Words[] {
  const credit = (decision.creditAmount ?? 0) > 0
  const parts: Words[] = [{ key: credit ? 'effect.credit' : 'effect.noCredit' }]
  if (decision.goodsOutcome) parts.push(decision.place && STOCK_OUTCOMES.includes(decision.goodsOutcome) ? { key: `effect.goodsAt.${decision.goodsOutcome}`, params: { place: decision.place } } : { key: `effect.goods.${decision.goodsOutcome}` })
  const follow = followUpOf(decision.disposition, decision.creditAmount ?? 0)
  parts.push({ key: follow ? `effect.follow.${follow}` : 'effect.noWork' })
  if (decision.disposition !== 'CREDIT_ONLY' && follow !== 'CREDIT_NOTE' && credit) parts.push({ key: 'effect.follow.CREDIT_NOTE' })
  return parts
}

/** Why an outcome may not be picked for a line (the decision preview's held sentence, read in our words). */
export function outcomeHeldKey(outcome: GoodsOutcome, line: Pick<ReturnLine, 'safety' | 'ppe' | 'grade'>, held: string | null): string | null {
  if (held === null) return null
  if (line.safety) return 'decide.held.safety'
  if (outcome === 'RESTOCK') return line.ppe ? 'decide.held.ppeRestock' : 'decide.held.restock'
  if (outcome === 'SECOND_QUALITY' || outcome === 'QUARANTINE') return 'decide.held.place'
  return 'decide.held.other'
}

// ---- New return (design pop:returns.new) ------------------------------------------------------------------------------------

export interface NewReturnLineDraft {
  readonly quantity: string
  readonly reasonCode: string
  readonly note: string
}

export interface NewReturnDraft {
  readonly partyId: string
  readonly salesOrderId: string
  readonly customerRef: string
  readonly goodsDueBy: string
  readonly internalNote: string
  /** By returnable line key. */
  readonly lines: Readonly<Record<string, NewReturnLineDraft>>
}

export const BLANK_RETURN: NewReturnDraft = Object.freeze({ partyId: '', salesOrderId: '', customerRef: '', goodsDueBy: '', internalNote: '', lines: {} })

/** A returnable line's key: its invoice line, else its order line and size. */
export const returnableKey = (line: Pick<ReturnableLine, 'invoiceLineId' | 'salesOrderLineId' | 'size'>): string => line.invoiceLineId ?? `${line.salesOrderLineId ?? ''}|${line.size ?? ''}`

const pieces = (text: string): number | null => (/^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : null)

export function picked(draft: NewReturnDraft, returnable: readonly ReturnableLine[]): { line: ReturnableLine; draft: NewReturnLineDraft; quantity: number | null }[] {
  return returnable
    .map((line) => ({ line, draft: draft.lines[returnableKey(line)] }))
    .filter((entry): entry is { line: ReturnableLine; draft: NewReturnLineDraft } => !!entry.draft && entry.draft.quantity.trim() !== '' && entry.draft.quantity.trim() !== '0')
    .map((entry) => ({ ...entry, quantity: pieces(entry.draft.quantity) }))
}

/** What stops New return before the API is asked (keys; the cell's own refusal names the numbers). */
export function newReturnProblems(draft: NewReturnDraft, returnable: readonly ReturnableLine[] | null): Words[] {
  const out: Words[] = []
  if (!draft.partyId) out.push({ key: 'newReturn.problem.customer' })
  const chosen = returnable ? picked(draft, returnable) : []
  if (draft.partyId && chosen.length === 0) out.push({ key: 'newReturn.problem.lines' })
  for (const entry of chosen) {
    if (entry.quantity === null || entry.quantity < 1) out.push({ key: 'newReturn.problem.quantity', params: { line: entry.line.description } })
    else if (entry.quantity > entry.line.left) out.push({ key: 'refusal.aboveSoldMax', params: { max: entry.line.left, sold: entry.line.sold } })
    if (!entry.draft.reasonCode) out.push({ key: 'newReturn.problem.reason', params: { line: entry.line.description } })
  }
  return out
}

export function newReturnBody(draft: NewReturnDraft, returnable: readonly ReturnableLine[], companyId: string): NewReturnBody {
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  return {
    companyId,
    partyId: draft.partyId,
    ...(draft.salesOrderId ? { salesOrderId: draft.salesOrderId } : {}),
    customerRef: text(draft.customerRef),
    internalNote: text(draft.internalNote),
    ...(draft.goodsDueBy ? { goodsDueBy: draft.goodsDueBy } : {}),
    lines: picked(draft, returnable).map((entry) => ({
      ...(entry.line.invoiceLineId ? { invoiceLineId: entry.line.invoiceLineId } : { salesOrderLineId: entry.line.salesOrderLineId, size: entry.line.size }),
      quantity: entry.quantity ?? 0,
      reasonCode: entry.draft.reasonCode,
      reasonNote: text(entry.draft.note),
      batchNumber: entry.line.batchNumbers.length === 1 ? entry.line.batchNumbers[0]! : null,
    })),
  }
}

// ---- Add lines on an open RMA (B-W2b-16; design rma.lines "Add lines by picking from the customer's invoiced lines") ------

/** The lines already on the return, by the key of what may come back: their seq (their pieces change on the Lines tab). */
export function takenOf(rma: Pick<Rma, 'lines'>): Record<string, number> {
  return Object.fromEntries(rma.lines.map((line) => [returnableKey(line), line.seq]))
}

/** What stops Add lines before the API is asked (the lines picked, their pieces and reasons; lines already on it never). */
export function addLinesProblems(lines: Readonly<Record<string, NewReturnLineDraft>>, returnable: readonly ReturnableLine[] | null, taken: Readonly<Record<string, number>>): Words[] {
  const open = (returnable ?? []).filter((line) => taken[returnableKey(line)] === undefined)
  const problems = newReturnProblems({ ...BLANK_RETURN, partyId: 'picked', lines }, open)
  return problems
}

/** The lines Add lines sends (POST /sales/returns/:id/lines). */
export function addLinesBody(lines: Readonly<Record<string, NewReturnLineDraft>>, returnable: readonly ReturnableLine[], taken: Readonly<Record<string, number>>): NewReturnBody['lines'] {
  const open = returnable.filter((line) => taken[returnableKey(line)] === undefined)
  return newReturnBody({ ...BLANK_RETURN, lines }, open, '').lines
}

/** Delivered outside the return window: a warning only (the policy check itself is SAL-338, W2b). */
export function outsideWindow(line: Pick<ReturnableLine, 'deliveredOn'>, windowDays: number | null, today: string): number | null {
  if (!line.deliveredOn || windowDays === null) return null
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${line.deliveredOn}T00:00:00Z`)) / 86_400_000)
  return days > windowDays ? days : null
}

// ---- New repair (design pop:returns.newRepair) -------------------------------------------------------------------------------

export interface NewRepairDraft {
  readonly returnLineId: string
  readonly serial: string
  readonly partyId: string
  readonly kind: RepairKind
  readonly problem: string
  /** The garment came with the customer: the repair starts received. */
  readonly received: boolean
  readonly inboundDdtNumber: string
  readonly inboundDdtDate: string
  readonly internalNote: string
}

export const BLANK_REPAIR: NewRepairDraft = Object.freeze({ returnLineId: '', serial: '', partyId: '', kind: 'REPAIR', problem: '', received: false, inboundDdtNumber: '', inboundDdtDate: '', internalNote: '' })

export function newRepairBody(draft: NewRepairDraft, companyId: string): NewRepairBody {
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  if (draft.returnLineId) return { returnLineId: draft.returnLineId, kind: draft.kind, ...(draft.problem.trim() ? { problem: draft.problem.trim() } : {}), internalNote: text(draft.internalNote) }
  return {
    companyId,
    ...(draft.partyId ? { partyId: draft.partyId } : {}),
    kind: draft.kind,
    serial: text(draft.serial),
    ...(draft.problem.trim() ? { problem: draft.problem.trim() } : {}),
    internalNote: text(draft.internalNote),
    ...(draft.received ? { received: { inboundDdtNumber: text(draft.inboundDdtNumber), inboundDdtDate: draft.inboundDdtDate || null } } : {}),
  }
}

export function newRepairProblems(draft: NewRepairDraft): Words[] {
  if (draft.returnLineId) return []
  const out: Words[] = []
  if (!draft.partyId) out.push({ key: 'newRepair.problem.customer' })
  if (!draft.problem.trim()) out.push({ key: 'newRepair.problem.problem' })
  return out
}

// ---- receiving (an RMA's goods at the counter; a repair's garment) ---------------------------------------------------------

export interface ReceiptDraft {
  readonly parcels: string
  readonly condition: ParcelCondition
  readonly carrierName: string
  readonly trackingNumber: string
  readonly ddtNumber: string
  readonly ddtDate: string
  readonly note: string
  /** Pieces per line (default what each still expects). */
  readonly lines: Readonly<Record<string, string>>
}

export function receiptDraftOf(rma: Pick<Rma, 'lines'>): ReceiptDraft {
  return {
    parcels: '1',
    condition: 'INTACT',
    carrierName: '',
    trackingNumber: '',
    ddtNumber: '',
    ddtDate: '',
    note: '',
    lines: Object.fromEntries(rma.lines.filter((line) => line.grade === null && line.receivedQuantity < line.quantity).map((line) => [line.id, String(line.quantity - line.receivedQuantity)])),
  }
}

export function receiptProblems(draft: ReceiptDraft, rma: Pick<Rma, 'lines'>): Words[] {
  const out: Words[] = []
  const parcels = pieces(draft.parcels)
  if (parcels === null || parcels < 1) out.push({ key: 'receive.problem.parcels' })
  const chosen = Object.entries(draft.lines).filter(([, value]) => value.trim() !== '' && value.trim() !== '0')
  if (chosen.length === 0) out.push({ key: 'receive.problem.lines' })
  for (const [lineId, value] of chosen) {
    const line = rma.lines.find((entry) => entry.id === lineId)
    const count = pieces(value)
    if (!line || count === null) out.push({ key: 'receive.problem.quantity' })
    else if (count > line.quantity - line.receivedQuantity) out.push({ key: 'receive.problem.more', params: { seq: line.seq, max: line.quantity - line.receivedQuantity } })
  }
  return out
}

export function receiptBody(draft: ReceiptDraft): ReceiptBody {
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  return {
    parcels: pieces(draft.parcels) ?? 1,
    parcelCondition: draft.condition,
    carrierName: text(draft.carrierName),
    trackingNumber: text(draft.trackingNumber),
    customerDdtNumber: text(draft.ddtNumber),
    customerDdtDate: draft.ddtDate || null,
    note: text(draft.note),
    lines: Object.entries(draft.lines)
      .map(([lineId, value]) => ({ lineId, quantity: pieces(value) ?? 0 }))
      .filter((line) => line.quantity > 0),
  }
}

// ---- the safety check (GateChecklist + SignBlock) ---------------------------------------------------------------------------

export interface ChecklistDraft {
  readonly seams: PointResult | ''
  readonly abrasionZones: PointResult | ''
  readonly closures: PointResult | ''
  readonly protectors: PointResult | ''
  readonly replaced: boolean
  readonly lot: string
  readonly level: '' | '1' | '2'
  readonly certificateCovers: boolean | null
  readonly note: string
}

export const BLANK_CHECKLIST: ChecklistDraft = Object.freeze({ seams: '', abrasionZones: '', closures: '', protectors: '', replaced: false, lot: '', level: '', certificateCovers: null, note: '' })

export const CHECK_POINTS = ['seams', 'abrasionZones', 'closures', 'protectors'] as const
export type CheckPoint = (typeof CHECK_POINTS)[number]

/** What the check still needs before it may be signed (keys): every point answered, a replaced protector's lot and level. */
export function checklistProblems(draft: ChecklistDraft): Words[] {
  const out: Words[] = []
  for (const point of CHECK_POINTS) if (!draft[point]) out.push({ key: 'safety.problem.point', params: { point: `safety.point.${point}` } })
  if (draft.seams === 'NOT_APPLICABLE') out.push({ key: 'safety.problem.seams' })
  if (draft.replaced && !draft.lot.trim()) out.push({ key: 'safety.problem.lot' })
  if (draft.replaced && !draft.level) out.push({ key: 'safety.problem.level' })
  if (draft.certificateCovers === null) out.push({ key: 'safety.problem.certificate' })
  return out
}

/** The result the signed check will have: PASS only with no point failed and the certificate still covering. */
export function checklistResult(draft: ChecklistDraft): 'PASS' | 'FAIL' {
  return CHECK_POINTS.some((point) => draft[point] === 'FAIL') || draft.certificateCovers === false ? 'FAIL' : 'PASS'
}

export function checklistBody(draft: ChecklistDraft): ChecklistBody {
  return {
    seams: (draft.seams || 'PASS') as PointResult,
    abrasionZones: (draft.abrasionZones || 'NOT_APPLICABLE') as PointResult,
    closures: (draft.closures || 'NOT_APPLICABLE') as PointResult,
    protectors: { result: (draft.protectors || 'NOT_APPLICABLE') as PointResult, replaced: draft.replaced, lot: draft.replaced ? draft.lot.trim() : null, level: draft.replaced ? draft.level || null : null },
    certificateCovers: draft.certificateCovers === true,
    note: draft.note.trim() || null,
  }
}

// ---- a DDT of a source (the repair's way back, unchanged goods back to the customer) ---------------------------------------

export interface DdtDraft {
  readonly transportBy: DdtTransportBy
  readonly carrier: string
  readonly packages: string
  readonly weight: string
  readonly appearance: string
  readonly freight: DdtFreight | ''
  readonly remarks: string
}

export const BLANK_DDT: DdtDraft = Object.freeze({ transportBy: 'CARRIER', carrier: '', packages: '1', weight: '', appearance: '', freight: '', remarks: '' })

export function ddtProblems(draft: DdtDraft): Words[] {
  const out: Words[] = []
  if (draft.transportBy === 'CARRIER' && !draft.carrier.trim()) out.push({ key: 'ddt.problem.carrier' })
  const packages = pieces(draft.packages)
  if (packages === null || packages < 1) out.push({ key: 'ddt.problem.packages' })
  if (!/^\d+([.,]\d{1,3})?$/.test(draft.weight.trim()) || Number(draft.weight.trim().replace(',', '.')) <= 0) out.push({ key: 'ddt.problem.weight' })
  return out
}

/** The DDT preview's problems by place, in our words (deduplicated). */
export function ddtPreviewWords(problems: readonly Issue[]): Words[] {
  const keys = new Set<string>()
  for (const entry of problems) {
    const path = entry.path
    keys.add(
      /carrier/.test(path)
        ? 'ddt.problem.carrier'
        : /packages/.test(path)
          ? 'ddt.problem.packages'
          : /grossWeight|netWeight/.test(path)
            ? 'ddt.problem.weight'
            : /transportBy/.test(path)
              ? 'ddt.problem.transportBy'
              : /numbering|series/.test(path)
                ? 'ddt.problem.numbering'
                : /^company/.test(path)
                  ? 'ddt.problem.company'
                  : /destination|address|party/.test(path)
                    ? 'ddt.problem.address'
                    : /lineIds|goods|lines/.test(path)
                      ? 'ddt.problem.goods'
                      : /version|state|status/.test(path)
                        ? 'ddt.problem.state'
                        : 'ddt.problem.other',
    )
  }
  return [...keys].map((key) => ({ key }))
}

export function ddtBody(draft: DdtDraft, reason: DdtBody['reason']): DdtBody {
  return {
    ...(reason ? { reason } : {}),
    transportBy: draft.transportBy,
    carrier: draft.transportBy === 'CARRIER' ? { name: draft.carrier.trim() } : null,
    packages: pieces(draft.packages) ?? 1,
    grossWeightKg: draft.weight.trim().replace(',', '.'),
    appearance: draft.appearance.trim() || null,
    freight: draft.freight || null,
    remarks: draft.remarks.trim() || null,
  }
}

// ---- close (design pop:returns.close) --------------------------------------------------------------------------------------

/** The finish reasons offered (SAL-360 is a later row: the chosen words are stored as the close reason's text). */
export const FINISH_REASONS = ['CREDITED', 'REPLACED', 'REPAIRED', 'RETURNED', 'SCRAPPED', 'OTHER'] as const
export type FinishReason = (typeof FINISH_REASONS)[number]

/** The close reason sent: the reason's words in the person's language, then the note. */
export function closeReasonText(reasonWords: string, note: string): string {
  const extra = note.trim()
  return extra ? `${reasonWords}: ${extra}` : reasonWords
}

// ---- the RMA's milestones (the design's MilestoneTracker; SAL-362) --------------------------------------------------------

export function trackingWords(step: Rma['tracking'][number], rma: Pick<Rma, 'goodsDueBy' | 'status' | 'lines'>): Words | null {
  if (step.step === 'AUTHORISED' && step.state === 'DONE' && rma.goodsDueBy) return { key: 'track.sub.sendBy', params: { date: rma.goodsDueBy } }
  if (step.step === 'INSPECTED' && step.state === 'CURRENT') {
    const received = rma.lines.filter((line) => line.receivedQuantity > 0)
    return { key: 'track.sub.decided', params: { decided: received.filter((line) => line.disposition !== null).length, count: received.length } }
  }
  if (step.step === 'OUTCOME' && step.state === 'SKIPPED') return { key: `track.sub.${rma.status === 'REJECTED' ? 'rejected' : 'cancelled'}` }
  return null
}

/** The line counts the tabs show (null: not known). */
export function rmaCounts(rma: Rma): { lines: number; toDecide: number; shipments: number } {
  return {
    lines: rma.lines.length,
    toDecide: rma.lines.filter((line) => line.receivedQuantity > 0 && line.disposition === null).length,
    shipments: rma.receipts.length + rma.ddts.live.length + (rma.replacementOrder ? 1 : 0),
  }
}

/** A line's garment in a few words: style · colour · size. */
export const garmentOf = (line: Pick<ReturnLine, 'style' | 'colourway' | 'size'>): string => [line.style?.code, line.colourway?.name, line.size].filter(Boolean).join(' · ')

/** Live events that concern the list (any return or repair). */
export const LIVE_TYPES = ['return.', 'repair.'] as const

/** A record's live event (its own id in the payload). */
export const liveConcerns = (change: { type: string; fields: Readonly<Record<string, unknown>> }, kind: 'return' | 'repair', id: string): boolean =>
  change.type.startsWith(`${kind}.`) && (change.fields[kind === 'return' ? 'returnId' : 'repairId'] === id || change.fields.id === id)

/** Today in the factory's zone (Europe/Rome), YYYY-MM-DD. */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
