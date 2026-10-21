/**
 * Meta step 30 part 2 (2026-10-21) — the drafts of set-meta-alert-subscription and remove-meta-alert-subscription: an
 * alert subscription of the CHOSEN ad account (ads-webhooks/subscriptions.md, WH-051–057), Meta pushing a `subscriptions`
 * notification to Nexus's receiver when it fires (the alerts inbox, phase 1). Pure: built from the request and the live
 * subscription (live-webhook-setup.ts).
 *
 *   create   POST /act_<id>/subscriptions event_type, filters (entity_type first; ≤ 20), field, operator, value, status
 *            — OBJECT_CREATED (no field), OBJECT_UPDATED (a metadata field; no value = any change of it),
 *            INSIGHTS_UPDATED (a metric crossing a threshold or range), INSIGHTS_MILESTONE_REACHED (EQUAL, each multiple
 *            of the value, at least Meta's minimum). Money (budgets, spend cap, bids, spend, costs) in the account
 *            currency's minor unit — `…Cents`, sent as Meta writes them; times as epoch seconds.
 *   status   PATCH /act_<id>/subscriptions/<id> status ENABLED | DISABLED
 *   remove   DELETE /act_<id>/subscriptions/<id>
 * An alert never spends: it only tells. Its undo: a new one is removed, a status goes back, a removed one is made again
 * with the same conditions (Meta gives it a new id).
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { AlertSubscriptionState } from './live-webhook-setup.js'
import {
  ALERT_ENTITY_TYPES, ALERT_FILTER_FIELDS, alertCreateProblem, alertFieldKind, alertFieldOps, alertFiltersProblem, alertValueProblem, ALERT_MILESTONE_MINIMUMS,
  type AlertValueKind,
} from '../../gateway/meta-webhook-rules.js'

export interface AlertFilterArg { field: typeof ALERT_FILTER_FIELDS[number]; operator: 'EQUAL' | 'IN' | 'NOT_IN'; values: string[] }

/** What set-meta-alert-subscription create takes (and what the undo of a removal gives it back). */
export interface AlertSpecArgs {
  eventType: 'OBJECT_CREATED' | 'OBJECT_UPDATED' | 'INSIGHTS_UPDATED' | 'INSIGHTS_MILESTONE_REACHED'
  entityType: typeof ALERT_ENTITY_TYPES[number]
  field?: string
  operator?: string
  /** Money: one amount, or two (low, high) for IN_RANGE / NOT_IN_RANGE — minor units of the account currency. */
  thresholdCents?: number[]
  /** A count or ratio: one value, or two for a range. */
  threshold?: number[]
  /** A time: one, or two for a range (ISO 8601). */
  thresholdTime?: string[]
  /** Text (a name EQUAL / CONTAIN / NOT_CONTAIN). */
  thresholdText?: string
  /** Meta's values for IN / NOT_IN / ANY / ALL / NONE (objectives, goals, true / false, label ids). */
  thresholdList?: string[]
  filters?: AlertFilterArg[]
  status?: 'ENABLED' | 'DISABLED'
}

export interface AlertRecord {
  action: 'create' | 'status' | 'remove'
  subscriptionId: string | null
  exists: boolean
  status?: string | null
  spec?: AlertSpecArgs | null
  undo?: Record<string, unknown> | null
  noUndo?: string[]
}

const decimal = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10_000) / 10_000))
const epochOf = (iso: string): string | null => { const ms = Date.parse(iso); return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : null }
const isoOf = (epoch: string) => new Date(Number(epoch) * 1000).toISOString()

