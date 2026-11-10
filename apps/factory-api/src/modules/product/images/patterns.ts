import type { FastifyRequest } from 'fastify'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import type { AddPatternFileBody, PatternFilesView, PatternFileVersionBody, RemovePatternFilesBody, UpdatePatternFileBody } from '@nexus/factory-domain/product/images/contracts'
import { inRangeOrder, noteProblem, patternEditKind, patternRefusal, patternSizeProblems, type PatternFileKind } from '@nexus/factory-domain/product/images/rules'
import { command, StaleVersionError, type CommandTools } from '../../../core/command'
import { downloadFile, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { requireEditRule } from '../lifecycle/edit-rule'
import { lockStyle } from '../styles/store'
import {
  assertMayWrite,
  filesCaller,
  findRevision,
  guardWords,
  PATTERN_COLUMNS,
  patternFileProblem,
  patternFilesView,
  readFiles,
  readStyleFor,
  revisionFactsOf,
  type PatternRow,
  type StyleRow,
} from './store'

/**
 * A revision's pattern, marker and CAD files (B-W2b-236; PRD-218; design products.styles › Files & patterns › "Pattern files
 * per revision and size range (Lectra, Gerber, DXF-AAMA)"). The file is sent to the revision through the files platform
 * first (a DOCUMENT of the StyleRevision, in parts: a DXF or an HP-GL plot is taken only that way; a PDF too), then named
 * here with its kind, format, sizes and a note; a newer version of it is the files platform's new version of the same series
 * (B-W2b-160), then named here:
 *
 *   GET    …/revisions/:revisionId/pattern-files                       the revision's files, each with its versions
 *   POST   …/revisions/:revisionId/pattern-files                       a file of the revision named a pattern file
 *   PATCH  …/revisions/:revisionId/pattern-files/:patternFileId        kind, format, sizes, note (its version)
 *   PUT    …/revisions/:revisionId/pattern-files/:patternFileId/file   the row names a newer version of its file
 *   POST   …/revisions/:revisionId/pattern-files/remove                several rows removed (the files stay, with their versions)
 *   GET    …/revisions/:revisionId/pattern-files/:patternFileId/download[?fileId]   a presigned attachment (60 s) of the
 *                                                                       file or one of its versions
 *
 * A PATTERN or CAD file is the revision's specification: added, changed, given a new version or removed only while the
 * revision is a DRAFT (the database's StyleRevisionFile_guard, said here first); a MARKER or OTHER file also on a released
 * revision. One command each: the style row FOR UPDATE, the style's edit rule (a draft's write: DRAFT; a marker on a
 * released revision: DETAILS), the rows compared and set at their versions. Audit per row; `style.pattern_files_changed`.
 */

type Tools = Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit' | 'context'>

async function onPatterns(request: FastifyRequest, name: `product.patternFiles.${string}`, idempotencyKey: string | undefined, input: unknown, work: (tools: Tools) => Promise<void>): Promise<void> {
  try {
    await command(request, { name, idempotencyKey, input }, async (tools) => {
      await work(tools)
      return { done: true }
    })
  } catch (error) {
    const words = guardWords(error)
    if (words) throw new ConflictError(`${words} Read the pattern files again.`)
    throw error
  }
}

async function writable(request: FastifyRequest, styleId: string): Promise<StyleRow> {
  const style = await readStyleFor(request, styleId, 'product.bom.view')
  assertMayWrite(request, PRODUCT_BOM_MANAGE, style.companyId)
  return style
}

/** The style locked, not archived; the revision of it; the edit rule asked for a write to it. */
async function lockRevision(tools: Tools, styleId: string, revisionId: string) {
  const locked = await lockStyle(tools.tx, styleId)
  if (locked.status === 'ARCHIVED') throw new InvalidStateError(`Style ${locked.code} is archived: reactivate it before changing its pattern files.`)
  const revision = revisionFactsOf(await findRevision(tools.tx, styleId, revisionId))
  await requireEditRule(tools.tx, styleId, patternEditKind(revision))
  return { code: locked.code, companyId: locked.companyId, revision }
}

async function rowOf(tools: Tools, revisionId: string, patternFileId: string, version: number): Promise<PatternRow> {
  const row = isUuid(patternFileId) ? await tools.tx.styleRevisionFile.findUnique({ where: { id: patternFileId }, select: PATTERN_COLUMNS }) : null
  if (!row || row.revisionId !== revisionId) throw new NotFoundError('Pattern file not found.')
  if (row.version !== version) throw new StaleVersionError('StyleRevisionFile', patternFileId, row.version, version)
  return row
}

function fieldProblems(style: StyleRow, body: { readonly sizes?: readonly string[] | undefined; readonly note?: string | null | undefined }): Issue[] {
  const note = noteProblem(body.note)
  return [...(body.sizes ? patternSizeProblems(body.sizes, style.sizes) : []), ...(note ? [{ path: 'body/note', message: note }] : [])]
}

const audited = (row: Pick<PatternRow, 'kind' | 'format' | 'sizes' | 'note' | 'fileId'>) => ({ kind: row.kind, format: row.format, sizes: [...row.sizes], note: row.note, fileId: row.fileId })

/** GET …/revisions/:revisionId/pattern-files. */
export const getPatternFiles = (request: FastifyRequest, styleId: string, revisionId: string): Promise<PatternFilesView> => patternFilesView(request, styleId, revisionId)

/** POST …/revisions/:revisionId/pattern-files. */
export async function addPatternFile(request: FastifyRequest, styleId: string, revisionId: string, body: AddPatternFileBody, idempotencyKey?: string): Promise<PatternFilesView> {
  const style = await writable(request, styleId)
  const problems = fieldProblems(style, body)
  if (problems.length > 0) throw new ValidationError('The pattern file is not valid.', problems)
  await onPatterns(request, 'product.patternFiles.add', idempotencyKey, { styleId, revisionId, ...body }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockRevision(tools, styleId, revisionId)
    const frozen = patternRefusal(body.kind, locked.revision)
    if (frozen) throw new InvalidStateError(frozen)
    const file = (await readFiles(tx, [body.fileId])).get(body.fileId)
    const fileProblem = patternFileProblem(styleId, revisionId, file)
    if (fileProblem) throw new ValidationError('The pattern file is not valid.', [{ path: 'body/fileId', message: fileProblem }])
    if ((await tx.styleRevisionFile.count({ where: { revisionId, fileId: body.fileId } })) > 0) throw new ConflictError(`${file!.originalName} is already a pattern file of revision ${locked.revision.revision}.`)
    const id = newId()
    const row = { kind: body.kind, format: body.format, sizes: inRangeOrder(body.sizes, style.sizes), note: body.note, fileId: body.fileId }
    await tx.styleRevisionFile.create({ data: { id, styleId, revisionId, ...row, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null }, select: { id: true } })
    tools.audit({ recordType: 'StyleRevisionFile', recordId: id, companyId: locked.companyId, after: { styleId, revisionId, ...audited(row) } })
    tools.emit({ type: 'style.pattern_files_changed', subject: styleId, companyId: locked.companyId, payload: { styleId, code: locked.code, revisionId, revision: locked.revision.revision, change: 'ADDED', patternFileIds: [id] } })
  })
  return patternFilesView(request, styleId, revisionId)
}

