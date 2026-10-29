import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { scopeWhere, type Actor, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { parseInstant } from '@nexus/factory-domain/core/time'
import type { AuditEntryView, AuditListEntryView, AuditViewName } from './contract'

/**
 * Reads the audit log (a read, so no command()). Row-level security keeps it to the tenant; scopeWhere keeps it to the
 * companies, sites and parties the caller's audit.read grants reach. A row without a company (tenant-wide, or written
 * where the company was not known) is not limited by the company scope, and likewise for site and party.
 */

export const AUDIT_READ = 'audit.read' as const

export const AUDIT_SCOPE_COLUMNS: ScopeColumns = {
  company: { field: 'companyId', nullable: true },
  site: { field: 'siteId', nullable: true },
  party: { field: 'partyId', nullable: true },
}

export interface AuditHistoryQuery {
  readonly recordType: string
  readonly recordId: string
  readonly limit: number
}

export async function readAuditHistory(client: FactoryClient, actor: Actor, query: AuditHistoryQuery): Promise<AuditEntryView[]> {
  const scope = scopeWhere(actor, AUDIT_READ, AUDIT_SCOPE_COLUMNS) as Prisma.AuditLogWhereInput
  const rows = await client.auditLog.findMany({
    where: { AND: [scope, { recordType: query.recordType, recordId: query.recordId }] },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: query.limit,
    select: {
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
    },
  })
  return rows.map((row) => ({ ...row, at: toUtcIso(row.at), deviceTime: row.deviceTime ? toUtcIso(row.deviceTime) : null }))
}

/**
 * The saved views of the audit log (design 02 admin.audit `views`) as action filters. Role changes: roles and floor
 * roles given or ended; Access: sign-ins, two-factor, passwords, invitations, step-ups; Deletes and cancels: every write
 * that removes, cancels, voids, revokes, archives or closes; Settings: the company structure, numbering, mail
 * identities, devices and floor times, connections and each area's settings.
 */
export const AUDIT_VIEW_ACTIONS: Readonly<Record<AuditViewName, { prefixes: readonly string[]; contains?: readonly string[] }>> = {
  roles: { prefixes: ['roles.', 'workers.setRoles'] },
  access: { prefixes: ['auth.', 'users.', 'floor.stepUp', 'floor.changePin', 'workers.issueBadge', 'workers.revokeBadge', 'workers.resetPin'] },
  deletes: { prefixes: [], contains: ['.delete', '.cancel', '.void', '.revoke', '.archive', '.close', '.remove', '.reverse', '.retire', 'Delete', 'Cancel', 'Void', 'Revoke', 'Archive', 'Close', 'Remove', 'Reverse', 'Retire'] },
  settings: {
    prefixes: ['org.', 'numbering.', 'email.createIdentity', 'email.updateIdentity', 'email.recordIdentity', 'devices.', 'integration.', 'companies.', 'print.createPrinter', 'print.updatePrinter', 'privacy.'],
    contains: ['.saveSettings', 'settings.save'],
  },
}

function viewWhere(view: AuditViewName): Prisma.AuditLogWhereInput {
  const rule = AUDIT_VIEW_ACTIONS[view]
  return {
    OR: [...rule.prefixes.map((prefix) => ({ action: { startsWith: prefix } })), ...(rule.contains ?? []).map((part) => ({ action: { contains: part } }))],
  }
}

export interface AuditListQuery {
  readonly actorId?: string | undefined
  readonly audience?: AuditEntryView['audience'] | undefined
  readonly recordType?: string | undefined
  readonly recordId?: string | undefined
  readonly action?: string | undefined
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly requestId?: string | undefined
  readonly view?: AuditViewName | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly before?: string | undefined
  readonly limit: number
  readonly withCounts?: boolean | undefined
}

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

function instantOf(value: string | undefined, path: string): Date | undefined {
  if (value === undefined) return undefined
  const parsed = parseInstant(value)
  if (parsed === null) throw new ValidationError('Not a time.', [{ path: `querystring/${path}`, message: 'Expected an ISO 8601 time with a zone.' }])
  return parsed
}

/**
 * The audit log across records (GET /audit): the caller's audit.read scope, the filters, newest first, `limit` a page.
 * A read, so no command(). The time window bounds the counts of the saved views too.
 */
export async function listAudit(
  client: FactoryClient,
  actor: Actor,
  query: AuditListQuery,
): Promise<{ entries: AuditListEntryView[]; nextBefore: string | null; counts: Record<AuditViewName, number> | null }> {
  const scope = scopeWhere(actor, AUDIT_READ, AUDIT_SCOPE_COLUMNS) as Prisma.AuditLogWhereInput
  const from = instantOf(query.from, 'from')
  const to = instantOf(query.to, 'to')
  const window: Prisma.AuditLogWhereInput = from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}
  const own: Prisma.AuditLogWhereInput[] = [
    ...(query.actorId ? [{ actorId: query.actorId }] : []),
    ...(query.audience ? [{ audience: query.audience }] : []),
    ...(query.recordType ? [{ recordType: query.recordType }] : []),
    ...(query.recordId ? [{ recordId: query.recordId }] : []),
    ...(query.action ? [{ action: { startsWith: query.action } }] : []),
    ...(query.companyId ? [{ companyId: query.companyId }] : []),
    ...(query.siteId ? [{ siteId: query.siteId }] : []),
    ...(query.requestId ? [{ requestId: query.requestId }] : []),
    ...(query.view ? [viewWhere(query.view)] : []),
  ]
  let page: Prisma.AuditLogWhereInput = {}
  if (query.before) {
    const anchor = await client.auditLog.findFirst({ where: { AND: [scope, { id: query.before }] }, select: { id: true, at: true } })
    if (!anchor) throw new ValidationError('No such entry to page from.', [{ path: 'querystring/before', message: 'Not an entry of this log.' }])
    page = { OR: [{ at: { lt: anchor.at } }, { at: anchor.at, id: { lt: anchor.id } }] }
  }
  const rows = await client.auditLog.findMany({
    where: { AND: [scope, window, ...own, page] },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    select: ENTRY_SELECT,
  })
  const more = rows.length > query.limit
  const shown = more ? rows.slice(0, query.limit) : rows
  const officeIds = [...new Set(shown.filter((row) => row.audience === 'OFFICE').map((row) => row.actorId))]
  const deviceIds = [...new Set(shown.flatMap((row) => (row.deviceId ? [row.deviceId] : [])))]
  const [people, devices] = await Promise.all([
    officeIds.length > 0 ? client.user.findMany({ where: { id: { in: officeIds } }, select: { id: true, displayName: true } }) : Promise.resolve([]),
    deviceIds.length > 0 ? client.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ])
  const personName = new Map(people.map((person) => [person.id, person.displayName]))
  const deviceName = new Map(devices.map((device) => [device.id, device.name]))
  const entries = shown.map((row) => ({
    ...row,
    at: toUtcIso(row.at),
    deviceTime: row.deviceTime ? toUtcIso(row.deviceTime) : null,
    actorName: row.audience === 'OFFICE' ? (personName.get(row.actorId) ?? null) : null,
    deviceName: row.deviceId ? (deviceName.get(row.deviceId) ?? null) : null,
  }))
  let counts: Record<AuditViewName, number> | null = null
  if (query.withCounts) {
    const count = (view: AuditViewName) => client.auditLog.count({ where: { AND: [scope, window, viewWhere(view)] } })
    const [roles, access, deletes, settings] = await Promise.all([count('roles'), count('access'), count('deletes'), count('settings')])
    counts = { roles, access, deletes, settings }
  }
  return { entries, nextBefore: more ? shown[shown.length - 1]!.id : null, counts }
}