/** The value of the spec as Meta writes it (text, or a JSON list for a range or list), or why it is not one. */
function valueOf(spec: AlertSpecArgs, kind: AlertValueKind, operator: string): { value: string } | { refusal: string } {
  const range = operator === 'IN_RANGE' || operator === 'NOT_IN_RANGE'
  const list = ['IN', 'NOT_IN', 'ANY', 'ALL', 'NONE'].includes(operator)
  const one = (parts: string[] | null, what: string): { value: string } | { refusal: string } => {
    if (!parts || !parts.length) return { refusal: `${spec.field} ${operator} needs ${what}.` }
    if (range && parts.length !== 2) return { refusal: `${operator} takes two values: low, then high.` }
    if (!range && !list && parts.length !== 1) return { refusal: `${operator} takes one value.` }
    return { value: range || list ? JSON.stringify(parts) : parts[0] }
  }
  switch (kind) {
    case 'money': return one(spec.thresholdCents?.map((n) => String(Math.trunc(n))) ?? null, 'thresholdCents (minor units of the account currency)')
    case 'number': return one(spec.threshold?.map(decimal) ?? null, 'threshold')
    case 'count': return one(spec.threshold?.map(decimal) ?? null, 'threshold (a whole number)')
    case 'time': {
      const parts = spec.thresholdTime?.map(epochOf) ?? null
      if (parts?.some((p) => p === null)) return { refusal: 'thresholdTime is ISO 8601 (e.g. 2026-11-01T08:00:00Z).' }
      return one(parts as string[] | null, 'thresholdTime')
    }
    case 'text': return one(spec.thresholdText ? [spec.thresholdText] : null, 'thresholdText')
    case 'enum': case 'bool': case 'ids': return one(spec.thresholdList ?? null, 'thresholdList')
  }
}

/** The gateway's own judge of the whole form (meta-webhook-rules.ts), asked before anything is queued. */
function judgedForm(params: Record<string, string>): { params: Record<string, string> } | { refusal: string } {
  const problem = alertCreateProblem(new Map(Object.entries(params)))
  return problem ? { refusal: `${problem}.` } : { params }
}

/** The form fields of a create, as Meta writes them; a refusal in words. The gateway judges the same (meta-webhook-rules.ts). */
export function alertParamsOf(spec: AlertSpecArgs): { params: Record<string, string> } | { refusal: string } {
  const filters = [{ field: 'entity_type', value: spec.entityType, operator: 'EQUAL' },
    // Review B2 — IN / NOT_IN with a real JSON list (as ad-rule filters are written), EQUAL with one value.
    ...(spec.filters ?? []).map((f) => ({ field: f.field, value: f.operator === 'EQUAL' ? (f.values[0] ?? '') : f.values, operator: f.operator }))]
  if ((spec.filters ?? []).some((f) => f.operator === 'EQUAL' && f.values.length !== 1)) return { refusal: 'An EQUAL filter takes one value.' }
  const params: Record<string, string> = { event_type: spec.eventType, filters: JSON.stringify(filters), ...(spec.status ? { status: spec.status } : {}) }
  const filterProblem = alertFiltersProblem(params.filters)
  if (filterProblem) return { refusal: `Filters: ${filterProblem}.` }
  if (spec.eventType === 'OBJECT_CREATED') {
    if (spec.field || spec.operator) return { refusal: 'OBJECT_CREATED watches new objects only: no field or operator (filter by entityType).' }
    return judgedForm(params)
  }
  if (!spec.field) return { refusal: `${spec.eventType} names its field.` }
  const kind = alertFieldKind(spec.eventType, spec.field)
  if (!kind) return { refusal: `${spec.field} is not a field ${spec.eventType} watches.` }
  params.field = spec.field
  if (spec.eventType === 'OBJECT_UPDATED' && !spec.operator) return judgedForm(params)
  const operator = spec.operator ?? (spec.eventType === 'INSIGHTS_MILESTONE_REACHED' ? 'EQUAL' : '')
  if (!alertFieldOps(spec.eventType, spec.field).includes(operator)) return { refusal: `${spec.field} takes ${alertFieldOps(spec.eventType, spec.field).join(', ')}.` }
  const value = valueOf(spec, kind, operator)
  if ('refusal' in value) return value
  const problem = alertValueProblem(kind, operator, value.value)
  if (problem) return { refusal: `${spec.field}: ${problem}.` }
  if (spec.eventType === 'INSIGHTS_MILESTONE_REACHED' && Number(value.value) < ALERT_MILESTONE_MINIMUMS[spec.field]) {
    return { refusal: `A ${spec.field} milestone is at least ${ALERT_MILESTONE_MINIMUMS[spec.field]}${kind === 'money' ? ' (minor units)' : ''}.` }
  }
  return judgedForm({ ...params, operator, value: value.value })
}

