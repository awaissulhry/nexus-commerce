import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { scopeWhere, type Actor, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { AuditEntryView } from './contract'

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
