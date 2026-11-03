import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_CAPA_MANAGE, QUALITY_CAPA_VIEW } from '@nexus/factory-domain/quality/capa/permissions'
import { CAPA_LIMITS, CAPA_STATUSES, type CapaPriority, type CapaStatus, type CapaType, type CapaView, type SourceType } from '@nexus/factory-domain/quality/capa/rules'
import { QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import { QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officePeople } from '../complaints/list'
import { officeOf, refuse } from './access'
import { asDay, byCapa, CAPA_COLUMNS, capaSummary, customersOf, namesOf, readActions, readSources, remindable, sourceFactsOf, sourceLabels, teamOf } from './store'

/**
 * The CAPA list, its tiles and its people (B-W2b-108; design quality.capa capa-metrics, capa-grid, the board by stage and
 * the pickers of capa-new and capa-action):
 *
 *   GET /quality/capa          `view` open (default) | mine (I own it, am in its team, or own an open action) | overdue (an
 *                              open action past its day) | closed | cancelled | all, or `status` (comma list); type,
 *                              priority, customerId, owner (me | id), sourceType + sourceId (the CAPAs of an NCR or a
 *                              complaint), q (number, title, customer code or name); newest first; `limit` ≤ 200 (50) and
 *                              `nextCursor` (`<createdAt ISO>|<id>`). Each row: sources (count + the first five the reader
 *                              may see), customer, owner and team (names in `people`), stage, next due, actions open /
 *                              overdue / done, priority, age.
 *   GET /quality/capa/counts   the tiles Open, Actions overdue (open actions past their day), Mine. Effectiveness, approval
 *                              and on-time are W3.
 *   GET /quality/capa/people   who may own a CAPA of a company (and customer), be in its team, own or be the escalation
 *                              path of an action: ACTIVE office people who see CAPAs there (live roles), whether they may
 *                              manage them, and whether a reminder task may be given to them.
 */

const SCOPE = { company: 'companyId', party: { field: 'customerId', nullable: true } } as const

export interface ListQuery {
  readonly view?: CapaView | undefined
  readonly status?: string | undefined
  readonly type?: CapaType | undefined
  readonly priority?: CapaPriority | undefined
  readonly customerId?: string | undefined
  readonly owner?: string | undefined
  readonly sourceType?: SourceType | undefined
  readonly sourceId?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

const OPEN: Prisma.CapaWhereInput = { status: { notIn: ['CLOSED', 'CANCELLED'] } }

function viewWhere(view: CapaView, me: string, today: string): Prisma.CapaWhereInput {
  switch (view) {
    case 'open':
      return OPEN
    case 'mine':
      return { AND: [OPEN, { OR: [{ ownerId: me }, { team: { array_contains: [{ userId: me }] } }, { actions: { some: { ownerId: me, status: 'OPEN' } } }] }] }
    case 'overdue':
      return { AND: [OPEN, { actions: { some: { status: 'OPEN', dueOn: { lt: asDay(today) } } } }] }
    case 'closed':
      return { status: 'CLOSED' }
    case 'cancelled':
      return { status: 'CANCELLED' }
    case 'all':
      return {}
  }
}

const scopeOfCaller = (caller: CommandCaller) => scopeWhere(actorOf(officeOf(caller)), QUALITY_CAPA_VIEW, SCOPE) as Prisma.CapaWhereInput

/** GET /quality/capa */
export async function listCapas(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  const today = businessDate(now)
  const limit = Math.min(query.limit ?? CAPA_LIMITS.listDefault, CAPA_LIMITS.list)
  const filters: Prisma.CapaWhereInput[] = [scopeOfCaller(caller)]
  if (query.status) {
    const statuses = query.status.split(',').map((value) => value.trim()).filter((value) => value !== '')
    if (statuses.some((value) => !(CAPA_STATUSES as readonly string[]).includes(value))) refuse([{ path: 'query/status', message: `Statuses among ${CAPA_STATUSES.join(', ')}.` }], 'Unknown status.')
    filters.push({ status: { in: statuses as CapaStatus[] } })
  } else filters.push(viewWhere(query.view ?? 'open', context.actorId, today))
  if (query.type) filters.push({ type: query.type })
  if (query.priority) filters.push({ priority: query.priority })
  if (query.customerId) filters.push({ customerId: query.customerId })
  if (query.owner) {
    const owner = query.owner === 'me' ? context.actorId : query.owner
    if (!isUuid(owner)) refuse([{ path: 'query/owner', message: 'me, or a person by id.' }], 'Unknown owner.')
    filters.push({ ownerId: owner })
  }
  if (query.sourceType || query.sourceId) {
    if (!query.sourceType || !query.sourceId || !isUuid(query.sourceId)) refuse([{ path: 'query/sourceId', message: 'Name the record by its type and id together.' }], 'Name the record.')
    filters.push({ sources: { some: { recordType: query.sourceType, recordId: query.sourceId } } })
  }
  const q = query.q?.trim()
  if (q) filters.push({ OR: [{ number: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }, { customer: { OR: [{ code: { contains: q, mode: 'insensitive' } }, { legalName: { contains: q, mode: 'insensitive' } }, { tradeName: { contains: q, mode: 'insensitive' } }] } }] })
  if (query.cursor) {
    const [at, id] = query.cursor.split('|')
    const when = at ? new Date(at) : null
    if (!when || Number.isNaN(when.getTime()) || !id || !isUuid(id)) refuse([{ path: 'query/cursor', message: 'Not a cursor of this list.' }], 'Not a cursor of this list.')
    filters.push({ OR: [{ createdAt: { lt: when! } }, { createdAt: when!, id: { lt: id } }] })
  }
  return caller.withClient(async (client) => {
    const rows = await client.capa.findMany({ where: { AND: filters }, select: CAPA_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const shown = rows.slice(0, limit)
    const ids = shown.map((row) => row.id)
    const sources = await readSources(client, ids)
    const actions = await readActions(client, ids)
    const facts = await sourceFactsOf(client, sources)
    const labels = sourceLabels(facts, (ncr) => can(actor, QUALITY_NCR_VIEW, { companyId: ncr.companyId, siteId: ncr.siteId }), (complaint) => can(actor, QUALITY_COMPLAINTS_VIEW, { companyId: complaint.companyId, partyId: complaint.partyId }))
    const customers = await customersOf(client, shown)
    const sourcesOf = byCapa(sources)
    const actionsOf = byCapa(actions)
    const last = shown[shown.length - 1]
    return {
      capas: shown.map((row) => capaSummary(row, { sources: sourcesOf.get(row.id) ?? [], actions: actionsOf.get(row.id) ?? [], customer: row.customerId ? (customers.get(row.customerId) ?? null) : null, labels }, now)),
      nextCursor: rows.length > limit && last ? `${toUtcIso(last.createdAt)}|${last.id}` : null,
      people: await namesOf(client, shown.flatMap((row) => [row.ownerId, ...teamOf(row.team).map((member) => member.userId)])),
      asOf: toUtcIso(now),
    }
  })
}

/** GET /quality/capa/counts */
export async function capaCounts(caller: CommandCaller) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const today = businessDate(now)
  return caller.withClient(async (client) => {
    const scope = scopeOfCaller(caller)
    return {
      tiles: {
        open: await client.capa.count({ where: { AND: [scope, OPEN] } }),
        actionsOverdue: await client.capaAction.count({ where: { status: 'OPEN', dueOn: { lt: asDay(today) }, capa: { AND: [scope, OPEN] } } }),
        mine: await client.capa.count({ where: { AND: [scope, viewWhere('mine', context.actorId, today)] } }),
      },
      asOf: toUtcIso(now),
    }
  })
}

/** GET /quality/capa/people?companyId&customerId */
export async function capaPeople(caller: CommandCaller, query: { readonly companyId: string; readonly customerId?: string | undefined }) {
  const context = officeOf(caller)
  const scope = { companyId: query.companyId, ...(query.customerId ? { partyId: query.customerId } : {}) }
  if (!can(actorOf(context), QUALITY_CAPA_VIEW, scope)) throw new NotFoundError('Company not found.')
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    if (!(await client.company.findUnique({ where: { id: query.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const people = await officePeople(client, context.tenantId, now)
    return {
      people: people
        .filter((person) => can(person.actor, QUALITY_CAPA_VIEW, scope))
        .map((person) => ({ id: person.id, name: person.name, manages: can(person.actor, QUALITY_CAPA_MANAGE, scope), remindable: remindable(person.actor, scope), me: person.id === context.actorId }))
        .sort((a, b) => (a.me === b.me ? a.name.localeCompare(b.name) : a.me ? -1 : 1)),
    }
  })
}
