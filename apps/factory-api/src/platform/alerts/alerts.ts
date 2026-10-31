import type { Prisma } from '@nexus/factory-db'
import { events as alertEvents } from '@nexus/factory-domain/alerts/events'
import { isRuleKind } from '@nexus/factory-domain/alerts/kinds'
import { ALERTS_HANDLE } from '@nexus/factory-domain/alerts/permissions'
import {
  ALERT_REFUSALS,
  ALERT_TILES,
  alertPhrase,
  isForMe,
  isRecipient,
  isSnoozedNow,
  kindLabel,
  phraseText,
  resolveNote,
  snoozeProblem,
  verbsOf,
  type AlertRefusal,
  type AlertTile,
  type HeldRole,
} from '@nexus/factory-domain/alerts/rules'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { serverClock } from '../../core/time'
import { heldRoles } from '../auth/roles/access'
import { ruleSentenceOf } from './rules'
import { ALERT_COLUMNS, heldOf, maySee, officeOf, peopleNames, placeNames, visibleWhere, type AlertRow, type Reader } from './store'

/**
 * Stored alerts (B-W2a-33; ANA-036; design home.alerts "Alerts" tiles, "Open alerts" with the popup alert): the list
 * with its tiles, one alert with its history and similar open alerts, and what people do about one — acknowledge, assign
 * (to a colleague who may handle it), snooze (at most 30 days), resolve with a note — and the bulk acknowledge of the
 * list's selection. Every change is ONE command with the alert's version (409 on a stale one), its history row with the
 * same actor and time (the database checks it at commit), its audit row and its event. Who sees an alert: alerts.view
 * and the record's own view permission over its place (./store.ts); who changes it: alerts.handle there too.
 */

const [, alertAcknowledged, alertAssigned, alertSnoozed, alertResolved] = alertEvents

/** The most alerts a list reads (in rank order) before it says it is not complete. */
export const READ_CAP = 1000
const ORDER: Prisma.AlertOrderByWithRelationInput[] = [{ severity: 'desc' }, { raisedAt: 'asc' }, { id: 'asc' }]
const DAY_MS = 86_400_000

export const LIVE_EVENTS = ['alert.raised', 'alert.acknowledged', 'alert.assigned', 'alert.snoozed', 'alert.resolved', 'alert.rule_changed'] as const


const refused = (code: AlertRefusal, path = `alert/${code}`): DomainError => new DomainError('conflict', ALERT_REFUSALS[code], [{ path, message: ALERT_REFUSALS[code] }])

// ---- the answer ------------------------------------------------------------------------------------------------------------

interface ViewContext {
  readonly actor: Actor
  readonly me: string
  readonly now: Date
  readonly held: readonly HeldRole[]
  readonly names: ReadonlyMap<string, string>
  /** B-W2a-78: the names of the alerts' sites and companies (the list's "Site" column). */
  readonly places?: Awaited<ReturnType<typeof placeNames>>
}

const scopeOf = (row: Pick<AlertRow, 'companyId' | 'siteId' | 'partyId'>) => ({ companyId: row.companyId, siteId: row.siteId, partyId: row.partyId })

