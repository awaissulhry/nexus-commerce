import { randomUUID } from 'node:crypto'
import type { FileCategory, Prisma } from '@nexus/factory-db'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { GatewayCallFailed, GatewayRefusal } from '../../gateway/gateway'
import type { FileView } from '../contract'
import { audited, checkSite, contextOf, mayWrite, presignedView, readOffice, SELECT_FOR, storeAccountOf, storeCall, tenantOf, viewOf, type OfficeRow } from '../files'
import { assertGenericPath, type UploadPath } from '../owned'
import { cleanFileName, fileMachine, normaliseContentType, normaliseVisibility, sharingProblems, storageKeyFor, type FileAudience, type FileKind, type QuarantineReason, type Sharing } from '../rules'
import { heldForScan } from '../scan/rules'
import { scanFile } from '../scan/scan'
import { processScanner } from '../scan/service'
import type { FilesRuntime } from '../service'
import { insertNewVersion, planNewVersion, type NewVersionInput, type VersionPlan } from '../versions/versions'
import { supersedeEarlierVersions } from '../versions/supersede'
import type { StoredPart } from './port'
import {
  largeUploadProblems,
  missingParts,
  PART_SIZE_DEFAULT,
  PART_URL_SECONDS,
  partCountOf,
  partSizeOf,
  partsDoneOf,
  SESSION_DAYS,
  TENANT_OPEN_UPLOADS_MAX,
  type PartDone,
} from './rules'

/**
 * Large uploads in parts (COL-052; B-W2b-160): a file too big for one PUT, or sent over a line that drops, goes to the
 * store in parts (R2 multipart through the gateway, multipart/store.ts), and a resume asks only for the parts still
 * missing. The flow:
 *
 *   start      POST /files/uploads (a new file) or POST /files/:fileId/versions/uploads (a new version of a file's series):
 *              the kind's large limits and the tenant's (rules.ts), sharing and permissions as for an upload → the store's
 *              multipart upload (files.multipart_start) → ONE command: the StoredFile PENDING_UPLOAD (its SHA-256 announced
 *              up front, hashed on the device) and its FileUploadSession OPEN, seven days at most
 *   parts      POST /files/uploads/:sessionId/parts {parts: [{partNumber, sha256}]}: a presigned PUT per part (15 minutes;
 *              the part's size and SHA-256 signed: the store refuses other bytes)
 *   sync       POST /files/uploads/:sessionId/sync: the store says which parts it holds (files.multipart_parts); the ones of
 *              the right size are recorded (partsDone grows only) → what is still missing. A resume after a dropped line
 *              calls this, then sends the missing parts
 *   complete   POST /files/uploads/:sessionId/complete: sync, then every part in → the store joins them
 *              (files.multipart_complete) → the joined object read once for its SHA-256 (files.digest) → ONE command: the
 *              session COMPLETED and the file AVAILABLE (`file.available`; a later version supersedes the earlier ones),
 *              QUARANTINED with the reason when it is not what was announced, or held for its virus scan (then scanned, as
 *              every upload)
 *   give up    DELETE /files/uploads/:sessionId: the store's upload aborted; the session ABORTED and the file DELETED
 *   expire     the scheduler's cron files.expireLargeUploads (expiry.ts): sessions past their seven days EXPIRED, the same way
 *
 * The plain confirm (POST /files/:fileId/complete) refuses a file sent in parts (guard.ts). Every write is ONE command
 * with its audit rows; every store call is one gateway call outside any transaction. The store's upload id never leaves
 * the API.
 */

