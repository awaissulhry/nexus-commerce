import type { Prisma } from '@nexus/factory-db'
import { FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { cleanNote, markedNameOf, markupProblems, markupTargetOf, type MarkupShape } from '@nexus/factory-domain/files/markup/rules'
import { isCurrentVersion, seriesRootOf } from '@nexus/factory-domain/files/versions/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { FileView } from '../contract'
import { contextOf, mayWrite, presignedView, readOffice, storeCall, viewOf, type OfficeRow } from '../files'
import { assertGenericPath } from '../owned'
import { UPLOAD_URL_SECONDS } from '../rules'
import type { FilesRuntime } from '../service'
import { insertNewVersion, planNewVersion, versionKeyOf } from '../versions/versions'
import type { MarkupView } from './contract'

/**
 * Marking up photos and PDFs (COL-055; B-W2b-177 on B-W2b-153's FileMarkup; QHS-063, PRD-226): arrows and circles drawn with
 * the design system's PhotoCapture (gap D21) on the CURRENT version of a file (the database checks it), with a note:
 *
 *   picture  POST /files/:fileId/markups {page: null, shapes, note, result: {contentType, sizeBytes, sha256}}: ONE command
 *            announces the marked copy as the series' next version (PENDING_UPLOAD, "<name> (marked).jpg", the current
 *            version's sharing and category; versions/versions.ts insertNewVersion: one new version at a time) and keeps the
 *            markup naming it; the answer carries its presigned PUT. The browser sends the picture with the marks drawn in,
 *            then confirms it like any upload (POST /files/:id/complete): the marked version becomes current and the one it
 *            was drawn on is superseded (versions/supersede.ts), so the original stays listed, read-only.
 *   PDF      the same route with the page and no result: an overlay; the PDF itself never changes.
 *   list     GET /files/:fileId/markups: every markup of the file's series, the newest first, with who drew it.
 *
 * Office only here (files.upload on the file's company to draw, files.read to list). A partner's or a link's markup (an
 * approval's "photo markup", B-W2b-184) is written by `recordMarkupInCommand` as the tenant's system caller with the
 * session's party (the file must be shared with it). Each markup is one command with its audit row and `file.marked_up`.
 */

export interface MarkupInput {
  readonly page: number | null
  readonly shapes: readonly unknown[]
  readonly note: string | null
  readonly result: { readonly contentType: string; readonly sizeBytes: number; readonly sha256: string } | null
}

const MARKUP_SELECT = { id: true, fileId: true, page: true, shapes: true, note: true, resultFileId: true, createdById: true, partyId: true, createdAt: true } as const satisfies Prisma.FileMarkupSelect
type MarkupRow = Prisma.FileMarkupGetPayload<{ select: typeof MARKUP_SELECT }>

const viewOfMarkup = (row: MarkupRow, versionNo: number | null, names: ReadonlyMap<string, { name: string; fromPartner: boolean }>): MarkupView => {
  const who = row.createdById ? names.get(row.createdById) : undefined
  return {
    id: row.id,
    fileId: row.fileId,
    versionNo,
    page: row.page,
    shapes: row.shapes as unknown as MarkupView['shapes'],
    note: row.note,
    resultFileId: row.resultFileId,
    createdById: row.createdById,
    createdByName: who?.name ?? null,
    fromPartner: row.partyId !== null || (who?.fromPartner ?? false),
    createdAt: toUtcIso(row.createdAt),
  }
}

/** The people behind some ids (office colleagues and partner users), as the office reads them. */
export async function namesOf(caller: CommandCaller, ids: readonly (string | null)[]): Promise<Map<string, { name: string; fromPartner: boolean }>> {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null))]
  if (wanted.length === 0) return new Map()
  const users = await caller.withClient((client) => client.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true, partyId: true } }))
  return new Map(users.map((user) => [user.id, { name: user.displayName, fromPartner: user.partyId !== null }]))
}

/**
 * INSIDE a command: the markup kept on the current version `file` (the database refuses another), its audit row and
 * `file.marked_up`. `party` names the partner or link a markup came from (the file shared with it); null for the office.
 */
export async function recordMarkupInCommand(
  tools: Pick<CommandTools, 'tx' | 'audit' | 'emit' | 'now' | 'context'>,
  file: Pick<OfficeRow, 'id' | 'companyId' | 'recordType' | 'recordId'>,
  markup: { readonly page: number | null; readonly shapes: readonly MarkupShape[]; readonly note: string | null; readonly resultFileId: string | null; readonly partyId: string | null; readonly createdById: string | null },
): Promise<MarkupRow> {
  const id = newId()
  const row = await tools.tx.fileMarkup.create({
    data: {
      id,
      fileId: file.id,
      page: markup.page,
      shapes: markup.shapes as unknown as Prisma.InputJsonValue,
      note: markup.note,
      resultFileId: markup.resultFileId,
      createdById: markup.createdById,
      partyId: markup.partyId,
      createdAt: tools.now,
    },
    select: MARKUP_SELECT,
  })
  tools.audit({
    action: 'files.markUp',
    recordType: 'StoredFile',
    recordId: file.id,
    companyId: file.companyId,
    after: { markupId: id, page: markup.page, marks: markup.shapes.length, note: markup.note !== null, resultFileId: markup.resultFileId, fromPartner: markup.partyId !== null },
  })
  tools.emit({
    type: 'file.marked_up',
    subject: file.id,
    companyId: file.companyId,
    payload: { markupId: id, fileId: file.id, recordType: file.recordType, recordId: file.recordId, page: markup.page, resultFileId: markup.resultFileId },
  })
  return row
}

