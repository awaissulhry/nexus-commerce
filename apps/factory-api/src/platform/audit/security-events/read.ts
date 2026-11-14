import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { SECURITY_EVENTS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { assertEverywhere } from '../reads/everywhere'
import { addressHashOf } from './address'
import type { SecurityEventKindCode, SecurityEventView } from './contract'

/**
 * Reads of the security events (B-W2b-399; PLT-075; contract.ts). Rows only, newest first; nothing counted per person.
 */

const WORDS = 'The security events are read by the administrators and the Owner only (security.events.view over every company).'

export interface SecurityEventsQuery {
  readonly kind?: readonly SecurityEventKindCode[] | undefined
  readonly view?: 'failed-sign-ins' | 'exports' | undefined
  readonly surface?: SecurityEventView['surface'] | undefined
  readonly actorId?: string | undefined
  readonly ip?: string | undefined
  readonly recordType?: string | undefined
  readonly recordId?: string | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
}

/** The design's saved filters, as kinds. */
const VIEW_KINDS: Readonly<Record<NonNullable<SecurityEventsQuery['view']>, readonly SecurityEventKindCode[]>> = {
  'failed-sign-ins': ['SIGN_IN_FAILED', 'LOCKOUT', 'STEP_UP_LOCKED'],
  exports: ['EXPORT'],
}

const RESULT: Readonly<Record<SecurityEventKindCode, SecurityEventView['result']>> = {
  SIGN_IN: 'SUCCEEDED',
  SIGN_IN_FAILED: 'REFUSED',
  LOCKOUT: 'LOCKED',
  MFA_CHANGED: 'DONE',
  PERMISSION_DENIED: 'REFUSED',
  ROLE_CHANGED: 'DONE',
  API_KEY_USED: 'DONE',
  EXPORT: 'DONE',
  STEP_UP_LOCKED: 'LOCKED',
}

const EVENT_SELECT = { id: true, at: true, kind: true, surface: true, actorId: true, ipCountry: true, siteId: true, partyId: true, recordType: true, recordId: true, details: true } as const satisfies Prisma.SecurityEventSelect
type EventRow = Prisma.SecurityEventGetPayload<{ select: typeof EVENT_SELECT }>

const contextOf = (caller: CommandCaller) => {
  if (!caller.factoryContext) throw new UnauthenticatedError()
  return caller.factoryContext
}

function instantOf(value: string | undefined, path: string): Date | undefined {
  if (value === undefined) return undefined
  const parsed = parseInstant(value)
  if (parsed === null) throw new ValidationError('Not a time.', [{ path: `querystring/${path}`, message: 'Expected an ISO 8601 time with a zone.' }])
  return parsed
}

/** The filters as a where (exported for the export source). */
export function securityEventsWhere(query: SecurityEventsQuery): Prisma.SecurityEventWhereInput {
  const from = instantOf(query.from, 'from')
  const to = instantOf(query.to, 'to')
  const kinds = query.kind && query.kind.length > 0 ? query.kind : undefined
  const viewKinds = query.view ? VIEW_KINDS[query.view] : undefined
  return {
    AND: [
      ...(kinds ? [{ kind: { in: [...kinds] } }] : []),
      ...(viewKinds ? [{ kind: { in: [...viewKinds] } }] : []),
      ...(query.surface ? [{ surface: query.surface }] : []),
      ...(query.actorId ? [{ actorId: query.actorId }] : []),
      ...(query.ip ? [{ ipHash: addressHashOf(query.ip, 'querystring/ip') }] : []),
      ...(query.recordType ? [{ recordType: query.recordType }] : []),
      ...(query.recordId ? [{ recordId: query.recordId }] : []),
      ...(from || to ? [{ at: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }] : []),
    ],
  }
}

/** Who an event names: office and portal people by name, a floor worker by id only (Owner answer W1). */
export async function eventViewsOf(client: FactoryClient, rows: readonly EventRow[]): Promise<SecurityEventView[]> {
  const people = [...new Set(rows.filter((row) => row.actorId && row.actorId !== SYSTEM_ACTOR_ID && (row.surface === 'OFFICE' || row.surface === 'PORTAL' || row.surface === 'API')).map((row) => row.actorId!))]
  const names = new Map((people.length > 0 ? await client.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } }) : []).map((user) => [user.id, user.displayName]))
  return rows.map((row) => {
    const kind: SecurityEventView['actor']['kind'] =
      row.actorId === null ? 'NOBODY' : row.actorId === SYSTEM_ACTOR_ID ? 'SYSTEM' : row.surface === 'FLOOR' ? 'WORKER' : row.surface === 'LINK' ? 'LINK' : 'PERSON'
    return {
      id: row.id,
      at: toUtcIso(row.at),
      kind: row.kind,
      surface: row.surface,
      result: RESULT[row.kind],
      actor: { kind, id: row.actorId, name: kind === 'PERSON' ? (names.get(row.actorId!) ?? null) : null },
      ipCountry: row.ipCountry,
      siteId: row.siteId,
      partyId: row.partyId,
      record: row.recordType && row.recordId ? { type: row.recordType, id: row.recordId } : null,
      details: row.details !== null && typeof row.details === 'object' && !Array.isArray(row.details) ? (row.details as Record<string, unknown>) : {},
    }
  })
}

