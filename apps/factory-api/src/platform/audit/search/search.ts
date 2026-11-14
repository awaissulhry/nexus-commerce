import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { fieldLinesOf } from '../../threads/timeline/field-lines'
import type { AuditViewName } from '../contract'
import { AUDIT_READ, AUDIT_SCOPE_COLUMNS, AUDIT_VIEW_ACTIONS } from '../read'
import { addressHashOf } from '../security-events/address'
import type { SearchEntryView } from './contract'

/**
 * The audit viewer's search (B-W2b-399; PLT-077; contract.ts): the caller's audit.read scope, every filter given, newest first.
 * A read, so no command(). The saved views are GET /audit's (`AUDIT_VIEW_ACTIONS`).
 */

export interface SearchQuery {
  readonly actorId?: string | undefined
  readonly audience?: SearchEntryView['audience'] | undefined
  readonly recordType?: string | undefined
  readonly recordId?: string | undefined
  readonly action?: string | undefined
  readonly ip?: string | undefined
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly requestId?: string | undefined
  readonly view?: AuditViewName | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
}

/** At most this many sessions of one address are matched (a shared office address: the newest). */
const MAX_SESSIONS = 500

const ENTRY_SELECT = {
  id: true,
  at: true,
  audience: true,
  actorId: true,
  deviceId: true,
  deviceTime: true,
  companyId: true,
  siteId: true,
  partyId: true,
  action: true,
  recordType: true,
  recordId: true,
  before: true,
  after: true,
  reason: true,
  requestId: true,
  idempotencyKey: true,
} as const satisfies Prisma.AuditLogSelect
type EntryRow = Prisma.AuditLogGetPayload<{ select: typeof ENTRY_SELECT }>

export const contextOf = (caller: CommandCaller) => {
  if (!caller.factoryContext) throw new UnauthenticatedError()
  return caller.factoryContext
}

function instantOf(value: string | undefined, path: string): Date | undefined {
  if (value === undefined) return undefined
  const parsed = parseInstant(value)
  if (parsed === null) throw new ValidationError('Not a time.', [{ path: `querystring/${path}`, message: 'Expected an ISO 8601 time with a zone.' }])
  return parsed
}

function viewWhere(view: AuditViewName): Prisma.AuditLogWhereInput {
  const rule = AUDIT_VIEW_ACTIONS[view]
  return { OR: [...rule.prefixes.map((prefix) => ({ action: { startsWith: prefix } })), ...(rule.contains ?? []).map((part) => ({ action: { contains: part } }))] }
}

/**
 * The address filter: the rows written by the people of the sessions signed in from that address, while each session lived
 * (from its start to its end: revoked, or its idle end). No session from it: nothing matches.
 */
