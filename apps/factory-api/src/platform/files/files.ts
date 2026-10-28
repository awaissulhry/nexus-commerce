import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission, type ScopeColumns, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, type CommandCaller } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { GatewayCallFailed, GatewayRefusal } from '../gateway/gateway'
import { systemContext } from '../outbox/system'
import type { FileView } from './contract'
import { FILES_DELETE, FILES_MANAGE, FILES_READ, FILES_UPLOAD } from './permissions'
import type { PresignedRequest, StoredObject } from './port'
import {
  attachmentDisposition,
  audienceSees,
  cleanFileName,
  DOWNLOAD_URL_SECONDS,
  fileMachine,
  normaliseContentType,
  normaliseVisibility,
  retentionFor,
  sharingProblems,
  storageKeyFor,
  UPLOAD_URL_SECONDS,
  uploadProblems,
  type FileAudience,
  type FileKind,
  type QuarantineReason,
  type Sharing,
  type Viewer,
} from './rules'
import type { FilesRuntime } from './service'
import { RetainedFileError } from './store'

/**
 * Files on R2 (plan A1 §3.6; features COL-045, COL-050, PLT-011; PLAN §2.8), the flow:
 *
 *   upload     POST /files: the kind's content types and size limit, the sharing, the retention (a fiscal archive
 *              file: ten years at least) → files.requestUpload writes the row PENDING_UPLOAD under a new random key
 *              → a presigned PUT (5 minutes; type, size and SHA-256 signed) from the tenant's file store
 *   confirm    POST /files/:id/complete: the store's HEAD; size, type and SHA-256 as announced → AVAILABLE (and the
 *              event file.available), anything else → QUARANTINED with the reason; not there yet → 409, still pending
 *   download   the audience check (COL-050: office always; a floor device, a portal or a link only what is shared with
 *              it, row-level security first) and can(files.read) → a presigned GET (60 seconds, as an attachment).
 *              Floor, portal and link callers presign as their tenant's system context: the gateway calls for office
 *              and system callers only
 *   delete     refused while on legal hold or before the retention date (the state machine's guard, the database's
 *              trigger) → DELETED, then the object is removed from the store
 *   share      files.setVisibility; retention and legal hold: files.setRetention (the date only moves later)
 *
 * Every write goes through command() with its audit row; no store call runs inside a transaction.
 */

