import { isApiError, issuePath } from '../../../lib/api/errors'
import { csvLine } from '../_shared/hooks'
import type { BoardLaneId, ContainmentAction, Decision, NcrCard, NcrCounts, NcrPrefill, NcrQuery, NcrRecord, NcrSettings, NcrStage, NcrSummary, Severity, StageCheck, StageCheckKey } from './api'

/**
 * The pure rules of Quality › Nonconformances (B-W2a-68; SCR-144 list and board, SCR-145 the NCR record): what a person
 * may do, the list's address ⇄ the API's own filters, the tiles, the board's lanes and why a card may not go to a lane,
 * the checks in our words from the facts the API answers (never its English), the "decided" bar, the record's tabs and
 * band, a refusal turned into words, the CSV. No React, no API client.
 */

// ---- who may do what ----------------------------------------------------------------------------------------------------

export const NCR_PERMISSIONS = {
  view: 'quality.ncr.view',
  raise: 'quality.ncr.raise',
  manage: 'quality.ncr.manage',
  approve: 'quality.ncr.approve',
  close: 'quality.ncr.close',
  holdsPlace: 'quality.holds.place',
  holdsView: 'quality.holds.view',
  defectsView: 'quality.defects.view',
  stockView: 'inventory.stock.view',
  locationsView: 'inventory.locations.view',
  scrap: 'inventory.scrap',
  transfer: 'inventory.transfer',
  adjust: 'inventory.adjust',
  issue: 'inventory.issue',
  rework: 'production.rework',
  claims: 'purchasing.claims.manage',
  repairsView: 'sales.repairs.view',
  workOrdersView: 'workorders.view',
  registerView: 'compliance.register.view',
  people: 'tasks.manage',
  filesUpload: 'files.upload',
  filesRead: 'files.read',
  threadsRead: 'threads.read',
} as const

export type NcrAbility = keyof typeof NCR_PERMISSIONS
export type NcrCan = Readonly<Record<NcrAbility, boolean>>

export function ncrCan(permissions: readonly string[]): NcrCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(NCR_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as NcrCan
}

/** The stock move's own right (an NCR decision posts it through inventory: B-W2a-47 MOVE_PERMISSIONS). */
export const MOVE_ABILITY = { SCRAP: 'scrap', TRANSFER: 'transfer', ADJUSTMENT: 'adjust', ISSUE: 'issue' } as const satisfies Record<string, NcrAbility>

// ---- the list's address ---------------------------------------------------------------------------------------------------

/** The saved rows (design ncr-grid "Saved views: Mine · Critical · Supplier NCRs · Waiting disposition · Closed"). */
export const NCR_VIEWS = ['open', 'mine', 'critical', 'supplier', 'waiting', 'overdue', 'closed', 'all'] as const
export type NcrView = (typeof NCR_VIEWS)[number]
export type NcrMode = 'list' | 'board'

