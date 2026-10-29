import type { FactoryClient } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, holds, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDayRange, toUtcIso } from '@nexus/factory-domain/core/time'
import {
  ACTION_REFUSALS,
  actionRefusal,
  parseRowKey,
  resolveNoteProblem,
  responsibleFor,
  rowActionsOf,
  takesActions,
  type ActionRefusal,
  type ActionVerb,
  type RowActions,
} from '@nexus/factory-domain/insights/actions'
import { actingPermission, attentionFor, isAttentionKind, rowKeyOf, sourcesFor, type AttentionCandidate, type AttentionItem, type Viewer } from '@nexus/factory-domain/insights/attention'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../core/command'
import type { OfficeContext } from '../../core/context'
import { heldRoles } from '../../platform/auth/roles/access'
import { countHandled, lockAction, peopleNames, readAction, readHandled, writeAction, writeLog, type ActionChange, type ActionIdentity, type ActionRow, type LogEntry } from './actions-store'
import { SOURCES } from './sources'
import { officeContextOf, viewerOf } from './viewer'

/**
 * Acting on Today's alerts (B-W1-52 actions; ANA-037; design home.today needs-me "alert → Acknowledge · Assign ·
 * Resolve", "Handled today", popups assign and resolve-note): POST /home/today/rows/:key/assign | resolve | acknowledge,
 * GET …/assignees, GET /home/today/handled. Rules: factory-domain insights/actions; storage: actions-store.ts.
 *
 * A person acts only on a row of their OWN Today, as the list computes it now: the row's kind's source is read for them
 * and the row must be one they may act on (actingPermission: the record's view and act permissions over its company,
 * site and party, four eyes, the decision's grain); anything else is ONE 404, whatever the reason (the row was handled
 * meanwhile, or it is not theirs to see). A row is assigned only to an ACTIVE person for whom the same rule holds (and
 * who reaches Today). Every action sends the row's condition and the stored version it read: a row whose condition
 * changed, or that someone acted on meanwhile, is a 409. Each action is ONE command: the action row, its history row,
 * audit rows on the action and on the row's record (its timeline), and the event `attention.<verb>`.
 */

const NOT_ON_TODAY = 'This row is not on your Today: it was handled meanwhile, or it is not yours to act on.'

/** A 409 with the refusal's code in the issue path (`action/<CODE>`) and its words. */
const refused = (refusal: ActionRefusal): DomainError => new DomainError('conflict', ACTION_REFUSALS[refusal], [{ path: `action/${refusal}`, message: ACTION_REFUSALS[refusal] }])
/** The most people the assignee list reads (a tenant's office staff). */
export const MAX_ASSIGNABLE = 500

/** The row of the viewer's Today with this key, as it is now, with the candidate it came from. */
export async function rowFor(caller: CommandCaller, viewer: Viewer, key: string): Promise<{ readonly candidate: AttentionCandidate; readonly item: AttentionItem }> {
  const parsed = parseRowKey(key)
  if (!parsed || !sourcesFor(viewer.actor).includes(parsed.kind)) throw new NotFoundError(NOT_ON_TODAY)
  const answer = await SOURCES[parsed.kind]({ caller, viewer })
  const candidate = answer.candidates.find((entry) => rowKeyOf(entry) === key)
  const item = candidate ? attentionFor(viewer, [candidate])[0] : undefined
  if (!candidate || !item) throw new NotFoundError(NOT_ON_TODAY)
  return { candidate, item }
}

/** A person as Today's rules see them: their live office roles (two-factor taken as proved: they prove it to sign in). */
async function personViewer(db: FactoryClient | CommandTx, context: OfficeContext, viewer: Viewer, userId: string): Promise<Viewer> {
  const actor: Actor = { audience: 'office', tenantId: context.tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(db, userId, viewer.now), true) }
  return { actor, personId: userId, today: viewer.today, now: viewer.now }
}

/** Whether this person may act on the row (and reaches Today to see it). */
const mayAct = (person: Viewer, candidate: AttentionCandidate): boolean => holds(person.actor, HOME_VIEW) && actingPermission(person, candidate) !== null

/** GET /home/today/rows/:key/assignees: the ACTIVE people the row may be assigned to, the responsible ones first. */
export async function assignees(caller: CommandCaller, key: string) {
  const context = officeContextOf(caller)
  const viewer = viewerOf(caller)
  const { candidate, item } = await rowFor(caller, viewer, key)
  if (!takesActions(item)) throw refused('NOT_AN_ALERT')
  return caller.withClient(async (db) => {
    const stored = await readAction(db, key)
    const users = await db.user.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: MAX_ASSIGNABLE, select: { id: true, displayName: true } })
    const people: Array<{ id: string; name: string; me: boolean; suggested: boolean; assigned: boolean }> = []
    for (const user of users) {
      const person = await personViewer(db, context, viewer, user.id)
      if (!mayAct(person, candidate)) continue
      const acting = actingPermission(person, candidate)
      people.push({
        id: user.id,
        name: user.displayName,
        me: user.id === context.actorId,
        suggested: acting !== null && responsibleFor(person.actor, acting, candidate.scope),
        assigned: stored?.assignedToId === user.id,
      })
    }
    people.sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    return { key, condition: item.condition, people }
  })
}