const COMMON = {
  id: true,
  companyId: true,
  recordType: true,
  recordId: true,
  kind: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  sha256: true,
  storeAccountId: true,
  storageKey: true,
  status: true,
  visibility: true,
  retainUntil: true,
  quarantineReason: true,
  availableAt: true,
  deletedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.StoredFileSelect

/** What each audience's role may read (its hidden columns left out: a forgotten one would fail loudly). */
const SELECT_FOR = {
  office: { ...COMMON, floorSiteId: true, partyId: true, legalHold: true },
  floor: { ...COMMON, floorSiteId: true },
  partner: { ...COMMON, partyId: true },
} as const satisfies Record<string, Prisma.StoredFileSelect>

type Row = Prisma.StoredFileGetPayload<{ select: typeof COMMON }> & { floorSiteId?: string | null; partyId?: string | null; legalHold?: boolean }
type OfficeRow = Prisma.StoredFileGetPayload<{ select: (typeof SELECT_FOR)['office'] }>

const selectFor = (context: RequestContext): Prisma.StoredFileSelect =>
  context.audience === 'floor' ? SELECT_FOR.floor : context.audience === 'partner' || context.audience === 'link' ? SELECT_FOR.partner : SELECT_FOR.office
const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

export function viewOf(row: Row): FileView {
  return {
    id: row.id,
    companyId: row.companyId,
    recordType: row.recordType,
    recordId: row.recordId,
    kind: row.kind,
    originalName: row.originalName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    status: row.status,
    visibility: row.visibility,
    ...('floorSiteId' in row ? { floorSiteId: row.floorSiteId ?? null } : {}),
    ...('partyId' in row ? { partyId: row.partyId ?? null } : {}),
    retainUntil: iso(row.retainUntil),
    ...('legalHold' in row ? { legalHold: row.legalHold } : {}),
    quarantineReason: row.quarantineReason as QuarantineReason | null,
    availableAt: iso(row.availableAt),
    deletedAt: iso(row.deletedAt),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** What an audit row records of a file (its content and sharing; never the storage key). */
const audited = (row: OfficeRow) => ({
  recordType: row.recordType,
  recordId: row.recordId,
  kind: row.kind,
  originalName: row.originalName,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  status: row.status,
  visibility: row.visibility,
  floorSiteId: row.floorSiteId,
  partyId: row.partyId,
  retainUntil: iso(row.retainUntil),
  legalHold: row.legalHold,
})

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

/** The caller's tenant (every audience of these routes has one). */
function tenantOf(context: RequestContext): string {
  if (context.audience === 'platform') throw new ApiError('internal_error', 'Files belong to a tenant; the platform audience has none.')
  return context.tenantId
}

function viewerOf(context: RequestContext): Viewer {
  switch (context.audience) {
    case 'office':
    case 'system':
      return { audience: context.audience }
    case 'floor':
      return { audience: 'floor', siteId: context.siteId }
    case 'partner':
      return { audience: 'partner', partyId: context.partyId }
    case 'link':
      return { audience: 'link', partyId: context.partyId, record: context.record }
    default:
      return { audience: 'platform' }
  }
}

/** The scope can() checks a file against: its company, and the site or party the caller sees it through. */
function scopeOf(context: RequestContext, row: Row): ScopedRecord {
  if (context.audience === 'floor') return { companyId: row.companyId, siteId: row.floorSiteId ?? null }
  if (context.audience === 'partner' || context.audience === 'link') return { companyId: row.companyId, partyId: row.partyId ?? null }
  return { companyId: row.companyId }
}

/** A write needs the permission for the file's company and for the site and party it is shared with. */
function mayWrite(caller: CommandCaller, permission: Permission, sharing: Pick<Sharing, 'companyId' | 'floorSiteId' | 'partyId'>): void {
  if (!can(actorOf(contextOf(caller)), permission, { companyId: sharing.companyId, siteId: sharing.floorSiteId, partyId: sharing.partyId })) throw new ForbiddenError()
}

async function readRow(caller: CommandCaller, fileId: string): Promise<Row> {
  const context = contextOf(caller)
  if (!isUuid(fileId)) throw new NotFoundError('File not found.')
  const row = (await caller.withClient((client) => client.storedFile.findUnique({ where: { id: fileId }, select: selectFor(context) }))) as Row | null
  if (!row) throw new NotFoundError('File not found.')
  return row
}

/** The file as the caller may see it: anything it may not see (another audience's, out of its scope) is not found. */
async function readVisible(caller: CommandCaller, fileId: string): Promise<Row> {
  const context = contextOf(caller)
  const row = await readRow(caller, fileId)
  const office = context.audience === 'office'
  if (!audienceSees(viewerOf(context), row) || (!office && row.status !== 'AVAILABLE') || !can(actorOf(context), FILES_READ, scopeOf(context, row))) {
    throw new NotFoundError('File not found.')
  }
  return row
}

const readOffice = async (caller: CommandCaller, fileId: string): Promise<OfficeRow> => (await readRow(caller, fileId)) as OfficeRow

/** A store call's failure for the caller: the store is not reachable now (503), a retained object (409). */
async function storeCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof RetainedFileError) throw new ConflictError(error.message)
    if (error instanceof GatewayRefusal || error instanceof GatewayCallFailed) {
      throw new ApiError('not_ready', 'The file store is not available right now; nothing was changed in it. Try again shortly.')
    }
    throw error
  }
}

/**
 * The tenant's file store: its R2 account (any mode) that is not DISABLED, the company's own before the tenant-wide
 * one. None, or two at the same level, is a set-up problem (409).
 */