export interface NcrAddress {
  view: NcrView
  q: string
  siteId: string | null
  mode: NcrMode
  /** New NCR (`?new=1`), raised from a record when `from` names one (`?from=<Type>&id=<uuid>`: "from anywhere"). */
  isNew: boolean
  from: { recordType: string; recordId: string } | null
  /**
   * B-W2b-17 ("Create NCR from N defects", design ins-defects): the inspection's defect lines picked (`&defects=a,b`), only
   * with `from=Inspection`; empty: the whole inspection.
   */
  defects: readonly string[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** At most this many picked defect lines (the API's NCR_PICKED_DEFECTS_LIMIT). */
export const PICKED_DEFECTS_MAX = 50

/** The picked defect lines of an address (`a,b,c`): ids only, each once, at most 50; anything else is left out. */
export function defectIdsOf(value: string | null | undefined): string[] {
  if (!value) return []
  return [...new Set(value.split(',').map((part) => part.trim()).filter((part) => UUID.test(part)))].slice(0, PICKED_DEFECTS_MAX)
}

export function ncrAddressOf(params: { get(name: string): string | null } | null): NcrAddress {
  const view = params?.get('view') ?? ''
  const fromType = params?.get('from') ?? ''
  const fromId = params?.get('id') ?? ''
  const site = params?.get('site') ?? ''
  return {
    view: (NCR_VIEWS as readonly string[]).includes(view) ? (view as NcrView) : 'open',
    q: (params?.get('q') ?? '').slice(0, 80),
    siteId: UUID.test(site) ? site : null,
    mode: params?.get('mode') === 'board' ? 'board' : 'list',
    isNew: params?.get('new') === '1',
    from: /^[A-Z][A-Za-z]{1,40}$/.test(fromType) && UUID.test(fromId) ? { recordType: fromType, recordId: fromId } : null,
    defects: fromType === 'Inspection' && UUID.test(fromId) ? defectIdsOf(params?.get('defects')) : [],
  }
}

export function ncrAddressText(address: NcrAddress): string {
  const search = new URLSearchParams()
  if (address.view !== 'open') search.set('view', address.view)
  if (address.q.trim()) search.set('q', address.q.trim())
  if (address.siteId) search.set('site', address.siteId)
  if (address.mode === 'board') search.set('mode', 'board')
  if (address.isNew) search.set('new', '1')
  if (address.isNew && address.from) {
    search.set('from', address.from.recordType)
    search.set('id', address.from.recordId)
    if (address.from.recordType === 'Inspection' && address.defects.length > 0) search.set('defects', address.defects.join(','))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** The address of New NCR raised from a record, from any screen ("Create NCR" on an inspection, a bundle, a lot …). */
export const newNcrAddress = (prefix: string, from?: { recordType: string; recordId: string } | null, defects: readonly string[] = []): string =>
  `${prefix}/quality/ncr${ncrAddressText({ view: 'open', q: '', siteId: null, mode: 'list', isNew: true, from: from ?? null, defects })}`

/** A saved row as the API's own filters. */
export function ncrQueryOf(address: Pick<NcrAddress, 'view' | 'q' | 'siteId'>): NcrQuery {
  const base: NcrQuery = { siteId: address.siteId, q: address.q || null }
  switch (address.view) {
    case 'mine':
      return { ...base, ownerId: 'me' }
    case 'critical':
      return { ...base, severity: 'CRITICAL' }
    case 'supplier':
      return { ...base, source: 'SUPPLIER' }
    case 'waiting':
      return { ...base, waiting: true }
    case 'overdue':
      return { ...base, overdue: true }
    case 'closed':
      return { ...base, stage: ['CLOSED'] }
    case 'all':
      return { ...base, open: false }
    default:
      return base
  }
}

/** The tiles (design ncr-metrics; each one a saved row: pressing it again goes back to Open). */
export const NCR_TILES = [
  { view: 'open', count: 'open' },
  { view: 'overdue', count: 'containmentOverdue' },
  { view: 'waiting', count: 'waitingDisposition' },
  { view: 'critical', count: 'criticalOpen' },
  { view: 'closed', count: 'closedThisMonth' },
] as const satisfies readonly { view: NcrView; count: keyof NcrCounts }[]

// ---- stages and words -------------------------------------------------------------------------------------------------------

export const STAGE_TONE: Readonly<Record<NcrStage, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = {
  OPEN: 'warning',
  CONTAINED: 'info',
  DECIDED: 'info',
  CLOSED: 'success',
  CANCELLED: 'neutral',
}
export const SEVERITY_TONE: Readonly<Record<Severity, 'danger' | 'warning' | 'neutral'>> = { CRITICAL: 'danger', MAJOR: 'warning', MINOR: 'neutral' }

/** The stage after this one (null: closed, cancelled). */
export const nextStageOf = (stage: NcrStage): NcrStage | null => (stage === 'OPEN' ? 'CONTAINED' : stage === 'CONTAINED' ? 'DECIDED' : stage === 'DECIDED' ? 'CLOSED' : null)
export const isOpenStage = (stage: NcrStage): boolean => stage === 'OPEN' || stage === 'CONTAINED' || stage === 'DECIDED'
/** The problem is edited while OPEN or CONTAINED (design ncr-what: "read-only after Decided"). */
export const problemEditable = (stage: NcrStage): boolean => stage === 'OPEN' || stage === 'CONTAINED'

/** Words with their parameters, in the `ncr` catalogue. */
export interface Say {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** A quantity as the API sends it ("51.8000", "40") in the reader's language, at most 4 decimals. */
export function quantityText(value: string | null | undefined, locale: string): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(number)
}

/** How much of the quantity affected is decided, from the API's facts: words, and the bar's percent. */
export function decidedOf(ncr: Pick<NcrSummary, 'quantityAffected' | 'decided' | 'uom'>): { readonly all: boolean; readonly percent: number | null; readonly say: Say } {
  const affected = Number(ncr.quantityAffected)
  const decided = Number(ncr.decided.decided)
  const left = Number(ncr.decided.left)
  const all = Number.isFinite(left) ? left <= 0 : false
  const percent = Number.isFinite(affected) && affected > 0 && Number.isFinite(decided) ? Math.max(0, Math.min(100, Math.round((decided / affected) * 100))) : null
  return { all, percent, say: all ? { key: 'decided.all', params: { affected: ncr.quantityAffected, unit: ncr.uom } } : { key: 'decided.some', params: { decided: ncr.decided.decided, affected: ncr.quantityAffected, left: ncr.decided.left, unit: ncr.uom } } }
}

/** What the checks read (from a record, or a board card's summary). */
export interface CheckFacts {
  readonly stage: NcrStage
  readonly actionsDone: number
  readonly actionsOpen: number
  readonly quantityAffected: string
  readonly decided: string
  readonly left: string
  readonly uom: string
  /** Decisions waiting another person's approval (null: not known — a board card). */
  readonly waitingApproval: number | null
  /** Decisions not carried out yet. */
  readonly notCarriedOut: number
  readonly carriedOut: number
  /** ACTIVE holds this NCR decides (closed with it). */
  readonly activeHolds: number
}

export function factsOfRecord(record: NcrRecord): CheckFacts {
  return {
    stage: record.ncr.stage,
    actionsDone: record.containment.filter((action) => action.status === 'DONE').length,
    actionsOpen: record.containment.filter((action) => action.status === 'OPEN').length,
    quantityAffected: record.ncr.quantityAffected,
    decided: record.ncr.decided.decided,
    left: record.ncr.decided.left,
    uom: record.ncr.uom,
    waitingApproval: record.decisions.filter((decision) => decision.state === 'WAITING_APPROVAL').length,
    notCarriedOut: record.decisions.filter((decision) => decision.state !== 'DONE').length,
    carriedOut: record.decisions.filter((decision) => decision.state === 'DONE').length,
    activeHolds: record.holds.filter((hold) => hold.decidedHere && hold.status === 'ACTIVE').length,
  }
}

export function factsOfSummary(row: NcrSummary): CheckFacts {
  return {
    stage: row.stage,
    actionsDone: row.actions.done,
    actionsOpen: row.actions.open,
    quantityAffected: row.quantityAffected,
    decided: row.decided.decided,
    left: row.decided.left,
    uom: row.uom,
    waitingApproval: null,
    notCarriedOut: row.decisionsWaiting,
    carriedOut: 0,
    activeHolds: 0,
  }
}

/**
 * A check of the API (its key and whether it is met) in our words, with the counts from the facts: "No containment
 * action is done yet", "12 of 40 pcs decided · 28 left: decide the rest first".
 */
export function checkSay(key: StageCheckKey, ok: boolean, facts: CheckFacts, to?: NcrStage | null): Say {
  const state = ok ? 'ok' : 'open'
  switch (key) {
    case 'STAGE':
      return ok ? { key: 'check.STAGE.ok', params: { from: facts.stage, to: to ?? 'CLOSED' } } : { key: facts.stage === 'CLOSED' || facts.stage === 'CANCELLED' ? 'check.STAGE.frozen' : 'check.STAGE.open', params: { stage: facts.stage } }
    case 'ACTION_DONE':
      return { key: `check.ACTION_DONE.${state}`, params: { count: facts.actionsDone } }
    case 'NO_OPEN_ACTION':
      return { key: `check.NO_OPEN_ACTION.${state}`, params: { count: facts.actionsOpen } }
    case 'ALL_DECIDED':
      return ok ? { key: 'check.ALL_DECIDED.ok', params: { affected: facts.quantityAffected, unit: facts.uom } } : { key: 'check.ALL_DECIDED.open', params: { decided: facts.decided, affected: facts.quantityAffected, left: facts.left, unit: facts.uom } }
    case 'APPROVED':
      return ok ? { key: 'check.APPROVED.ok' } : facts.waitingApproval ? { key: 'check.APPROVED.open', params: { count: facts.waitingApproval } } : { key: 'check.APPROVED.openSome' }
    case 'CARRIED_OUT':
      return { key: `check.CARRIED_OUT.${state}`, params: { count: facts.notCarriedOut } }
    case 'HOLDS':
      return facts.activeHolds > 0 ? { key: 'check.HOLDS.some', params: { count: facts.activeHolds } } : { key: 'check.HOLDS.none' }
    case 'NOTHING_CARRIED_OUT':
      return { key: `check.NOTHING_CARRIED_OUT.${state}`, params: { count: facts.carriedOut } }
  }
}

/** Every check of a list (the Stepper's "what is missing", the closing checklist) in our words. */
export const checksSay = (checks: readonly StageCheck[], facts: CheckFacts, to?: NcrStage | null): { key: StageCheckKey; ok: boolean; say: Say }[] =>
  checks.map((check) => ({ key: check.key, ok: check.ok, say: checkSay(check.key, check.ok, facts, to) }))

/** The first check not met, in our words (null: every check is met). */
export function firstOpen(checks: readonly StageCheck[], facts: CheckFacts, to?: NcrStage | null): Say | null {
  const open = checks.find((check) => !check.ok)
  return open ? checkSay(open.key, false, facts, to) : null
}

// ---- the board -------------------------------------------------------------------------------------------------------------

/**
 * Why a card may not go to a lane (null: it may; the same lane is the board's own word). One stage at a time, forward
 * only (CANCELLED from the record); Contained and Decided need quality.ncr.manage, Closed quality.ncr.close and opens the
 * closing signature. The card's own facts say what is missing ("No containment action is done yet").
 */
export function laneHeld(card: NcrCard, lane: BoardLaneId, can: Pick<NcrCan, 'manage' | 'close'>): Say | null {
  if (lane === card.stage) return null
  const order: readonly NcrStage[] = ['OPEN', 'CONTAINED', 'DECIDED', 'CLOSED']
  if (order.indexOf(lane) < order.indexOf(card.stage)) return { key: 'board.held.back' }
  if (lane !== nextStageOf(card.stage)) return { key: 'board.held.skip', params: { stage: nextStageOf(card.stage) ?? card.stage } }
  if (lane === 'CLOSED' && !can.close) return { key: 'board.held.noClose' }
  if (lane !== 'CLOSED' && !can.manage) return { key: 'board.held.noManage' }
  if (card.next.ready) return null
  const facts = factsOfSummary(card)
  if (lane === 'CONTAINED') return facts.actionsDone === 0 ? checkSay('ACTION_DONE', false, facts) : checkSay('NO_OPEN_ACTION', false, facts)
  if (lane === 'DECIDED') return Number(facts.left) > 0 ? checkSay('ALL_DECIDED', false, facts) : checkSay('APPROVED', false, facts)
  return checkSay('CARRIED_OUT', false, facts)
}

/** A card that may not move at all (closed; being moved). */
export const cardHeld = (card: Pick<NcrSummary, 'stage'>, moving: boolean): Say | null => (card.stage === 'CLOSED' ? { key: 'board.held.closed' } : moving ? { key: 'board.held.busy' } : null)

// ---- the record -----------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['problem', 'containment', 'disposition', 'linked', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** The band's actions: null = allowed, words = why not (our words for the API's `actions`). */
export interface BandHeld {
  readonly edit: Say | null
  readonly contain: Say | null
  readonly decide: Say | null
  readonly close: Say | null
  readonly cancel: Say | null
}

export function bandHeld(record: NcrRecord): BandHeld {
  const facts = factsOfRecord(record)
  const stage = record.ncr.stage
  const frozen: Say | null = stage === 'CLOSED' || stage === 'CANCELLED' ? { key: 'held.frozen', params: { stage } } : null
  const edit = record.actions.edit === null ? null : (frozen ?? { key: 'held.editDecided' })
  const contain = record.actions.contain === null ? null : stage === 'OPEN' ? (firstOpen(record.next.checks, facts, 'CONTAINED') ?? { key: 'held.notReady' }) : (frozen ?? { key: 'held.contained' })
  const decide = record.actions.decide === null ? null : stage === 'CONTAINED' ? (firstOpen(record.next.checks, facts, 'DECIDED') ?? { key: 'held.notReady' }) : stage === 'OPEN' ? { key: 'held.containFirst' } : (frozen ?? { key: 'held.decided' })
  const close = record.actions.close === null ? null : (frozen ?? firstOpen(record.closing.checks, facts, 'CLOSED') ?? { key: 'held.notReady' })
  const cancel = record.actions.cancel === null ? null : stage === 'OPEN' || stage === 'CONTAINED' ? { key: 'held.cancelCarried' } : (frozen ?? { key: 'held.cancelDecided' })
  return { edit, contain, decide, close, cancel }
}

/** What the Stepper shows: the four stages, the current one, and what the next one still needs. */
export function stepsOf(record: NcrRecord): { current: number; next: NcrStage | null; missing: Say[] } {
  const order: readonly NcrStage[] = ['OPEN', 'CONTAINED', 'DECIDED', 'CLOSED']
  const stage = record.ncr.stage
  const current = stage === 'CANCELLED' ? 0 : order.indexOf(stage)
  const facts = factsOfRecord(record)
  const next = record.next.stage
  return { current, next, missing: record.next.checks.filter((check) => !check.ok && check.key !== 'STAGE').map((check) => checkSay(check.key, false, facts, next)) }
}

/** What a decision may do next for this person (approve, carry out, remove), each held with its reason. */
export function decisionHeld(decision: Decision, record: NcrRecord, can: NcrCan, me: string): { approve: Say | null; carryOut: Say | null; edit: Say | null } {
  const stage = record.ncr.stage
  const open = problemEditable(stage)
  const approve: Say | null = !decision.approvalRequired
    ? { key: 'held.decision.noApproval' }
    : decision.approvedAt
      ? { key: 'held.decision.approved' }
      : !can.approve
        ? { key: 'held.decision.noApprove' }
        : decision.decidedById === me
          ? { key: 'held.decision.ownDecision' }
          : !open
            ? { key: 'held.frozen', params: { stage } }
            : !decision.mayApprove
              ? { key: 'held.decision.noApprove' }
              : null
  const move = decision.disposition?.stockMoveReason ?? null
  const carryOut: Say | null =
    decision.doneAt !== null
      ? { key: 'held.decision.done' }
      : !isOpenStage(stage)
        ? { key: 'held.frozen', params: { stage } }
        : !can.manage
          ? { key: 'held.noManage' }
          : decision.state === 'WAITING_APPROVAL'
            ? { key: 'held.decision.waiting' }
            : move && !can[MOVE_ABILITY[move]]
              ? { key: 'held.decision.noMove', params: { permission: `inventory.${MOVE_ABILITY[move]}` } }
              : decision.disposition?.followUp === 'REWORK_ORDER' && !can.rework
                ? { key: 'held.decision.noRework' }
                : decision.disposition?.followUp === 'SUPPLIER_CLAIM' && !can.claims && !move
                  ? { key: 'held.decision.noClaims' }
                  : null
  const edit: Say | null = !can.manage ? { key: 'held.noManage' } : !open ? (stage === 'DECIDED' ? { key: 'held.decision.decidedStage' } : { key: 'held.frozen', params: { stage } }) : decision.doneAt ? { key: 'held.decision.done' } : decision.approvedAt ? { key: 'held.decision.approvedFrozen' } : null
  return { approve, carryOut, edit }
}

/** What an action may do next (done, cancel, change owner or due). */
export function actionHeld(action: ContainmentAction, record: NcrRecord, can: NcrCan): Say | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (!problemEditable(record.ncr.stage)) return record.ncr.stage === 'DECIDED' ? { key: 'held.contained' } : { key: 'held.frozen', params: { stage: record.ncr.stage } }
  if (action.status !== 'OPEN') return { key: action.status === 'DONE' ? 'held.action.done' : 'held.action.cancelled' }
  return null
}

/** Decisions are added while OPEN or CONTAINED and something is left to decide. */
export function addDecisionHeld(record: NcrRecord, can: NcrCan): Say | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (!problemEditable(record.ncr.stage)) return record.ncr.stage === 'DECIDED' ? { key: 'held.decision.decidedStage' } : { key: 'held.frozen', params: { stage: record.ncr.stage } }
  if (Number(record.ncr.decided.left) <= 0) return { key: 'held.decision.allDecided' }
  if (!can.defectsView) return { key: 'held.decision.noCodes' }
  return null
}

export function addActionHeld(record: NcrRecord, can: NcrCan): Say | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (!problemEditable(record.ncr.stage)) return record.ncr.stage === 'DECIDED' ? { key: 'held.contained' } : { key: 'held.frozen', params: { stage: record.ncr.stage } }
  return null
}

/** The records a "Hold stock" action may hold, from what the NCR names (a lot, a work order, a serial). */
export function holdSubjectsOf(ncr: NcrRecord['ncr']): { subjectType: 'Lot' | 'WorkOrder' | 'GarmentSerial'; id: string; label: string }[] {
  const subjects: { subjectType: 'Lot' | 'WorkOrder' | 'GarmentSerial'; id: string; label: string }[] = []
  if (ncr.lot) subjects.push({ subjectType: 'Lot', id: ncr.lot.id, label: ncr.lot.code })
  if (ncr.workOrder) subjects.push({ subjectType: 'WorkOrder', id: ncr.workOrder.id, label: ncr.workOrder.number })
  return subjects
}

/** A due time typed in the site's zone (`datetime-local`) as a UTC instant, and back: the Plant screens' own rule. */
export { instantOf, localOf } from '../../plant/_shared/model'

// ---- refusals ----------------------------------------------------------------------------------------------------------------

/** A failed call as a notice: our words by kind; the API's sentences only as detail lines (data, like a lot code). */
export interface Refusal {
  readonly say: Say
  readonly detail: readonly string[]
  /** The record changed meanwhile (a stale version): read it again. */
  readonly stale: boolean
  /** The 409's `stage/<CHECK>` keys (the board's or the close's checks not met). */
  readonly checks: readonly StageCheckKey[]
  /** The 400's fields (`body/<field>`). */
  readonly fields: readonly string[]
}

const KIND_KEY: Readonly<Record<string, string>> = {
  signed_out: 'problem.signedOut',
  forbidden: 'problem.forbidden',
  step_up: 'problem.stepUp',
  not_found: 'problem.notFound',
  conflict: 'problem.refused',
  invalid: 'problem.invalid',
  rate_limited: 'problem.rateLimited',
  contract: 'problem.contract',
  unavailable: 'problem.unavailable',
}

export function refusalOf(error: unknown): Refusal {
  if (!isApiError(error)) return { say: { key: 'problem.unavailable' }, detail: [], stale: false, checks: [], fields: [] }
  const paths = error.issues.map((issue) => issuePath(issue))
  const stale = error.kind === 'conflict' && paths.includes('version')
  const checks = paths.filter((path) => path.startsWith('stage/')).map((path) => path.slice(6)) as StageCheckKey[]
  const fields = paths.filter((path) => path.startsWith('body/')).map((path) => path.slice(5).split('/')[0] ?? '')
  const carriesWords = (error.kind === 'conflict' || error.kind === 'invalid' || error.kind === 'forbidden') && !stale
  const detail = carriesWords ? [...new Set([error.message, ...error.issues.filter((issue) => issuePath(issue).startsWith('body/')).map((issue) => issue.message ?? '')].filter((line) => line && line.length < 400))] : []
  const key = stale ? 'problem.stale' : checks.length > 0 ? 'problem.checks' : (KIND_KEY[error.kind] ?? 'problem.internal')
  return { say: { key }, detail: checks.length > 0 ? [] : detail, stale, checks, fields }
}

/** A failed read as a `quality` problem key (the shared words of the quality screens). */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  return KIND_KEY[error.kind] && error.kind !== 'conflict' ? KIND_KEY[error.kind]! : 'problem.internal'
}

// ---- export ---------------------------------------------------------------------------------------------------------------

export const csvText = (header: readonly string[], lines: readonly (readonly (string | number | null)[])[]): string => [csvLine(header), ...lines.map(csvLine)].join('\r\n')

/** The API's English type words at the head of its labels ("Work order WO-0150"), longest first, as record types. */
const API_TYPE_WORDS: readonly (readonly [string, string])[] = [
  ['Purchase order', 'PurchaseOrder'],
  ['PPE register', 'PpeRegisterEntry'],
  ['Work order', 'WorkOrder'],
  ['Inspection', 'Inspection'],
  ['Bundle', 'Bundle'],
  ['Garment', 'GarmentSerial'],
  ['Lot', 'Lot'],
  ['Hide', 'Hide'],
  ['Receipt', 'GoodsReceipt'],
  ['Claim', 'SupplierClaim'],
  ['Return', 'ReturnAuthorisation'],
  ['Complaint', 'Complaint'],
  ['Repair', 'RepairOrder'],
  ['Shipment', 'Shipment'],
  ['Order', 'SalesOrder'],
  ['Style', 'Style'],
]

/** The API's longer label shapes (modules/quality/ncr sources.ts and store.ts), re-said from their parts. */
const API_LABEL_SHAPES: readonly { readonly shape: RegExp; readonly key: string; readonly parts: readonly string[] }[] = [
  { shape: /^Rework of (\S+) on (\S+)$/, key: 'recordLabel.rework', parts: ['quantity', 'workOrder'] },
  { shape: /^Receipt (\S+) discrepancy (\d+)$/, key: 'recordLabel.discrepancy', parts: ['receipt', 'seq'] },
  { shape: /^Return (\S+) line (\d+)$/, key: 'recordLabel.returnLine', parts: ['number', 'seq'] },
  { shape: /^Scan of bundle (\S*) at (.+)$/, key: 'recordLabel.scan', parts: ['bundle', 'operation'] },
]

/** "Lot LOT-7" → ['Lot', 'LOT-7'] when the label is the API's type words and one code; else null. */
function typedCode(label: string): readonly [string, string] | null {
  for (const [words, type] of API_TYPE_WORDS) {
    if (label.startsWith(`${words} `)) {
      const code = label.slice(words.length + 1).trim()
      return code && !/\s/.test(code) ? [type, code] : null
    }
  }
  return null
}

/**
 * A record the API names in English ("Lot DEMO-LOT-0007", "Work order WO-0150", "Rework of 4 on WO-0150", "Return RMA-1
 * line 2", "Hold of Lot A, Hide B") in our words: the type in the reader's language and the record's code; the API's
 * longer shapes re-said from their parts; a bare number (a repair's, a claim's) after the type word; anything else as the
 * type and the API's label as data.
 */
export function recordLabel(t: (key: string, params?: Record<string, string | number>) => string, type: string, label: string | null | undefined): string {
  const word = t(`recordType.${type}`)
  const text = (label ?? '').trim()
  if (!text) return word
  for (const { shape, key, parts } of API_LABEL_SHAPES) {
    const found = shape.exec(text)
    if (found) return t(key, Object.fromEntries(parts.map((part, index) => [part, found[index + 1] ?? ''])))
  }
  const held = /^Hold of (.+)$/.exec(text)
  if (held) {
    const subjects = held[1]!.split(', ').map((subject) => {
      const typed = typedCode(subject)
      if (typed) return `${t(`recordType.${typed[0]}`)} ${typed[1]}`
      // No subject read: the API names the hold's subject type ("Hold of Lot").
      const type = t(`recordType.${subject}`)
      return type === `recordType.${subject}` ? subject : type
    })
    return t('recordLabel.hold', { subjects: subjects.join(', ') })
  }
  const typed = typedCode(text)
  if (typed) return `${word} ${typed[1]}`
  if (!/\s/.test(text)) return `${word} ${text}`
  return `${word} · ${text}`
}

/** The person's name from the people read (null: not known; the screen says "—"). */
export const nameOf = (people: readonly { id: string; name: string }[] | null, id: string | null): string | null => (id ? (people?.find((person) => person.id === id)?.name ?? null) : null)

// ---- W2b follow-ups (B-W2b-17) ---------------------------------------------------------------------------------------

/** The title words' params that are counts (they pick the plural). */
const TITLE_COUNT = new Set(['count'])

/**
 * The NCR's prefilled title in the reader's language (B-W2a-68's gap: the API's English sentence on Italian screens),
 * from the parts the prefill answers: `title.<KEY>` in the `ncr` words with its values; a library defect in its words in
 * the reader's language (`defectLabel`; else the line's own words as the inspector wrote them); a receipt discrepancy's
 * kind in words; a hold's reason as its code. Null when the prefill has no parts (then the API's `title` is kept).
 */
export function titleWords(t: (key: string, params?: Record<string, string | number>) => string, parts: NcrPrefill['titleParts'], defectLabel?: (defectCodeId: string) => string | null): string | null {
  if (!parts) return null
  const params: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(parts.values)) params[name] = TITLE_COUNT.has(name) && /^\d+$/.test(value) ? Number(value) : value
  if (parts.key === 'INSPECTION_DEFECT' && parts.values.defectCodeId) params.defectWords = defectLabel?.(parts.values.defectCodeId) ?? parts.values.defectWords ?? parts.values.defect ?? ''
  if (parts.key === 'DISCREPANCY' && typeof params.kind === 'string') {
    const kind = t(`discrepancyKind.${params.kind}`)
    params.kind = kind === `discrepancyKind.${params.kind}` ? String(params.kind) : kind
  }
  const key: string = parts.key === 'SCAN_REJECTED' && !parts.values.operation ? 'title.SCAN_REJECTED_op' : `title.${parts.key}`
  const text = t(key, params).trim()
  return text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : text
}

