import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_COMPLAINTS_ACKNOWLEDGE, QUALITY_COMPLAINTS_MANAGE, QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import {
  AWAITING_ANSWER,
  COMPLAINT_CATEGORIES,
  COMPLAINT_LIMITS,
  COMPLAINT_SEVERITIES,
  COMPLAINT_STATUSES,
  dueSoonUntil,
  monthStart,
  OPEN_STATUSES,
  type ComplaintCategory,
  type ComplaintSeverity,
  type ComplaintStatus,
  type ComplaintView,
} from '@nexus/factory-domain/quality/complaints/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../../platform/auth/roles/access'
import { officeOf } from './access'
import { asDay, COMPLAINT_COLUMNS, peopleOf, rowFacts, rowView, summaryOf, type Reader } from './store'

/**
 * The complaints list, its tiles and the safety banner (B-W2a-65; design quality.complaints cmp-metrics, cmp-safety,
 * cmp-grid). Office only, within the caller's companies and customers (quality.complaints.view).
 *
 *   GET /quality/complaints          newest first (received, then id): `view` new | safety | dueSoon | open (default) |
 *                                    answeredMonth | closed | all, or `status` (one or a comma list), `category`,
 *                                    `severity`, `partyId`, `salesOrderId`, `shipmentId`, `returnId`, `owner` me | <id>,
 *                                    `q` (number, customer code or name, their reference, serial, batch); pages of `limit`
 *                                    (≤ 200, default 50) with `nextCursor`.
 *   GET /quality/complaints/counts   the tiles and the banner's safety alerts (raised, not acknowledged, oldest first).
 *   GET /quality/complaints/people   who may own a complaint of a company, and whom its safety alert tells.
 */

export interface ListQuery {
  readonly view?: ComplaintView | undefined
  readonly status?: string | undefined
  readonly category?: ComplaintCategory | undefined
  readonly severity?: ComplaintSeverity | undefined
  readonly partyId?: string | undefined
  readonly salesOrderId?: string | undefined
  readonly shipmentId?: string | undefined
  readonly returnId?: string | undefined
  readonly owner?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

const SCOPE = { company: 'companyId', party: 'partyId' } as const
const PAGE = 50

/** The tiles' and rows' filters (named saved filters: the same words on the screen and here). */
export function viewWhere(view: ComplaintView, now: Date): Prisma.ComplaintWhereInput {
  const today = businessDate(now)
  switch (view) {
    case 'new':
      return { status: 'NEW' }
    case 'safety':
      return { safetyRaisedAt: { not: null }, status: { not: 'CLOSED' } }
    case 'dueSoon':
      return { status: { in: [...AWAITING_ANSWER] }, answerDueOn: { lte: asDay(dueSoonUntil(today)) } }
    case 'open':
      return { status: { in: [...OPEN_STATUSES] } }
    case 'answeredMonth':
      return { answeredAt: { gte: businessDayStart(monthStart(today)) } }
    case 'closed':
      return { status: 'CLOSED' }
    case 'all':
      return {}
  }
}

const scopeOfCaller = (caller: CommandCaller) => scopeWhere(actorOf(officeOf(caller)), QUALITY_COMPLAINTS_VIEW, SCOPE) as Prisma.ComplaintWhereInput

function whereOf(caller: CommandCaller, query: ListQuery, now: Date): Prisma.ComplaintWhereInput {
  const context = officeOf(caller)
  const statuses = query.status ? query.status.split(',').map((entry) => entry.trim()).filter(Boolean) : []
  const bad = statuses.find((status) => !(COMPLAINT_STATUSES as readonly string[]).includes(status))
  if (bad) throw new ValidationError('Not a complaint status.', [{ path: 'querystring/status', message: `One or more of ${COMPLAINT_STATUSES.join(', ')}.` }])
  if (query.category && !(COMPLAINT_CATEGORIES as readonly string[]).includes(query.category)) throw new ValidationError('Not a category.', [{ path: 'querystring/category', message: COMPLAINT_CATEGORIES.join(', ') }])
  if (query.severity && !(COMPLAINT_SEVERITIES as readonly string[]).includes(query.severity)) throw new ValidationError('Not a severity.', [{ path: 'querystring/severity', message: COMPLAINT_SEVERITIES.join(', ') }])
  if (query.owner && query.owner !== 'me' && !isUuid(query.owner)) throw new ValidationError('Not an owner.', [{ path: 'querystring/owner', message: "A person's id, or me." }])
  const q = (query.q ?? '').trim()
  return {
    AND: [
      scopeOfCaller(caller),
      statuses.length > 0 ? { status: { in: statuses as ComplaintStatus[] } } : viewWhere(query.view ?? 'open', now),
      query.category ? { category: query.category } : {},
      query.severity ? { severity: query.severity } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.salesOrderId ? { salesOrderId: query.salesOrderId } : {},
      query.shipmentId ? { shipmentId: query.shipmentId } : {},
      query.returnId ? { returnId: query.returnId } : {},
      query.owner ? { ownerId: query.owner === 'me' ? context.actorId : query.owner } : {},
      q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' } },
              { customerRef: { contains: q, mode: 'insensitive' } },
              { serial: { contains: q, mode: 'insensitive' } },
              { batchNumber: { contains: q, mode: 'insensitive' } },
              { party: { legalName: { contains: q, mode: 'insensitive' } } },
              { party: { code: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {},
    ],
  }
}

/** The cursor of a page: the last row's received time and id (newest first). */
const cursorOf = (row: { receivedAt: Date; id: string }): string => `${row.receivedAt.toISOString()}|${row.id}`
function afterCursor(cursor: string | undefined): Prisma.ComplaintWhereInput {
  if (!cursor) return {}
  const [at, id] = cursor.split('|')
  const when = at ? new Date(at) : null
  if (!when || Number.isNaN(when.getTime()) || !id || !isUuid(id)) throw new ValidationError('Not a cursor of this list.', [{ path: 'querystring/cursor', message: 'The nextCursor of the page before.' }])
  return { OR: [{ receivedAt: { lt: when } }, { receivedAt: when, id: { lt: id } }] }
}

/** GET /quality/complaints */
export async function listComplaints(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const limit = Math.min(query.limit ?? PAGE, COMPLAINT_LIMITS.list)
  return caller.withClient(async (client) => {
    const where = { AND: [whereOf(caller, query, now), afterCursor(query.cursor)] }
    const rows = await client.complaint.findMany({ where, select: COMPLAINT_COLUMNS, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const shown = rows.slice(0, limit)
    const facts = await rowFacts(client, shown, context)
    return {
      complaints: shown.map((row) => rowView(row, facts)),
      nextCursor: rows.length > limit ? cursorOf(shown[shown.length - 1]!) : null,
      people: await peopleOf(client, shown.map((row) => row.ownerId)),
      asOf: toUtcIso(now),
    }
  })
}

/** GET /quality/complaints/counts */
export async function complaintCounts(caller: CommandCaller) {
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const scope = scopeOfCaller(caller)
    const count = async (view: ComplaintView) => client.complaint.count({ where: { AND: [scope, viewWhere(view, now)] } })
    const banner = { AND: [scope, { safetyRaisedAt: { not: null }, safetyAcknowledgedAt: null, status: { not: 'CLOSED' as const } }] }
    const alerts = await client.complaint.findMany({
      where: banner,
      select: { id: true, number: true, description: true, styleId: true, batchNumber: true, serial: true, safetyRaisedAt: true, version: true },
      orderBy: [{ safetyRaisedAt: 'asc' }, { id: 'asc' }],
      take: COMPLAINT_LIMITS.banner,
    })
    const styleIds = [...new Set(alerts.map((row) => row.styleId).filter((id): id is string => id !== null))]
    const styles = styleIds.length ? await client.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } }) : []
    const styleOf = new Map(styles.map((row) => [row.id, row]))
    const total = alerts.length < COMPLAINT_LIMITS.banner ? alerts.length : await client.complaint.count({ where: banner })
    return {
      tiles: { new: await count('new'), safety: await count('safety'), dueSoon: await count('dueSoon'), open: await count('open'), answeredMonth: await count('answeredMonth') },
      safetyAlerts: alerts.map((row) => ({
        id: row.id,
        number: row.number,
        summary: summaryOf(row.description),
        style: row.styleId ? (styleOf.get(row.styleId) ?? null) : null,
        batchNumber: row.batchNumber,
        serial: row.serial,
        raisedAt: toUtcIso(row.safetyRaisedAt!),
        version: row.version,
      })),
      moreSafetyAlerts: Math.max(0, total - alerts.length),
      asOf: toUtcIso(now),
    }
  })
}

