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
 * Where a supplier's portal uploads and profile change requests are kept (B-W2b-189; since W2b schema wave 23, B-W2b-F12 /
 * B-W2b-F13a, in tables of their own: factory-db portal-followups.prisma). This file is their ONLY reader and writer's
 * helper:
 *
 *   SupplierDocumentUpload   one row per document a supplier announced (the file, what it says it is, the record it is for,
 *                            the request it answers, the document it replaces, who); `receivedAt` once the file arrived;
 *                            WAITING → ACCEPTED (the kind and expiry confirmed, the file in force) | REFUSED (why), once
 *   PartyChangeRequest       one row per request to change the supplier's addresses, contacts and website (the planned
 *                            changes old → new); OPEN → APPROVED | REFUSED (why) | WITHDRAWN, once; `version` is the
 *                            compare-and-set every change moves by exactly one
 *
 * The …_portal_followups_w2b_guards triggers hold the states for every login; the API checks first and says it in words. The
 * rows are written in the office scope (as the partner person for the supplier's own acts) and read in the office or the
 * tenant's system scope, always filtered to one party (or, for the office's lists, to the parties the reader may check). Each
 * act still writes its audit row on the supplier's record (recordType `Party`, the actions below), as before: the party's
 * history shows them. The audit rows written before wave 23 are kept as history; the factory had no live deployment then, so
 * no row was copied (the step's notes).
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
/** How far back the office's lists and Today look for decided items (what still waits shows whatever its age). */
export const LOOK_BACK_DAYS = 365

const dayText = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10))

// ---- documents --------------------------------------------------------------------------------------------------------

type UploadReader = Pick<FactoryClient | CommandTx, 'supplierDocumentUpload'>