/** How long after it was found an NCR's containment is due, in words: whole days when it is a multiple of 24 hours. */
export function containmentSpan(hours: number): Say {
  return hours >= 24 && hours % 24 === 0 ? { key: 'containmentTime.days', params: { count: hours / 24 } } : { key: 'containmentTime.hours', params: { count: hours } }
}

/** The containment-time dialog's draft: follow the tenant / default, or its own hours. */
export interface ContainmentTimeDraft {
  readonly follow: boolean
  readonly hours: string
}

export const containmentDraftOf = (settings: NcrSettings): ContainmentTimeDraft => {
  const own = settings.own?.defaultContainmentHours ?? null
  return { follow: own === null, hours: String(own ?? settings.inForce.hours) }
}

/** The hours the draft saves (null: follow), or undefined when they are not whole hours from 1 to 720. */
export function containmentHoursOf(draft: ContainmentTimeDraft): number | null | undefined {
  if (draft.follow) return null
  const text = draft.hours.trim()
  if (!/^\d{1,3}$/.test(text)) return undefined
  const hours = Number(text)
  return hours >= 1 && hours <= 720 ? hours : undefined
}

/** Why Save is held in the containment-time dialog (an `ncr` key), or null. */
export function containmentSaveHeld(input: { readonly mayChange: boolean; readonly settings: NcrSettings | null; readonly draft: ContainmentTimeDraft; readonly offline?: boolean }): string | null {
  if (!input.mayChange) return 'containmentTime.heldNoRight'
  if (!input.settings) return 'containmentTime.heldReading'
  if (input.offline) return 'containmentTime.heldOffline'
  const hours = containmentHoursOf(input.draft)
  if (hours === undefined) return 'containmentTime.heldHours'
  if (hours === (input.settings.own?.defaultContainmentHours ?? null)) return 'containmentTime.heldSame'
  return null
}

