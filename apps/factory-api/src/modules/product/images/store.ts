import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Grant, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { LIMITS, type PatternFilesView, type PictureView, type StylePicturesView } from '@nexus/factory-domain/product/images/contracts'
import {
  calloutsOf,
  inGalleryOrder,
  inRangeOrder,
  isPictureType,
  PATTERN_FILE_KINDS,
  patternEditKind,
  patternRefusal,
  pictureChangeRefusal,
  PICTURE_TYPES,
  printableInTechPack,
  type PatternFileKind,
  type RevisionFacts,
} from '@nexus/factory-domain/product/images/rules'
import { editRefusal } from '@nexus/factory-domain/product/lifecycle/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type RequestContext, type SystemContext } from '../../../core/context'
import { editRuleOf } from '../lifecycle/edit-rule'
import { mayWrite } from '../materials/store'

/**
 * A style's pictures and pattern files (factory-db `StyleImage`, `StyleRevisionFile`, B-W2b-206) and the files they name
 * (`StoredFile`): the columns every read names, who may see and change them, the section views, and the looks (the API's
 * own address of each picture, `GET /product/pictures/<file id>`, its bytes read once from the store as the tenant's system
 * holding files.read over the style's company: bytes.ts; the person needs no files right to
 * see a style's pictures, as a point of measure's picture, B-W2b-224).
 *
 * Lock order of a write: the style row FOR UPDATE (W1's lockStyle: a picture's or a pattern file's changes take turns with
 * the style's), the style's edit rule (B-W2b-221), then the rows. The database's guards (StyleImage_guard,
 * StyleRevisionFile_guard) refuse what these refuse in words first.
 */

export type Client = FactoryClient | CommandTx

export const STYLE_COLUMNS = { id: true, code: true, name: true, companyId: true, status: true, sizes: true } as const satisfies Prisma.StyleSelect
export type StyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_COLUMNS }>

export const PICTURE_COLUMNS = {
  id: true,
  styleId: true,
  revisionId: true,
  colourwayId: true,
  fileId: true,
  kind: true,
  seq: true,
  isMain: true,
  caption: true,
  callouts: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.StyleImageSelect
export type PictureRow = Prisma.StyleImageGetPayload<{ select: typeof PICTURE_COLUMNS }>

export const PATTERN_COLUMNS = { id: true, styleId: true, revisionId: true, fileId: true, kind: true, format: true, sizes: true, note: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.StyleRevisionFileSelect
export type PatternRow = Prisma.StyleRevisionFileGetPayload<{ select: typeof PATTERN_COLUMNS }>

export const FILE_COLUMNS = {
  id: true,
  recordType: true,
  recordId: true,
  kind: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  status: true,
  companyId: true,
  seriesId: true,
  versionNo: true,
  supersededAt: true,
  createdAt: true,
} as const satisfies Prisma.StoredFileSelect
export type FileRow = Prisma.StoredFileGetPayload<{ select: typeof FILE_COLUMNS }>

const REVISION_COLUMNS = { id: true, styleId: true, revision: true, status: true } as const satisfies Prisma.StyleRevisionSelect
type RevisionRow = Prisma.StyleRevisionGetPayload<{ select: typeof REVISION_COLUMNS }>

export const revisionFactsOf = (row: Pick<RevisionRow, 'id' | 'revision' | 'status'>): RevisionFacts => ({ id: row.id, revision: row.revision, status: row.status as RevisionFacts['status'] })

// ---- who may see and change -----------------------------------------------------------------------------------------------

export function contextOf(caller: CommandCaller): RequestContext {
  const context = caller.factoryContext
  if (!context) throw new ForbiddenError()
  return context
}

/** The style as the caller may see it with `permission` (its company); another company's or tenant's is not found. */
export async function readStyleFor(caller: CommandCaller, styleId: string, permission: Permission): Promise<StyleRow> {
  const context = contextOf(caller)
  if (!isUuid(styleId)) throw new NotFoundError('Style not found.')
  const row = await caller.withClient((client) => client.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS }))
  if (!row || !can(actorOf(context), permission, { companyId: row.companyId })) throw new NotFoundError('Style not found.')
  return row
}