/** A live subscription as create's arguments (the undo of a removal), or null when Nexus could not write it the same way. */
export function alertSpecOf(state: AlertSubscriptionState): AlertSpecArgs | null {
  const [first, ...rest] = state.filters
  const eventType = state.eventType as AlertSpecArgs['eventType']
  if (!first || first.field !== 'entity_type' || typeof first.value !== 'string' || !(ALERT_ENTITY_TYPES as readonly string[]).includes(first.value)) return null
  const filters: AlertFilterArg[] = []
  for (const f of rest) {
    if (!(ALERT_FILTER_FIELDS as readonly string[]).includes(f.field) || !['EQUAL', 'IN', 'NOT_IN'].includes(f.operator)) return null
    const values = Array.isArray(f.value) ? f.value : f.operator === 'EQUAL' ? [f.value] : null
    if (!values) return null
    filters.push({ field: f.field as AlertFilterArg['field'], operator: f.operator as AlertFilterArg['operator'], values })
  }
  const spec: AlertSpecArgs = { eventType, entityType: first.value as AlertSpecArgs['entityType'], ...(filters.length ? { filters } : {}), ...(state.status === 'DISABLED' ? { status: 'DISABLED' as const } : {}) }
  if (eventType !== 'OBJECT_CREATED' && state.field) {
    spec.field = state.field
    const kind = alertFieldKind(eventType, state.field)
    if (!kind) return null
    if (state.operator && state.value !== null) {
      spec.operator = state.operator
      let parts: string[]
      try { parts = state.value.startsWith('[') ? (JSON.parse(state.value) as unknown[]).map(String) : [state.value] } catch { return null }
      if (kind === 'money') spec.thresholdCents = parts.map(Number)
      else if (kind === 'number' || kind === 'count') spec.threshold = parts.map(Number)
      else if (kind === 'time') spec.thresholdTime = parts.map(isoOf)
      else if (kind === 'text') spec.thresholdText = parts[0]
      else spec.thresholdList = parts
    }
  }
  const params = alertParamsOf(spec)
  return 'refusal' in params ? null : spec
}

/** One line a person reads: when it fires, never more than Meta's own words for it. */
export function alertWords(spec: AlertSpecArgs): string {
  const what = spec.entityType.toLowerCase().replace('adset', 'ad set')
  const a = what === 'ad' ? 'an' : 'a'
  if (spec.eventType === 'OBJECT_CREATED') return `a new ${what} is created`
  const field = spec.field ?? '?'
  const value = spec.thresholdCents ? `${spec.thresholdCents.join('–')} (minor units)` : spec.threshold?.join('–') ?? spec.thresholdTime?.join('–') ?? spec.thresholdText ?? spec.thresholdList?.join(', ') ?? ''
  if (spec.eventType === 'OBJECT_UPDATED') return spec.operator ? `${a} ${what}'s ${field} changes ${spec.operator} ${value}` : `${a} ${what}'s ${field} changes`
  if (spec.eventType === 'INSIGHTS_MILESTONE_REACHED') return `${a} ${what}'s ${field} reaches each multiple of ${value}`
  return `${a} ${what}'s ${field} is ${spec.operator} ${value}`
}

function request(fields: Omit<MetaChangeRequest, 'step' | 'check' | 'raisesSpend' | 'readBackInPost' | 'budget' | 'kind' | 'objectKind'>): MetaChangeRequest {
  // `kind` is a status change's and is not read here: objectKind names the object (change-draft.ts).
  return { step: 1, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, kind: 'campaign', objectKind: 'adaccount', ...fields }
}

function draft(summary: string, lines: Array<[string, unknown, unknown]>, requests: MetaChangeRequest[], stands: unknown, before: AlertRecord, after: AlertRecord, extra: { warnings?: string[]; skipped?: string[] } = {}): MetaChangeDraft {
  const { changes, more } = changeLines(lines)
  return { summary, changes, totals: { requests: requests.length, ...(more ? { moreLines: more } : {}) }, warnings: extra.warnings ?? [], spendsMoney: [], skipped: extra.skipped ?? [], requests, stands, before, after }
}