export function alertView(row: AlertRow, context: ViewContext) {
  const person = (id: string | null) => (id ? { id, name: context.names.get(id) ?? '', me: id === context.me } : null)
  const phrase = alertPhrase(row.ruleKind, row.recordLabel, row.facts)
  const recipient = isRecipient(context.held, row.rule.recipientRoleId, scopeOf(row))
  const mayHandle = maySee(context.actor, row, ALERTS_HANDLE)
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleKind: row.ruleKind,
    ruleName: row.rule.name,
    kindLabel: isRuleKind(row.ruleKind) ? kindLabel(row.ruleKind) : row.ruleKind,
    severity: row.severity,
    state: row.state,
    record: { type: row.recordType, id: row.recordId, label: row.recordLabel },
    companyId: row.companyId,
    siteId: row.siteId,
    partyId: row.partyId,
    placeLabel: (row.siteId ? context.places?.sites.get(row.siteId) : undefined) ?? (row.companyId ? context.places?.companies.get(row.companyId) : undefined) ?? null,
    sentence: phraseText(phrase, row.recordLabel, 'en'),
    words: phrase ? { key: phrase.key, params: { ...phrase.params } } : { key: 'alerts.UNKNOWN', params: { label: row.recordLabel } },
    facts: (row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts) ? row.facts : {}) as Record<string, unknown>,
    raisedAt: toUtcIso(row.raisedAt),
    occurrence: row.occurrence,
    ageDays: Math.max(0, Math.floor((context.now.getTime() - row.raisedAt.getTime()) / DAY_MS)),
    acknowledged: row.acknowledgedAt && row.acknowledgedById ? { by: person(row.acknowledgedById)!, at: toUtcIso(row.acknowledgedAt) } : null,
    assigned: row.assignedToId && row.assignedById && row.assignedAt ? { to: person(row.assignedToId)!, by: person(row.assignedById)!, at: toUtcIso(row.assignedAt) } : null,
    snoozed: row.snoozedUntil && row.snoozedById && row.snoozedAt ? { until: toUtcIso(row.snoozedUntil), by: person(row.snoozedById)!, at: toUtcIso(row.snoozedAt), now: isSnoozedNow(row, context.now) } : null,
    resolved: row.resolvedAt && row.resolution ? { at: toUtcIso(row.resolvedAt), resolution: row.resolution, by: person(row.resolvedById), note: row.resolveNote } : null,
    forMe: isForMe(row, context.me, recipient, context.now),
    verbs: verbsOf(row, mayHandle),
    version: row.version,
  }
}

const peopleOf = (rows: readonly AlertRow[]): (string | null)[] => rows.flatMap((row) => [row.acknowledgedById, row.assignedToId, row.assignedById, row.snoozedById, row.resolvedById])

async function viewContextOf(db: Reader, context: OfficeContext, rows: readonly AlertRow[], now: Date, extraPeople: readonly (string | null)[] = []): Promise<ViewContext> {
  const places = await placeNames(db, rows.map((row) => ({ companyId: row.companyId, siteId: row.siteId, recipientRoleId: null })))
  return { actor: actorOf(context), me: context.actorId, now, held: await heldOf(db, context.actorId, now), names: await peopleNames(db, [...peopleOf(rows), ...extraPeople]), places }
}

// ---- the list ------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly tile?: AlertTile | undefined
  readonly state?: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'UNRESOLVED' | 'ALL' | undefined
  readonly severity?: 'INFO' | 'WARNING' | 'CRITICAL' | undefined
  readonly ruleKind?: string | undefined
  readonly ruleId?: string | undefined
  readonly recordType?: string | undefined
  readonly recordId?: string | undefined
  readonly snoozed?: 'true' | 'false' | undefined
  readonly q?: string | undefined
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The company and site filters: a company's alerts and the tenant-wide ones; a site's, and its company's of no site. */
async function scopeFilter(db: Reader, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }): Promise<Prisma.AlertWhereInput> {
  const parts: Prisma.AlertWhereInput[] = []
  if (query.companyId) parts.push({ OR: [{ companyId: query.companyId }, { companyId: null }] })
  if (query.siteId) {
    const site = await db.site.findUnique({ where: { id: query.siteId }, select: { id: true, companyId: true } })
    if (!site) throw new NotFoundError('Site not found.')
    parts.push({ OR: [{ siteId: site.id }, { siteId: null, OR: [{ companyId: site.companyId }, { companyId: null }] }] })
  }
  return { AND: parts }
}

const UNRESOLVED: Prisma.AlertWhereInput = { state: { not: 'RESOLVED' } }
const awakeAt = (now: Date): Prisma.AlertWhereInput => ({ OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] })

/** The where of a tile (OPEN_FOR_ME is narrowed further in memory: the recipient's place). */
function tileWhere(tile: AlertTile, me: string, held: readonly HeldRole[], now: Date): Prisma.AlertWhereInput {
  switch (tile) {
    case 'OPEN_FOR_ME':
      return { AND: [UNRESOLVED, awakeAt(now), { OR: [{ assignedToId: me }, { assignedToId: null, rule: { recipientRoleId: { in: [...new Set(held.map((role) => role.roleId))] } } }] }] }
    case 'CRITICAL':
      return { AND: [UNRESOLVED, awakeAt(now), { severity: 'CRITICAL' }] }
    case 'UNASSIGNED':
      return { AND: [UNRESOLVED, awakeAt(now), { assignedToId: null }] }
    case 'ACKNOWLEDGED':
      return { AND: [{ state: 'ACKNOWLEDGED' }, awakeAt(now)] }
    case 'RESOLVED_TODAY':
      return { AND: [{ state: 'RESOLVED' }, { resolvedAt: { gte: businessDayStart(businessDate(now)) } }] }
  }
}