async function storeAccountOf(caller: CommandCaller, companyId: string | null): Promise<string> {
  const accounts = await caller.withClient((client) =>
    client.integrationAccount.findMany({
      where: { provider: 'R2', status: { not: 'DISABLED' }, OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] },
      select: { id: true, companyId: true },
      orderBy: { id: 'asc' },
    }),
  )
  const own = accounts.filter((account) => companyId !== null && account.companyId === companyId)
  const chosen = own.length > 0 ? own : accounts.filter((account) => account.companyId === null)
  if (chosen.length === 0) throw new ConflictError('Files are not set up: this tenant has no file store (an R2 account).')
  if (chosen.length > 1) throw new ConflictError('This tenant has more than one file store for these files; disable the ones not in use.')
  return chosen[0]!.id
}

async function checkSite(tx: Pick<FactoryClient, 'site'>, sharing: Sharing): Promise<void> {
  if (sharing.floorSiteId === null) return
  const site = await tx.site.findFirst({ where: { id: sharing.floorSiteId, companyId: sharing.companyId ?? undefined }, select: { id: true } })
  if (!site) throw new ValidationError('The site is not one of the file\'s company.', [{ path: 'body/floorSiteId', message: 'Expected a site of the file\'s company.' }])
}

const presignedView = (request: PresignedRequest) => ({ method: request.method, url: request.url, headers: { ...request.headers }, expiresAt: toUtcIso(request.expiresAt) })

export interface UploadRequest {
  readonly companyId?: string | null | undefined
  readonly recordType: string
  readonly recordId: string
  readonly kind: FileKind
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly visibility?: readonly FileAudience[] | undefined
  readonly floorSiteId?: string | null | undefined
  readonly partyId?: string | null | undefined
  readonly retainUntil?: string | null | undefined
}

/** files.requestUpload, then the presigned PUT. A repeat with the same Idempotency-Key gets the same file, freshly presigned. */
export async function requestUpload(runtime: FilesRuntime, caller: CommandCaller, input: UploadRequest, idempotencyKey?: string) {
  const now = runtime.clock.now()
  const contentType = normaliseContentType(input.contentType)
  const originalName = cleanFileName(input.originalName)
  const sharing: Sharing = {
    visibility: normaliseVisibility(input.visibility),
    companyId: input.companyId ?? null,
    floorSiteId: input.floorSiteId ?? null,
    partyId: input.partyId ?? null,
  }
  const retention = retentionFor(input.kind, input.retainUntil ? new Date(input.retainUntil) : null, now)
  const problems: Issue[] = [
    ...uploadProblems({ kind: input.kind, contentType, sizeBytes: input.sizeBytes, sha256: input.sha256 }),
    ...(originalName === null ? [{ path: 'body/originalName', message: 'The file needs a name.' }] : []),
    ...sharingProblems(sharing),
    ...retention.problems,
  ]
  if (problems.length > 0) throw new ValidationError('The upload is not valid.', problems)
  mayWrite(caller, FILES_UPLOAD, sharing)
  const storeAccountId = await storeAccountOf(caller, sharing.companyId)

  const { result } = await command(caller, { name: 'files.requestUpload', idempotencyKey, input }, async ({ tx, audit, now: at, context }) => {
    if (sharing.companyId !== null && !(await tx.company.findUnique({ where: { id: sharing.companyId }, select: { id: true } }))) {
      throw new NotFoundError('Company not found.')
    }
    await checkSite(tx, sharing)
    const id = newId()
    const storageKey = storageKeyFor({ tenantId: tenantOf(context), companyId: sharing.companyId, kind: input.kind, now: at, random: randomUUID() })
    const row = await tx.storedFile.create({
      data: {
        id,
        companyId: sharing.companyId,
        recordType: input.recordType,
        recordId: input.recordId,
        kind: input.kind,
        originalName: originalName!,
        contentType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        storeAccountId,
        storageKey,
        visibility: sharing.visibility as FileAudience[],
        floorSiteId: sharing.floorSiteId,
        partyId: sharing.partyId,
        retainUntil: retention.retainUntil,
        createdAt: at,
        updatedAt: at,
        createdById: context.audience === 'office' ? context.actorId : null,
      },
      select: SELECT_FOR.office,
    })
    audit({ recordType: 'StoredFile', recordId: id, companyId: sharing.companyId, after: audited(row) })
    return { file: viewOf(row), storageKey }
  })
  const upload = await storeCall(() =>
    runtime.storage.presignUpload(caller, storeAccountId, {
      key: result.storageKey,
      contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      expiresInSeconds: UPLOAD_URL_SECONDS,
      now: runtime.clock.now(),
    }),
  )
  return { file: result.file, upload: presignedView(upload) }
}