export function assertMayWrite(caller: CommandCaller, permission: Permission, companyId: string | null): void {
  if (!mayWrite(actorOf(contextOf(caller)), permission, companyId)) {
    throw new ForbiddenError(companyId === null ? "The pictures and pattern files of a style for every company are changed only by a role over every company." : undefined)
  }
}

/** A revision of this style (another style's is not found). */
export async function findRevision(client: Client, styleId: string, revisionId: string): Promise<RevisionRow> {
  const row = isUuid(revisionId) ? await client.styleRevision.findUnique({ where: { id: revisionId }, select: REVISION_COLUMNS }) : null
  if (!row || row.styleId !== styleId) throw new NotFoundError('Revision not found.')
  return row
}

/** Why the style's pictures or pattern files do not change now: an archived style, then its edit rule for `kind`; or null. */
export async function writeRefusal(client: Client, style: Pick<StyleRow, 'id' | 'code' | 'status'>, kind: 'DETAILS' | 'DRAFT'): Promise<string | null> {
  if (style.status === 'ARCHIVED') return `Style ${style.code} is archived: reactivate it before changing its pictures or pattern files.`
  const { rule, facts } = await editRuleOf(client, style.id)
  return editRefusal(rule, kind, facts)?.message ?? null
}

/** The request acting as its tenant's system, holding exactly `permissions` over the style's company (every company for a tenant-wide style). */
export function filesCaller(request: FastifyRequest, companyId: string | null, permissions: readonly Permission[]): CommandCaller {
  const context = contextOf(request)
  if (context.audience !== 'office' && context.audience !== 'system') throw new ForbiddenError()
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: companyId === null ? 'all' : [companyId], sites: 'all', parties: 'all' }
  const system: SystemContext = Object.freeze({ audience: 'system', tenantId: context.tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = system
  return view
}

/** The picture's address on the API (bytes.ts), or null when it cannot be shown (not available, not a picture). */
export function lookOf(file: Pick<FileRow, 'id' | 'status' | 'contentType'>): { url: string } | null {
  return file.status === 'AVAILABLE' && isPictureType(file.contentType) ? { url: `/product/pictures/${file.id}` } : null
}

// ---- pictures -------------------------------------------------------------------------------------------------------------

export const readPictures = (client: Client, styleId: string): Promise<PictureRow[]> =>
  client.styleImage.findMany({ where: { styleId }, select: PICTURE_COLUMNS, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })

export async function readFiles(client: Client, ids: readonly string[]): Promise<Map<string, FileRow>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await client.storedFile.findMany({ where: { id: { in: unique } }, select: FILE_COLUMNS })
  return new Map(rows.map((row) => [row.id, row]))
}

/** Whether a stored file may be one of this style's pictures (the database's StyleImage_guard, in words first), or why not. */
export async function pictureFileProblem(client: Client, styleId: string, file: FileRow | undefined): Promise<string | null> {
  if (!file || file.status === 'DELETED') return 'The file was not found among the style’s files: upload it to the style first.'
  if (file.status !== 'AVAILABLE') return `The file ${file.originalName} is not available yet (${file.status === 'PENDING_UPLOAD' ? 'still uploading' : 'waiting for its check'}): add it once it is.`
  if (!['PHOTO', 'DOCUMENT', 'ATTACHMENT'].includes(file.kind)) return `The file ${file.originalName} is not a picture or a drawing.`
  if (!isPictureType(file.contentType)) return `The file ${file.originalName} is a ${file.contentType}: a picture is a JPEG, a PNG or a WebP.`
  const ofStyle =
    (file.recordType === 'Style' && file.recordId === styleId) ||
    (file.recordType === 'Colourway' && (await client.colourway.count({ where: { id: file.recordId, styleId } })) > 0) ||
    (file.recordType === 'StyleRevision' && (await client.styleRevision.count({ where: { id: file.recordId, styleId } })) > 0)
  return ofStyle ? null : 'The file belongs to another record: upload it to this style first.'
}