/** The API's code of a refused NCR (409 `ncrs/<i>/<CODE>`) → our words' key. */
const ASSIGN_CODES: Readonly<Record<string, string>> = { STALE: 'assign.refused.stale', NO_RIGHT: 'assign.refused.noRight', CLOSED: 'assign.refused.frozen', NOT_FOUND: 'assign.refused.notFound' }

/** Why a refused NCR of a bulk owner change was refused: its code when the API names one, else from its sentence. */
export function assignRefusalKey(message: string, code?: string | null): string {
  if (code && ASSIGN_CODES[code]) return ASSIGN_CODES[code]!
  if (/changed since it was read/i.test(message)) return 'assign.refused.stale'
  if (/quality\.ncr\.manage/.test(message)) return 'assign.refused.noRight'
  if (/never changes/i.test(message)) return 'assign.refused.frozen'
  if (/not found/i.test(message)) return 'assign.refused.notFound'
  return 'assign.refused.other'
}

/**
 * The refused NCRs of a bulk owner change (409, `ncrs/<i>/<CODE>` per NCR, nothing changed) as lines of our words: the NCR's
 * number (from the rows the person picked) and why. Empty when the answer names none.
 */
export function assignRefusals(issues: readonly { readonly path: string; readonly message?: string }[], picked: readonly { readonly id: string; readonly number: string }[]): { number: string; key: string }[] {
  const lines: { number: string; key: string }[] = []
  for (const issue of issues) {
    const found = /^ncrs\/(\d+)(?:\/([A-Z_]+))?$/.exec(issue.path)
    if (!found) continue
    const row = picked[Number(found[1])]
    lines.push({ number: row?.number ?? '—', key: assignRefusalKey(issue.message ?? '', found[2] ?? null) })
  }
  return lines
}
