import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { PlannedChange, ProfileRequestState } from '@nexus/factory-domain/purchasing/portal-profile/profile'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'

/**
 * Where a supplier's portal uploads and profile change requests are kept (B-W2b-189). The schema has no table for either
 * (Schema needs in the step's notes: a SupplierDocumentUpload and a PartyChangeRequest), so — as B-W2a-41 kept its first-load
 * steps until FirstLoadStep — they are AUDIT ROWS on the supplier's own record (AuditLog recordType `Party`, recordId the
 * party: the party's history shows them, and one indexed read finds them all):
 *
 *   supplierDocuments.upload        the supplier announced a document: the file (a StoredFile of the party or of one of its
 *                                   records, OFFICE only), what it says it is (kind, issuer, number, dates, articles, lots),
 *                                   the request it answers, the document it replaces, who
 *   supplierDocuments.received      the file arrived (AVAILABLE or held for its scan): the request it answered closed
 *   supplierDocuments.accept        a buyer or quality person accepted it (kind, until when, the file now in force)
 *   supplierDocuments.refuse        they refused it (the reason)
 *   supplierProfile.requestChange   the supplier sent changes of its addresses and contacts (the planned changes, old → new)
 *   supplierProfile.withdrawChange  the supplier withdrew them
 *   supplierProfile.approveChange   the buyer approved them (applied in the same command)
 *   supplierProfile.refuseChange    the buyer refused them (the reason)
 *
 * Every command that writes one of these first locks the party's row (FOR UPDATE), so what it reads of the earlier rows is
 * final. The rows are written in the office scope (as the partner person for the supplier's own acts: `byPartner`), and read
 * in the office or the tenant's system scope, always filtered to one party (or, for the office's lists, to the parties the
 * reader may check).
 */

export const ACTIONS = Object.freeze({
  upload: 'supplierDocuments.upload',
  received: 'supplierDocuments.received',
  accept: 'supplierDocuments.accept',
  refuse: 'supplierDocuments.refuse',
  request: 'supplierProfile.requestChange',
  withdraw: 'supplierProfile.withdrawChange',
  approve: 'supplierProfile.approveChange',
  refuseChange: 'supplierProfile.refuseChange',
})
const DOCUMENT_ACTIONS = [ACTIONS.upload, ACTIONS.received, ACTIONS.accept, ACTIONS.refuse]
const PROFILE_ACTIONS = [ACTIONS.request, ACTIONS.withdraw, ACTIONS.approve, ACTIONS.refuseChange]
/** How far back the office's lists and Today look for open items (older ones still show on the party). */
export const LOOK_BACK_DAYS = 365

type Reader = Pick<FactoryClient | CommandTx, 'auditLog'>

const AUDIT_SELECT = { id: true, action: true, at: true, actorId: true, companyId: true, recordId: true, after: true, reason: true } as const satisfies Prisma.AuditLogSelect
type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_SELECT }>

const obj = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const strs = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

// ---- documents --------------------------------------------------------------------------------------------------------

export interface UploadDecision {
  readonly kind: 'ACCEPTED' | 'REFUSED'
  readonly at: Date
  readonly byId: string
  readonly byName: string | null
  readonly documentFileId: string | null
  readonly category: string | null
  readonly expiresOn: string | null
  readonly reason: string | null
}

/** One upload of a supplier, as the audit rows tell it. */
export interface UploadRecord {
  readonly fileId: string
  readonly partyId: string
  readonly companyId: string | null
  readonly at: Date
  readonly recordType: string
  readonly recordId: string
  readonly recordLabel: string
  readonly category: string
  readonly issuer: string | null
  readonly number: string | null
  readonly issuedOn: string | null
  readonly expiresOn: string | null
  readonly articles: readonly string[]
  readonly lots: readonly string[]
  readonly note: string | null
  readonly replacesFileId: string | null
  readonly taskId: string | null
  readonly personId: string
  readonly personName: string | null
  readonly received: boolean
  readonly decision: UploadDecision | null
}

