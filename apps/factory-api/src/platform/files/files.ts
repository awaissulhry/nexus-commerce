import { createHash, randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { FactoryClient, FileCategory, Prisma } from '@nexus/factory-db'
import { FILES_DELETE, FILES_MANAGE, FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission, type ScopeColumns, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { GatewayCallFailed, GatewayRefusal } from '../gateway/gateway'
import { systemContext } from '../outbox/system'
import { mayOnThread, resolveRecord } from '../threads/records' // B-TH-003; B-TH-029: mayOnThread
import type { FileView } from './contract'
import type { PresignedRequest, StoredObject } from './port'
import {
  attachmentDisposition,
  audienceSees,
  cleanFileName,
  DOWNLOAD_URL_SECONDS,
  fileMachine,
  isStorageKey,
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
import { assertGenericPath, readsThroughModule, type UploadPath } from './owned'
import type { FilesRuntime } from './service'
import { RetainedFileError } from './store'
import { heldForScan, waitsForScan } from './scan/rules'
import { scanFile } from './scan/scan'
import { processScanner } from './scan/service'
// B-W2b-160 (COL-046, COL-052, COL-058): versions, large uploads in parts, the stripped copy outside the office.
import { refuseLargeUploadConfirm } from './multipart/guard'
import { keyShownTo } from './thumbs/outside'
// B-W2b-F56: a file whose bytes are missing from the store (404 in words, never an outage).
import { MissingFileError } from './missing'
import { sharingNarrows, supersedeEarlierVersions } from './versions/supersede'
// B-TH-083: measurement sheets are body data (the tick at upload, the permission that opens them, each opening recorded).
import { isMeasurementSheet, MEASUREMENT_SHEET_CATEGORY, MEASUREMENT_SHEET_PERMISSION, measurementSheetProblem } from '@nexus/factory-domain/files/measurements'

/**
 * Files on R2 (plan A1 §3.6; features COL-045, COL-050, PLT-011; PLAN §2.8), the flow:
 *
 *   upload     POST /files: the kind's content types and size limit, the sharing (beyond the office it also needs
 *              files.manage), the retention (a fiscal archive file: ten years at least) → files.requestUpload writes
 *              the row PENDING_UPLOAD under a new random key
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
 *   generated  storeGeneratedFile: bytes the API made itself (a rendered document) are written to the store first,
 *              then recorded AVAILABLE in one command (the module that made them names it and checked its permission)
 *   owned      a record type whose files its module owns (owned.ts: ComplianceDocument; a Certificate's CERTIFICATE
 *              files) is uploaded and confirmed only through that module's route: the generic routes answer 409
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
  scanStatus: true,
  scannedAt: true,
  availableAt: true,
  deletedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.StoredFileSelect

/** B-TH-083: what the file is evidence of (MEASUREMENTS keeps it behind sales.measurements.view); every role reads it. */
const CATEGORY = { category: true } as const satisfies Prisma.StoredFileSelect

/** B-W2b-160: the version and the stripped copy, which every role reads (the floor and partner roles too). */
const DEPTH = { versionNo: true, supersededAt: true, thumbnailKey: true } as const satisfies Prisma.StoredFileSelect

/** What each audience's role may read (its hidden columns left out: a forgotten one would fail loudly). */
export const SELECT_FOR = {
  office: { ...COMMON, ...DEPTH, ...CATEGORY, floorSiteId: true, partyId: true, legalHold: true, scanEngine: true, scanFinding: true, seriesId: true, sourceFileId: true },
  floor: { ...COMMON, ...DEPTH, ...CATEGORY, floorSiteId: true },
  partner: { ...COMMON, ...DEPTH, ...CATEGORY, partyId: true, seriesId: true },
} as const satisfies Record<string, Prisma.StoredFileSelect>

export type Row = Prisma.StoredFileGetPayload<{ select: typeof COMMON }> & { floorSiteId?: string | null; partyId?: string | null; legalHold?: boolean; scanEngine?: string | null; scanFinding?: string | null } & DepthColumns
/** B-W2b-160: the depth columns, read by the selects above (a module's own select may leave them out). */
type DepthColumns = { versionNo?: number; supersededAt?: Date | null; thumbnailKey?: string | null; seriesId?: string | null; sourceFileId?: string | null; category?: FileCategory | null }
export type OfficeRow = Prisma.StoredFileGetPayload<{ select: (typeof SELECT_FOR)['office'] }>

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
    scanStatus: row.scanStatus,
    scannedAt: iso(row.scannedAt),
    ...('scanEngine' in row ? { scanEngine: row.scanEngine ?? null } : {}),
    ...('scanFinding' in row ? { scanFinding: row.scanFinding ?? null } : {}),
    availableAt: iso(row.availableAt),
    deletedAt: iso(row.deletedAt),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
    // B-W2b-160 (COL-046): the version (the series is hidden from the floor, the source of a copy from outside).
    ...(row.versionNo === undefined ? {} : { versionNo: row.versionNo, supersededAt: iso(row.supersededAt ?? null) }),
    ...('seriesId' in row ? { seriesId: row.seriesId ?? null } : {}),
    ...('sourceFileId' in row ? { sourceFileId: row.sourceFileId ?? null } : {}),
    // B-TH-083: the file's category (a module's select may leave it out).
    ...('category' in row ? { category: row.category ?? null } : {}),
  }
}

/** What an audit row records of a file (its content and sharing; never the storage key). */
export const audited = (row: OfficeRow) => ({
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

export function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

/** The caller's tenant (every audience of these routes has one). */
export function tenantOf(context: RequestContext): string {
  if (context.audience === 'platform') throw new ApiError('internal_error', 'Files belong to a tenant; the platform audience has none.')
  return context.tenantId
}

export function viewerOf(context: RequestContext): Viewer {
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
export function scopeOf(context: RequestContext, row: Row): ScopedRecord {
  if (context.audience === 'floor') return { companyId: row.companyId, siteId: row.floorSiteId ?? null }
  if (context.audience === 'partner' || context.audience === 'link') return { companyId: row.companyId, partyId: row.partyId ?? null }
  return { companyId: row.companyId }
}

/** A write needs the permission for the file's company and for the site and party it is shared with. */
export function mayWrite(caller: CommandCaller, permission: Permission, sharing: Pick<Sharing, 'companyId' | 'floorSiteId' | 'partyId'>): void {
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
export async function readVisible(caller: CommandCaller, fileId: string, path: UploadPath = {}): Promise<Row> {
  const context = contextOf(caller)
  const row = await readRow(caller, fileId)
  const office = context.audience === 'office'
  // B-W2b-48: a record type read through its module: its module asked its own permission instead of files.read.
  const throughModule = readsThroughModule(row.recordType)
  if (throughModule && !path.viaModule) throw new NotFoundError('File not found.')
  if (!audienceSees(viewerOf(context), row) || (!office && row.status !== 'AVAILABLE') || (!throughModule && !can(actorOf(context), FILES_READ, scopeOf(context, row)))) {
    throw new NotFoundError('File not found.')
  }
  // B-TH-029: and its record's own scope (the same 404: a file of a record out of reach is as unknown as a wrong id).
  if (office && !throughModule && !(await officeReachesRecord(caller, row))) throw new NotFoundError('File not found.')
  // B-TH-083: a measurement sheet opens only with sales.measurements.view (the same 404 for everyone else in the office).
  if (isMeasurementSheet(row) && !(await opensMeasurementSheets(caller, row))) throw new NotFoundError('File not found.')
  return row
}

// ---- B-TH-029 (threads plan TH-2, WALL-G13, wall test T26): an office file read checks its record's own scope ---------------
/**
 * The brand wall inside the office (Owner rule 2026-11-16): for an office person a file was checked by its company only, so a
 * person limited to some customers (RoleAssignment.partyIds) or sites opened any record's file by id. Now an office read — the
 * file by id, its download, preview, versions and history, and a record's file list — also asks files.read over the RECORD's
 * own scope (company, site and party from its thread resolver, platform/threads/records.ts) and the record type's thread gate
 * (a person's records: users.view, workers.view …), exactly as threads do (mayOnThread). A record type no resolver knows, or a
 * record gone, keeps the file's company check. A person without a customer or site limit (the default: the factory sees it
 * all) reads what they read before; a site-limited person no longer reads the files of another site's records.
 */
async function officeReachesRecord(caller: CommandCaller, record: { readonly recordType: string; readonly recordId: string }): Promise<boolean> {
  const context = contextOf(caller)
  if (context.audience !== 'office') return true
  const scope = await caller.withClient((client) => resolveRecord(client, record.recordType, record.recordId))
  return scope === null || mayOnThread(actorOf(context), FILES_READ, record.recordType, scope)
}
// ---- end B-TH-029

// ---- B-TH-083 (threads plan TH-7, N11; walls W25 / W26, tests T25 / T26): measurement sheets are body data ----------------------
/**
 * A customer's measurement sheet (StoredFile.category MEASUREMENTS, filed by the tick at upload) opens in the office only for
 * people holding sales.measurements.view over its RECORD's scope (company, site and customer from the thread resolver; a type no
 * resolver knows keeps the file's company) — the production manager holds it on purpose, finance does not. For everyone else
 * in the office the file is not found by id (404, as a wrong id), and a record's list shows it LOCKED (`locked: MEASUREMENTS`,
 * no name, no checksum: "Measurement sheet — you cannot open it"; counted, never dropped). A portal or a link reads only its
 * own party's sheets (row-level security and the record-party guard), a floor never (the database refuses FLOOR on a sheet);
 * the system reads them for its own work. Each opening (download, preview) writes one audit row `files.measurementSheetOpened`.
 */
export async function opensMeasurementSheets(caller: CommandCaller, record: { readonly recordType: string; readonly recordId: string; readonly companyId: string | null }): Promise<boolean> {
  const context = contextOf(caller)
  if (context.audience !== 'office') return true
  const scope = await caller.withClient((client) => resolveRecord(client, record.recordType, record.recordId))
  return can(actorOf(context), MEASUREMENT_SHEET_PERMISSION, scope ?? { companyId: record.companyId })
}

/** A locked sheet as an office reader without the permission sees it: what it is and where, never its name or content. */
export const lockedView = (view: FileView): FileView => ({ ...view, originalName: '', sha256: '', locked: MEASUREMENT_SHEET_CATEGORY })

/** One audit row per opening of a sheet (download or preview), by whoever opened it (office, portal, link). */
export async function recordSheetOpening(caller: CommandCaller, row: Pick<Row, 'id' | 'companyId' | 'recordType' | 'recordId' | 'category'>, how: 'download' | 'preview'): Promise<void> {
  if (!isMeasurementSheet(row)) return
  const context = contextOf(caller)
  if (context.audience === 'system' || context.audience === 'platform') return
  await command(caller, { name: 'files.measurementSheetOpened', idempotencyKey: `sheet-open:${randomUUID()}`, input: { fileId: row.id, how } }, async ({ audit }) => {
    audit({ action: 'files.measurementSheetOpened', recordType: 'StoredFile', recordId: row.id, companyId: row.companyId, after: { recordType: row.recordType, recordId: row.recordId, how } })
    return null
  })
}
// ---- end B-TH-083

export const readOffice = async (caller: CommandCaller, fileId: string): Promise<OfficeRow> => (await readRow(caller, fileId)) as OfficeRow

/** A store call's failure for the caller: the store is not reachable now (503), a retained object (409). */
export async function storeCall<T>(work: () => Promise<T>): Promise<T> {
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

// ── B-W2b-F56 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export { MISSING_FILE_WORDS, MissingFileError } from './missing'

/**
 * A stored file's bytes, for a read that serves them (a picture, a PDF): the store not answering is 503 and worth a retry
 * (storeCall); no object under the key is MissingFileError (404), never a 503. Server-side work that must tell a missing
 * object apart in its own words (an import, the scan, a copy) reads `storage.read` and its null itself.
 */
export async function readStoredFile(
  runtime: Pick<FilesRuntime, 'storage'>,
  caller: CommandCaller,
  file: { readonly storeAccountId: string; readonly storageKey: string },
  maxBytes: number,
): Promise<Buffer> {
  let bytes: Buffer | null
  try {
    bytes = await runtime.storage.read(caller, file.storeAccountId, file.storageKey, maxBytes)
  } catch (error) {
    // The store's account paused, rate-limited or not answering: 503 in words, worth a retry.
    if (error instanceof GatewayRefusal || error instanceof GatewayCallFailed) throw new ApiError('not_ready', 'The file store does not answer now. Try again in a moment.')
    throw error
  }
  if (!bytes) throw new MissingFileError()
  return bytes
}
// ── end B-W2b-F56 ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The tenant's file store: its R2 account (any mode) that is not DISABLED, the company's own before the tenant-wide
 * one. None, or two at the same level, is a set-up problem (409).
 */
export async function storeAccountOf(caller: CommandCaller, companyId: string | null): Promise<string> {
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

export async function checkSite(tx: Pick<FactoryClient, 'site'>, sharing: Sharing): Promise<void> {
  if (sharing.floorSiteId === null) return
  const site = await tx.site.findFirst({ where: { id: sharing.floorSiteId, companyId: sharing.companyId ?? undefined }, select: { id: true } })
  if (!site) throw new ValidationError('The site is not one of the file\'s company.', [{ path: 'body/floorSiteId', message: 'Expected a site of the file\'s company.' }])
}

export const presignedView = (request: PresignedRequest) => ({ method: request.method, url: request.url, headers: { ...request.headers }, expiresAt: toUtcIso(request.expiresAt) })

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
  /** B-W2b-14: what the file is (StoredFile.category, a tag: DDT_PHOTO, CLAIM_PHOTO …), set by the module that uploads it. */
  readonly category?: FileCategory | null | undefined
  /** B-TH-083: "This is a measurement sheet" — filed as MEASUREMENTS (body data: opened only with sales.measurements.view). */
  readonly measurementSheet?: boolean | undefined
}

// ---- B-TH-003 (threads plan TH-0, WALL-G02; T25): a file is shared only with its record's party ---------------------------

/** The office's words for a share outside that does not reach the record's own party (only the office shares files). */
export const RECORD_PARTY_WORDS = Object.freeze({
  noParty: "This record has no customer or supplier: its files are not shared with a portal or a link. Share the file from the customer's or supplier's own record.",
  otherParty: "A file is shared only with its record's own customer or supplier, never with another one.",
})

/**
 * B-TH-003 (the brand wall, Owner rule 2026-11-16: "one brand must not be able to see anything related to any other brand"):
 * the party a file shared with a portal or a link reaches is its RECORD's — the customer, supplier or subcontractor the
 * record's thread resolver names (platform/threads/records.ts, read in the caller's office scope), never one a request names.
 * Shared outside without a party, the record's is taken; another party, or a record with none (or of a type no resolver
 * knows), is refused in words (400, `body/partyId`). A sharing with the office or the floor only is returned as it is.
 */
export async function withRecordParty(caller: CommandCaller, record: { readonly recordType: string; readonly recordId: string }, sharing: Sharing, at = 'body'): Promise<Sharing> {
  if (!sharing.visibility.includes('PARTNER') && !sharing.visibility.includes('LINK')) return sharing
  const scope = await caller.withClient((client) => resolveRecord(client, record.recordType, record.recordId))
  const own = scope?.partyId ?? null
  const refused = (message: string) => new ValidationError(message, [{ path: `${at}/partyId`, message }])
  if (own === null) throw refused(RECORD_PARTY_WORDS.noParty)
  if (sharing.partyId !== null && sharing.partyId !== own) throw refused(RECORD_PARTY_WORDS.otherParty)
  return { ...sharing, partyId: own }
}
// ---- end B-TH-003

/**
 * files.requestUpload, then the presigned PUT. A repeat with the same Idempotency-Key gets the same file, freshly
 * presigned. A record type whose files its module owns (owned.ts) is refused unless that module calls with `viaModule`.
 */
export async function requestUpload(runtime: FilesRuntime, caller: CommandCaller, input: UploadRequest, idempotencyKey?: string, path: UploadPath = {}) {
  assertGenericPath(input.recordType, input.kind, path)
  const now = runtime.clock.now()
  const contentType = normaliseContentType(input.contentType)
  const originalName = cleanFileName(input.originalName)
  const asked: Sharing = {
    visibility: normaliseVisibility(input.visibility),
    companyId: input.companyId ?? null,
    floorSiteId: input.floorSiteId ?? null,
    partyId: input.partyId ?? null,
  }
  // B-TH-003: through the generic route a portal or link share reaches the record's own party only.
  const sharing: Sharing = path.generic ? await withRecordParty(caller, input, asked) : asked
  const retention = retentionFor(input.kind, input.retainUntil ? new Date(input.retainUntil) : null, now)
  // B-TH-083: the tick files it as a measurement sheet (a document, an attachment or a photo of one; never for a floor).
  const category: FileCategory | null = input.measurementSheet ? MEASUREMENT_SHEET_CATEGORY : (input.category ?? null)
  const sheetProblem = category === MEASUREMENT_SHEET_CATEGORY ? measurementSheetProblem({ kind: input.kind, visibility: sharing.visibility }) : null
  const problems: Issue[] = [
    ...uploadProblems({ kind: input.kind, contentType, sizeBytes: input.sizeBytes, sha256: input.sha256, clip: path.clip }),
    ...(originalName === null ? [{ path: 'body/originalName', message: 'The file needs a name.' }] : []),
    ...sharingProblems(sharing),
    ...retention.problems,
    ...(sheetProblem ? [{ path: 'body/measurementSheet', message: sheetProblem }] : []),
  ]
  if (problems.length > 0) throw new ValidationError('The upload is not valid.', problems)
  mayWrite(caller, FILES_UPLOAD, sharing)
  // Sharing with a floor, a portal or links is files.manage, at upload as afterwards (COL-050).
  if (sharing.visibility.length > 1) mayWrite(caller, FILES_MANAGE, sharing)
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
        ...(category ? { category } : {}),
        createdAt: at,
        updatedAt: at,
        createdById: context.audience === 'office' ? context.actorId : null,
      },
      select: SELECT_FOR.office,
    })
    audit({ recordType: 'StoredFile', recordId: id, companyId: sharing.companyId, after: { ...audited(row), ...(category ? { category } : {}) } })
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

/** A file the API made itself: a rendered document (platform/documents), never bytes from a request. */
export interface GeneratedFile {
  readonly companyId: string | null
  readonly recordType: string
  readonly recordId: string
  readonly kind: FileKind
  readonly originalName: string
  readonly contentType: string
  readonly body: Uint8Array
  readonly visibility?: readonly FileAudience[] | undefined
  readonly floorSiteId?: string | null | undefined
  readonly partyId?: string | null | undefined
  /** Default: none, or ten years for the fiscal archive (retentionFor). */
  readonly retainUntil?: Date | null | undefined
}

export interface GeneratedFileOptions {
  /** The command that makes the file (`documents.render`): its audit action and idempotency scope. Default files.storeGenerated. */
  readonly commandName?: Permission
  readonly idempotencyKey?: string | undefined
  /** What the audit row records beside the file: the document's type, number, layout and language. Plain JSON, no money. */
  readonly details?: Readonly<Record<string, string | number | boolean | null>>
}

/**
 * A generated file whose bytes are in the store and whose row is not written yet (putGeneratedFile → recordGeneratedFile).
 * Plain data: the row's content, sharing and retention as checked before the put.
 */
export interface PreparedGeneratedFile {
  readonly companyId: string | null
  readonly recordType: string
  readonly recordId: string
  readonly kind: FileKind
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly visibility: readonly FileAudience[]
  readonly floorSiteId: string | null
  readonly partyId: string | null
  readonly retainUntil: Date | null
  readonly storeAccountId: string
  readonly storageKey: string
  /** B-W2b-160 (FV1:01): the file a copy was made from (prepareFileCopy); absent for a document the API made. */
  readonly sourceFileId?: string
}

/**
 * The first half of storing a generated file, OUTSIDE any transaction: the file's rules (type, size, name, sharing,
 * retention), the tenant's store, a new random key, and the bytes put there (one gateway call, files.put). Nothing is
 * written to the database: recordGeneratedFile does that inside the caller's command. When that command never runs or
 * fails, the object stays behind with no row naming it: never listed, never downloadable, removed by a later sweep.
 */
export async function putGeneratedFile(runtime: FilesRuntime, caller: CommandCaller, file: GeneratedFile): Promise<PreparedGeneratedFile> {
  const context = contextOf(caller)
  if (context.audience !== 'office' && context.audience !== 'system') throw new ForbiddenError()
  const now = runtime.clock.now()
  const body = Buffer.from(file.body.buffer, file.body.byteOffset, file.body.byteLength)
  const sha256 = createHash('sha256').update(body).digest('hex')
  const contentType = normaliseContentType(file.contentType)
  const originalName = cleanFileName(file.originalName)
  const sharing: Sharing = {
    visibility: normaliseVisibility(file.visibility),
    companyId: file.companyId,
    floorSiteId: file.floorSiteId ?? null,
    partyId: file.partyId ?? null,
  }
  const retention = retentionFor(file.kind, file.retainUntil ?? null, now)
  const problems: Issue[] = [
    ...uploadProblems({ kind: file.kind, contentType, sizeBytes: body.length, sha256 }),
    ...(originalName === null ? [{ path: 'body/originalName', message: 'The file needs a name.' }] : []),
    ...sharingProblems(sharing),
    ...retention.problems,
  ]
  if (problems.length > 0) throw new ValidationError('The generated file is not valid.', problems)
  const storeAccountId = await storeAccountOf(caller, sharing.companyId)
  const storageKey = storageKeyFor({ tenantId: tenantOf(context), companyId: sharing.companyId, kind: file.kind, now, random: randomUUID() })
  await storeCall(() => runtime.storage.put(caller, storeAccountId, { key: storageKey, contentType, body, sha256 }))
  return {
    companyId: sharing.companyId,
    recordType: file.recordType,
    recordId: file.recordId,
    kind: file.kind,
    originalName: originalName!,
    contentType,
    sizeBytes: body.length,
    sha256,
    visibility: sharing.visibility,
    floorSiteId: sharing.floorSiteId,
    partyId: sharing.partyId,
    retainUntil: retention.retainUntil,
    storeAccountId,
    storageKey,
  }
}

/**
 * The second half, INSIDE the caller's command (the module's own command, e.g. the one that names the file on its
 * record): the StoredFile row AVAILABLE (the …_files_guards trigger lets a generated document be born AVAILABLE), its
 * audit row and the event file.available, in the caller's transaction. A rollback leaves no row.
 */
export async function recordGeneratedFile(
  tools: Pick<CommandTools, 'tx' | 'audit' | 'emit' | 'now' | 'context'>,
  prepared: PreparedGeneratedFile,
  // B-TH-024: `category`, a carried copy keeps its source's (StoredFile.category, set with the row).
  options: { readonly action?: Permission; readonly details?: GeneratedFileOptions['details']; readonly category?: FileCategory | null } = {},
): Promise<FileView> {
  const { tx, now: at, context: inside } = tools
  const sharing: Sharing = { visibility: [...prepared.visibility], companyId: prepared.companyId, floorSiteId: prepared.floorSiteId, partyId: prepared.partyId }
  if (sharing.companyId !== null && !(await tx.company.findUnique({ where: { id: sharing.companyId }, select: { id: true } }))) {
    throw new NotFoundError('Company not found.')
  }
  await checkSite(tx, sharing)
  const id = newId()
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
      availableAt: at,
      visibility: [...prepared.visibility] as FileAudience[],
      floorSiteId: prepared.floorSiteId,
      partyId: prepared.partyId,
      retainUntil: prepared.retainUntil,
      // B-W2b-160 (FV1:01): a copy names its source; the database checks the bytes match and the source is AVAILABLE.
      ...(prepared.sourceFileId ? { sourceFileId: prepared.sourceFileId } : {}),
      ...(options.category ? { category: options.category } : {}),
      createdAt: at,
      updatedAt: at,
      createdById: inside.audience === 'office' ? inside.actorId : null,
    },
    select: SELECT_FOR.office,
  })
  tools.audit({ ...(options.action ? { action: options.action } : {}), recordType: 'StoredFile', recordId: id, companyId: prepared.companyId, after: { ...audited(row), ...(options.details ?? {}) } })
  tools.emit({ type: 'file.available', subject: id, companyId: row.companyId, payload: { fileId: id, recordType: row.recordType, recordId: row.recordId, kind: row.kind } })
  return viewOf(row)
}

/**
 * Stores a file the API made itself (A1 §3.9: "stored in R2 with its hash, linked to the record"): the bytes go to the
 * tenant's store first (putGeneratedFile: one gateway call, files.put, under a new random key), then ONE command records
 * the file AVAILABLE with its audit row and the event file.available (recordGeneratedFile). The caller is an office
 * session or a tenant's system context and has checked its own permission for the record (quotes.send, ddt.issue,
 * documents.view for a preview…): no files.* permission is asked, as for every document the system makes. Sharing and
 * retention follow the upload's rules. A module that names the file on its own record in the same transaction calls the
 * two halves itself (invoicing: the invoice's XML and PDF).
 */
export async function storeGeneratedFile(runtime: FilesRuntime, caller: CommandCaller, file: GeneratedFile, options: GeneratedFileOptions = {}): Promise<FileView> {
  const prepared = await putGeneratedFile(runtime, caller, file)
  const input = {
    companyId: prepared.companyId,
    recordType: prepared.recordType,
    recordId: prepared.recordId,
    kind: prepared.kind,
    originalName: prepared.originalName,
    contentType: prepared.contentType,
    sizeBytes: prepared.sizeBytes,
    sha256: prepared.sha256,
    visibility: prepared.visibility,
    floorSiteId: prepared.floorSiteId,
    partyId: prepared.partyId,
    details: options.details ?? null,
  }
  const { result } = await command(caller, { name: options.commandName ?? 'files.storeGenerated', idempotencyKey: options.idempotencyKey, input }, (tools) =>
    recordGeneratedFile(tools, prepared, options.details ? { details: options.details } : {}),
  )
  return result
}

/** Where a copy of a file goes: another record, maybe another kind, with its own sharing and retention. */
export interface FileCopyTarget {
  readonly companyId: string | null
  readonly recordType: string
  readonly recordId: string
  /** Default: the source's kind (a fiscal archive copy for a party is a DOCUMENT). */
  readonly kind?: FileKind | undefined
  /** Default: the source's name. */
  readonly originalName?: string | undefined
  readonly visibility?: readonly FileAudience[] | undefined
  readonly floorSiteId?: string | null | undefined
  readonly partyId?: string | null | undefined
  readonly retainUntil?: Date | null | undefined
}

/**
 * The first half of copying a stored file onto another record, OUTSIDE any transaction, like putGeneratedFile (B-W1-49:
 * a style's signed DoC, OFFICE only because it serves every customer, copied onto a shipment and shared with that
 * shipment's party; the copy is the evidence of what travelled). The source must be AVAILABLE; its bytes are read from
 * the store (files.read), checked against its SHA-256 and put under a new key (files.put) with the target's rules
 * (kind, sharing, retention). recordGeneratedFile then records the copy inside the caller's command. The caller is an
 * office session or a tenant's system context and has checked its own permission for both records: no files.*
 * permission is asked, as for generated files.
 */
export async function prepareFileCopy(runtime: FilesRuntime, caller: CommandCaller, sourceFileId: string, target: FileCopyTarget): Promise<PreparedGeneratedFile & { readonly sourceFileId: string }> {
  const context = contextOf(caller)
  if (context.audience !== 'office' && context.audience !== 'system') throw new ForbiddenError()
  const source = await readOffice(caller, sourceFileId)
  if (source.status !== 'AVAILABLE') throw new InvalidStateError(`This file is ${source.status}; only an available file is copied.`)
  const body = await storeCall(() => runtime.storage.read(caller, source.storeAccountId, source.storageKey, source.sizeBytes))
  if (!body) throw new ConflictError('The file is missing from the file store; nothing was copied.')
  if (createHash('sha256').update(body).digest('hex') !== source.sha256) throw new ConflictError('The stored file does not match its SHA-256; nothing was copied.')
  const prepared = await putGeneratedFile(runtime, caller, {
    companyId: target.companyId,
    recordType: target.recordType,
    recordId: target.recordId,
    kind: target.kind ?? source.kind,
    originalName: target.originalName ?? source.originalName,
    contentType: source.contentType,
    body,
    visibility: target.visibility,
    floorSiteId: target.floorSiteId,
    partyId: target.partyId,
    retainUntil: target.retainUntil,
  })
  return { ...prepared, sourceFileId: source.id }
}

/** Why a stored object is not the file that was announced, or null when it is. */
function mismatchOf(file: OfficeRow, object: StoredObject): QuarantineReason | null {
  if (object.sizeBytes !== file.sizeBytes) return 'size_mismatch'
  if (normaliseContentType(object.contentType ?? '') !== file.contentType) return 'type_mismatch'
  if (object.sha256 !== file.sha256) return 'checksum_mismatch'
  return null
}

/**
 * files.completeUpload: the store's HEAD decides AVAILABLE or QUARANTINED. Confirming an AVAILABLE file again changes
 * nothing. A file of a record type its module owns (owned.ts) is confirmed only by that module (`viaModule`).
 */
export async function completeUpload(runtime: FilesRuntime, caller: CommandCaller, fileId: string, idempotencyKey?: string, path: UploadPath = {}): Promise<FileView> {
  const before = await readOffice(caller, fileId)
  mayWrite(caller, FILES_UPLOAD, { companyId: before.companyId, floorSiteId: null, partyId: null })
  assertGenericPath(before.recordType, before.kind, path)
  if (before.status === 'AVAILABLE') return viewOf(before)
  // B-W2a-42 (PLT-245): a file held for its virus scan is scanned again (the person's Try again).
  const scanner = processScanner()
  if (scanner && waitsForScan(before)) return (await scanFile(runtime, scanner, caller, fileId)).file
  if (before.status !== 'PENDING_UPLOAD') throw new InvalidStateError(`This file is ${before.status}; only a pending upload is confirmed.`)
  // B-W2b-160 (COL-052): a large upload in parts is completed through its own session (the store joins the parts first).
  await refuseLargeUploadConfirm(caller, fileId)
  const object = await storeCall(() => runtime.storage.head(caller, before.storeAccountId, before.storageKey))
  if (!object) throw new ConflictError('The upload has not arrived yet: send the file to its upload URL, then confirm it.')
  const reason = mismatchOf(before, object)

  const { result } = await command(
    caller,
    { name: 'files.completeUpload', idempotencyKey, input: { fileId }, record: { type: 'StoredFile', id: fileId, expectedVersion: before.version } },
    async ({ tx, audit, emit, now }) => {
      const current = await tx.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: SELECT_FOR.office })
      // With a scanner, a matching upload waits QUARANTINED (`scan_pending`) until its scan says CLEAN (B-W2a-42).
      const to = reason === null && !scanner ? 'AVAILABLE' : 'QUARANTINED'
      assertTransition(fileMachine, current.status, to, { legalHold: current.legalHold, retainUntil: current.retainUntil, now })
      const row = await tx.storedFile.update({
        where: { id: fileId },
        data: reason !== null ? { status: to, quarantineReason: reason } : scanner ? heldForScan() : { status: to, availableAt: now },
        select: SELECT_FOR.office,
      })
      audit({ recordType: 'StoredFile', recordId: fileId, companyId: row.companyId, before: { status: current.status }, after: { status: row.status, quarantineReason: row.quarantineReason, ...(scanner ? { scanStatus: row.scanStatus } : {}) } })
      if (row.status === 'AVAILABLE') {
        emit({ type: 'file.available', subject: fileId, companyId: row.companyId, payload: { fileId, recordType: row.recordType, recordId: row.recordId, kind: row.kind } })
        // B-W2b-160 (COL-046): a later version that became AVAILABLE supersedes the earlier ones in this transaction.
        await supersedeEarlierVersions({ tx, audit, now }, fileId)
      }
      return viewOf(row)
    },
  )
  if (scanner && reason === null) return (await scanFile(runtime, scanner, caller, fileId)).file
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
export async function downloadFile(runtime: FilesRuntime, callers: Callers, fileId: string, path: UploadPath = {}) {
  const context = contextOf(callers.caller)
  const row = await readVisible(callers.caller, fileId, path)
  if (row.status !== 'AVAILABLE') throw new InvalidStateError(`This file is ${row.status}; only an available file can be downloaded.`)
  // B-TH-083: a measurement sheet's opening is recorded (who, when, how).
  await recordSheetOpening(callers.caller, row, 'download')
  const storeCaller = context.audience === 'office' ? callers.caller : callers.system(tenantOf(context))
  // B-W2b-160 (COL-058): a portal or a link gets a picture only as its stripped copy (no EXIF, no position).
  const key = await keyShownTo(runtime, context, storeCaller, row)
  // B-W2b-F56: a key no upload could have made holds no bytes: missing (404), never a store call that fails as an outage.
  if (!isStorageKey(key)) throw new MissingFileError()
  const download = await storeCall(() =>
    runtime.storage.presignDownload(storeCaller, row.storeAccountId, {
      key,
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
  if (readsThroughModule(record.recordType)) return []
  // B-TH-029: an office list asks the record's own scope first (a record out of reach lists nothing).
  if (!(await officeReachesRecord(caller, record))) return []
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
  // B-TH-083: an office reader without sales.measurements.view sees a record's sheets locked (counted, never named).
  const opens = !rows.some(isMeasurementSheet) || (await opensMeasurementSheets(caller, { ...record, companyId: rows[0]?.companyId ?? null }))
  const views = rows.filter((row) => audienceSees(viewerOf(context), row)).map((row) => (isMeasurementSheet(row) && !opens ? lockedView(viewOf(row)) : viewOf(row)))
  // B-TH-024: the office sees where a copy came from (the source's record, name and version), when it may open that record.
  return context.audience === 'office' ? withOrigins(caller, views) : views
}

/** B-TH-024: each copy's origin — its source file's record, name and version — for the office (null: its record out of reach). */
async function withOrigins(caller: CommandCaller, views: readonly FileView[]): Promise<FileView[]> {
  const sourceIds = [...new Set(views.flatMap((view) => (view.sourceFileId ? [view.sourceFileId] : [])))]
  if (sourceIds.length === 0) return [...views]
  const sources = await caller.withClient((client) => client.storedFile.findMany({ where: { id: { in: sourceIds } }, select: { id: true, recordType: true, recordId: true, originalName: true, versionNo: true, companyId: true, category: true } }))
  const reachable = new Map<string, (typeof sources)[number]>()
  for (const source of sources) {
    if (!(await officeReachesRecord(caller, source))) continue
    // B-TH-083: a sheet's name is not shown to a reader who may not open it.
    reachable.set(source.id, isMeasurementSheet(source) && !(await opensMeasurementSheets(caller, source)) ? { ...source, originalName: '' } : source)
  }
  return views.map((view) => {
    if (!view.sourceFileId) return view
    const source = reachable.get(view.sourceFileId)
    return { ...view, origin: source ? { fileId: source.id, recordType: source.recordType, recordId: source.recordId, originalName: source.originalName, versionNo: source.versionNo } : null }
  })
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

/**
 * Keeps files at least until `retainUntil`, inside the caller's own command (a module that must keep a record's files:
 * compliance keeps a registered certificate's PDF, Reg. (EU) 2016/425 art. 8(3)). The caller checked its own
 * permission for the record; no files.* permission is asked, as for generated files. A file already kept longer, or
 * deleted, is left as it is: the date only moves later (the …_files_guards trigger refuses anything else). One audit
 * row per changed file, as files.setRetention writes it. Returns the files it changed.
 */
export async function retainFilesInCommand(tools: Pick<CommandTools, 'tx' | 'audit'>, fileIds: readonly string[], retainUntil: Date, reason: string): Promise<string[]> {
  const rows = await tools.tx.storedFile.findMany({ where: { id: { in: [...fileIds] }, status: { not: 'DELETED' } }, select: { id: true, companyId: true, retainUntil: true, legalHold: true }, orderBy: { id: 'asc' } })
  const changed: string[] = []
  for (const row of rows) {
    if (row.retainUntil !== null && row.retainUntil >= retainUntil) continue
    await tools.tx.storedFile.update({ where: { id: row.id }, data: { retainUntil, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: 'files.setRetention',
      recordType: 'StoredFile',
      recordId: row.id,
      companyId: row.companyId,
      before: { legalHold: row.legalHold, retainUntil: iso(row.retainUntil) },
      after: { legalHold: row.legalHold, retainUntil: iso(retainUntil) },
      reason,
    })
    changed.push(row.id)
  }
  return changed
}

/** files.setVisibility: who sees the file (COL-050). The caller needs files.manage for the new site and party too. */
export async function setVisibility(
  caller: CommandCaller,
  fileId: string,
  input: { visibility: readonly FileAudience[]; floorSiteId?: string | null | undefined; partyId?: string | null | undefined; version: number },
  idempotencyKey?: string,
): Promise<FileView> {
  const before = await readOffice(caller, fileId)
  // B-TH-003: a portal or link share reaches the file's record's own party only.
  const sharing: Sharing = await withRecordParty(caller, before, {
    visibility: normaliseVisibility(input.visibility),
    companyId: before.companyId,
    floorSiteId: input.floorSiteId ?? null,
    partyId: input.partyId ?? null,
  })
  mayWrite(caller, FILES_MANAGE, { companyId: before.companyId, floorSiteId: null, partyId: null })
  mayWrite(caller, FILES_MANAGE, sharing)
  if (before.status === 'DELETED') throw new InvalidStateError('This file is deleted.')
  // B-W2b-160 (COL-046): a superseded version is read-only: its sharing may only narrow (the database holds the same rule).
  if (before.supersededAt !== null && !sharingNarrows(before, sharing)) {
    throw new InvalidStateError('This is an earlier version: it is never shared more widely. Share the current version instead.')
  }
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