const DELIVERY = 'Meta sends a fired alert to the app\'s webhook (ad_account field subscriptions): it reaches Nexus\'s alerts inbox only when the app is subscribed to it and the ad account is connected (set-meta-webhooks, or Meta\'s App Dashboard).'

/** The draft of a new alert subscription on the chosen ad account. */
export function alertCreateDraft(adAccountId: string, spec: AlertSpecArgs): MetaChangeDraft | { refusal: string } {
  const built = alertParamsOf(spec)
  if ('refusal' in built) return built
  const { params } = built
  const act = `act_${adAccountId}`
  return draft(
    `Create an alert subscription on ad account ${adAccountId}: Meta tells Nexus when ${alertWords(spec)}.`,
    [['Alert subscription', 'none', `${alertWords(spec)}${spec.status === 'DISABLED' ? ' (disabled)' : ''}`]],
    [request({ objectId: act, label: `Create an alert subscription (${spec.eventType})`, params, edge: 'subscriptions', undoable: true, operation: 'alerts.create', via: {} })],
    { action: 'create', adAccountId, params },
    { action: 'create', subscriptionId: null, exists: false, spec: null, noUndo: [] },
    { action: 'create', subscriptionId: null, exists: true, spec },
    { warnings: [DELIVERY] },
  )
}

/** The draft of an alert subscription switched on or off. */
export function alertStatusDraft(adAccountId: string, live: AlertSubscriptionState, status: 'ENABLED' | 'DISABLED'): MetaChangeDraft {
  const act = `act_${adAccountId}`
  const id = live.subscriptionId
  const record = (s: string | null): AlertRecord => ({ action: 'status', subscriptionId: id, exists: true, status: s })
  if (live.status === status) return draft(`Alert subscription ${id} is already ${status.toLowerCase()}.`, [], [], { action: 'status', id, status: live.status }, record(live.status), record(live.status), { skipped: [`${id}: already ${status}.`] })
  return draft(
    `${status === 'ENABLED' ? 'Switch on' : 'Switch off'} alert subscription ${id} of ad account ${adAccountId}.`,
    [[`Alert subscription ${id}`, live.status ?? 'unknown', status]],
    [request({ objectId: act, label: `${status === 'ENABLED' ? 'Enable' : 'Disable'} alert subscription ${id}`, params: { status }, undoable: true, operation: 'alerts.status', via: { path: `${act}/subscriptions/${id}`, method: 'PATCH' } })],
    { action: 'status', id, status: live.status },
    { ...record(live.status), undo: live.status === 'ENABLED' || live.status === 'DISABLED' ? { action: live.status === 'ENABLED' ? 'enable' : 'disable', subscriptionId: id } : null, noUndo: live.status === 'ENABLED' || live.status === 'DISABLED' ? [] : ['Meta did not say the status it had, so there is no undo.'] },
    record(status),
  )
}

/** The draft of an alert subscription removed (its conditions kept for the undo, which makes it again). */
export function alertRemoveDraft(adAccountId: string, live: AlertSubscriptionState): MetaChangeDraft {
  const act = `act_${adAccountId}`
  const id = live.subscriptionId
  const spec = alertSpecOf(live)
  return draft(
    `Remove alert subscription ${id} of ad account ${adAccountId}${spec ? ` (when ${alertWords(spec)})` : ''}.`,
    [[`Alert subscription ${id}`, spec ? alertWords(spec) : 'exists', 'removed']],
    [request({ objectId: act, label: `Remove alert subscription ${id}`, params: {}, method: 'DELETE', undoable: !!spec, operation: 'alerts.remove', via: { path: `${act}/subscriptions/${id}` } })],
    { action: 'remove', id, eventType: live.eventType, field: live.field, operator: live.operator, value: live.value, filters: live.filters, status: live.status },
    { action: 'remove', subscriptionId: id, exists: true, spec, undo: spec ? { action: 'create', ...spec } : null, noUndo: spec ? [] : ['Nexus cannot write these conditions again the same way, so there is no undo.'] },
    { action: 'remove', subscriptionId: id, exists: false },
    { warnings: spec ? ['Its undo makes it again with the same conditions; Meta gives it a new id.'] : [] },
  )
}