export interface ActionBody {
  readonly condition: string
  readonly version: number
  readonly assigneeId?: string | null | undefined
  readonly note?: string | undefined
}

const NAMES: Readonly<Record<ActionVerb, 'insights.assignRow' | 'insights.resolveRow' | 'insights.acknowledgeRow'>> = Object.freeze({ ASSIGN: 'insights.assignRow', RESOLVE: 'insights.resolveRow', ACKNOWLEDGE: 'insights.acknowledgeRow' })

/** A row's actions as the answer carries them: people by name, `me` for the reader. */
export function actionsView(actions: RowActions, names: ReadonlyMap<string, string>, me: string) {
  const person = (id: string) => ({ id, name: names.get(id) ?? '', me: id === me })
  return {
    version: actions.version,
    verbs: [...actions.verbs],
    assigned: actions.assigned ? { to: person(actions.assigned.toId), by: person(actions.assigned.byId), at: toUtcIso(actions.assigned.at) } : null,
    acknowledged: actions.acknowledged ? { by: person(actions.acknowledged.byId), at: toUtcIso(actions.acknowledged.at) } : null,
  }
}

const auditView = (row: ActionRow | null) =>
  row && {
    assignedToId: row.assignedToId,
    resolvedCondition: row.resolvedCondition,
    acknowledgedCondition: row.acknowledgedCondition,
  }

/** POST /home/today/rows/:key/assign | resolve | acknowledge. */
export async function actOnRow(caller: CommandCaller, key: string, verb: ActionVerb, body: ActionBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const viewer = viewerOf(caller)
  const { candidate, item } = await rowFor(caller, viewer, key)

  let note: string | null = null
  if (verb === 'RESOLVE') {
    const problem = resolveNoteProblem(body.note ?? '')
    if (problem !== null) throw new ValidationError(problem, [{ path: 'body/note', message: problem }])
    note = (body.note ?? '').trim()
  }
  const assigneeId = verb === 'ASSIGN' ? (body.assigneeId ?? null) : null
  if (verb === 'ASSIGN' && assigneeId !== null) {
    const allowed = await caller.withClient(async (db) => {
      const user = await db.user.findFirst({ where: { id: assigneeId, status: 'ACTIVE' }, select: { id: true } })
      return user !== null && mayAct(await personViewer(db, context, viewer, user.id), candidate)
    })
    if (!allowed) {
      const message = 'This person may not act on this row: they cannot see its record here, may not act on it, or four eyes keep them from it.'
      throw new ValidationError(message, [{ path: 'body/assigneeId', message }])
    }
  }

  const identity: ActionIdentity = {
    rowKey: key,
    kind: item.kind,
    recordType: item.record.type,
    recordId: item.record.id,
    subKey: candidate.subKey ?? null,
    companyId: item.companyId,
    siteId: item.siteId,
    partyId: item.partyId,
  }
  const name = NAMES[verb]
  // What is stored is read and checked INSIDE the command (after its receipt: a repeated Idempotency-Key answers the
  // first answer), under the action's row lock; the version the caller read is the compare-and-set.
  const { result } = await command(caller, { name, idempotencyKey, input: { key, verb, ...body } }, async (tools) => {
    const { tx, now } = tools
    const existing = await lockAction(tx, key)
    const refusal = actionRefusal(verb, item, existing ?? undefined, { condition: body.condition, assigneeId })
    if (refusal !== null) throw refused(refusal)
    if ((existing?.version ?? 0) !== body.version) throw new StaleVersionError('AttentionAction', existing?.id ?? key, existing?.version ?? 0, body.version)

    const base = { condition: item.condition, recordLabel: item.record.label, actorId: context.actorId, at: now, requestId: context.requestId }
    let change: ActionChange
    let entry: LogEntry
    if (verb === 'ASSIGN') {
      change = assigneeId === null ? { assignedToId: null, assignedById: null, assignedAt: null } : { assignedToId: assigneeId, assignedById: context.actorId, assignedAt: now }
      entry = { ...base, verb: assigneeId === null ? 'UNASSIGNED' : 'ASSIGNED', assigneeId: assigneeId ?? existing!.assignedToId, note: null }
    } else if (verb === 'RESOLVE') {
      // Resolved, it leaves Today for everyone; it comes back, unassigned, when its condition changes.
      change = { resolvedCondition: item.condition, resolveNote: note, resolvedById: context.actorId, resolvedAt: now, assignedToId: null, assignedById: null, assignedAt: null }
      entry = { ...base, verb: 'RESOLVED', assigneeId: null, note }
    } else {
      change = { acknowledgedCondition: item.condition, acknowledgedById: context.actorId, acknowledgedAt: now }
      entry = { ...base, verb: 'ACKNOWLEDGED', assigneeId: null, note: null }
    }
    const row = await writeAction(tx, existing, identity, change, { id: newId(), actorId: context.actorId, now })
    await writeLog(tx, row.id, identity, entry, newId())
    const after = { key, verb: entry.verb, condition: item.condition, ...(entry.assigneeId ? { assigneeId: entry.assigneeId } : {}), ...(note ? { note } : {}) }
    tools.audit({ recordType: 'AttentionAction', recordId: row.id, companyId: item.companyId, siteId: item.siteId, ...(existing ? { before: auditView(existing) } : {}), after, ...(note ? { reason: note } : {}) })
    // The row's record keeps it on its timeline (the resolve note says what was done about it).
    tools.audit({ recordType: item.record.type, recordId: item.record.id, companyId: item.companyId, siteId: item.siteId, after, ...(note ? { reason: note } : {}) })
    const event = { subject: row.id, companyId: item.companyId, siteId: item.siteId }
    const payload = { actionId: row.id, key, kind: item.kind, recordType: item.record.type, recordId: item.record.id, condition: item.condition }
    if (verb === 'ASSIGN') tools.emit({ type: 'attention.assigned', ...event, payload: { ...payload, assigneeId } })
    else if (verb === 'RESOLVE') tools.emit({ type: 'attention.resolved', ...event, payload })
    else tools.emit({ type: 'attention.acknowledged', ...event, payload })
    const names = await peopleNames(tx, [row.assignedToId, row.assignedById, row.acknowledgedById])
    return { key, condition: item.condition, resolved: verb === 'RESOLVE', actions: actionsView(rowActionsOf(item, row), names, context.actorId) }
  }).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('Someone acted on this row at the same moment. Read Today again.')
    throw error
  })
  return result
}