function pictureViewOf(row: PictureRow, file: FileRow | undefined, revisions: Map<string, RevisionRow>, colourways: Map<string, { id: string; code: string; name: string }>, look: PictureView['look']): PictureView {
  const revision = row.revisionId ? revisions.get(row.revisionId) : undefined
  const facts = revision ? revisionFactsOf(revision) : null
  const colourway = row.colourwayId ? colourways.get(row.colourwayId) : undefined
  return {
    id: row.id,
    version: row.version,
    kind: row.kind,
    seq: row.seq,
    isMain: row.isMain,
    caption: row.caption,
    callouts: calloutsOf(row.callouts),
    revision: facts ? { id: facts.id, revision: facts.revision, status: facts.status } : null,
    colourway: colourway ? { id: colourway.id, code: colourway.code, name: colourway.name } : null,
    file: { id: row.fileId, name: file?.originalName ?? '', contentType: file?.contentType ?? '', sizeBytes: file?.sizeBytes ?? 0, status: file?.status ?? 'DELETED' },
    look,
    printable: file ? printableInTechPack(file) : false,
    frozen: pictureChangeRefusal(facts),
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The Sketches and pictures section of the style (its pictures with a look each, the files not yet pictures, what may change). */
export async function picturesView(request: FastifyRequest, styleId: string): Promise<StylePicturesView> {
  const style = await readStyleFor(request, styleId, 'product.styles.view')
  const read = await request.withClient(async (client) => {
    const rows = await readPictures(client, styleId)
    const files = await readFiles(
      client,
      rows.map((row) => row.fileId),
    )
    const revisions = await client.styleRevision.findMany({ where: { styleId }, select: REVISION_COLUMNS, orderBy: { revision: 'desc' } })
    const colourways = await client.colourway.findMany({ where: { styleId }, select: { id: true, code: true, name: true, status: true }, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] })
    const used = new Set(rows.map((row) => row.fileId))
    const unused = await client.storedFile.findMany({
      where: { recordType: 'Style', recordId: styleId, status: 'AVAILABLE', kind: { in: ['PHOTO', 'DOCUMENT', 'ATTACHMENT'] }, contentType: { in: [...PICTURE_TYPES] }, supersededAt: null },
      select: FILE_COLUMNS,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50 + used.size,
    })
    const refusal = await writeRefusal(client, style, 'DETAILS')
    return { rows, files, revisions, colourways, unused: unused.filter((file) => !used.has(file.id)).slice(0, 50), refusal }
  })
  const revisions = new Map(read.revisions.map((row) => [row.id, row]))
  const colourways = new Map(read.colourways.map((row) => [row.id, row]))
  const pictures = read.rows.map((row) => {
    const file = read.files.get(row.fileId)
    return pictureViewOf(row, file, revisions, colourways, file ? lookOf(file) : null)
  })
  return {
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status },
    pictures: inGalleryOrder(pictures),
    unused: read.unused.map((file) => ({ fileId: file.id, name: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, createdAt: toUtcIso(file.createdAt) })),
    revisions: read.revisions.map((row) => ({ id: row.id, revision: row.revision, status: row.status })),
    colourways: read.colourways.map((row) => ({ id: row.id, code: row.code, name: row.name, status: row.status })),
    refusal: read.refusal,
    limits: { ...LIMITS, types: [...PICTURE_TYPES] },
    at: new Date().toISOString(),
  }
}

// ---- pattern files ----------------------------------------------------------------------------------------------------------

export const readPatternFiles = (client: Client, revisionId: string): Promise<PatternRow[]> =>
  client.styleRevisionFile.findMany({ where: { revisionId }, select: PATTERN_COLUMNS, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })

/** The versions of each file's series (its first version's id), not deleted, newest first. */
export async function seriesOf(client: Client, files: readonly FileRow[]): Promise<Map<string, FileRow[]>> {
  const roots = [...new Set(files.map((file) => file.seriesId ?? file.id))]
  if (roots.length === 0) return new Map()
  const rows = await client.storedFile.findMany({ where: { OR: [{ id: { in: roots } }, { seriesId: { in: roots } }], status: { not: 'DELETED' } }, select: FILE_COLUMNS, orderBy: [{ versionNo: 'desc' }, { createdAt: 'desc' }] })
  const out = new Map<string, FileRow[]>()
  for (const row of rows) {
    const root = row.seriesId ?? row.id
    out.set(root, [...(out.get(root) ?? []), row])
  }
  return out
}

