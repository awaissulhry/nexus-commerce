import { z } from 'zod'
import { ALERT_SEVERITIES, type AlertSeverity, type RuleKind } from '@nexus/factory-domain/alerts/kinds'
import { ALERT_RESOLUTIONS, ALERT_STATES, ALERT_TILES, ALERT_VERBS, type AlertTile } from '@nexus/factory-domain/alerts/rules'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of Home › Alerts (SCR-234) about the stored alerts (B-W2a-33's routes, + B-W2a-78's assignees), the answers
 * checked with zod (unknown fields dropped). The shapes mirror apps/factory-api platform/alerts/contract.ts. The API's
 * English (`sentence`, `kindLabel`, a rule's `sentence`) is never drawn: an alert is said from its phrase (`words`), in the
 * reader's language. People are office colleagues named inside one alert; no figure about a person exists.
 */

export type { AlertSeverity, AlertTile }

const person = z.object({ id: z.string(), name: z.string(), me: z.boolean() })
export type AlertPerson = z.infer<typeof person>
const record = z.object({ type: z.string(), id: z.string(), label: z.string() })

export const alertSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  ruleKind: z.string(),
  severity: z.enum(ALERT_SEVERITIES),
  state: z.enum(ALERT_STATES),
  record,
  companyId: z.string().nullable(),
  siteId: z.string().nullable(),
  partyId: z.string().nullable(),
  placeLabel: z.string().nullable().default(null),
  words: z.object({ key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])) }),
  facts: z.record(z.string(), z.unknown()),
  raisedAt: z.string(),
  occurrence: z.number(),
  ageDays: z.number(),
  acknowledged: z.object({ by: person, at: z.string() }).nullable(),
  assigned: z.object({ to: person, by: person, at: z.string() }).nullable(),
  snoozed: z.object({ until: z.string(), by: person, at: z.string(), now: z.boolean() }).nullable(),
  resolved: z.object({ at: z.string(), resolution: z.enum(ALERT_RESOLUTIONS), by: person.nullable(), note: z.string().nullable() }).nullable(),
  forMe: z.boolean(),
  verbs: z.array(z.enum(ALERT_VERBS)),
  version: z.number(),
})
export type AlertItem = z.infer<typeof alertSchema>

const tile = z.object({ tile: z.enum(ALERT_TILES), count: z.number(), complete: z.boolean() })
export type AlertTileCount = z.infer<typeof tile>

const listSchema = z.object({ asOf: z.string(), tiles: z.array(tile), total: z.number(), complete: z.boolean(), items: z.array(alertSchema), nextCursor: z.string().nullable() })
export type AlertList = z.infer<typeof listSchema>

export const HISTORY_VERBS = ['RAISED', 'ACKNOWLEDGED', 'ASSIGNED', 'UNASSIGNED', 'SNOOZED', 'RESOLVED'] as const
const historySchema = z.object({
  verb: z.enum(HISTORY_VERBS),
  at: z.string(),
  actor: person.nullable(),
  assignee: person.nullable(),
  snoozedUntil: z.string().nullable(),
  note: z.string().nullable(),
})
export type AlertHistoryEntry = z.infer<typeof historySchema>

const detailSchema = z.object({
  alert: alertSchema,
  rule: z.object({ id: z.string(), enabled: z.boolean(), threshold: z.record(z.string(), z.union([z.number(), z.boolean()])) }),
  history: z.array(historySchema),
  similar: z.array(z.object({ id: z.string(), record, severity: z.enum(ALERT_SEVERITIES), state: z.enum(ALERT_STATES), raisedAt: z.string() })),
})
export type AlertDetail = z.infer<typeof detailSchema>

/** The API's own filters, as the page's address holds them. */
export interface AlertQuery {
  tile?: AlertTile | null
  severity?: AlertSeverity | null
  ruleKind?: RuleKind | null
  q?: string
  cursor?: string | null
}

export function listAlerts(api: ApiClient, query: AlertQuery, signal?: AbortSignal): Promise<AlertList> {
  return api.get('/alerts', {
    query: { tile: query.tile ?? undefined, severity: query.severity ?? undefined, ruleKind: query.ruleKind ?? undefined, q: query.q?.trim() || undefined, cursor: query.cursor ?? undefined, limit: 50 },
    schema: listSchema,
    signal,
  })
}

export function getAlert(api: ApiClient, id: string, signal?: AbortSignal): Promise<AlertDetail> {
  return api.get(`/alerts/${encodeURIComponent(id)}`, { schema: detailSchema, signal })
}

const one = z.object({ alert: alertSchema })
const path = (id: string, verb: string) => `/alerts/${encodeURIComponent(id)}/${verb}`

/** OPEN → ACKNOWLEDGED (someone looked at it), with the version read. */
export async function acknowledgeAlert(api: ApiClient, alert: Pick<AlertItem, 'id' | 'version'>): Promise<AlertItem> {
  return (await api.post(path(alert.id, 'acknowledge'), { body: { version: alert.version }, schema: one, idempotencyKey: newIdempotencyKey() })).alert
}

/** The selection, all or none (at most 200). */
export async function bulkAcknowledge(api: ApiClient, alerts: readonly Pick<AlertItem, 'id' | 'version'>[]): Promise<AlertItem[]> {
  return (await api.post('/alerts/acknowledge', { body: { items: alerts.map((alert) => ({ id: alert.id, version: alert.version })) }, schema: z.object({ alerts: z.array(alertSchema) }), idempotencyKey: newIdempotencyKey() })).alerts
}

/** To a colleague who may handle it (they are told), or back to nobody (null). */
export async function assignAlert(api: ApiClient, alert: Pick<AlertItem, 'id' | 'version'>, assigneeId: string | null): Promise<AlertItem> {
  return (await api.post(path(alert.id, 'assign'), { body: { version: alert.version, assigneeId }, schema: one, idempotencyKey: newIdempotencyKey() })).alert
}

/** Off the lists and Today until then (at most 30 days); it comes back by itself. */
export async function snoozeAlert(api: ApiClient, alert: Pick<AlertItem, 'id' | 'version'>, until: string): Promise<AlertItem> {
  return (await api.post(path(alert.id, 'snooze'), { body: { version: alert.version, until }, schema: one, idempotencyKey: newIdempotencyKey() })).alert
}

/** Resolved, with a note saying what was done: it changes no more. */
export async function resolveAlert(api: ApiClient, alert: Pick<AlertItem, 'id' | 'version'>, note: string): Promise<AlertItem> {
  return (await api.post(path(alert.id, 'resolve'), { body: { version: alert.version, note: note.trim() }, schema: one, idempotencyKey: newIdempotencyKey() })).alert
}

/** Who the alert may be given to (B-W2a-78: the same check as the assign). */
export async function alertAssignees(api: ApiClient, id: string, signal?: AbortSignal): Promise<AlertPerson[]> {
  return (await api.get(path(id, 'assignees'), { schema: z.object({ people: z.array(person), complete: z.boolean() }), signal })).people
}