function uploadsOf(rows: readonly AuditRow[]): UploadRecord[] {
  const uploads = new Map<string, UploadRecord>()
  const received = new Set<string>()
  const decisions = new Map<string, UploadDecision>()
  for (const row of rows) {
    const after = obj(row.after)
    const fileId = str(after.fileId)
    if (!fileId) continue
    if (row.action === ACTIONS.upload) {
      uploads.set(fileId, {
        fileId,
        partyId: row.recordId,
        companyId: row.companyId,
        at: row.at,
        recordType: str(after.recordType) ?? 'Party',
        recordId: str(after.recordId) ?? row.recordId,
        recordLabel: str(after.recordLabel) ?? '',
        category: str(after.category) ?? 'SUPPLIER_CERTIFICATE',
        issuer: str(after.issuer),
        number: str(after.number),
        issuedOn: str(after.issuedOn),
        expiresOn: str(after.expiresOn),
        articles: strs(after.articles),
        lots: strs(after.lots),
        note: str(after.note),
        replacesFileId: str(after.replacesFileId),
        taskId: str(after.taskId),
        personId: str(after.personId) ?? row.actorId,
        personName: str(after.personName),
        received: false,
        decision: null,
      })
    } else if (row.action === ACTIONS.received) {
      received.add(fileId)
    } else if (row.action === ACTIONS.accept || row.action === ACTIONS.refuse) {
      // The first decision stands (a decision is final; the file's version guards a second one).
      if (decisions.has(fileId)) continue
      decisions.set(fileId, {
        kind: row.action === ACTIONS.accept ? 'ACCEPTED' : 'REFUSED',
        at: row.at,
        byId: row.actorId,
        byName: str(after.byName),
        documentFileId: str(after.documentFileId),
        category: str(after.category),
        expiresOn: str(after.expiresOn),
        reason: row.reason ?? null,
      })
    }
  }
  return [...uploads.values()].map((upload) => ({ ...upload, received: received.has(upload.fileId), decision: decisions.get(upload.fileId) ?? null }))
}

/** A party's uploads, oldest first (every one: a party sends a handful a year). */
export async function partyUploads(client: Reader, partyId: string): Promise<UploadRecord[]> {
  const rows = await client.auditLog.findMany({ where: { recordType: 'Party', recordId: partyId, action: { in: DOCUMENT_ACTIONS } }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: AUDIT_SELECT, take: 5000 })
  return uploadsOf(rows)
}

/** The uploads of every party (or one) in the last year, for the office's lists and Today. */
export async function recentUploads(client: Reader, since: Date, partyId?: string): Promise<UploadRecord[]> {
  const rows = await client.auditLog.findMany({
    where: { recordType: 'Party', ...(partyId ? { recordId: partyId } : {}), action: { in: DOCUMENT_ACTIONS }, at: { gte: since } },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
    select: AUDIT_SELECT,
    take: 20000,
  })
  return uploadsOf(rows)
}

/** The upload of a file (any party), or null. */
export async function uploadOfFile(client: Reader, fileId: string): Promise<UploadRecord | null> {
  const first = await client.auditLog.findFirst({ where: { recordType: 'Party', action: ACTIONS.upload, after: { path: ['fileId'], equals: fileId } }, select: { recordId: true } })
  if (!first) return null
  return (await partyUploads(client, first.recordId)).find((upload) => upload.fileId === fileId) ?? null
}

// ---- profile change requests ----------------------------------------------------------------------------------------------

export interface ChangeRequest {
  readonly requestId: string
  readonly partyId: string
  readonly companyId: string | null
  readonly at: Date
  readonly personId: string
  readonly personName: string | null
  readonly changes: readonly PlannedChange[]
  readonly summary: string
  readonly note: string | null
  readonly state: ProfileRequestState
  readonly decidedAt: Date | null
  readonly decidedById: string | null
  readonly decidedByName: string | null
  readonly reason: string | null
}

