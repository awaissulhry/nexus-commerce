import type { Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_SERVICE_MANAGE, SALES_SERVICE_VIEW } from '@nexus/factory-domain/sales/service/permissions'
import {
  buyerOfParty,
  CASE_KINDS,
  CASE_LIMITS,
  CASE_STATUSES,
  COVER_STATES,
  coverStateOf,
  LINK_RECORD_TYPES,
  OPEN_CASE_STATUSES,
  type CaseKind,
  type CaseStatus,
  type CaseView,
  type Cover,
  type CoverState,
} from '@nexus/factory-domain/sales/service/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../../platform/auth/roles/access'
import { officeOf } from './access'
import { CASE_COLUMNS, checkOfRow, peopleOf, rowFacts, rowView } from './store'

/**
 * The service cases list and its tiles (B-W2b-345; design service.tiles "New · Waiting for the customer · Waiting for a
 * part", service.grid "Case · Customer or rider · Garment serial · Style · Cover · Status · Opened · Owner", savedRows "Open ·
 * Mine · Waiting · Closed · All"). Office only, within the caller's companies and customers (sales.service.view; a case that
 * names no customer is seen by whoever reaches its company).
 *
 *   GET /sales/service/cases          newest first (opened, then id): `view` open (default) | new | waitingCustomer |
 *                                     waitingPart | waiting | mine | closed | all, or `status` (one or a comma list), `kind`,
 *                                     `cover` (the Cover column: decided, else what the check points to), `partyId`, `owner`
 *                                     me | <id>, `serial` (a garment's cases: as typed or ours), `linked` <RecordType>:<id> (the
 *                                     cases a record is linked to), `q` (number, serial, batch, customer code or name); pages
 *                                     of `limit` (≤ 200, default 50) with `nextCursor`.
 *   GET /sales/service/cases/counts   the tiles: each tile's number is the list's total under that filter.
 */

