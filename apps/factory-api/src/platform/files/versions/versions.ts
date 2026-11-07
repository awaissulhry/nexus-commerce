import { randomUUID } from 'node:crypto'
import type { FileCategory, Prisma } from '@nexus/factory-db'
import { FILES_MANAGE, FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { isCurrentVersion, newVersionRefusal, nextVersionNo, restoreRefusal, seriesRootOf, uploadingRefusal } from '@nexus/factory-domain/files/versions/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { FileView } from '../contract'
import {
  audited,
  checkSite,
  contextOf,
  mayWrite,
  prepareFileCopy,
  presignedView,
  readOffice,
  readVisible,
  scopeOf,
  SELECT_FOR,
  storeAccountOf,
  storeCall,
  tenantOf,
  viewerOf,
  viewOf,
  type OfficeRow,
  type Row,
} from '../files'
import { assertGenericPath } from '../owned'
import {
  audienceSees,
  cleanFileName,
  normaliseContentType,
  normaliseVisibility,
  sharingProblems,
  storageKeyFor,
  UPLOAD_URL_SECONDS,
  uploadProblems,
  type FileAudience,
  type FileKind,
  type Sharing,
} from '../rules'
import type { FilesRuntime } from '../service'
import { seriesOf, supersedeEarlierVersions } from './supersede'

/**
 * File versions (COL-046, PLT-216; B-W2b-160): a new version is a new file of the same series, so a new object in the
 * store: nothing stored is overwritten, the old version stays listed and read-only.
 *
 *   new version  POST /files/:fileId/versions (files.upload; files.manage to share it beyond the office, as at upload):
 *                the series' next number, of the first version's record, company and kind (the type may change within
 *                the kind), the current version's sharing and category unless the request names a sharing → a presigned
 *                PUT, then the usual confirm (POST /files/:id/complete). When it becomes AVAILABLE (at the confirm, or at
 *                its clean scan) the earlier versions are superseded in the same command (supersede.ts).
 *                Refused for a fiscal archive file, a deleted one, and while a version of the series is still uploading
 *                (confirm it or give it up with DELETE /files/:id first). Large files: POST /files/:fileId/versions/uploads
 *                (multipart/).
 *   versions     GET /files/:fileId/versions: the series, the first version first, each with `current`; the office sees every
 *                version not deleted, a portal or a link the available ones shared with it (never the floor: its role does
 *                not read the series)
 *   restore      POST /files/:fileId/restore (files.upload): an earlier AVAILABLE version comes back as the series' next
 *                version, a copy of its bytes naming it as its source (prepareFileCopy, then one command: the copy born
 *                AVAILABLE and the current version superseded); the restored version takes the current version's sharing
 *
 * A record type whose files its module owns (owned.ts) gets no version here (409 naming its route), as for uploads.
 * Every write goes through command() with its audit rows; one advisory lock per series keeps two new versions from
 * taking the same number (the database's partial unique index would refuse the second).
 */

export interface NewVersionInput {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  /** Default: the current version's sharing. Beyond the office it needs files.manage, as at upload. */
  readonly visibility?: readonly FileAudience[] | undefined
  readonly floorSiteId?: string | null | undefined
  readonly partyId?: string | null | undefined
}

/** A new version as checked before its command: what it takes from the series and from the request. */
export interface VersionPlan {
  readonly root: string
  readonly companyId: string | null
  readonly recordType: string
  readonly recordId: string
  readonly kind: FileKind
  readonly category: FileCategory | null
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly sharing: Sharing
  readonly storeAccountId: string
}

const conflict = (refusal: string | null): void => {
  if (refusal !== null) throw new ConflictError(refusal)
}

/** The current version's sharing and category (or the named file's when no version is current). */
async function inheritedOf(caller: CommandCaller, fileId: string) {
  return caller.withClient((client) =>
    client.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: { visibility: true, floorSiteId: true, partyId: true, category: true } }),
  )
}

/**
 * The checks of a new version, OUTSIDE any transaction: the series, the kind's rules (or the caller's own for a large
 * upload: `problems`), the sharing, the permissions and the store. The command checks the series again under its lock.
 */