function requestsOf(rows: readonly AuditRow[]): ChangeRequest[] {
  const requests = new Map<string, ChangeRequest>()
  // The requests first, then the decisions in order (rows written in the same millisecond may sort either way).
  for (const row of rows) {
    const after = obj(row.after)
    const requestId = str(after.requestId)
    if (!requestId || row.action !== ACTIONS.request) continue
    requests.set(requestId, {
      requestId,
      partyId: row.recordId,
      companyId: row.companyId,
      at: row.at,
      personId: str(after.personId) ?? row.actorId,
      personName: str(after.personName),
      changes: Array.isArray(after.changes) ? (after.changes as PlannedChange[]) : [],
      summary: str(after.summary) ?? '',
      note: str(after.note),
      state: 'OPEN',
      decidedAt: null,
      decidedById: null,
      decidedByName: null,
      reason: null,
    })
  }
  for (const row of rows) {
    const after = obj(row.after)
    const requestId = str(after.requestId)
    if (!requestId || row.action === ACTIONS.request) continue
    const request = requests.get(requestId)
    if (!request || request.state !== 'OPEN') continue
    const state: ProfileRequestState = row.action === ACTIONS.approve ? 'APPROVED' : row.action === ACTIONS.refuseChange ? 'REFUSED' : 'WITHDRAWN'
    requests.set(requestId, { ...request, state, decidedAt: row.at, decidedById: row.actorId, decidedByName: str(after.byName), reason: row.reason ?? null })
  }
  return [...requests.values()]
}

/** A party's change requests, oldest first. */
export async function partyRequests(client: Reader, partyId: string): Promise<ChangeRequest[]> {
  const rows = await client.auditLog.findMany({ where: { recordType: 'Party', recordId: partyId, action: { in: PROFILE_ACTIONS } }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: AUDIT_SELECT, take: 5000 })
  return requestsOf(rows)
}

/** Every party's (or one's) change requests of the last year, for the office's list and Today. */
export async function recentRequests(client: Reader, since: Date, partyId?: string): Promise<ChangeRequest[]> {
  const rows = await client.auditLog.findMany({
    where: { recordType: 'Party', ...(partyId ? { recordId: partyId } : {}), action: { in: PROFILE_ACTIONS }, at: { gte: since } },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
    select: AUDIT_SELECT,
    take: 20000,
  })
  return requestsOf(rows)
}

/** The party a request belongs to, or null. */
export async function partyOfRequest(client: Reader, requestId: string): Promise<string | null> {
  const row = await client.auditLog.findFirst({ where: { recordType: 'Party', action: ACTIONS.request, after: { path: ['requestId'], equals: requestId } }, select: { recordId: true } })
  return row?.recordId ?? null
}

// ---- callers ------------------------------------------------------------------------------------------------------------

/** The supplier's party row, locked for the rest of the command (its uploads' and requests' audit rows are read after it). */
export async function lockSupplier(tx: CommandTx, partyId: string): Promise<{ readonly status: string; readonly companyId: string | null; readonly code: string; readonly legalName: string }> {
  const rows = await tx.$queryRaw<{ status: string; companyId: string | null; code: string; legalName: string }[]>`
    SELECT "status"::text AS "status", "companyId"::text AS "companyId", "code", "legalName" FROM "Party" WHERE "id" = ${partyId}::uuid FOR UPDATE`
  const row = rows[0]
  if (!row) throw new NotFoundError('Party not found.')
  return row
}

/**
 * The tenant's system caller with files.upload and files.manage over exactly this company and party (as the supplier's
 * confirmation PDF on its link, purchasing/confirm/upload.ts): the partner role writes no file row, so the files module is
 * called this way AFTER the portal session, its party and its capability were checked here.
 */
export function supplierUploader(request: FastifyRequest, tenantId: string, companyId: string, partyId: string): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [companyId], sites: 'all', parties: [partyId] }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

export const iso = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))

/** A second command's key from the request's own (or none). */
export const keyFor = (key: string | undefined, suffix: string): string | undefined => (key === undefined ? undefined : `${key.slice(0, 120)}:${suffix}`)