const mineOnly = (rows: readonly AlertRow[], me: string, held: readonly HeldRole[], now: Date): AlertRow[] => rows.filter((row) => isForMe(row, me, isRecipient(held, row.rule.recipientRoleId, scopeOf(row)), now))

async function tilesOf(db: Reader, base: Prisma.AlertWhereInput, me: string, held: readonly HeldRole[], now: Date) {
  const tiles: { tile: AlertTile; count: number; complete: boolean }[] = []
  for (const tile of ALERT_TILES) {
    if (tile === 'OPEN_FOR_ME') {
      const rows = await db.alert.findMany({ where: { AND: [base, tileWhere(tile, me, held, now)] }, take: READ_CAP + 1, select: ALERT_COLUMNS })
      tiles.push({ tile, count: mineOnly(rows.slice(0, READ_CAP), me, held, now).length, complete: rows.length <= READ_CAP })
    } else {
      tiles.push({ tile, count: await db.alert.count({ where: { AND: [base, tileWhere(tile, me, held, now)] } }), complete: true })
    }
  }
  return tiles
}

/** GET /alerts: the open alerts (or a tile, a state, a record's), ranked: critical first, then the oldest. */
export async function listAlerts(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const held = await heldOf(db, context.actorId, now)
    const base: Prisma.AlertWhereInput = { AND: [visibleWhere(actor), await scopeFilter(db, query)] }
    const state = query.state ?? 'UNRESOLVED'
    const filters: Prisma.AlertWhereInput[] = [
      query.tile ? tileWhere(query.tile, context.actorId, held, now) : state === 'UNRESOLVED' ? UNRESOLVED : state === 'ALL' ? {} : { state },
      query.tile || query.snoozed === 'true' || state === 'RESOLVED' ? {} : awakeAt(now),
      query.severity ? { severity: query.severity } : {},
      query.ruleKind ? { ruleKind: query.ruleKind } : {},
      query.ruleId ? { ruleId: query.ruleId } : {},
      query.recordType ? { recordType: query.recordType } : {},
      query.recordId ? { recordId: query.recordId } : {},
      query.q ? { recordLabel: { contains: query.q.trim(), mode: 'insensitive' } } : {},
    ]
    const found = await db.alert.findMany({ where: { AND: [base, ...filters] }, orderBy: ORDER, take: READ_CAP + 1, select: ALERT_COLUMNS })
    const complete = found.length <= READ_CAP
    const rows = query.tile === 'OPEN_FOR_ME' ? mineOnly(found.slice(0, READ_CAP), context.actorId, held, now) : found.slice(0, READ_CAP)
    const start = query.cursor ? rows.findIndex((row) => row.id === query.cursor) + 1 : 0
    if (query.cursor && start === 0) throw new ValidationError('The cursor is not one this list gave.', [{ path: 'cursor', message: 'Not a cursor of this list.' }])
    const page = rows.slice(start, start + query.limit)
    const view = await viewContextOf(db, context, page, now)
    return {
      asOf: toUtcIso(now),
      tiles: await tilesOf(db, base, context.actorId, held, now),
      total: rows.length,
      complete,
      items: page.map((row) => alertView(row, view)),
      nextCursor: start + query.limit < rows.length && page.length > 0 ? page[page.length - 1]!.id : null,
      live: { events: [...LIVE_EVENTS] },
    }
  })
}

/** GET /alerts/counts: the tiles only (the Today strip, the rail badge). */
export async function alertCounts(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const held = await heldOf(db, context.actorId, now)
    const base: Prisma.AlertWhereInput = { AND: [visibleWhere(actorOf(context)), await scopeFilter(db, query)] }
    return { asOf: toUtcIso(now), tiles: await tilesOf(db, base, context.actorId, held, now) }
  })
}