export async function planNewVersion(
  caller: CommandCaller,
  fileId: string,
  input: NewVersionInput,
  problemsOf: (kind: FileKind, contentType: string) => Issue[] = (kind, contentType) => uploadProblems({ kind, contentType, sizeBytes: input.sizeBytes, sha256: input.sha256 }),
): Promise<VersionPlan> {
  const context = contextOf(caller)
  if (context.audience !== 'office' && context.audience !== 'system') throw new NotFoundError('File not found.')
  const named = await readOffice(caller, fileId)
  mayWrite(caller, FILES_UPLOAD, { companyId: named.companyId, floorSiteId: null, partyId: null })
  assertGenericPath(named.recordType, named.kind, {})
  const root = seriesRootOf(named)
  const series = await caller.withClient((client) => seriesOf(client, root))
  conflict(newVersionRefusal(named, series))
  const current = series.find(isCurrentVersion) ?? named
  const inherited = await inheritedOf(caller, current.id)
  const sharing: Sharing =
    input.visibility === undefined
      ? { visibility: normaliseVisibility(inherited.visibility as FileAudience[]), companyId: named.companyId, floorSiteId: inherited.floorSiteId, partyId: inherited.partyId }
      : { visibility: normaliseVisibility(input.visibility), companyId: named.companyId, floorSiteId: input.floorSiteId ?? null, partyId: input.partyId ?? null }
  const contentType = normaliseContentType(input.contentType)
  const originalName = cleanFileName(input.originalName)
  const problems: Issue[] = [
    ...problemsOf(named.kind as FileKind, contentType),
    ...(originalName === null ? [{ path: 'body/originalName', message: 'The file needs a name.' }] : []),
    ...sharingProblems(sharing),
  ]
  if (problems.length > 0) throw new ValidationError('The new version is not valid.', problems)
  if (sharing.visibility.length > 1) mayWrite(caller, FILES_MANAGE, sharing)
  return {
    root,
    companyId: named.companyId,
    recordType: named.recordType,
    recordId: named.recordId,
    kind: named.kind as FileKind,
    category: inherited.category,
    originalName: originalName!,
    contentType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    sharing,
    storeAccountId: await storeAccountOf(caller, named.companyId),
  }
}

/** One new version of a series at a time: the series' advisory lock, for the rest of the command's transaction. */
export async function lockSeries(tx: CommandTools['tx'], root: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.file-series', current_setting('factory.tenant_id', true), ${root}::text), 0))`
}

/**
 * INSIDE the command: the series checked again under its lock, then the version written PENDING_UPLOAD under `storageKey`
 * with the series' next number, and its audit row.
 */
export async function insertNewVersion(tools: Pick<CommandTools, 'tx' | 'audit' | 'now' | 'context'>, plan: VersionPlan, storageKey: string): Promise<OfficeRow> {
  const { tx, now, context } = tools
  await lockSeries(tx, plan.root)
  const series = await seriesOf(tx, plan.root)
  if (!series.some((file) => file.id === plan.root)) throw new NotFoundError('File not found.')
  conflict(uploadingRefusal(series))
  await checkSite(tx, plan.sharing)
  const id = newId()
  const versionNo = nextVersionNo(series)
  const row = await tx.storedFile.create({
    data: {
      id,
      companyId: plan.companyId,
      recordType: plan.recordType,
      recordId: plan.recordId,
      kind: plan.kind,
      originalName: plan.originalName,
      contentType: plan.contentType,
      sizeBytes: plan.sizeBytes,
      sha256: plan.sha256,
      storeAccountId: plan.storeAccountId,
      storageKey,
      visibility: [...plan.sharing.visibility] as FileAudience[],
      floorSiteId: plan.sharing.floorSiteId,
      partyId: plan.sharing.partyId,
      seriesId: plan.root,
      versionNo,
      ...(plan.category ? { category: plan.category } : {}),
      createdAt: now,
      updatedAt: now,
      createdById: context.audience === 'office' ? context.actorId : null,
    },
    select: SELECT_FOR.office,
  })
  tools.audit({ action: 'files.requestVersion', recordType: 'StoredFile', recordId: id, companyId: plan.companyId, after: { ...audited(row), seriesId: plan.root, versionNo, ...(plan.category ? { category: plan.category } : {}) } })
  return row
}

/** A new storage key for a version (never the old one's: a version is a new object). */
export const versionKeyOf = (context: ReturnType<typeof contextOf>, plan: Pick<VersionPlan, 'companyId' | 'kind'>, now: Date): string =>
  storageKeyFor({ tenantId: tenantOf(context), companyId: plan.companyId, kind: plan.kind, now, random: randomUUID() })

/** POST /files/:fileId/versions: the new version announced, and its presigned PUT. */
export async function requestNewVersion(runtime: FilesRuntime, caller: CommandCaller, fileId: string, input: NewVersionInput, idempotencyKey?: string) {
  const plan = await planNewVersion(caller, fileId, input)
  const { result } = await command(caller, { name: 'files.requestVersion', idempotencyKey, input: { fileId, ...input } }, async (tools) => {
    const storageKey = versionKeyOf(tools.context, plan, tools.now)
    const row = await insertNewVersion(tools, plan, storageKey)
    return { file: viewOf(row), storageKey }
  })
  const upload = await storeCall(() =>
    runtime.storage.presignUpload(caller, plan.storeAccountId, {
      key: result.storageKey,
      contentType: plan.contentType,
      sizeBytes: plan.sizeBytes,
      sha256: plan.sha256,
      expiresInSeconds: UPLOAD_URL_SECONDS,
      now: runtime.clock.now(),
    }),
  )
  return { file: result.file, upload: presignedView(upload) }
}