// ---- who owns a complaint, whom a safety alert tells ---------------------------------------------------------------------

/** At most this many office people are looked at (as the notification fan-out does). */
const MAX_PEOPLE = 500

export interface CompanyPerson {
  readonly id: string
  readonly name: string
  readonly actor: Actor
}

/** Every ACTIVE office person with their live roles now (no two-factor asked: what their roles give). */
export async function officePeople(db: Reader, tenantId: string, now: Date): Promise<CompanyPerson[]> {
  const users = await db.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true, displayName: true }, orderBy: { id: 'asc' }, take: MAX_PEOPLE })
  const people: CompanyPerson[] = []
  for (const user of users) {
    const grants = sessionGrants({ requireMfa: false }, await heldRoles(db as FactoryClient | CommandTx, user.id, now), true)
    people.push({ id: user.id, name: user.displayName, actor: { audience: 'office', tenantId, grants } })
  }
  return people
}

/** Whom a safety alert of the company's complaint for this customer tells: who may acknowledge it (OWNER), who follows complaints up (QUALITY). */
export function toldOf(people: readonly CompanyPerson[], scope: { readonly companyId: string; readonly partyId?: string | undefined }): { id: string; name: string; as: 'OWNER' | 'QUALITY' }[] {
  const told: { id: string; name: string; as: 'OWNER' | 'QUALITY' }[] = []
  for (const person of people) {
    if (can(person.actor, QUALITY_COMPLAINTS_ACKNOWLEDGE, scope)) told.push({ id: person.id, name: person.name, as: 'OWNER' })
    else if (can(person.actor, QUALITY_COMPLAINTS_MANAGE, scope)) told.push({ id: person.id, name: person.name, as: 'QUALITY' })
  }
  return told
}

/** GET /quality/complaints/people?companyId= */
export async function complaintPeople(caller: CommandCaller, companyId: string) {
  const context = officeOf(caller)
  if (!can(actorOf(context), QUALITY_COMPLAINTS_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    if (!(await client.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const people = await officePeople(client, context.tenantId, now)
    return {
      owners: people.filter((person) => can(person.actor, QUALITY_COMPLAINTS_MANAGE, { companyId })).map((person) => ({ id: person.id, name: person.name })),
      told: toldOf(people, { companyId }),
    }
  })
}