/** GET /alerts/:id: what, why, the record, its history and the open alerts of the same kind elsewhere. */
export async function getAlert(caller: CommandCaller, id: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const row = await db.alert.findFirst({ where: { AND: [{ id }, visibleWhere(actor)] }, select: ALERT_COLUMNS })
    if (!row) throw new NotFoundError('Alert not found.')
    const history = await db.alertEvent.findMany({ where: { alertId: id }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { verb: true, at: true, actorId: true, assigneeId: true, snoozedUntil: true, note: true, facts: true } })
    const similar = await db.alert.findMany({ where: { AND: [visibleWhere(actor), UNRESOLVED, { ruleKind: row.ruleKind, id: { not: id } }] }, orderBy: ORDER, take: 5, select: { id: true, recordType: true, recordId: true, recordLabel: true, severity: true, state: true, raisedAt: true } })
    const rule = await db.alertRule.findUniqueOrThrow({ where: { id: row.ruleId }, select: { id: true, name: true, enabled: true, threshold: true, ruleKind: true, channels: true, cooldownMinutes: true, companyId: true, siteId: true, recipientRoleId: true } })
    const view = await viewContextOf(db, context, [row], now, history.flatMap((entry) => [entry.actorId, entry.assigneeId]))
    const person = (personId: string | null) => (personId ? { id: personId, name: view.names.get(personId) ?? '', me: personId === context.actorId } : null)
    return {
      alert: alertView(row, view),
      rule: { id: rule.id, name: rule.name, sentence: isRuleKind(rule.ruleKind) ? (await ruleSentenceOf(db, rule)).en : rule.name, enabled: rule.enabled, threshold: (rule.threshold ?? {}) as Record<string, number | boolean> },
      history: history.map((entry) => ({
        verb: entry.verb,
        at: toUtcIso(entry.at),
        actor: person(entry.actorId),
        assignee: person(entry.assigneeId),
        snoozedUntil: entry.snoozedUntil ? toUtcIso(entry.snoozedUntil) : null,
        note: entry.note,
        facts: entry.facts && typeof entry.facts === 'object' && !Array.isArray(entry.facts) ? (entry.facts as Record<string, unknown>) : null,
      })),
      similar: similar.map((other) => ({ id: other.id, record: { type: other.recordType, id: other.recordId, label: other.recordLabel }, severity: other.severity, state: other.state, raisedAt: toUtcIso(other.raisedAt) })),
    }
  })
}

// ---- what people do --------------------------------------------------------------------------------------------------------

async function lockForChange(tools: CommandTools, context: OfficeContext, id: string, version: number, path = 'alert'): Promise<AlertRow> {
  await tools.tx.$queryRaw`SELECT id FROM "Alert" WHERE id = ${id}::uuid FOR UPDATE`
  const row = await tools.tx.alert.findUnique({ where: { id }, select: ALERT_COLUMNS })
  const actor = actorOf(context)
  if (!row || !maySee(actor, row)) throw new NotFoundError('Alert not found.')
  if (!maySee(actor, row, ALERTS_HANDLE)) throw new ForbiddenError('You may see this alert but not handle it.')
  if (row.version !== version) throw new StaleVersionError('Alert', id, row.version, version)
  if (row.state === 'RESOLVED') throw refused('RESOLVED', path === 'alert' ? 'alert/RESOLVED' : `${path}/RESOLVED`)
  return row
}

/** The change of one alert: its columns and a version bump, compare-and-set on the version read. */
async function writeAlert(tx: CommandTx, row: AlertRow, data: Prisma.AlertUncheckedUpdateManyInput, now: Date): Promise<AlertRow> {
  const { count } = await tx.alert.updateMany({ where: { id: row.id, version: row.version }, data: { ...(data as Prisma.AlertUpdateManyMutationInput), version: row.version + 1, updatedAt: now } })
  if (count === 0) throw new StaleVersionError('Alert', row.id, row.version + 1, row.version)
  return tx.alert.findUniqueOrThrow({ where: { id: row.id }, select: ALERT_COLUMNS })
}

async function history(tools: CommandTools, alertId: string, data: Omit<Prisma.AlertEventUncheckedCreateInput, 'id' | 'alertId' | 'at' | 'requestId' | 'createdAt'>): Promise<void> {
  await tools.tx.alertEvent.create({ data: { id: newId(), alertId, ...data, at: tools.now, requestId: tools.context.requestId, createdAt: tools.now }, select: { id: true } })
}