const AUDIENCE_FLAG = { partner: 'PARTNER', link: 'LINK' } as const

/** GET /files/:fileId/versions: the versions of the file's series the caller may see, the first one first. */
export async function listVersions(caller: CommandCaller, fileId: string): Promise<Array<FileView & { current: boolean }>> {
  const context = contextOf(caller)
  if (context.audience === 'floor') throw new NotFoundError('File not found.')
  const named = await readVisible(caller, fileId)
  const root = seriesRootOf({ id: named.id, seriesId: named.seriesId ?? null })
  const outside = context.audience === 'partner' || context.audience === 'link'
  const select = outside ? SELECT_FOR.partner : SELECT_FOR.office
  const where: Prisma.StoredFileWhereInput = {
    AND: [{ OR: [{ id: root }, { seriesId: root }] }, outside ? { status: 'AVAILABLE', visibility: { has: AUDIENCE_FLAG[context.audience] } } : { status: { not: 'DELETED' } }],
  }
  const rows = (await caller.withClient((client) => client.storedFile.findMany({ where, select, orderBy: { versionNo: 'asc' }, take: 500 }))) as Row[]
  const viewer = viewerOf(context)
  return rows
    .filter((row) => audienceSees(viewer, row) && can(actorOf(context), FILES_READ, scopeOf(context, row)))
    .map((row) => ({ ...viewOf(row), current: row.status === 'AVAILABLE' && (row.supersededAt ?? null) === null }))
}

/**
 * POST /files/:fileId/restore: the earlier version `fileId` copied as the series' next version (born AVAILABLE, naming it
 * as its source), the current version superseded in the same command.
 */
export async function restoreVersion(runtime: FilesRuntime, caller: CommandCaller, fileId: string, idempotencyKey?: string): Promise<FileView> {
  const context = contextOf(caller)
  if (context.audience !== 'office' && context.audience !== 'system') throw new NotFoundError('File not found.')
  const old = await readOffice(caller, fileId)
  mayWrite(caller, FILES_UPLOAD, { companyId: old.companyId, floorSiteId: null, partyId: null })
  assertGenericPath(old.recordType, old.kind, {})
  const root = seriesRootOf(old)
  const series = await caller.withClient((client) => seriesOf(client, root))
  conflict(restoreRefusal(old, series))
  // A copy reads the bytes into the API: only a file within its kind's own limit and types (a large one is uploaded again).
  if (uploadProblems({ kind: old.kind as FileKind, contentType: old.contentType, sizeBytes: old.sizeBytes, sha256: old.sha256 }).length > 0) {
    throw new ConflictError('This version was sent in parts and is too large to copy here: download it and upload it as a new version.')
  }
  const current = series.find(isCurrentVersion) ?? old
  const inherited = await inheritedOf(caller, current.id)
  const sharing: Sharing = { visibility: normaliseVisibility(inherited.visibility as FileAudience[]), companyId: old.companyId, floorSiteId: inherited.floorSiteId, partyId: inherited.partyId }
  if (sharing.visibility.length > 1) mayWrite(caller, FILES_MANAGE, sharing)
  const prepared = await prepareFileCopy(runtime, caller, old.id, {
    companyId: old.companyId,
    recordType: old.recordType,
    recordId: old.recordId,
    kind: old.kind as FileKind,
    originalName: old.originalName,
    visibility: sharing.visibility,
    floorSiteId: sharing.floorSiteId,
    partyId: sharing.partyId,
  })
  const { result } = await command(caller, { name: 'files.restoreVersion', idempotencyKey, input: { fileId } }, async (tools) => {
    const { tx, now } = tools
    await lockSeries(tx, root)
    const fresh = await seriesOf(tx, root)
    const again = fresh.find((file) => file.id === old.id)
    if (!again) throw new NotFoundError('File not found.')
    conflict(restoreRefusal(again, fresh))
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
        ...(inherited.category ? { category: inherited.category } : {}),
        createdAt: now,
        updatedAt: now,
        createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
      },
      select: SELECT_FOR.office,
    })
    tools.audit({
      recordType: 'StoredFile',
      recordId: id,
      companyId: row.companyId,
      after: { ...audited(row), seriesId: root, versionNo, restoredFrom: old.id, restoredVersionNo: old.versionNo },
    })
    tools.emit({ type: 'file.available', subject: id, companyId: row.companyId, payload: { fileId: id, recordType: row.recordType, recordId: row.recordId, kind: row.kind } })
    await supersedeEarlierVersions(tools, id)
    return viewOf(row)
  })
  return result
}