const SESSION_SELECT = {
  id: true,
  fileId: true,
  uploadId: true,
  partSizeBytes: true,
  partsDone: true,
  status: true,
  expiresAt: true,
  endedAt: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.FileUploadSessionSelect

type SessionRow = Prisma.FileUploadSessionGetPayload<{ select: typeof SESSION_SELECT }>

/** The session as the caller sees it (never the store's upload id). */
export function sessionViewOf(session: SessionRow, fileSizeBytes: number) {
  const partCount = partCountOf(fileSizeBytes, session.partSizeBytes)
  const done = partsDoneOf(session.partsDone)
  return {
    id: session.id,
    fileId: session.fileId,
    status: session.status,
    partSizeBytes: session.partSizeBytes,
    partCount,
    partsDone: done.map((part) => ({ partNumber: part.partNumber, sizeBytes: part.sizeBytes })).sort((a, b) => a.partNumber - b.partNumber),
    missing: missingParts(done, partCount),
    expiresAt: toUtcIso(session.expiresAt),
    endedAt: session.endedAt === null ? null : toUtcIso(session.endedAt),
    version: session.version,
  }
}
export type SessionView = ReturnType<typeof sessionViewOf>

export interface LargeUploadRequest {
  readonly companyId?: string | null | undefined
  readonly recordType: string
  readonly recordId: string
  readonly kind: FileKind
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  /** Default 8 MiB; 5 to 64 MiB. */
  readonly partSizeBytes?: number | undefined
  readonly visibility?: readonly FileAudience[] | undefined
  readonly floorSiteId?: string | null | undefined
  readonly partyId?: string | null | undefined
  /** What the file is (StoredFile.category), set by the module that uploads it. */
  readonly category?: FileCategory | null | undefined
}

/** The file a session fills: a new first version, or a new version of a series (planned by versions.ts). */
type Announced =
  | { readonly kind: 'first'; readonly request: LargeUploadRequest; readonly contentType: string; readonly originalName: string; readonly sharing: Sharing; readonly storeAccountId: string }
  | { readonly kind: 'version'; readonly plan: VersionPlan }

const partSizeOfRequest = (value: number | undefined): number => value ?? PART_SIZE_DEFAULT

/** POST /files/uploads: a new file sent in parts. A module that owns its record type's files passes `viaModule`. */
export async function startLargeUpload(runtime: FilesRuntime, caller: CommandCaller, input: LargeUploadRequest, idempotencyKey?: string, path: UploadPath = {}) {
  assertGenericPath(input.recordType, input.kind, path)
  const contentType = normaliseContentType(input.contentType)
  const originalName = cleanFileName(input.originalName)
  const sharing: Sharing = { visibility: normaliseVisibility(input.visibility), companyId: input.companyId ?? null, floorSiteId: input.floorSiteId ?? null, partyId: input.partyId ?? null }
  const problems: Issue[] = [
    ...largeUploadProblems({ kind: input.kind, contentType, sizeBytes: input.sizeBytes, sha256: input.sha256, partSizeBytes: partSizeOfRequest(input.partSizeBytes) }),
    ...(originalName === null ? [{ path: 'body/originalName', message: 'The file needs a name.' }] : []),
    ...sharingProblems(sharing),
  ]
  if (problems.length > 0) throw new ValidationError('The upload is not valid.', problems)
  mayWrite(caller, FILES_UPLOAD, sharing)
  if (sharing.visibility.length > 1) mayWrite(caller, FILES_MANAGE, sharing)
  const storeAccountId = await storeAccountOf(caller, sharing.companyId)
  return begin(runtime, caller, { kind: 'first', request: input, contentType, originalName: originalName!, sharing, storeAccountId }, partSizeOfRequest(input.partSizeBytes), input, idempotencyKey)
}

/** POST /files/:fileId/versions/uploads: a new version of the file's series, sent in parts. */
export async function startLargeVersion(runtime: FilesRuntime, caller: CommandCaller, fileId: string, input: NewVersionInput & { readonly partSizeBytes?: number | undefined }, idempotencyKey?: string) {
  const partSizeBytes = partSizeOfRequest(input.partSizeBytes)
  const plan = await planNewVersion(caller, fileId, input, (kind, contentType) => largeUploadProblems({ kind, contentType, sizeBytes: input.sizeBytes, sha256: input.sha256, partSizeBytes }))
  return begin(runtime, caller, { kind: 'version', plan }, partSizeBytes, { fileId, ...input }, idempotencyKey)
}

async function begin(runtime: FilesRuntime, caller: CommandCaller, announced: Announced, partSizeBytes: number, input: unknown, idempotencyKey: string | undefined) {
  const context = contextOf(caller)
  const open = await caller.withClient((client) => client.fileUploadSession.count({ where: { status: 'OPEN' } }))
  if (open >= TENANT_OPEN_UPLOADS_MAX) throw new ConflictError(`${open} uploads in parts are still open here: finish or give some up first.`)
  const companyId = announced.kind === 'first' ? announced.sharing.companyId : announced.plan.companyId
  const fileKind = announced.kind === 'first' ? announced.request.kind : announced.plan.kind
  const contentType = announced.kind === 'first' ? announced.contentType : announced.plan.contentType
  const storeAccountId = announced.kind === 'first' ? announced.storeAccountId : announced.plan.storeAccountId
  const storageKey = storageKeyFor({ tenantId: tenantOf(context), companyId, kind: fileKind, now: runtime.clock.now(), random: randomUUID() })
  const uploadId = await storeCall(() => runtime.multipart.start(caller, storeAccountId, { key: storageKey, contentType }))
  const giveUp = () => runtime.multipart.abort(caller, storeAccountId, storageKey, uploadId).catch(() => {})
  let outcome
  try {
    outcome = await command(caller, { name: 'files.startLargeUpload', idempotencyKey, input }, async (tools) => {
      const row = announced.kind === 'version' ? await insertNewVersion(tools, announced.plan, storageKey) : await insertFirst(tools, announced, storageKey)
      const session = await tools.tx.fileUploadSession.create({
        data: {
          id: newId(),
          fileId: row.id,
          uploadId,
          partSizeBytes,
          status: 'OPEN',
          expiresAt: new Date(tools.now.getTime() + SESSION_DAYS * 86_400_000),
          createdAt: tools.now,
          updatedAt: tools.now,
          createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
        },
        select: SESSION_SELECT,
      })
      tools.audit({ recordType: 'FileUploadSession', recordId: session.id, companyId: row.companyId, after: { fileId: row.id, partSizeBytes, partCount: partCountOf(row.sizeBytes, partSizeBytes), expiresAt: toUtcIso(session.expiresAt) } })
      return { file: viewOf(row), session: sessionViewOf(session, row.sizeBytes), uploadId }
    })
  } catch (error) {
    await giveUp()
    throw error
  }
  // A repeat of the same request answers its first session: the upload started for it here is given up.
  if (outcome.result.uploadId !== uploadId) await giveUp()
  return { file: outcome.result.file, session: outcome.result.session }
}

async function insertFirst(tools: Pick<CommandTools, 'tx' | 'audit' | 'now' | 'context'>, announced: Extract<Announced, { kind: 'first' }>, storageKey: string): Promise<OfficeRow> {
  const { tx, now, context } = tools
  const { request, sharing } = announced
  if (sharing.companyId !== null && !(await tx.company.findUnique({ where: { id: sharing.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
  await checkSite(tx, sharing)
  const id = newId()
  const row = await tx.storedFile.create({
    data: {
      id,
      companyId: sharing.companyId,
      recordType: request.recordType,
      recordId: request.recordId,
      kind: request.kind,
      originalName: announced.originalName,
      contentType: announced.contentType,
      sizeBytes: request.sizeBytes,
      sha256: request.sha256,
      storeAccountId: announced.storeAccountId,
      storageKey,
      visibility: [...sharing.visibility] as FileAudience[],
      floorSiteId: sharing.floorSiteId,
      partyId: sharing.partyId,
      ...(request.category ? { category: request.category } : {}),
      createdAt: now,
      updatedAt: now,
      createdById: context.audience === 'office' ? context.actorId : null,
    },
    select: SELECT_FOR.office,
  })
  tools.audit({ action: 'files.requestUpload', recordType: 'StoredFile', recordId: id, companyId: sharing.companyId, after: { ...audited(row), inParts: true, ...(request.category ? { category: request.category } : {}) } })
  return row
}

/** The session and its file, for a caller with files.upload over the file's company. */
async function readSession(caller: CommandCaller, sessionId: string): Promise<{ session: SessionRow; file: OfficeRow }> {
  const context = contextOf(caller)
  if ((context.audience !== 'office' && context.audience !== 'system') || !isUuid(sessionId)) throw new NotFoundError('Upload not found.')
  const session = await caller.withClient((client) => client.fileUploadSession.findUnique({ where: { id: sessionId }, select: SESSION_SELECT }))
  if (!session) throw new NotFoundError('Upload not found.')
  const file = await readOffice(caller, session.fileId)
  mayWrite(caller, FILES_UPLOAD, { companyId: file.companyId, floorSiteId: null, partyId: null })
  return { session, file }
}

function assertOpen(session: SessionRow, now: Date): void {
  if (session.status !== 'OPEN') throw new InvalidStateError(`This upload is ${session.status}; start it again.`)
  if (session.expiresAt <= now) throw new InvalidStateError('This upload has expired (after seven days); start it again.')
}

/** GET /files/uploads/:sessionId. */
export async function getLargeUpload(caller: CommandCaller, sessionId: string) {
  const { session, file } = await readSession(caller, sessionId)
  return { file: viewOf(file), session: sessionViewOf(session, file.sizeBytes) }
}

/** POST /files/uploads/:sessionId/parts: a presigned PUT for each part asked (not done yet). */
export async function presignParts(runtime: FilesRuntime, caller: CommandCaller, sessionId: string, parts: readonly { readonly partNumber: number; readonly sha256: string }[]) {
  const { session, file } = await readSession(caller, sessionId)
  const now = runtime.clock.now()
  assertOpen(session, now)
  const count = partCountOf(file.sizeBytes, session.partSizeBytes)
  const done = new Set(partsDoneOf(session.partsDone).map((part) => part.partNumber))
  const problems: Issue[] = parts.flatMap((part, index) =>
    part.partNumber > count
      ? [{ path: `body/parts/${index}/partNumber`, message: `This file has ${count} parts.` }]
      : done.has(part.partNumber)
        ? [{ path: `body/parts/${index}/partNumber`, message: `Part ${part.partNumber} is in already.` }]
        : [],
  )
  if (new Set(parts.map((part) => part.partNumber)).size !== parts.length) problems.push({ path: 'body/parts', message: 'Ask for each part once.' })
  if (problems.length > 0) throw new ValidationError('The parts are not valid.', problems)
  const signed = await storeCall(() =>
    runtime.multipart.presignParts(
      caller,
      file.storeAccountId,
      parts.map((part) => ({
        key: file.storageKey,
        uploadId: session.uploadId,
        partNumber: part.partNumber,
        sizeBytes: partSizeOf(part.partNumber, file.sizeBytes, session.partSizeBytes),
        sha256: part.sha256,
        expiresInSeconds: PART_URL_SECONDS,
        now,
      })),
    ),
  )
  return { parts: signed.map((request, index) => ({ partNumber: parts[index]!.partNumber, sizeBytes: partSizeOf(parts[index]!.partNumber, file.sizeBytes, session.partSizeBytes), ...presignedView(request) })) }
}

const NO_UPLOAD = 'The file store no longer holds this upload (it expired or was given up); start it again.'

/** The parts the store holds for the session (null: the store has no such upload any more). */
const storedPartsOf = (runtime: FilesRuntime, caller: CommandCaller, session: SessionRow, file: OfficeRow) =>
  storeCall(() => runtime.multipart.listParts(caller, file.storeAccountId, file.storageKey, session.uploadId))

/** Records the store's new parts of the right size (partsDone only grows); returns the session as it is now. */
async function recordStoredParts(caller: CommandCaller, session: SessionRow, file: OfficeRow, stored: readonly StoredPart[]): Promise<SessionRow> {
  const count = partCountOf(file.sizeBytes, session.partSizeBytes)
  const done = partsDoneOf(session.partsDone)
  const have = new Set(done.map((part) => part.partNumber))
  const fresh: PartDone[] = stored
    .filter((part) => part.partNumber >= 1 && part.partNumber <= count && !have.has(part.partNumber) && part.sizeBytes === partSizeOf(part.partNumber, file.sizeBytes, session.partSizeBytes))
    .map((part) => ({ partNumber: part.partNumber, etag: part.etag, sizeBytes: part.sizeBytes }))
  if (fresh.length === 0) return session
  await command(
    caller,
    {
      name: 'files.recordUploadParts',
      idempotencyKey: `files-parts.${session.id}.${newId()}`,
      input: { sessionId: session.id, parts: fresh.map((part) => part.partNumber) },
      record: { type: 'FileUploadSession', id: session.id, expectedVersion: session.version },
    },
    async ({ tx, audit }) => {
      await tx.fileUploadSession.update({ where: { id: session.id }, data: { partsDone: [...done, ...fresh] as unknown as Prisma.InputJsonValue }, select: { id: true } })
      audit({ recordType: 'FileUploadSession', recordId: session.id, companyId: file.companyId, after: { partsAdded: fresh.map((part) => part.partNumber), partsDone: done.length + fresh.length, partCount: count } })
      return null
    },
  )
  return reread(caller, session.id)
}

const reread = (caller: CommandCaller, sessionId: string) => caller.withClient((client) => client.fileUploadSession.findUniqueOrThrow({ where: { id: sessionId }, select: SESSION_SELECT }))

/** POST /files/uploads/:sessionId/sync: what the store holds, recorded; what is still missing. */
export async function syncLargeUpload(runtime: FilesRuntime, caller: CommandCaller, sessionId: string) {
  const { session, file } = await readSession(caller, sessionId)
  assertOpen(session, runtime.clock.now())
  const stored = await storedPartsOf(runtime, caller, session, file)
  if (stored === null) throw new InvalidStateError(NO_UPLOAD)
  return { file: viewOf(file), session: sessionViewOf(await recordStoredParts(caller, session, file, stored), file.sizeBytes) }
}

/** Why the joined object is not the file that was announced, or null when it is. */
function mismatchOf(file: OfficeRow, object: { sizeBytes: number; contentType: string | null; sha256: string }): QuarantineReason | null {
  if (object.sizeBytes !== file.sizeBytes) return 'size_mismatch'
  if (normaliseContentType(object.contentType ?? '') !== file.contentType) return 'type_mismatch'
  if (object.sha256 !== file.sha256) return 'checksum_mismatch'
  return null
}

/** POST /files/uploads/:sessionId/complete. */
export async function completeLargeUpload(runtime: FilesRuntime, caller: CommandCaller, sessionId: string, idempotencyKey?: string): Promise<{ file: FileView; session: SessionView }> {
  const read = await readSession(caller, sessionId)
  if (read.session.status === 'COMPLETED') return { file: viewOf(read.file), session: sessionViewOf(read.session, read.file.sizeBytes) }
  assertOpen(read.session, runtime.clock.now())
  const { file } = read
  const count = partCountOf(file.sizeBytes, read.session.partSizeBytes)
  const stored = await storedPartsOf(runtime, caller, read.session, file)
  // No upload in the store, every part recorded: an earlier try joined it and its command did not finish; else gone.
  const joinedBefore = stored === null && missingParts(partsDoneOf(read.session.partsDone), count).length === 0
  if (stored === null && !joinedBefore) throw new InvalidStateError(NO_UPLOAD)
  const session = stored === null ? read.session : await recordStoredParts(caller, read.session, file, stored)
  const missing = missingParts(partsDoneOf(session.partsDone), count)
  if (missing.length > 0) {
    throw new ConflictError(`Part${missing.length === 1 ? '' : 's'} ${missing.join(', ')} of ${count} ${missing.length === 1 ? 'has' : 'have'} not arrived yet: send ${missing.length === 1 ? 'it' : 'them'}, then complete the upload.`)
  }
  if (stored !== null) {
    const parts = stored.filter((part) => part.partNumber >= 1 && part.partNumber <= count)
    await storeCall(() => runtime.multipart.complete(caller, file.storeAccountId, file.storageKey, session.uploadId, parts))
  }
  const object = await storeCall(() => runtime.multipart.digest(caller, file.storeAccountId, file.storageKey))
  if (!object) throw new InvalidStateError(stored === null ? NO_UPLOAD : 'The joined file is not in the file store; nothing was changed. Try again.')
  const reason = mismatchOf(file, object)
  const scanner = processScanner()
  const { result } = await command(
    caller,
    { name: 'files.completeLargeUpload', idempotencyKey, input: { sessionId }, record: { type: 'StoredFile', id: file.id, expectedVersion: file.version } },
    async ({ tx, audit, emit, now }) => {
      const ended = await tx.fileUploadSession.update({ where: { id: session.id }, data: { status: 'COMPLETED', endedAt: now, version: { increment: 1 } }, select: SESSION_SELECT })
      const current = await tx.storedFile.findUniqueOrThrow({ where: { id: file.id }, select: SELECT_FOR.office })
      const to = reason === null && !scanner ? 'AVAILABLE' : 'QUARANTINED'
      assertTransition(fileMachine, current.status, to, { legalHold: current.legalHold, retainUntil: current.retainUntil, now })
      const row = await tx.storedFile.update({
        where: { id: file.id },
        data: reason !== null ? { status: to, quarantineReason: reason } : scanner ? heldForScan() : { status: to, availableAt: now },
        select: SELECT_FOR.office,
      })
      audit({ recordType: 'StoredFile', recordId: file.id, companyId: row.companyId, before: { status: current.status }, after: { status: row.status, quarantineReason: row.quarantineReason, inParts: count, ...(scanner ? { scanStatus: row.scanStatus } : {}) } })
      audit({ recordType: 'FileUploadSession', recordId: session.id, companyId: row.companyId, before: { status: 'OPEN' }, after: { status: 'COMPLETED' } })
      if (row.status === 'AVAILABLE') {
        emit({ type: 'file.available', subject: file.id, companyId: row.companyId, payload: { fileId: file.id, recordType: row.recordType, recordId: row.recordId, kind: row.kind } })
        await supersedeEarlierVersions({ tx, audit, now }, file.id)
      }
      return { file: viewOf(row), session: sessionViewOf(ended, row.sizeBytes) }
    },
  )
  if (scanner && reason === null) return { file: (await scanFile(runtime, scanner, caller, file.id)).file, session: result.session }
  return result
}

/** Ends an OPEN session (ABORTED by a person, EXPIRED by the sweep) and gives its file up (DELETED), in one command. */
export async function endLargeUpload(caller: CommandCaller, session: SessionRow, file: OfficeRow, to: 'ABORTED' | 'EXPIRED', idempotencyKey?: string) {
  const { result } = await command(
    caller,
    {
      name: to === 'ABORTED' ? 'files.abortLargeUpload' : 'files.expireLargeUpload',
      idempotencyKey: idempotencyKey ?? `files-end.${session.id}.${newId()}`,
      input: { sessionId: session.id },
      record: { type: 'FileUploadSession', id: session.id, expectedVersion: session.version },
    },
    async ({ tx, audit, now }) => {
      const ended = await tx.fileUploadSession.update({ where: { id: session.id }, data: { status: to, endedAt: now }, select: SESSION_SELECT })
      audit({ recordType: 'FileUploadSession', recordId: session.id, companyId: file.companyId, before: { status: 'OPEN' }, after: { status: to } })
      const current = await tx.storedFile.findUniqueOrThrow({ where: { id: file.id }, select: SELECT_FOR.office })
      let row = current
      if (current.status === 'PENDING_UPLOAD' && !current.legalHold && (current.retainUntil === null || current.retainUntil <= now)) {
        row = await tx.storedFile.update({ where: { id: file.id }, data: { status: 'DELETED', deletedAt: now, version: { increment: 1 } }, select: SELECT_FOR.office })
        audit({ action: 'files.delete', recordType: 'StoredFile', recordId: file.id, companyId: row.companyId, before: { status: 'PENDING_UPLOAD' }, after: { status: 'DELETED' }, reason: to === 'ABORTED' ? 'The upload in parts was given up.' : 'The upload in parts expired.' })
      }
      return { file: viewOf(row), session: sessionViewOf(ended, row.sizeBytes) }
    },
  )
  return result
}

/** DELETE /files/uploads/:sessionId: the store's upload aborted, then the session ABORTED and its file DELETED. */
export async function abortLargeUpload(runtime: FilesRuntime, caller: CommandCaller, sessionId: string, idempotencyKey?: string) {
  const { session, file } = await readSession(caller, sessionId)
  if (session.status === 'ABORTED') return { file: viewOf(file), session: sessionViewOf(session, file.sizeBytes) }
  if (session.status !== 'OPEN') throw new InvalidStateError(`This upload is ${session.status}; there is nothing to give up.`)
  try {
    await runtime.multipart.abort(caller, file.storeAccountId, file.storageKey, session.uploadId)
  } catch (error) {
    // The store's own expiry removes the parts in the end; the person's "give up" must not wait for it.
    if (!(error instanceof GatewayCallFailed) && !(error instanceof GatewayRefusal)) throw error
  }
  return endLargeUpload(caller, session, file, 'ABORTED', idempotencyKey)
}

export { SESSION_SELECT, type SessionRow }