const about = (row: AlertRow) => ({ alertId: row.id, ruleKind: row.ruleKind, recordType: row.recordType, recordId: row.recordId })
const placeOf = (row: AlertRow) => ({ subject: row.id, companyId: row.companyId, siteId: row.siteId })

async function answer(tools: CommandTools, context: OfficeContext, row: AlertRow) {
  return { alert: alertView(row, await viewContextOf(tools.tx, context, [row], tools.now)) }
}

async function acknowledgeInCommand(tools: CommandTools, context: OfficeContext, row: AlertRow, path = 'alert'): Promise<AlertRow> {
  if (row.state !== 'OPEN') throw refused('ALREADY_ACKNOWLEDGED', `${path}/ALREADY_ACKNOWLEDGED`)
  await history(tools, row.id, { verb: 'ACKNOWLEDGED', actorId: context.actorId })
  const next = await writeAlert(tools.tx, row, { state: 'ACKNOWLEDGED', acknowledgedAt: tools.now, acknowledgedById: context.actorId }, tools.now)
  tools.audit({ action: 'alerts.acknowledge', recordType: 'Alert', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { state: row.state }, after: { state: next.state } })
  tools.emit(eventFor(alertAcknowledged, { ...placeOf(row), payload: about(row) }))
  return next
}

/** POST /alerts/:id/acknowledge: someone looked at it (OPEN → ACKNOWLEDGED). */
export async function acknowledgeAlert(caller: CommandCaller, id: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'alerts.acknowledge', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const row = await lockForChange(tools, context, id, body.version)
    return answer(tools, context, await acknowledgeInCommand(tools, context, row))
  })
  return result
}

/** Whether this person may be given the alert: ACTIVE, and may see and handle it (their live roles, at its place). */
async function mayBeGiven(tx: Reader, tenantId: string, userId: string, row: AlertRow, now: Date): Promise<boolean> {
  const user = await tx.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } })
  if (!user) return false
  const actor: Actor = { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(tx, userId, now), true) }
  return maySee(actor, row, ALERTS_HANDLE)
}
const ASSIGNEE_REFUSED = 'This person may not be given the alert: they cannot see its record or handle alerts there.'

/** The most people GET /alerts/:id/assignees reads (by name). */
export const ASSIGNABLE_MAX = 500

/**
 * GET /alerts/:id/assignees (B-W2a-78, the popup's Assign): the ACTIVE people the alert may be given to — the same check
 * as the assign itself (`mayBeGiven`: they see its record and handle alerts at its place). The reader must handle it
 * there too. Names only, by name; nobody is counted.
 */
export async function alertAssignees(caller: CommandCaller, id: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const row = await db.alert.findFirst({ where: { AND: [{ id }, visibleWhere(actor)] }, select: ALERT_COLUMNS })
    if (!row) throw new NotFoundError('Alert not found.')
    if (!maySee(actor, row, ALERTS_HANDLE)) throw new ForbiddenError('You may see this alert but not handle it.')
    const users = await db.user.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: ASSIGNABLE_MAX, select: { id: true, displayName: true } })
    const people: { id: string; name: string; me: boolean }[] = []
    for (const user of users) if (await mayBeGiven(db, context.tenantId, user.id, row, now)) people.push({ id: user.id, name: user.displayName, me: user.id === context.actorId })
    return { people, complete: users.length < ASSIGNABLE_MAX }
  })
}

/** POST /alerts/:id/assign: to a colleague who may handle it (they are told), or back to nobody (null). */
export async function assignAlert(caller: CommandCaller, id: string, body: { readonly version: number; readonly assigneeId: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'alerts.assign', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockForChange(tools, context, id, body.version)
    const to = body.assigneeId
    if (to === null && row.assignedToId === null) throw refused('NOT_ASSIGNED')
    if (to !== null && to === row.assignedToId) throw refused('ALREADY_ASSIGNED')
    if (to !== null && !(await mayBeGiven(tx, context.tenantId, to, row, now))) throw new ValidationError(ASSIGNEE_REFUSED, [{ path: 'body/assigneeId', message: ASSIGNEE_REFUSED }])
    if (row.assignedToId !== null) await history(tools, row.id, { verb: 'UNASSIGNED', actorId: context.actorId, assigneeId: row.assignedToId })
    if (to !== null) await history(tools, row.id, { verb: 'ASSIGNED', actorId: context.actorId, assigneeId: to })
    const next = await writeAlert(tx, row, to === null ? { assignedToId: null, assignedById: null, assignedAt: null } : { assignedToId: to, assignedById: context.actorId, assignedAt: now }, now)
    tools.audit({ action: 'alerts.assign', recordType: 'Alert', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { assignedToId: row.assignedToId }, after: { assignedToId: to } })
    tools.emit(eventFor(alertAssigned, { ...placeOf(row), payload: { ...about(row), assigneeId: to, assignedById: context.actorId } }))
    return answer(tools, context, next)
  })
  return result
}