/** Why a stored object is not the file that was announced, or null when it is. */
function mismatchOf(file: OfficeRow, object: StoredObject): QuarantineReason | null {
  if (object.sizeBytes !== file.sizeBytes) return 'size_mismatch'
  if (normaliseContentType(object.contentType ?? '') !== file.contentType) return 'type_mismatch'
  if (object.sha256 !== file.sha256) return 'checksum_mismatch'
  return null
}

/** files.completeUpload: the store's HEAD decides AVAILABLE or QUARANTINED. Confirming an AVAILABLE file again changes nothing. */
export async function completeUpload(runtime: FilesRuntime, caller: CommandCaller, fileId: string, idempotencyKey?: string): Promise<FileView> {
  const before = await readOffice(caller, fileId)
  mayWrite(caller, FILES_UPLOAD, { companyId: before.companyId, floorSiteId: null, partyId: null })
  if (before.status === 'AVAILABLE') return viewOf(before)
  if (before.status !== 'PENDING_UPLOAD') throw new InvalidStateError(`This file is ${before.status}; only a pending upload is confirmed.`)
  const object = await storeCall(() => runtime.storage.head(caller, before.storeAccountId, before.storageKey))
  if (!object) throw new ConflictError('The upload has not arrived yet: send the file to its upload URL, then confirm it.')
  const reason = mismatchOf(before, object)

  const { result } = await command(
    caller,
    { name: 'files.completeUpload', idempotencyKey, input: { fileId }, record: { type: 'StoredFile', id: fileId, expectedVersion: before.version } },
    async ({ tx, audit, emit, now }) => {
      const current = await tx.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: SELECT_FOR.office })
      const to = reason === null ? 'AVAILABLE' : 'QUARANTINED'
      assertTransition(fileMachine, current.status, to, { legalHold: current.legalHold, retainUntil: current.retainUntil, now })
      const row = await tx.storedFile.update({
        where: { id: fileId },
        data: reason === null ? { status: to, availableAt: now } : { status: to, quarantineReason: reason },
        select: SELECT_FOR.office,
      })
      audit({ recordType: 'StoredFile', recordId: fileId, companyId: row.companyId, before: { status: current.status }, after: { status: row.status, quarantineReason: row.quarantineReason } })
      if (reason === null) {
        emit({ type: 'file.available', subject: fileId, companyId: row.companyId, payload: { fileId, recordType: row.recordType, recordId: row.recordId, kind: row.kind } })
      }
      return viewOf(row)
    },
  )
  return result
}

export interface Callers {
  /** The caller (its scope reads the file). */
  readonly caller: CommandCaller
  /** The caller's tenant acting as the system, for the store call of a floor, portal or link caller. */
  readonly system: (tenantId: string) => CommandCaller
}

/** The request acting as its tenant's system context (as the inbound route does): same database, office role, RLS forced. */
export function systemCallerOf(request: FastifyRequest): (tenantId: string) => CommandCaller {
  return (tenantId) => {
    const view = Object.create(request) as FastifyRequest
    view.factoryContext = systemContext(tenantId, String(request.id))
    return view
  }
}