async function addressWhere(client: FactoryClient, ip: string): Promise<Prisma.AuditLogWhereInput> {
  const sessions = await client.session.findMany({
    where: { ipHash: addressHashOf(ip, 'querystring/ip') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_SESSIONS,
    select: { userId: true, createdAt: true, revokedAt: true, idleExpiresAt: true, absoluteExpiresAt: true },
  })
  if (sessions.length === 0) return { id: { in: [] } }
  return {
    OR: sessions.map((session) => {
      const end = session.revokedAt ?? new Date(Math.min(session.idleExpiresAt.getTime(), session.absoluteExpiresAt.getTime()))
      return { actorId: session.userId, at: { gte: session.createdAt, lte: end } }
    }),
  }
}

/** The search as a where in the caller's scope (exported for the export source). */
export async function searchWhere(client: FactoryClient, actor: Actor, query: SearchQuery): Promise<Prisma.AuditLogWhereInput> {
  const scope = scopeWhere(actor, AUDIT_READ, AUDIT_SCOPE_COLUMNS) as Prisma.AuditLogWhereInput
  const from = instantOf(query.from, 'from')
  const to = instantOf(query.to, 'to')
  return {
    AND: [
      scope,
      ...(from || to ? [{ at: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }] : []),
      ...(query.actorId ? [{ actorId: query.actorId }] : []),
      ...(query.audience ? [{ audience: query.audience }] : []),
      ...(query.recordType ? [{ recordType: query.recordType }] : []),
      ...(query.recordId ? [{ recordId: query.recordId }] : []),
      ...(query.action ? [{ action: { startsWith: query.action } }] : []),
      ...(query.companyId ? [{ companyId: query.companyId }] : []),
      ...(query.siteId ? [{ siteId: query.siteId }] : []),
      ...(query.requestId ? [{ requestId: query.requestId }] : []),
      ...(query.view ? [viewWhere(query.view)] : []),
      ...(query.ip ? [await addressWhere(client, query.ip)] : []),
    ],
  }
}

/** One page after `before` (newest first) and the next anchor (exported for the export source). */
export async function searchPage(client: FactoryClient, where: Prisma.AuditLogWhereInput, before: string | null | undefined, limit: number): Promise<{ rows: EntryRow[]; nextBefore: string | null }> {
  let page: Prisma.AuditLogWhereInput = {}
  if (before) {
    const anchor = await client.auditLog.findFirst({ where: { AND: [where, { id: before }] }, select: { id: true, at: true } })
    if (!anchor) throw new ValidationError('No such entry to page from.', [{ path: 'querystring/before', message: 'Not an entry of this search.' }])
    page = { OR: [{ at: { lt: anchor.at } }, { at: anchor.at, id: { lt: anchor.id } }] }
  }
  const rows = await client.auditLog.findMany({ where: { AND: [where, page] }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: limit + 1, select: ENTRY_SELECT })
  const more = rows.length > limit
  const shown = more ? rows.slice(0, limit) : rows
  return { rows: shown, nextBefore: more ? shown[shown.length - 1]!.id : null }
}

/** The entries as the screens show them: the office person's and the device's names, the field lines. */
export async function entryViewsOf(client: FactoryClient, actor: Actor, rows: readonly EntryRow[]): Promise<SearchEntryView[]> {
  const officeIds = [...new Set(rows.filter((row) => row.audience === 'OFFICE').map((row) => row.actorId))]
  const deviceIds = [...new Set(rows.flatMap((row) => (row.deviceId ? [row.deviceId] : [])))]
  const [people, devices] = await Promise.all([
    officeIds.length > 0 ? client.user.findMany({ where: { id: { in: officeIds } }, select: { id: true, displayName: true } }) : Promise.resolve([]),
    deviceIds.length > 0 ? client.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ])
  const personName = new Map(people.map((person) => [person.id, person.displayName]))
  const deviceName = new Map(devices.map((device) => [device.id, device.name]))
  const held = heldGrains(actor)
  return rows.map((row) => ({
    ...row,
    at: toUtcIso(row.at),
    deviceTime: row.deviceTime ? toUtcIso(row.deviceTime) : null,
    actorName: row.audience === 'OFFICE' ? (personName.get(row.actorId) ?? null) : null,
    deviceName: row.deviceId ? (deviceName.get(row.deviceId) ?? null) : null,
    lines: fieldLinesOf(row.before, row.after, { held, values: true, unheldMoney: 'name' }),
  }))
}

/** GET /audit/search */
export async function searchAudit(caller: CommandCaller, query: SearchQuery & { readonly before?: string | undefined; readonly limit: number }): Promise<{ entries: SearchEntryView[]; nextBefore: string | null; ipMatch: 'SESSIONS' | null }> {
  const actor = actorOf(contextOf(caller))
  return caller.withClient(async (client) => {
    const where = await searchWhere(client, actor, query)
    const { rows, nextBefore } = await searchPage(client, where, query.before, query.limit)
    return { entries: await entryViewsOf(client, actor, rows), nextBefore, ipMatch: query.ip ? 'SESSIONS' : null }
  })
}

/** GET /audit/entries/:entryId */
export async function auditEntry(caller: CommandCaller, entryId: string) {
  const actor = actorOf(contextOf(caller))
  const scope = scopeWhere(actor, AUDIT_READ, AUDIT_SCOPE_COLUMNS) as Prisma.AuditLogWhereInput
  return caller.withClient(async (client) => {
    const row = await client.auditLog.findFirst({ where: { AND: [scope, { id: entryId }] }, select: ENTRY_SELECT })
    if (!row) throw new NotFoundError('No such audit entry.')
    const [entry] = await entryViewsOf(client, actor, [row])
    // The office session the row was written in: one live then, of that person; its country when it is known.
    const sessions =
      row.audience === 'OFFICE'
        ? await client.session.findMany({ where: { userId: row.actorId, createdAt: { lte: row.at }, OR: [{ revokedAt: null }, { revokedAt: { gte: row.at } }], idleExpiresAt: { gte: row.at } }, take: 2, select: { ipCountry: true } })
        : []
    const siblings = await client.auditLog.findMany({
      where: { AND: [scope, { requestId: row.requestId, id: { not: row.id } }] },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      take: 50,
      select: { id: true, at: true, action: true, recordType: true, recordId: true, before: true, after: true },
    })
    return {
      entry: entry!,
      context: { ipCountry: sessions.length === 1 ? sessions[0]!.ipCountry : null, serverTime: toUtcIso(row.at), deviceTime: row.deviceTime ? toUtcIso(row.deviceTime) : null },
      siblings: siblings.map((sibling) => ({ ...sibling, at: toUtcIso(sibling.at) })),
    }
  })
}