// ---- Handled today ----------------------------------------------------------------------------------------------------

/** The most rows "Handled today" lists. */
export const HANDLED_LIMIT = 200

/** What the viewer decided today: the quote approvals they decided (Today decides them in place) and Today's verbs. */
async function quoteDecisions(caller: CommandCaller, viewer: Viewer, range: { start: Date; end: Date }) {
  if (!holds(viewer.actor, QUOTES_VIEW)) return []
  const rows = await caller.withClient((db) =>
    db.quoteApproval.findMany({
      where: { decidedById: viewer.personId, decidedAt: { gte: range.start, lt: range.end }, status: { in: ['APPROVED', 'REJECTED'] } },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: HANDLED_LIMIT,
      select: { id: true, status: true, decidedAt: true, decisionNote: true, quoteVersion: { select: { quote: { select: { id: true, number: true, companyId: true, partyId: true } } } } },
    }),
  )
  return rows.filter((row) => can(viewer.actor, QUOTES_VIEW, { companyId: row.quoteVersion.quote.companyId, partyId: row.quoteVersion.quote.partyId }))
}

/** "Handled today: N" (the footer of Needs me now). */
export async function handledCount(caller: CommandCaller, viewer: Viewer): Promise<number> {
  const range = businessDayRange(viewer.today)
  const verbs = await caller.withClient((db) => countHandled(db, viewer.personId, range.start, range.end))
  return verbs + (await quoteDecisions(caller, viewer, range)).length
}

/** GET /home/today/handled: what I decided today, newest first, for my own record. */
export async function handledToday(caller: CommandCaller) {
  const viewer = viewerOf(caller)
  const range = businessDayRange(viewer.today)
  const logged = await caller.withClient((db) => readHandled(db, viewer.personId, range.start, range.end, HANDLED_LIMIT))
  const quotes = await quoteDecisions(caller, viewer, range)
  const names = await caller.withClient((db) => peopleNames(db, logged.map((row) => row.assigneeId)))
  const count = (await caller.withClient((db) => countHandled(db, viewer.personId, range.start, range.end))) + quotes.length
  const items = [
    ...logged.flatMap((row) => (isAttentionKind(row.kind) ? [{ ...row, kind: row.kind }] : [])).map((row) => ({
      at: row.at,
      verb: row.verb,
      kind: row.kind,
      key: row.rowKey as string | null,
      record: { type: row.recordType, id: row.recordId, label: row.recordLabel },
      companyId: row.companyId,
      note: row.note,
      assignee: row.assigneeId ? { id: row.assigneeId, name: names.get(row.assigneeId) ?? '' } : null,
    })),
    ...quotes.map((row) => ({
      at: row.decidedAt!,
      verb: row.status as 'APPROVED' | 'REJECTED',
      kind: 'QUOTE_APPROVAL' as const,
      key: null,
      record: { type: 'Quote', id: row.quoteVersion.quote.id, label: row.quoteVersion.quote.number },
      companyId: row.quoteVersion.quote.companyId,
      note: row.decisionNote,
      assignee: null,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, HANDLED_LIMIT)
  return { today: viewer.today, count, items: items.map((row) => ({ ...row, at: toUtcIso(row.at) })) }
}