/** A presigned GET for a file the caller may see (A1 §3.6: 60 seconds, always an attachment). */
export async function downloadFile(runtime: FilesRuntime, callers: Callers, fileId: string) {
  const context = contextOf(callers.caller)
  const row = await readVisible(callers.caller, fileId)
  if (row.status !== 'AVAILABLE') throw new InvalidStateError(`This file is ${row.status}; only an available file can be downloaded.`)
  const storeCaller = context.audience === 'office' ? callers.caller : callers.system(tenantOf(context))
  const download = await storeCall(() =>
    runtime.storage.presignDownload(storeCaller, row.storeAccountId, {
      key: row.storageKey,
      contentType: row.contentType,
      disposition: attachmentDisposition(row.originalName),
      expiresInSeconds: DOWNLOAD_URL_SECONDS,
      now: runtime.clock.now(),
    }),
  )
  return presignedView(download)
}

export async function getFile(caller: CommandCaller, fileId: string): Promise<FileView> {
  return viewOf(await readVisible(caller, fileId))
}

const AUDIENCE_FLAG: Partial<Record<RequestContext['audience'], FileAudience>> = { floor: 'FLOOR', partner: 'PARTNER', link: 'LINK' }

/** A record's files the caller may see, newest first (office: every one not deleted; others: the available ones shared with them). */
export async function listFiles(caller: CommandCaller, record: { readonly recordType: string; readonly recordId: string }): Promise<FileView[]> {
  const context = contextOf(caller)
  if (context.audience === 'link' && (context.record.type !== record.recordType || context.record.id !== record.recordId)) return []
  const columns: ScopeColumns = {
    company: { field: 'companyId', nullable: true },
    ...(context.audience === 'floor' ? { site: 'floorSiteId' } : {}),
    ...(context.audience === 'partner' || context.audience === 'link' ? { party: 'partyId' } : {}),
  }
  const flag = AUDIENCE_FLAG[context.audience]
  const where: Prisma.StoredFileWhereInput = {
    AND: [
      scopeWhere(actorOf(context), FILES_READ, columns) as Prisma.StoredFileWhereInput,
      { recordType: record.recordType, recordId: record.recordId },
      flag ? { visibility: { has: flag }, status: 'AVAILABLE' } : { status: { not: 'DELETED' } },
    ],
  }
  const rows = (await caller.withClient((client) =>
    client.storedFile.findMany({ where, select: selectFor(context), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 500 }),
  )) as Row[]
  return rows.filter((row) => audienceSees(viewerOf(context), row)).map(viewOf)
}

/** files.delete: refused while retained or on legal hold; then the object is removed from the store (best effort). */
export async function deleteFile(runtime: FilesRuntime, caller: CommandCaller, fileId: string, input: { version?: number | undefined; reason?: string | undefined }, idempotencyKey?: string) {
  const before = await readOffice(caller, fileId)
  mayWrite(caller, FILES_DELETE, { companyId: before.companyId, floorSiteId: null, partyId: null })
  assertTransition(fileMachine, before.status, 'DELETED', { legalHold: before.legalHold, retainUntil: before.retainUntil, now: runtime.clock.now() })
  const { result } = await command(
    caller,
    { name: 'files.delete', idempotencyKey, input: { fileId, ...input }, record: { type: 'StoredFile', id: fileId, expectedVersion: input.version } },
    async ({ tx, audit, now }) => {
      const current = await tx.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: SELECT_FOR.office })
      assertTransition(fileMachine, current.status, 'DELETED', { legalHold: current.legalHold, retainUntil: current.retainUntil, now })
      const row = await tx.storedFile.update({ where: { id: fileId }, data: { status: 'DELETED', deletedAt: now }, select: SELECT_FOR.office })
      audit({ recordType: 'StoredFile', recordId: fileId, companyId: row.companyId, before: { status: current.status }, after: { status: 'DELETED' }, ...(input.reason ? { reason: input.reason } : {}) })
      return viewOf(row)
    },
  )
  try {
    await runtime.storage.remove(caller, before.storeAccountId, { key: before.storageKey, legalHold: before.legalHold, retainUntil: before.retainUntil }, runtime.clock.now())
  } catch {
    // The row is DELETED: the file is gone for every caller. An object left behind is invisible, and removed again by
    // a later sweep; the gateway's ledger row records the failure.
  }
  return result
}