/** PATCH …/revisions/:revisionId/pattern-files/:patternFileId. */
export async function updatePatternFile(request: FastifyRequest, styleId: string, revisionId: string, patternFileId: string, body: UpdatePatternFileBody, idempotencyKey?: string): Promise<PatternFilesView> {
  const style = await writable(request, styleId)
  const problems = fieldProblems(style, body)
  if (problems.length > 0) throw new ValidationError('The pattern file is not valid.', problems)
  await onPatterns(request, 'product.patternFiles.update', idempotencyKey, { styleId, revisionId, patternFileId, ...body }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockRevision(tools, styleId, revisionId)
    const row = await rowOf(tools, revisionId, patternFileId, body.version)
    const sizes = body.sizes === undefined ? undefined : inRangeOrder(body.sizes, style.sizes)
    const changes = {
      ...(body.kind !== undefined && body.kind !== row.kind ? { kind: body.kind } : {}),
      ...(body.format !== undefined && body.format !== row.format ? { format: body.format } : {}),
      ...(sizes !== undefined && sizes.join('|') !== row.sizes.join('|') ? { sizes } : {}),
      ...(body.note !== undefined && body.note !== row.note ? { note: body.note } : {}),
    }
    if (Object.keys(changes).length === 0) return
    const frozen = patternRefusal(row.kind as PatternFileKind, locked.revision) ?? (changes.kind ? patternRefusal(changes.kind, locked.revision) : null)
    if (frozen) throw new InvalidStateError(frozen)
    const { count } = await tx.styleRevisionFile.updateMany({ where: { id: patternFileId, version: body.version }, data: { ...changes, version: body.version + 1, updatedAt: now } })
    if (count !== 1) throw new StaleVersionError('StyleRevisionFile', patternFileId, row.version, body.version)
    tools.audit({ recordType: 'StyleRevisionFile', recordId: patternFileId, companyId: locked.companyId, before: audited(row), after: audited({ ...row, ...changes }) })
    tools.emit({ type: 'style.pattern_files_changed', subject: styleId, companyId: locked.companyId, payload: { styleId, code: locked.code, revisionId, revision: locked.revision.revision, change: 'CHANGED', patternFileIds: [patternFileId] } })
  })
  return patternFilesView(request, styleId, revisionId)
}