const NOT_CURRENT = 'Only the current version is marked up: open the newest version and mark it up there.'

/** POST /files/:fileId/markups (office). */
export async function createMarkup(runtime: FilesRuntime, caller: CommandCaller, fileId: string, input: MarkupInput, idempotencyKey?: string) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new NotFoundError('File not found.')
  const file = await readOffice(caller, fileId)
  if (!can(actorOf(context), FILES_READ, { companyId: file.companyId })) throw new NotFoundError('File not found.')
  mayWrite(caller, FILES_UPLOAD, { companyId: file.companyId, floorSiteId: null, partyId: null })
  assertGenericPath(file.recordType, file.kind, {})
  const target = markupTargetOf(file.contentType)
  const problems = markupProblems({ target, page: input.page, shapes: input.shapes, note: input.note, resultType: input.result?.contentType ?? null })
  if (problems.length > 0) throw new ValidationError('The markup is not valid.', problems)
  if (!isCurrentVersion({ status: file.status, supersededAt: file.supersededAt ?? null })) throw new ConflictError(NOT_CURRENT)
  const shapes = input.shapes as readonly MarkupShape[]
  const note = cleanNote(input.note)
  const createdById = context.actorId

  if (target === 'pdf') {
    const { result } = await command(caller, { name: 'files.markUp', idempotencyKey, input: { fileId, ...input } }, async (tools) => {
      const fresh = await tools.tx.storedFile.findUnique({ where: { id: fileId }, select: { status: true, supersededAt: true } })
      if (!fresh || !isCurrentVersion(fresh)) throw new ConflictError(NOT_CURRENT)
      const row = await recordMarkupInCommand(tools, file, { page: input.page, shapes, note, resultFileId: null, partyId: null, createdById })
      return { markup: viewOfMarkup(row, file.versionNo, await namesOf(caller, [createdById])), file: null as FileView | null }
    })
    return { ...result, upload: null }
  }

  const announced = input.result!
  const plan = await planNewVersion(caller, fileId, { originalName: markedNameOf(file.originalName, announced.contentType), contentType: announced.contentType, sizeBytes: announced.sizeBytes, sha256: announced.sha256 })
  const names = await namesOf(caller, [createdById])
  const { result } = await command(caller, { name: 'files.markUp', idempotencyKey, input: { fileId, ...input } }, async (tools) => {
    const fresh = await tools.tx.storedFile.findUnique({ where: { id: fileId }, select: { status: true, supersededAt: true } })
    if (!fresh || !isCurrentVersion(fresh)) throw new ConflictError(NOT_CURRENT)
    const storageKey = versionKeyOf(tools.context, plan, tools.now)
    const version = await insertNewVersion(tools, plan, storageKey)
    const row = await recordMarkupInCommand(tools, file, { page: null, shapes, note, resultFileId: version.id, partyId: null, createdById })
    return { markup: viewOfMarkup(row, file.versionNo, names), file: viewOf(version), storageKey }
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
  return { markup: result.markup, file: result.file, upload: presignedView(upload) }
}

/** GET /files/:fileId/markups (office): every markup of the file's series, the newest first. */
export async function listMarkups(caller: CommandCaller, fileId: string): Promise<MarkupView[]> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new NotFoundError('File not found.')
  const file = await readOffice(caller, fileId)
  if (!can(actorOf(context), FILES_READ, { companyId: file.companyId })) throw new NotFoundError('File not found.')
  const root = seriesRootOf({ id: file.id, seriesId: file.seriesId ?? null })
  const versions = await caller.withClient((client) => client.storedFile.findMany({ where: { OR: [{ id: root }, { seriesId: root }] }, select: { id: true, versionNo: true } }))
  const numbers = new Map(versions.map((version) => [version.id, version.versionNo]))
  const rows = await caller.withClient((client) =>
    client.fileMarkup.findMany({ where: { fileId: { in: [...numbers.keys()] } }, select: MARKUP_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 500 }),
  )
  const names = await namesOf(caller, rows.map((row) => row.createdById))
  return rows.map((row) => viewOfMarkup(row, numbers.get(row.fileId) ?? null, names))
}
