import { isApiError, issuePath } from '../../../lib/api/errors'
import { formatDate } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { GATE_KINDS, GATE_LIMITS, isSampleGate, reasonOf, tileOf, WAITING_TILES, type GateKind, type WaitingTile } from '@nexus/factory-domain/planning/milestones/rules'
import type { Gate, GateAction, Milestone, Milestones, Order } from './api'

/**
 * Planning › Time & action (SCR-253; design planning.milestones), pure: the page's address (`?view=calendar|list|orders`
 * `?tile=` `?q=` `?open=<milestone>` `?add=1|<order>`), the rows of the three views from the one read, the tiles as saved
 * filters, a milestone's name and state in words, what each action is held by (the API's codes and the permission missing,
 * said in our words), a refusal of a write as a key of our catalogue, the dots of the per-order row. Never the API's English.
 */

export const NAMESPACE = 'planning-milestones'

/** A business day (YYYY-MM-DD) in the page's language; '—' for none. */
export const dayText = (iso: string | null, locale: Locale): string => (iso ? formatDate(`${iso}T12:00:00Z`, { locale, timeZone: 'UTC' }) : '—')
export const VIEWS = ['calendar', 'list', 'orders'] as const
export type View = (typeof VIEWS)[number]

export interface Controls {
  readonly view: View
  readonly tile: WaitingTile | null
  readonly q: string
  /** The milestone open in its dialog (`gate:<id>`, `start:<order>`, `ship:<order>`). */
  readonly open: string | null
  /** Add a gate: `1` (pick the order) or the order's id. */
  readonly add: string | null
}

export function controlsOf(params: { get(name: string): string | null }): Controls {
  const view = params.get('view')
  const tile = params.get('tile')
  return {
    view: (VIEWS as readonly string[]).includes(view ?? '') ? (view as View) : 'calendar',
    tile: (WAITING_TILES as readonly string[]).includes(tile ?? '') ? (tile as WaitingTile) : null,
    q: (params.get('q') ?? '').slice(0, 100),
    open: params.get('open'),
    add: params.get('add'),
  }
}

export function queryOf(controls: Controls): string {
  const params = new URLSearchParams()
  if (controls.view !== 'calendar') params.set('view', controls.view)
  if (controls.tile) params.set('tile', controls.tile)
  if (controls.q.trim()) params.set('q', controls.q.trim())
  if (controls.open) params.set('open', controls.open)
  if (controls.add) params.set('add', controls.add)
  return params.toString()
}

export const DEFAULT_CONTROLS: Controls = { view: 'calendar', tile: null, q: '', open: null, add: null }

export interface Can {
  readonly view: boolean
  readonly manage: boolean
  readonly override: boolean
}

export const canOf = (permissions: readonly string[]): Can => ({
  view: permissions.includes('planning.view'),
  manage: permissions.includes('planning.milestones.manage'),
  override: permissions.includes('planning.milestones.override'),
})

/** One milestone with its order and its gate (the list, the calendar and the dialog read it). */
export interface MilestoneRow extends Milestone {
  readonly order: Order
  readonly gate: Gate | null
}

export function rowsOf(world: Milestones | null): MilestoneRow[] {
  if (!world) return []
  return world.orders.flatMap((order) => order.milestones.map((milestone) => ({ ...milestone, order, gate: milestone.gateId ? (order.gates.find((gate) => gate.id === milestone.gateId) ?? null) : null })))
}

const matches = (order: Order, q: string): boolean => {
  const text = q.trim().toLowerCase()
  if (!text) return true
  return [order.number, order.customer.name, order.customer.code, order.customerRef ?? ''].some((value) => value.toLowerCase().includes(text))
}

/** A gate counts for a tile while it waits and falls in the tile's group. */
const inTile = (gate: Gate, tile: WaitingTile): boolean => gate.state === 'WAITING' && tileOf(gate.kind, gate.leather) === tile

/** The milestones shown: the search, and a pressed tile keeps the WAITING gates of its group. */
export function visibleRows(rows: readonly MilestoneRow[], controls: Controls): MilestoneRow[] {
  return rows.filter((row) => matches(row.order, controls.q) && (controls.tile === null || (row.gate !== null && inTile(row.gate, controls.tile))))
}

/** The orders shown in "Per order": the search, and a pressed tile keeps the orders waiting on a gate of its group. */
export function visibleOrders(world: Milestones | null, controls: Controls): Order[] {
  if (!world) return []
  return world.orders.filter((order) => matches(order, controls.q) && (controls.tile === null || order.gates.some((gate) => inTile(gate, controls.tile!))))
}

export type Translate = (key: string, params?: Record<string, string | number>) => string

export interface Words {
  readonly t: Translate
  readonly locale: Locale
}

/** A gate's name: its kind's words, or for Other its own words. */
export const gateName = (kind: GateKind, label: string | null, t: Translate): string => (kind === 'OTHER' && label ? label : t(`kind.${kind}`))

/** A milestone's name (a gate's, production start, ship). */
export function milestoneName(row: Pick<Milestone, 'kind' | 'gateKind' | 'label'>, t: Translate): string {
  if (row.kind === 'GATE' && row.gateKind) return gateName(row.gateKind, row.label, t)
  return t(`milestone.${row.kind}`)
}

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

export function stateTone(row: Pick<Milestone, 'state' | 'late'>): Tone {
  if (row.state === 'DONE') return row.late ? 'warning' : 'success'
  if (row.state === 'STARTED_BEFORE') return 'info'
  if (row.late) return 'danger'
  return row.state === 'WAITING' ? 'warning' : 'neutral'
}

export const stateWords = (row: Pick<Milestone, 'state'>, t: Translate): string => t(`state.${row.state}`)