/** PUT …/revisions/:revisionId/pattern-files/:patternFileId/file: a newer version of the row's file (same series). */
export async function setPatternFileVersion(request: FastifyRequest, styleId: string, revisionId: string, patternFileId: string, body: PatternFileVersionBody, idempotencyKey?: string): Promise<PatternFilesView> {
  await writable(request, styleId)
  await onPatterns(request, 'product.patternFiles.version', idempotencyKey, { styleId, revisionId, patternFileId, ...body }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockRevision(tools, styleId, revisionId)
    const row = await rowOf(tools, revisionId, patternFileId, body.version)
    if (row.fileId === body.fileId) return
    const frozen = patternRefusal(row.kind as PatternFileKind, locked.revision)
    if (frozen) throw new InvalidStateError(frozen)
    const files = await readFiles(tx, [row.fileId, body.fileId])
    const current = files.get(row.fileId)
    const next = files.get(body.fileId)
    const fileProblem = patternFileProblem(styleId, revisionId, next)
    if (fileProblem) throw new ValidationError('The new version is not valid.', [{ path: 'body/fileId', message: fileProblem }])
    if (!current || (current.seriesId ?? current.id) !== (next!.seriesId ?? next!.id)) {
      throw new ValidationError('The new version is not valid.', [{ path: 'body/fileId', message: `The file is not a version of ${current?.originalName ?? 'this pattern file'}: send it as its new version.` }])
    }
    const { count } = await tx.styleRevisionFile.updateMany({ where: { id: patternFileId, version: body.version }, data: { fileId: body.fileId, version: body.version + 1, updatedAt: now } })
    if (count !== 1) throw new StaleVersionError('StyleRevisionFile', patternFileId, row.version, body.version)
    tools.audit({ recordType: 'StyleRevisionFile', recordId: patternFileId, companyId: locked.companyId, before: { fileId: row.fileId, versionNo: current.versionNo }, after: { fileId: body.fileId, versionNo: next!.versionNo } })
    tools.emit({ type: 'style.pattern_files_changed', subject: styleId, companyId: locked.companyId, payload: { styleId, code: locked.code, revisionId, revision: locked.revision.revision, change: 'NEW_VERSION', patternFileIds: [patternFileId] } })
  })
  return patternFilesView(request, styleId, revisionId)
}

/** POST …/revisions/:revisionId/pattern-files/remove: every row named, at its version, or none. */
export async function removePatternFiles(request: FastifyRequest, styleId: string, revisionId: string, body: RemovePatternFilesBody, idempotencyKey?: string): Promise<PatternFilesView> {
  await writable(request, styleId)
  await onPatterns(request, 'product.patternFiles.remove', idempotencyKey, { styleId, revisionId, ...body }, async (tools) => {
    const { tx } = tools
    const locked = await lockRevision(tools, styleId, revisionId)
    const rows: PatternRow[] = []
    for (const item of body.items) rows.push(await rowOf(tools, revisionId, item.id, item.version))
    const frozen = rows.filter((row) => patternRefusal(row.kind as PatternFileKind, locked.revision) !== null)
    if (frozen.length > 0) throw new InvalidStateError(patternRefusal(frozen[0]!.kind as PatternFileKind, locked.revision)!)
    await tx.styleRevisionFile.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })
    for (const row of rows) tools.audit({ recordType: 'StyleRevisionFile', recordId: row.id, companyId: locked.companyId, before: { styleId, revisionId, ...audited(row) }, after: null })
    tools.emit({ type: 'style.pattern_files_changed', subject: styleId, companyId: locked.companyId, payload: { styleId, code: locked.code, revisionId, revision: locked.revision.revision, change: 'REMOVED', patternFileIds: rows.map((row) => row.id) } })
  })
  return patternFilesView(request, styleId, revisionId)
}

/** GET …/pattern-files/:patternFileId/download[?fileId]: the row's file, or one of its versions, as a presigned attachment. */
export async function downloadPatternFile(request: FastifyRequest, styleId: string, revisionId: string, patternFileId: string, fileId: string | undefined) {
  const style = await readStyleFor(request, styleId, 'product.bom.view')
  const target = await request.withClient(async (client) => {
    await findRevision(client, styleId, revisionId)
    const row = isUuid(patternFileId) ? await client.styleRevisionFile.findUnique({ where: { id: patternFileId }, select: PATTERN_COLUMNS }) : null
    if (!row || row.revisionId !== revisionId) throw new NotFoundError('Pattern file not found.')
    if (fileId === undefined || fileId === row.fileId) return row.fileId
    const files = await readFiles(client, [row.fileId, fileId])
    const current = files.get(row.fileId)
    const asked = files.get(fileId)
    if (!current || !asked || (current.seriesId ?? current.id) !== (asked.seriesId ?? asked.id)) throw new NotFoundError('Version not found.')
    return fileId
  })
  return { download: await downloadFile(processFiles(), { caller: filesCaller(request, style.companyId, [FILES_READ]), system: systemCallerOf(request) }, target) }
}