/** Whether a stored file may be a pattern file of this revision (StyleRevisionFile_guard, in words first), or why not. */
export function patternFileProblem(styleId: string, revisionId: string, file: FileRow | undefined): string | null {
  if (!file || file.status === 'DELETED') return 'The file was not found: send it to the revision first.'
  if (file.status !== 'AVAILABLE') return `The file ${file.originalName} is not available yet (${file.status === 'PENDING_UPLOAD' ? 'still uploading' : 'waiting for its check'}): name it once it is.`
  if (!['DOCUMENT', 'ATTACHMENT', 'PHOTO'].includes(file.kind)) return `The file ${file.originalName} is not a document or a drawing.`
  const ofRevision = (file.recordType === 'StyleRevision' && file.recordId === revisionId) || (file.recordType === 'Style' && file.recordId === styleId)
  return ofRevision ? null : 'The file belongs to another record: send it to this revision first.'
}

/** Files & patterns › Pattern files of one revision. */
export async function patternFilesView(request: FastifyRequest, styleId: string, revisionId: string): Promise<PatternFilesView> {
  const style = await readStyleFor(request, styleId, 'product.bom.view')
  return request.withClient((client) => patternFilesViewWith(client, style, revisionId))
}

export async function patternFilesViewWith(client: Client, style: StyleRow, revisionId: string): Promise<PatternFilesView> {
  const revision = revisionFactsOf(await findRevision(client, style.id, revisionId))
  const rows = await readPatternFiles(client, revisionId)
  const files = await readFiles(
    client,
    rows.map((row) => row.fileId),
  )
  const series = await seriesOf(client, [...files.values()])
  const refusal = await writeRefusal(client, style, patternEditKind(revision))
  return {
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status, sizes: [...style.sizes] },
    revision: { id: revision.id, revision: revision.revision, status: revision.status },
    files: rows.map((row) => {
      const file = files.get(row.fileId)
      const versions = file ? (series.get(file.seriesId ?? file.id) ?? [file]) : []
      return {
        id: row.id,
        version: row.version,
        kind: row.kind,
        format: row.format,
        sizes: inRangeOrder(row.sizes, style.sizes),
        note: row.note,
        file: { id: row.fileId, name: file?.originalName ?? '', contentType: file?.contentType ?? '', sizeBytes: file?.sizeBytes ?? 0, status: file?.status ?? 'DELETED', versionNo: file?.versionNo ?? 1 },
        versions: versions.map((entry) => ({ fileId: entry.id, versionNo: entry.versionNo, name: entry.originalName, sizeBytes: entry.sizeBytes, status: entry.status, createdAt: toUtcIso(entry.createdAt), current: entry.id === row.fileId })),
        frozen: patternRefusal(row.kind as PatternFileKind, revision),
        createdAt: toUtcIso(row.createdAt),
        updatedAt: toUtcIso(row.updatedAt),
      }
    }),
    refusal,
    kinds: Object.fromEntries(PATTERN_FILE_KINDS.map((kind) => [kind, patternRefusal(kind, revision)])) as PatternFilesView['kinds'],
    at: new Date().toISOString(),
  }
}

type DriverError = { code?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null

/** A guard's refusal of a picture or pattern file write (check_violation / restrict_violation 'product: …'), in its words, or null. */
export function guardWords(error: unknown): string | null {
  const cause = (error as DriverError)?.meta?.driverAdapterError?.cause
  if ((cause?.originalCode !== '23514' && cause?.originalCode !== '23001') || typeof cause.originalMessage !== 'string' || !cause.originalMessage.startsWith('product: ')) return null
  const words = cause.originalMessage.slice('product: '.length).trim()
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${/[.!?]$/.test(words) ? '' : '.'}`
}

/** A unique key refused the write (the one main picture per style, two people at once). */
export const isUniqueViolation = (error: unknown): boolean => (error as DriverError)?.code === 'P2002' || (error as DriverError)?.meta?.driverAdapterError?.cause?.originalCode === '23505'

export const nowIso = (): string => new Date().toISOString()
export type { RevisionRow }