/** POST /alerts/:id/snooze: off the lists and Today until a time (at most 30 days); it comes back by itself. */
export async function snoozeAlert(caller: CommandCaller, id: string, body: { readonly version: number; readonly until: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'alerts.snooze', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockForChange(tools, context, id, body.version)
    const until = new Date(body.until)
    const problem = snoozeProblem(until, now)
    if (problem) throw new ValidationError(problem, [{ path: 'body/until', message: problem }])
    await history(tools, row.id, { verb: 'SNOOZED', actorId: context.actorId, snoozedUntil: until })
    const next = await writeAlert(tx, row, { snoozedUntil: until, snoozedById: context.actorId, snoozedAt: now }, now)
    tools.audit({ action: 'alerts.snooze', recordType: 'Alert', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { snoozedUntil: row.snoozedUntil ? toUtcIso(row.snoozedUntil) : null }, after: { snoozedUntil: toUtcIso(until) } })
    tools.emit(eventFor(alertSnoozed, { ...placeOf(row), payload: { ...about(row), snoozedUntil: toUtcIso(until) } }))
    return answer(tools, context, next)
  })
  return result
}

/** POST /alerts/:id/resolve: done, with a note saying what was done (HANDLED). It changes no more. */
export async function resolveAlert(caller: CommandCaller, id: string, body: { readonly version: number; readonly note: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const cleaned = resolveNote(body.note)
  if ('problem' in cleaned) throw new ValidationError(cleaned.problem, [{ path: 'body/note', message: cleaned.problem }])
  const { result } = await command(caller, { name: 'alerts.resolve', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockForChange(tools, context, id, body.version)
    await history(tools, row.id, { verb: 'RESOLVED', actorId: context.actorId, note: cleaned.note })
    const next = await writeAlert(tx, row, { state: 'RESOLVED', resolvedAt: now, resolution: 'HANDLED', resolvedById: context.actorId, resolveNote: cleaned.note }, now)
    tools.audit({ action: 'alerts.resolve', recordType: 'Alert', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { state: row.state }, after: { state: 'RESOLVED', resolution: 'HANDLED' } })
    tools.emit(eventFor(alertResolved, { ...placeOf(row), payload: { ...about(row), resolution: 'HANDLED' } }))
    return answer(tools, context, next)
  })
  return result
}

/** POST /alerts/acknowledge: the list's selection, in ONE command (all or none; 409 names the item: body/items/<i>). */
export async function bulkAcknowledge(caller: CommandCaller, body: { readonly items: readonly { readonly id: string; readonly version: number }[] }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const ids = body.items.map((item) => item.id)
  if (new Set(ids).size !== ids.length) throw new ValidationError('An alert is listed twice.', [{ path: 'body/items', message: 'Each alert once.' }])
  const { result } = await command(caller, { name: 'alerts.acknowledgeBulk', idempotencyKey, input: body }, async (tools) => {
    const done: AlertRow[] = []
    for (const [index, item] of body.items.entries()) {
      const path = `body/items/${index}`
      let row: AlertRow
      try {
        row = await lockForChange(tools, context, item.id, item.version, path)
      } catch (error) {
        if (error instanceof DomainError && error.code !== 'conflict') throw new DomainError(error.code, error.message, [{ path, message: error.message }])
        if (error instanceof StaleVersionError) throw new DomainError('conflict', error.message, [{ path: `${path}/version`, message: error.message }])
        throw error
      }
      done.push(await acknowledgeInCommand(tools, context, row, path))
    }
    const view = await viewContextOf(tools.tx, context, done, tools.now)
    return { alerts: done.map((row) => alertView(row, view)) }
  })
  return result
}