/** One page of events (newest first) after `before`, and the next anchor (exported for the export source). */
export async function securityEventsPage(client: FactoryClient, where: Prisma.SecurityEventWhereInput, before: string | null | undefined, limit: number): Promise<{ rows: EventRow[]; nextBefore: string | null }> {
  let page: Prisma.SecurityEventWhereInput = {}
  if (before) {
    const anchor = await client.securityEvent.findFirst({ where: { id: before }, select: { id: true, at: true } })
    if (!anchor) throw new ValidationError('No such event to page from.', [{ path: 'querystring/before', message: 'Not an event of this log.' }])
    page = { OR: [{ at: { lt: anchor.at } }, { at: anchor.at, id: { lt: anchor.id } }] }
  }
  const rows = await client.securityEvent.findMany({ where: { AND: [where, page] }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: limit + 1, select: EVENT_SELECT })
  const more = rows.length > limit
  const shown = more ? rows.slice(0, limit) : rows
  return { rows: shown, nextBefore: more ? shown[shown.length - 1]!.id : null }
}

/** GET /audit/security-events */
export async function listSecurityEvents(caller: CommandCaller, query: SecurityEventsQuery & { readonly before?: string | undefined; readonly limit: number }): Promise<{ events: SecurityEventView[]; nextBefore: string | null }> {
  assertEverywhere(contextOf(caller), SECURITY_EVENTS_VIEW, WORDS)
  const where = securityEventsWhere(query)
  return caller.withClient(async (client) => {
    const { rows, nextBefore } = await securityEventsPage(client, where, query.before, query.limit)
    return { events: await eventViewsOf(client, rows), nextBefore }
  })
}

/** How far either side of an event its related events are looked for (B-W2b-413). */
const RELATED_WINDOW_MS = 24 * 3_600_000
const RELATED_LIMIT = 20

/** GET /audit/security-events/:eventId — the event and (B-W2b-413) the other events from the same address around it. */
export async function oneSecurityEvent(caller: CommandCaller, eventId: string): Promise<{ event: SecurityEventView; related: SecurityEventView[] }> {
  assertEverywhere(contextOf(caller), SECURITY_EVENTS_VIEW, WORDS)
  return caller.withClient(async (client) => {
    const row = await client.securityEvent.findUnique({ where: { id: eventId }, select: { ...EVENT_SELECT, ipHash: true } })
    if (!row) throw new NotFoundError('No such security event.')
    const { ipHash, ...shown } = row
    const near = ipHash
      ? await client.securityEvent.findMany({
          where: { ipHash, id: { not: row.id }, at: { gte: new Date(row.at.getTime() - RELATED_WINDOW_MS), lte: new Date(row.at.getTime() + RELATED_WINDOW_MS) } },
          orderBy: [{ at: 'desc' }, { id: 'desc' }],
          take: RELATED_LIMIT,
          select: EVENT_SELECT,
        })
      : []
    const [event, ...related] = await eventViewsOf(client, [shown, ...near])
    return { event: event!, related }
  })
}
