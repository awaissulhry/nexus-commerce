import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { ApprovalKind, ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTools, CommandTx } from '../../core/command'
import type { RequestRef } from './adapter'

/**
 * Every read and write of ApprovalRequest outside the adapters (B-W2b-184; links-depth.prisma, B-W2b-154). The partner role
 * reads its own party's requests but never `createdById` or `withdrawnById` (hidden columns): PARTNER_COLUMNS leaves them
 * out. Its files are StoredFiles of record type ApprovalRequest (copies of the record's, shared with the party).
 */

type Client = FactoryClient | CommandTx

export const RECORD = 'ApprovalRequest'
/** The partner task's source key of a request (platform/portal/tasks/sources: prefix ApprovalRequest). */
export const sourceKeyOf = (requestId: string): string => `${RECORD}:${requestId}`

export const PARTNER_COLUMNS = {
  id: true,
  companyId: true,
  recordType: true,
  recordId: true,
  partyId: true,
  contactId: true,
  kind: true,
  question: true,
  dueAt: true,
  status: true,
  answer: true,
  typedName: true,
  markupFileId: true,
  answeredAt: true,
  answeredByUserId: true,
  answeredViaLinkId: true,
  withdrawnAt: true,
  withdrawReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ApprovalRequestSelect

export const OFFICE_COLUMNS = { ...PARTNER_COLUMNS, createdById: true, withdrawnById: true } as const satisfies Prisma.ApprovalRequestSelect

export type PartnerRow = Prisma.ApprovalRequestGetPayload<{ select: typeof PARTNER_COLUMNS }>
export type OfficeRow = Prisma.ApprovalRequestGetPayload<{ select: typeof OFFICE_COLUMNS }>

export const refOf = (row: PartnerRow): RequestRef => ({
  id: row.id,
  companyId: row.companyId,
  kind: row.kind as ApprovalKind,
  recordType: row.recordType,
  recordId: row.recordId,
  partyId: row.partyId,
  status: row.status,
  answer: row.answer,
  typedName: row.typedName,
  answeredAt: row.answeredAt,
})

export async function readPartner(client: Client, id: string): Promise<PartnerRow | null> {
  return client.approvalRequest.findUnique({ where: { id }, select: PARTNER_COLUMNS })
}

export async function readOfficeRow(client: Client, id: string): Promise<OfficeRow | null> {
  return client.approvalRequest.findUnique({ where: { id }, select: OFFICE_COLUMNS })
}

/** The request locked for the command (FOR UPDATE: the partner role may, it updates the row), at the version the page read. */
export async function lockRequest(tx: CommandTx, id: string, version?: number): Promise<PartnerRow> {
  await tx.$queryRaw`SELECT 1 FROM "ApprovalRequest" WHERE "id" = ${id}::uuid FOR UPDATE`
  const row = await readPartner(tx, id)
  if (!row) throw new NotFoundError('Approval request not found.')
  if (version !== undefined && row.version !== version) throw new ConflictError(`This request changed since you read it (now version ${row.version}). Read it again.`)
  return row
}

/** The request's files (the copies shared with the party), oldest first. */
export async function filesOf(client: Client, requestId: string) {
  return client.storedFile.findMany({
    where: { recordType: RECORD, recordId: requestId, status: 'AVAILABLE', supersededAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, originalName: true, contentType: true, sizeBytes: true, kind: true },
  })
}

/** The live APPROVAL links of a request stop working (revoked; their evidence stays). Returns their ids. */
export async function revokeLinksInCommand(tools: Pick<CommandTools, 'tx' | 'now' | 'audit'>, request: { readonly id: string; readonly companyId: string }, actorId: string | null): Promise<string[]> {
  const rows = await tools.tx.oneOffLink.findMany({ where: { purpose: 'APPROVAL', recordType: RECORD, recordId: request.id, revokedAt: null }, select: { id: true, expiresAt: true, uses: true, maxUses: true, revokedAt: true } })
  const ids = rows.filter((link) => linkState(link, tools.now) === 'LIVE').map((link) => link.id)
  if (ids.length === 0) return []
  await tools.tx.oneOffLink.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: tools.now, revokedById: actorId } })
  for (const id of ids) tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: id, companyId: request.companyId, after: { revokedAt: toUtcIso(tools.now) } })
  return ids
}

/** "it" unless the person's or contact's language starts with "en". */
export const localeOf = (value: string | null | undefined): ApprovalLocale => (value?.toLowerCase().startsWith('en') ? 'en' : 'it')