/** files.setVisibility: who sees the file (COL-050). The caller needs files.manage for the new site and party too. */
export async function setVisibility(
  caller: CommandCaller,
  fileId: string,
  input: { visibility: readonly FileAudience[]; floorSiteId?: string | null | undefined; partyId?: string | null | undefined; version: number },
  idempotencyKey?: string,
): Promise<FileView> {
  const before = await readOffice(caller, fileId)
  const sharing: Sharing = { visibility: normaliseVisibility(input.visibility), companyId: before.companyId, floorSiteId: input.floorSiteId ?? null, partyId: input.partyId ?? null }
  mayWrite(caller, FILES_MANAGE, { companyId: before.companyId, floorSiteId: null, partyId: null })
  mayWrite(caller, FILES_MANAGE, sharing)
  if (before.status === 'DELETED') throw new InvalidStateError('This file is deleted.')
  const problems = sharingProblems(sharing)
  if (problems.length > 0) throw new ValidationError('The sharing is not valid.', problems)
  const { result } = await command(
    caller,
    { name: 'files.setVisibility', idempotencyKey, input: { fileId, ...input }, record: { type: 'StoredFile', id: fileId, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      await checkSite(tx, sharing)
      const row = await tx.storedFile.update({
        where: { id: fileId },
        data: { visibility: sharing.visibility as FileAudience[], floorSiteId: sharing.floorSiteId, partyId: sharing.partyId },
        select: SELECT_FOR.office,
      })
      audit({
        recordType: 'StoredFile',
        recordId: fileId,
        companyId: row.companyId,
        before: { visibility: before.visibility, floorSiteId: before.floorSiteId, partyId: before.partyId },
        after: { visibility: row.visibility, floorSiteId: row.floorSiteId, partyId: row.partyId },
      })
      return viewOf(row)
    },
  )
  return result
}

/** files.setRetention: the legal hold on or off, and the retention date (only ever later). */
export async function setRetention(
  runtime: FilesRuntime,
  caller: CommandCaller,
  fileId: string,
  input: { legalHold?: boolean | undefined; retainUntil?: string | undefined; reason: string; version: number },
  idempotencyKey?: string,
): Promise<FileView> {
  const before = await readOffice(caller, fileId)
  mayWrite(caller, FILES_MANAGE, { companyId: before.companyId, floorSiteId: null, partyId: null })
  if (before.status === 'DELETED') throw new InvalidStateError('This file is deleted.')
  if (input.legalHold === undefined && input.retainUntil === undefined) {
    throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send legalHold, retainUntil or both.' }])
  }
  const retainUntil = input.retainUntil === undefined ? undefined : new Date(input.retainUntil)
  if (retainUntil !== undefined && (retainUntil <= runtime.clock.now() || (before.retainUntil !== null && retainUntil < before.retainUntil))) {
    throw new ValidationError('The retention date only moves later.', [
      { path: 'body/retainUntil', message: before.retainUntil ? `Expected ${toUtcIso(before.retainUntil)} or later.` : 'Expected a date in the future.' },
    ])
  }
  const { result } = await command(
    caller,
    { name: 'files.setRetention', idempotencyKey, input: { fileId, ...input }, record: { type: 'StoredFile', id: fileId, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      const row = await tx.storedFile.update({
        where: { id: fileId },
        data: { ...(input.legalHold === undefined ? {} : { legalHold: input.legalHold }), ...(retainUntil === undefined ? {} : { retainUntil }) },
        select: SELECT_FOR.office,
      })
      audit({
        recordType: 'StoredFile',
        recordId: fileId,
        companyId: row.companyId,
        before: { legalHold: before.legalHold, retainUntil: iso(before.retainUntil) },
        after: { legalHold: row.legalHold, retainUntil: iso(row.retainUntil) },
        reason: input.reason,
      })
      return viewOf(row)
    },
  )
  return result
}
