import { FILES_DELETE, FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { isCurrentVersion, nextVersionNo, seriesRootOf, uploadingRefusal } from '@nexus/factory-domain/files/versions/rules'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import type { FactoryClient } from '@nexus/factory-db'
import type { FileView } from '../contract'
import { audited, checkSite, contextOf, mayWrite, prepareFileCopy, readOfficeReached, SELECT_FOR, tenantOf, viewOf, type OfficeRow } from '../files'
import { MADE_WORDS, madePapersOf } from '../made'
import { assertGenericPath } from '../owned'
import { fileLivePartyId } from '../record-scope'
import { cleanFileName, fileMachine, normaliseVisibility, uploadProblems, type FileAudience, type FileKind, type Sharing } from '../rules'
import type { FilesRuntime } from '../service'
import { seriesOf, supersedeEarlierVersions } from './supersede'
import { lockSeries } from './versions'

/**
 * B-OF-010 / B-OF-011 / B-OF-012 (order files tab; 13-backend §3; Owner D4) — two acts on a WHOLE document (a file's series of versions),
 * on every record's Files window (the order's tab and every thread's window call the same routes):
 *
 *   POST /files/:fileId/delete-document {version, reason}   every version of the series not deleted yet, in ONE command, under the
 *                                                          series lock: refused WHOLE (nothing deleted) when any version is on legal
 *                                                          hold or kept until a later day (the file machine's words), is a fiscal
 *                                                          paper, or is a paper Nexus made (made.ts); one audit row per version with
 *                                                          the reason, the event file.removed (every id); the store's objects removed
 *                                                          after the commit, best effort (as DELETE /files/:id does). files.delete.
 *   POST /files/:fileId/rename {version, name}             the CURRENT version copied as the series' next version under the new name
 *                                                          (restoreVersion's path: the same bytes, born AVAILABLE, naming its source;
 *                                                          the current superseded in the same command); the old name stays in the old
 *                                                          version. Refused: a fiscal file, a paper Nexus made, the same name, a version
 *                                                          still uploading, a version sent in parts too large to copy. files.upload.
 * Each file is reached first (readOfficeReached: the record's own scope, a priced file only with the price grain; else not found).
 */

const FISCAL_WORDS = Object.freeze({ delete: 'A fiscal paper is kept by law: it is never deleted.', rename: 'A fiscal file keeps its name.' })

type Reader = FactoryClient | CommandTx

/** The series' versions not deleted yet, oldest first. */
async function liveVersionsOf(db: Reader, root: string): Promise<OfficeRow[]> {
  return (await db.storedFile.findMany({ where: { OR: [{ id: root }, { seriesId: root }], status: { not: 'DELETED' } }, select: SELECT_FOR.office, orderBy: { versionNo: 'asc' } })) as OfficeRow[]
}

/** Why the whole document may not be deleted (throws in words): a fiscal paper, a paper Nexus made, a hold or a retention on any version. */
async function refuseWhole(db: Reader, versions: readonly OfficeRow[], now: Date): Promise<void> {
  if (versions.some((row) => row.kind === 'FISCAL_ARCHIVE')) throw new ConflictError(FISCAL_WORDS.delete)
  if ((await madePapersOf(db, versions.map((row) => row.id))).size > 0) throw new ConflictError(MADE_WORDS.delete)
  for (const row of versions) assertTransition(fileMachine, row.status, 'DELETED', { legalHold: row.legalHold, retainUntil: row.retainUntil, now })
}

/** POST /files/:fileId/delete-document — the whole document, with a reason. */
export async function deleteDocument(runtime: FilesRuntime, caller: CommandCaller, fileId: string, input: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ file: FileView; removed: number }> {
  const reason = input.reason.trim()
  if (reason.length < 3 || reason.length > 500) throw new ValidationError('Say why (3 to 500 characters): the audit keeps it.', [{ path: 'body/reason', message: 'Say why (3 to 500 characters).' }])
  const before = await readOfficeReached(caller, fileId)
  mayWrite(caller, FILES_DELETE, { companyId: before.companyId, floorSiteId: null, partyId: null })
  const root = seriesRootOf(before)
  const versions = await caller.withClient((client) => liveVersionsOf(client, root))
  await caller.withClient((client) => refuseWhole(client, versions, runtime.clock.now()))
  const { result } = await command(
    caller,
    { name: 'files.deleteDocument', idempotencyKey, input: { fileId, ...input }, record: { type: 'StoredFile', id: fileId, expectedVersion: input.version } },
    async ({ tx, audit, emit, now, context }) => {
      await lockSeries(tx, root)
      const fresh = await liveVersionsOf(tx, root)
      await refuseWhole(tx, fresh, now)
      for (const row of fresh) {
        await tx.storedFile.update({ where: { id: row.id }, data: { status: 'DELETED', deletedAt: now }, select: { id: true } })
        audit({ action: 'files.deleteDocument', recordType: 'StoredFile', recordId: row.id, companyId: row.companyId, before: { status: row.status, versionNo: row.versionNo }, after: { status: 'DELETED', seriesId: root, versions: fresh.length }, reason })
      }
      emit({
        type: 'file.removed',
        subject: fileId,
        companyId: before.companyId,
        payload: { fileId, recordType: before.recordType, recordId: before.recordId, fileIds: fresh.map((row) => row.id).slice(0, 500), partyId: await fileLivePartyId(tx, tenantOf(context), before) },
      })
      const shown = await tx.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: SELECT_FOR.office })
      return { file: viewOf(shown), removed: fresh.length }
    },
  )
  // The rows are DELETED: gone for every caller. An object left behind is invisible and removed again by a later sweep.
  for (const row of versions) {
    try {
      await runtime.storage.remove(caller, row.storeAccountId, { key: row.storageKey, legalHold: row.legalHold, retainUntil: row.retainUntil }, runtime.clock.now())
    } catch {
      // The gateway's ledger row records the failure.
    }
  }
  return result
}