export const UPLOAD_SELECT = {
  id: true,
  companyId: true,
  partyId: true,
  fileId: true,
  recordType: true,
  recordId: true,
  recordLabel: true,
  category: true,
  issuer: true,
  documentNumber: true,
  issuedOn: true,
  expiresOn: true,
  articleCodes: true,
  lotCodes: true,
  note: true,
  replacesFileId: true,
  taskId: true,
  uploadedById: true,
  uploadedByName: true,
  receivedAt: true,
  status: true,
  decidedAt: true,
  decidedById: true,
  decidedByName: true,
  acceptedCategory: true,
  acceptedExpiresOn: true,
  documentFileId: true,
  refuseReason: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.SupplierDocumentUploadSelect
type UploadRow = Prisma.SupplierDocumentUploadGetPayload<{ select: typeof UPLOAD_SELECT }>

export interface UploadDecision {
  readonly kind: 'ACCEPTED' | 'REFUSED'
  readonly at: Date
  readonly byId: string | null
  readonly byName: string | null
  readonly documentFileId: string | null
  readonly category: string | null
  readonly expiresOn: string | null
  readonly reason: string | null
}

/** One upload of a supplier (a SupplierDocumentUpload row). */
export interface UploadRecord {
  readonly id: string
  readonly version: number
  readonly fileId: string
  readonly partyId: string
  readonly companyId: string
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
  readonly receivedAt: Date | null
  readonly decision: UploadDecision | null
}

export function uploadOf(row: UploadRow): UploadRecord {
  return {
    id: row.id,
    version: row.version,
    fileId: row.fileId,
    partyId: row.partyId,
    companyId: row.companyId,
    at: row.createdAt,
    recordType: row.recordType,
    recordId: row.recordId,
    recordLabel: row.recordLabel,
    category: row.category,
    issuer: row.issuer,
    number: row.documentNumber,
    issuedOn: dayText(row.issuedOn),
    expiresOn: dayText(row.expiresOn),
    articles: [...row.articleCodes],
    lots: [...row.lotCodes],
    note: row.note,
    replacesFileId: row.replacesFileId,
    taskId: row.taskId,
    personId: row.uploadedById,
    personName: row.uploadedByName,
    received: row.receivedAt !== null,
    receivedAt: row.receivedAt,
    decision:
      row.status === 'WAITING' || row.decidedAt === null
        ? null
        : {
            kind: row.status === 'ACCEPTED' ? 'ACCEPTED' : 'REFUSED',
            at: row.decidedAt,
            byId: row.decidedById,
            byName: row.decidedByName,
            documentFileId: row.documentFileId,
            category: row.acceptedCategory,
            expiresOn: dayText(row.acceptedExpiresOn),
            reason: row.refuseReason,
          },
  }
}

const OLDEST_FIRST = [{ createdAt: 'asc' }, { id: 'asc' }] as const satisfies Prisma.SupplierDocumentUploadOrderByWithRelationInput[]

/** A party's uploads, oldest first (every one: a party sends a handful a year). */
export async function partyUploads(client: UploadReader, partyId: string): Promise<UploadRecord[]> {
  return (await client.supplierDocumentUpload.findMany({ where: { partyId }, orderBy: [...OLDEST_FIRST], select: UPLOAD_SELECT, take: 5000 })).map(uploadOf)
}

/** The uploads of every party (or one): every one still WAITING, and the others of the last year (the office's lists, Today). */
export async function recentUploads(client: UploadReader, since: Date, partyId?: string): Promise<UploadRecord[]> {
  const rows = await client.supplierDocumentUpload.findMany({
    where: { ...(partyId ? { partyId } : {}), OR: [{ status: 'WAITING' }, { createdAt: { gte: since } }] },
    orderBy: [...OLDEST_FIRST],
    select: UPLOAD_SELECT,
    take: 20000,
  })
  return rows.map(uploadOf)
}

/** The upload of a file (any party), or null (one upload per file: the API's rule). */
export async function uploadOfFile(client: UploadReader, fileId: string): Promise<UploadRecord | null> {
  const row = await client.supplierDocumentUpload.findFirst({ where: { fileId }, orderBy: [...OLDEST_FIRST], select: UPLOAD_SELECT })
  return row ? uploadOf(row) : null
}

// ---- profile change requests ----------------------------------------------------------------------------------------------

type RequestReader = Pick<FactoryClient | CommandTx, 'partyChangeRequest'>

export const REQUEST_SELECT = {
  id: true,
  companyId: true,
  partyId: true,
  requestedById: true,
  requestedByName: true,
  changes: true,
  summary: true,
  note: true,
  status: true,
  decidedAt: true,
  decidedById: true,
  decidedByName: true,
  refuseReason: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.PartyChangeRequestSelect
type RequestRow = Prisma.PartyChangeRequestGetPayload<{ select: typeof REQUEST_SELECT }>

export interface ChangeRequest {
  readonly requestId: string
  readonly version: number
  readonly partyId: string
  readonly companyId: string
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

export function requestOf(row: RequestRow): ChangeRequest {
  return {
    requestId: row.id,
    version: row.version,
    partyId: row.partyId,
    companyId: row.companyId,
    at: row.createdAt,
    personId: row.requestedById,
    personName: row.requestedByName,
    changes: Array.isArray(row.changes) ? (row.changes as unknown as PlannedChange[]) : [],
    summary: row.summary,
    note: row.note,
    state: row.status,
    decidedAt: row.decidedAt,
    decidedById: row.decidedById,
    decidedByName: row.decidedByName,
    reason: row.refuseReason,
  }
}

const REQUESTS_OLDEST_FIRST = [{ createdAt: 'asc' }, { id: 'asc' }] as const satisfies Prisma.PartyChangeRequestOrderByWithRelationInput[]

/** A party's change requests, oldest first. */
export async function partyRequests(client: RequestReader, partyId: string): Promise<ChangeRequest[]> {
  return (await client.partyChangeRequest.findMany({ where: { partyId }, orderBy: [...REQUESTS_OLDEST_FIRST], select: REQUEST_SELECT, take: 5000 })).map(requestOf)
}

/** Every party's (or one's) change requests: every OPEN one, and the others of the last year (the office's list, Today). */
export async function recentRequests(client: RequestReader, since: Date, partyId?: string): Promise<ChangeRequest[]> {
  const rows = await client.partyChangeRequest.findMany({
    where: { ...(partyId ? { partyId } : {}), OR: [{ status: 'OPEN' }, { createdAt: { gte: since } }] },
    orderBy: [...REQUESTS_OLDEST_FIRST],
    select: REQUEST_SELECT,
    take: 20000,
  })
  return rows.map(requestOf)
}

/** One request by its id, or null. */
export async function requestById(client: RequestReader, requestId: string): Promise<ChangeRequest | null> {
  const row = await client.partyChangeRequest.findUnique({ where: { id: requestId }, select: REQUEST_SELECT })
  return row ? requestOf(row) : null
}

// ---- callers ------------------------------------------------------------------------------------------------------------

/**
 * The supplier's party row, locked for the rest of the command: the acts that check before they insert (one upload per
 * file, one open request per address, contact or website) take it, so two of them never both pass the check.
 */
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