export interface ListQuery {
  readonly view?: CaseView | undefined
  readonly status?: string | undefined
  readonly kind?: CaseKind | undefined
  readonly cover?: CoverState | undefined
  readonly partyId?: string | undefined
  readonly owner?: string | undefined
  readonly serial?: string | undefined
  readonly linked?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

const SCOPE = { company: 'companyId', party: { field: 'partyId', nullable: true } } as const

export function viewWhere(view: CaseView, actorId: string): Prisma.ServiceCaseWhereInput {
  switch (view) {
    case 'open':
      return { status: { in: [...OPEN_CASE_STATUSES] } }
    case 'new':
      return { status: 'NEW' }
    case 'waitingCustomer':
      return { status: 'WAITING_CUSTOMER' }
    case 'waitingPart':
      return { status: 'WAITING_PART' }
    case 'waiting':
      return { status: { in: ['WAITING_CUSTOMER', 'WAITING_PART'] } }
    case 'mine':
      return { ownerId: actorId, status: { in: [...OPEN_CASE_STATUSES] } }
    case 'closed':
      return { status: 'CLOSED' }
    case 'all':
      return {}
  }
}

const scopeOfCaller = (caller: CommandCaller) => scopeWhere(actorOf(officeOf(caller)), SALES_SERVICE_VIEW, SCOPE) as Prisma.ServiceCaseWhereInput

function linkedWhere(linked: string | undefined): Prisma.ServiceCaseWhereInput {
  if (!linked) return {}
  const [recordType, recordId] = linked.split(':')
  if (!recordType || !(LINK_RECORD_TYPES as readonly string[]).includes(recordType) || !recordId || !isUuid(recordId)) {
    throw new ValidationError('Not a linked record.', [{ path: 'querystring/linked', message: `<RecordType>:<id>, a type of ${LINK_RECORD_TYPES.join(', ')}.` }])
  }
  return { links: { some: { recordType, recordId } } }
}

function whereOf(caller: CommandCaller, query: ListQuery): Prisma.ServiceCaseWhereInput {
  const context = officeOf(caller)
  const statuses = query.status ? query.status.split(',').map((entry) => entry.trim()).filter(Boolean) : []
  const bad = statuses.find((status) => !(CASE_STATUSES as readonly string[]).includes(status))
  if (bad) throw new ValidationError('Not a case status.', [{ path: 'querystring/status', message: `One or more of ${CASE_STATUSES.join(', ')}.` }])
  if (query.kind && !(CASE_KINDS as readonly string[]).includes(query.kind)) throw new ValidationError('Not a kind of case.', [{ path: 'querystring/kind', message: CASE_KINDS.join(', ') }])
  if (query.owner && query.owner !== 'me' && !isUuid(query.owner)) throw new ValidationError('Not an owner.', [{ path: 'querystring/owner', message: "A person's id, or me." }])
  const q = (query.q ?? '').trim()
  const serial = (query.serial ?? '').trim()
  return {
    AND: [
      scopeOfCaller(caller),
      statuses.length > 0 ? { status: { in: statuses as CaseStatus[] } } : viewWhere(query.view ?? 'open', context.actorId),
      query.kind ? { kind: query.kind } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.owner ? { ownerId: query.owner === 'me' ? context.actorId : query.owner } : {},
      serial ? { OR: [{ serial }, { garmentSerial: serial }] } : {},
      linkedWhere(query.linked),
      q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' } },
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

/** The cursor of a page: the last row's opening time and id (newest first). */
const cursorOf = (row: { createdAt: Date; id: string }): string => `${row.createdAt.toISOString()}|${row.id}`
function afterCursor(cursor: string | undefined): Prisma.ServiceCaseWhereInput {
  if (!cursor) return {}
  const [at, id] = cursor.split('|')
  const when = at ? new Date(at) : null
  if (!when || Number.isNaN(when.getTime()) || !id || !isUuid(id)) throw new ValidationError('Not a cursor of this list.', [{ path: 'querystring/cursor', message: 'The nextCursor of the page before.' }])
  return { OR: [{ createdAt: { lt: when } }, { createdAt: when, id: { lt: id } }] }
}

/**
 * The Cover column is the decision, else what the check reads from the case's days: the cover filter reads the rows of the
 * other filters and keeps those that match, page by page (at most CASE_LIMITS.list rows looked at per page beyond the limit).
 */
export async function listCases(caller: CommandCaller, query: ListQuery) {
  const now = serverClock.now()
  const today = businessDate(now)
  const limit = Math.min(query.limit ?? CASE_LIMITS.page, CASE_LIMITS.list)
  if (query.cover && !(COVER_STATES as readonly string[]).includes(query.cover)) throw new ValidationError('Not a cover.', [{ path: 'querystring/cover', message: COVER_STATES.join(', ') }])
  return caller.withClient(async (client) => {
    const where = { AND: [whereOf(caller, query), afterCursor(query.cursor)] }
    const window = query.cover ? CASE_LIMITS.list : limit
    const read = await client.serviceCase.findMany({ where, select: { ...CASE_COLUMNS, party: { select: { kind: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: window + 1 })
    const looked = read.slice(0, window)
    const matching = query.cover ? looked.filter((row) => coverStateOf(row.cover as Cover | null, checkOfRow(row, buyerOfParty(row.party), today)) === query.cover) : looked
    const shown = matching.slice(0, limit)
    // The next page starts after the last row shown when more matched, else after the last row looked at when the read went on.
    const last = matching.length > limit ? shown[shown.length - 1]! : read.length > window ? looked[looked.length - 1]! : null
    const facts = await rowFacts(client, shown)
    return {
      cases: shown.map((row) => rowView(row, facts, today)),
      nextCursor: last ? cursorOf(last) : null,
      people: await peopleOf(client, shown.map((row) => row.ownerId)),
      asOf: toUtcIso(now),
    }
  })
}

/** GET /sales/service/cases/counts */
export async function caseCounts(caller: CommandCaller) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const scope = scopeOfCaller(caller)
    const count = async (view: CaseView) => client.serviceCase.count({ where: { AND: [scope, viewWhere(view, context.actorId)] } })
    return {
      tiles: { new: await count('new'), waitingCustomer: await count('waitingCustomer'), waitingPart: await count('waitingPart') },
      rows: { open: await count('open'), mine: await count('mine'), waiting: await count('waiting'), closed: await count('closed'), all: await count('all') },
      asOf: toUtcIso(now),
    }
  })
}

/** At most this many office people are looked at (as the notification fan-out does). */
const MAX_PEOPLE = 500

/** GET /sales/service/cases/people?companyId= — who may own a case of the company (sales.service.manage there, live roles now). */
export async function casePeople(caller: CommandCaller, companyId: string) {
  const context = officeOf(caller)
  if (!can(actorOf(context), SALES_SERVICE_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    if (!(await client.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const users = await client.user.findMany({ where: { status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true, displayName: true }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: MAX_PEOPLE })
    const owners: { id: string; name: string }[] = []
    for (const user of users) {
      const grants = sessionGrants({ requireMfa: false }, await heldRoles(client, user.id, now), true)
      if (can({ audience: 'office', tenantId: context.tenantId, grants }, SALES_SERVICE_MANAGE, { companyId })) owners.push({ id: user.id, name: user.displayName })
    }
    return { owners }
  })
}