/** POST /files/:fileId/rename — the current version copied as the next one under the new name. */
export async function renameFile(runtime: FilesRuntime, caller: CommandCaller, fileId: string, input: { readonly version: number; readonly name: string }, idempotencyKey?: string): Promise<FileView> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new NotFoundError('File not found.')
  const old = await readOfficeReached(caller, fileId)
  mayWrite(caller, FILES_UPLOAD, { companyId: old.companyId, floorSiteId: null, partyId: null })
  assertGenericPath(old.recordType, old.kind, {})
  const name = cleanFileName(input.name)
  if (name === null) throw new ValidationError('The file needs a name.', [{ path: 'body/name', message: 'The file needs a name.' }])
  if (name === old.originalName) throw new ValidationError('The name is the same: nothing changes.', [{ path: 'body/name', message: 'Type another name.' }])
  if (old.kind === 'FISCAL_ARCHIVE') throw new ConflictError(FISCAL_WORDS.rename)
  if (!isCurrentVersion(old)) throw new ConflictError('Rename the current version: this one was replaced by a later one.')
  if (old.version !== input.version) throw new StaleVersionError('StoredFile', old.id, old.version, input.version)
  const root = seriesRootOf(old)
  const series = await caller.withClient((client) => seriesOf(client, root))
  if ((await caller.withClient((client) => madePapersOf(client, series.map((file) => file.id)))).size > 0) throw new ConflictError(MADE_WORDS.rename)
  const uploading = uploadingRefusal(series)
  if (uploading) throw new ConflictError(uploading)
  // A copy reads the bytes into the API: only a file within its kind's own limit and types (a large one is uploaded again).
  if (uploadProblems({ kind: old.kind as FileKind, contentType: old.contentType, sizeBytes: old.sizeBytes, sha256: old.sha256 }).length > 0) {
    throw new ConflictError('This version was sent in parts and is too large to copy here: download it and upload it as a new version with the new name.')
  }
  const sharing: Sharing = { visibility: normaliseVisibility(old.visibility as FileAudience[]), companyId: old.companyId, floorSiteId: old.floorSiteId, partyId: old.partyId }
  if (sharing.visibility.length > 1) mayWrite(caller, FILES_MANAGE, sharing)
  const prepared = await prepareFileCopy(runtime, caller, old.id, {
    companyId: old.companyId,
    recordType: old.recordType,
    recordId: old.recordId,
    kind: old.kind as FileKind,
    originalName: name,
    visibility: sharing.visibility,
    floorSiteId: sharing.floorSiteId,
    partyId: sharing.partyId,
  })
  const { result } = await command(caller, { name: 'files.rename', idempotencyKey, input: { fileId, ...input } }, async (tools) => {
    const { tx, now } = tools
    await lockSeries(tx, root)
    const fresh = await seriesOf(tx, root)
    const again = fresh.find((file) => file.id === old.id)
    if (!again || !isCurrentVersion(again)) throw new ConflictError('Rename the current version: this one was replaced by a later one.')
    const lock = await tx.storedFile.findUniqueOrThrow({ where: { id: old.id }, select: { version: true } })
    if (lock.version !== input.version) throw new StaleVersionError('StoredFile', old.id, lock.version, input.version)
    const stillUploading = uploadingRefusal(fresh)
    if (stillUploading) throw new ConflictError(stillUploading)
    await checkSite(tx, sharing)
    const id = newId()
    const versionNo = nextVersionNo(fresh)
    const row = await tx.storedFile.create({
      data: {
        id,
        companyId: prepared.companyId,
        recordType: prepared.recordType,
        recordId: prepared.recordId,
        kind: prepared.kind,
        originalName: prepared.originalName,
        contentType: prepared.contentType,
        sizeBytes: prepared.sizeBytes,
        sha256: prepared.sha256,
        storeAccountId: prepared.storeAccountId,
        storageKey: prepared.storageKey,
        status: 'AVAILABLE',
        availableAt: now,
        visibility: [...prepared.visibility] as FileAudience[],
        floorSiteId: prepared.floorSiteId,
        partyId: prepared.partyId,
        retainUntil: prepared.retainUntil,
        seriesId: root,
        versionNo,
        sourceFileId: old.id,
        ...(old.category ? { category: old.category } : {}),
        // A priced series stays priced (B-CP-014).
        ...(prepared.priced === true || fresh.some((file) => file.priced) ? { priced: true } : {}),
        createdAt: now,
        updatedAt: now,
        createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
      },
      select: SELECT_FOR.office,
    })
    tools.audit({ recordType: 'StoredFile', recordId: id, companyId: row.companyId, after: { ...audited(row), seriesId: root, versionNo, renamedFrom: { fileId: old.id, name: old.originalName, versionNo: old.versionNo } } })
    tools.emit({ type: 'file.available', subject: id, companyId: row.companyId, payload: { fileId: id, recordType: row.recordType, recordId: row.recordId, kind: row.kind, partyId: await fileLivePartyId(tx, tenantOf(tools.context), row) } })
    await supersedeEarlierVersions(tools, id)
    return viewOf(row)
  })
  return result
}