export function lateWords(row: Pick<Milestone, 'late' | 'state'>, t: Translate): string {
  if (row.late === null) return row.state === 'DONE' ? t('late.onTime') : '—'
  return row.state === 'DONE' ? t('late.doneLate', { count: row.late }) : t('late.late', { count: row.late })
}

/** Why an action is held, in our words (null: it may go): the permission missing first, then the API's refusal code. */
export function heldOf(action: GateAction | null | undefined, t: Translate, busy = false): string | null {
  if (!action) return t('held.unknown')
  if (busy) return t('held.busy')
  if (action.needs) return t(`needs.${action.needs}`)
  if (action.refusal) return t(`refusal.${action.refusal.code}`)
  return action.allowed ? null : t('held.unknown')
}

/** "Mark done N": a row may be ticked only when its gate may be marked done now (the reason otherwise). */
export function selectableHeld(row: MilestoneRow, t: Translate): string | null {
  if (!row.gate) return t('held.notAGate')
  return heldOf(row.gate.actions.pass, t)
}

/** The reason of a start before the gate: held until it says enough. */
export function reasonHeld(reason: string, t: Translate): string | null {
  if (reason.trim().length > GATE_LIMITS.reason) return t('held.reasonLong', { max: GATE_LIMITS.reason })
  return reasonOf(reason) === null ? t('held.reasonShort', { min: GATE_LIMITS.reasonMin }) : null
}

/** A refused write as a key of our catalogue (the API's code when it sent one). */
export function refusalOf(error: unknown): string {
  if (!isApiError(error)) return 'refusal.failed'
  const paths = error.issues.map((issue) => issuePath(issue).replace(/\./g, '/'))
  if (error.kind === 'conflict') {
    const coded = paths.find((path) => path.startsWith('refusal/'))
    if (coded) return `refusal.${coded.slice('refusal/'.length)}`
    return 'refusal.changed'
  }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'refusal.forbidden'
  if (error.kind === 'not_found') return 'refusal.notFound'
  if (error.kind === 'invalid') return paths.includes('body/reason') ? 'refusal.reason' : 'refusal.invalid'
  if (error.kind === 'unavailable') return 'refusal.offline'
  return 'refusal.failed'
}

export type ReadProblem = 'error.offline' | 'error.forbidden' | 'error.failed'
export function readProblemOf(error: unknown): ReadProblem {
  if (!isApiError(error)) return 'error.failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'error.forbidden'
  if (error.kind === 'unavailable') return 'error.offline'
  return 'error.failed'
}

/** A name cut for one line of a grid cell (the full name is in the Next column and the milestone's dialog). */
const short = (text: string, max = 28): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** The dots of the per-order row (DS MilestoneTracker, compact): done, started before (skipped), the next one, to come. */
/**
 * B-W2b-284 (F22's follow-up): the order's work orders per kind, in words — the production ones production start follows, then a
 * sample or a repair apart ("2 production (1 not started) · 1 sample · 1 repair").
 */
export function workOrdersWords(byKind: Order['workOrders']['byKind'], t: Translate): string {
  return byKind.map((entry) => (entry.notStarted > 0 ? t('workOrders.kindNotStarted', { kind: t(`workOrders.kind.${entry.kind}`, { count: entry.count }), count: entry.notStarted }) : t(`workOrders.kind.${entry.kind}`, { count: entry.count }))).join(' · ')
}

export function trackerSteps(order: Order, t: Translate, day: (iso: string) => string) {
  return order.milestones.map((row) => ({
    id: row.id,
    label: short(milestoneName(row, t)),
    state: row.state === 'DONE' ? ('done' as const) : row.state === 'STARTED_BEFORE' ? ('skipped' as const) : ('todo' as const),
    current: row.id === order.next,
    date: row.actual ? day(row.actual) : null,
    expected: row.state !== 'DONE' && row.target ? day(row.target) : null,
  }))
}

/** The gate kinds an order may still get (one per kind; Other always). */
export function kindsLeft(order: Order): GateKind[] {
  const taken = new Set(order.gates.map((gate) => gate.kind))
  return GATE_KINDS.filter((kind) => kind === 'OTHER' || !taken.has(kind))
}

export interface GateDraft {
  readonly kind: GateKind
  readonly label: string
  readonly targetDate: string
  readonly sampleRoundId: string
  readonly ownerId: string
}

/** What the Add gate / Change gate dialog holds the Save by (our words), null when it may go. */
export function draftHeld(draft: GateDraft, t: Translate): string | null {
  if (draft.kind === 'OTHER' && draft.label.trim() === '') return t('refusal.LABEL_NEEDED')
  if (draft.label.length > GATE_LIMITS.label) return t('held.labelLong', { max: GATE_LIMITS.label })
  if (draft.sampleRoundId && !isSampleGate(draft.kind)) return t('refusal.ROUND_ONLY_SAMPLE')
  return null
}

/** The body of an add or change from the dialog's draft (empty fields: none). */
export function bodyOf(draft: GateDraft) {
  return {
    kind: draft.kind,
    label: draft.label.trim() === '' ? null : draft.label.trim(),
    targetDate: draft.targetDate || null,
    sampleRoundId: isSampleGate(draft.kind) && draft.sampleRoundId ? draft.sampleRoundId : null,
    ownerId: draft.ownerId || null,
  }
}

export const draftOfGate = (gate: Gate): GateDraft => ({ kind: gate.kind, label: gate.label ?? '', targetDate: gate.targetDate ?? '', sampleRoundId: gate.sampleRound?.id ?? '', ownerId: gate.ownerId ?? '' })
export const emptyDraft = (kind: GateKind = 'PP_SAMPLE'): GateDraft => ({ kind, label: '', targetDate: '', sampleRoundId: '', ownerId: '' })
