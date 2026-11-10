import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { AddPictureBody, OrderPicturesBody, StylePicturesView, UpdatePictureBody } from '@nexus/factory-domain/product/images/contracts'
import { calloutProblems, calloutsOf, captionProblem, mainAfterRemoval, orderedCallouts, orderProblems, pictureEditKind, PICTURES_MAX, type Callout } from '@nexus/factory-domain/product/images/rules'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import { command, StaleVersionError, type CommandTools } from '../../../core/command'
import { requireEditRule } from '../lifecycle/edit-rule'
import { lockStyle } from '../styles/store'
import {
  assertMayWrite,
  findRevision,
  guardWords,
  isUniqueViolation,
  PICTURE_COLUMNS,
  pictureFileProblem,
  picturesView,
  readFiles,
  readPictures,
  readStyleFor,
  revisionFactsOf,
  type PictureRow,
} from './store'

/**
 * A style's pictures (B-W2b-236; PRD-016; design products.styles › Overview › "Sketches and pictures": upload, reorder, set
 * main picture, lightbox; image pages with numbered callouts). A picture is a JPEG, PNG or WebP file of the style (uploaded
 * through the files platform as a PHOTO of the Style, or one of the style's picture files already there) named here:
 *
 *   GET    /product/styles/:styleId/pictures                    the section: pictures in order with a look each (bytes.ts)
 *   POST   /product/styles/:styleId/pictures                    a file made a picture (SKETCH, PHOTO or PAGE), at the end;
 *                                                               the style's first picture is its main one
 *   PATCH  /product/styles/:styleId/pictures/:pictureId         kind, caption, callouts, revision, colourway (its version)
 *   POST   /product/styles/:styleId/pictures/:pictureId/main    the main picture (the list's thumbnail, the gallery's card,
 *                                                               the public DoC page's picture)
 *   PUT    /product/styles/:styleId/pictures/order              the gallery's order (every picture once)
 *   DELETE /product/styles/:styleId/pictures/:pictureId?version the picture goes (its file stays among the style's files);
 *                                                               the main one's mark goes to the next in order
 *
 * One command each: the style row FOR UPDATE, then the style's edit rule (B-W2b-221: a picture of a draft revision is a
 * DRAFT write, every other one the style's DETAILS), then the rows, each compared and set at its version (COL-078). A
 * picture of a released or obsolete revision keeps what it shows (only its place and the main mark move): refused here in
 * words, as the database's StyleImage_guard would. Audit per picture; event `style.pictures_changed`.
 */

type Tools = Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit' | 'context'>

/** One command on the style's pictures; a database refusal (a guard, the one main picture per style) as a 409 in words. */
async function onPictures(request: FastifyRequest, name: `product.pictures.${string}`, idempotencyKey: string | undefined, input: unknown, work: (tools: Tools) => Promise<void>): Promise<void> {
  try {
    await command(request, { name, idempotencyKey, input }, async (tools) => {
      await work(tools)
      return { done: true }
    })
  } catch (error) {
    const words = guardWords(error)
    if (words) throw new ConflictError(`${words} Read the pictures again.`)
    if (isUniqueViolation(error)) throw new ConflictError('Someone else changed the main picture meanwhile. Read the pictures again.')
    throw error
  }
}

/** The style for a picture write: seen, written by this person, then locked in the command. */
async function writable(request: FastifyRequest, styleId: string) {
  const style = await readStyleFor(request, styleId, 'product.styles.view')
  assertMayWrite(request, PRODUCT_STYLES_MANAGE, style.companyId)
  return style
}

async function lockAndAsk(tools: Tools, styleId: string, kind: 'DETAILS' | 'DRAFT'): Promise<{ code: string; companyId: string | null }> {
  const locked = await lockStyle(tools.tx, styleId)
  if (locked.status === 'ARCHIVED') throw new InvalidStateError(`Style ${locked.code} is archived: reactivate it before changing its pictures.`)
  await requireEditRule(tools.tx, styleId, kind)
  return { code: locked.code, companyId: locked.companyId }
}

async function pictureOf(tools: Tools, styleId: string, pictureId: string, version: number): Promise<PictureRow> {
  const row = isUuid(pictureId) ? await tools.tx.styleImage.findUnique({ where: { id: pictureId }, select: PICTURE_COLUMNS }) : null
  if (!row || row.styleId !== styleId) throw new NotFoundError('Picture not found.')
  if (row.version !== version) throw new StaleVersionError('StyleImage', pictureId, row.version, version)
  return row
}

/** The picture's revision as the guard sees it, or null (the style's own picture). */
async function revisionOf(tools: Tools, styleId: string, revisionId: string | null) {
  return revisionId === null ? null : revisionFactsOf(await findRevision(tools.tx, styleId, revisionId))
}

const frozenWords = (revision: { revision: number; status: string }) =>
  `This picture shows revision ${revision.revision}, which is ${revision.status === 'RELEASED' ? 'released' : 'obsolete'}: it keeps what it shows. Move it or make it the main picture; for a change, add the picture to the draft revision.`

/** A revision a picture may newly show: a DRAFT of this style. */
async function draftForPicture(tools: Tools, styleId: string, revisionId: string, at: string) {
  const revision = await revisionOf(tools, styleId, revisionId)
  if (revision && revision.status !== 'DRAFT') {
    throw new ValidationError('The picture is not valid.', [{ path: at, message: `Revision ${revision.revision} is ${revision.status === 'RELEASED' ? 'released' : 'obsolete'}: a picture is added only to a draft revision or to the style itself.` }])
  }
  return revision
}

/** A colourway a picture may newly show: an ACTIVE colourway of this style. */
async function colourwayForPicture(tools: Tools, styleId: string, colourwayId: string, at: string) {
  const row = await tools.tx.colourway.findUnique({ where: { id: colourwayId }, select: { id: true, styleId: true, code: true, status: true } })
  if (!row || row.styleId !== styleId) throw new ValidationError('The picture is not valid.', [{ path: at, message: 'The colourway is not one of this style.' }])
  if (row.status !== 'ACTIVE') throw new ValidationError('The picture is not valid.', [{ path: at, message: `Colourway ${row.code} is archived: pick an active colourway.` }])
  return row
}

function textProblems(body: { readonly caption?: string | null | undefined; readonly callouts?: readonly Callout[] | undefined }): Issue[] {
  const caption = captionProblem(body.caption)
  return [...(caption ? [{ path: 'body/caption', message: caption }] : []), ...(body.callouts ? calloutProblems(body.callouts) : [])]
}

const auditedOf = (row: Pick<PictureRow, 'kind' | 'revisionId' | 'colourwayId' | 'fileId' | 'caption' | 'seq' | 'isMain'> & { callouts: unknown }) => ({
  kind: row.kind,
  revisionId: row.revisionId,
  colourwayId: row.colourwayId,
  fileId: row.fileId,
  caption: row.caption,
  callouts: calloutsOf(row.callouts).length,
  seq: row.seq,
  isMain: row.isMain,
})

/** GET /product/styles/:styleId/pictures. */
export const getPictures = (request: FastifyRequest, styleId: string): Promise<StylePicturesView> => picturesView(request, styleId)

/** POST /product/styles/:styleId/pictures. */
export async function addPicture(request: FastifyRequest, styleId: string, body: AddPictureBody, idempotencyKey?: string): Promise<StylePicturesView> {
  await writable(request, styleId)
  const problems = textProblems(body)
  if (problems.length > 0) throw new ValidationError('The picture is not valid.', problems)
  await onPictures(request, 'product.pictures.add', idempotencyKey, { styleId, ...body }, async (tools) => {
    const { tx, now } = tools
    const revision = body.revisionId === null ? null : await draftForPicture(tools, styleId, body.revisionId, 'body/revisionId')
    const style = await lockAndAsk(tools, styleId, pictureEditKind(revision))
    if (body.colourwayId !== null) await colourwayForPicture(tools, styleId, body.colourwayId, 'body/colourwayId')
    const file = (await readFiles(tx, [body.fileId])).get(body.fileId)
    const fileProblem = await pictureFileProblem(tx, styleId, file)
    if (fileProblem) throw new ValidationError('The picture is not valid.', [{ path: 'body/fileId', message: fileProblem }])
    const pictures = await readPictures(tx, styleId)
    if (pictures.some((picture) => picture.fileId === body.fileId)) throw new ConflictError(`${file!.originalName} is already a picture of style ${style.code}.`)
    if (pictures.length >= PICTURES_MAX) throw new InvalidStateError(`Style ${style.code} has ${PICTURES_MAX} pictures, the most it keeps: remove one first.`)
    const id = newId()
    const row = {
      id,
      styleId,
      revisionId: body.revisionId,
      colourwayId: body.colourwayId,
      fileId: body.fileId,
      kind: body.kind,
      seq: pictures.reduce((top, picture) => Math.max(top, picture.seq + 1), 0),
      isMain: !pictures.some((picture) => picture.isMain),
      caption: body.caption,
      callouts: orderedCallouts(body.callouts),
    }
    await tx.styleImage.create({ data: { ...row, callouts: row.callouts.length > 0 ? (row.callouts as unknown as Prisma.InputJsonValue) : undefined, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null }, select: { id: true } })
    tools.audit({ recordType: 'StyleImage', recordId: id, companyId: style.companyId, after: { styleId, ...auditedOf(row) } })
    tools.emit({ type: 'style.pictures_changed', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, change: 'ADDED', pictureIds: [id] } })
  })
  return picturesView(request, styleId)
}

/** PATCH /product/styles/:styleId/pictures/:pictureId. */
export async function updatePicture(request: FastifyRequest, styleId: string, pictureId: string, body: UpdatePictureBody, idempotencyKey?: string): Promise<StylePicturesView> {
  await writable(request, styleId)
  const problems = textProblems(body)
  if (problems.length > 0) throw new ValidationError('The picture is not valid.', problems)
  await onPictures(request, 'product.pictures.update', idempotencyKey, { styleId, pictureId, ...body }, async (tools) => {
    const { tx, now } = tools
    const before = await tx.styleImage.findUnique({ where: { id: pictureId }, select: { revisionId: true, styleId: true } })
    if (!before || before.styleId !== styleId) throw new NotFoundError('Picture not found.')
    const shown = await revisionOf(tools, styleId, before.revisionId)
    const next = body.revisionId === undefined || body.revisionId === before.revisionId ? shown : body.revisionId === null ? null : await draftForPicture(tools, styleId, body.revisionId, 'body/revisionId')
    const style = await lockAndAsk(tools, styleId, shown?.status === 'DRAFT' || next?.status === 'DRAFT' ? 'DRAFT' : 'DETAILS')
    const row = await pictureOf(tools, styleId, pictureId, body.version)
    const changes = {
      ...(body.kind !== undefined && body.kind !== row.kind ? { kind: body.kind } : {}),
      ...(body.caption !== undefined && body.caption !== row.caption ? { caption: body.caption } : {}),
      ...(body.callouts !== undefined ? { callouts: orderedCallouts(body.callouts) } : {}),
      ...(body.revisionId !== undefined && body.revisionId !== row.revisionId ? { revisionId: body.revisionId } : {}),
      ...(body.colourwayId !== undefined && body.colourwayId !== row.colourwayId ? { colourwayId: body.colourwayId } : {}),
    }
    if (changes.callouts && JSON.stringify(changes.callouts) === JSON.stringify(orderedCallouts(calloutsOf(row.callouts)))) delete (changes as { callouts?: unknown }).callouts
    if (Object.keys(changes).length === 0) return
    if (shown && shown.status !== 'DRAFT') throw new InvalidStateError(frozenWords(shown))
    if (changes.colourwayId) await colourwayForPicture(tools, styleId, changes.colourwayId, 'body/colourwayId')
    const { count } = await tx.styleImage.updateMany({
      where: { id: pictureId, version: body.version },
      data: { ...changes, ...(changes.callouts ? { callouts: changes.callouts as unknown as Prisma.InputJsonValue } : {}), version: body.version + 1, updatedAt: now } as Prisma.StyleImageUncheckedUpdateManyInput,
    })
    if (count !== 1) throw new StaleVersionError('StyleImage', pictureId, row.version, body.version)
    tools.audit({ recordType: 'StyleImage', recordId: pictureId, companyId: style.companyId, before: auditedOf(row), after: auditedOf({ ...row, ...changes }) })
    tools.emit({ type: 'style.pictures_changed', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, change: 'CHANGED', pictureIds: [pictureId] } })
  })
  return picturesView(request, styleId)
}

/** POST /product/styles/:styleId/pictures/:pictureId/main. */
export async function setMainPicture(request: FastifyRequest, styleId: string, pictureId: string, version: number, idempotencyKey?: string): Promise<StylePicturesView> {
  await writable(request, styleId)
  await onPictures(request, 'product.pictures.main', idempotencyKey, { styleId, pictureId, version }, async (tools) => {
    const { tx, now } = tools
    const style = await lockAndAsk(tools, styleId, 'DETAILS')
    const row = await pictureOf(tools, styleId, pictureId, version)
    if (row.isMain) return
    // The old main mark first: one main picture per style (a partial unique index, checked row by row).
    const old = await tx.styleImage.findFirst({ where: { styleId, isMain: true }, select: { id: true, version: true } })
    if (old) await tx.styleImage.update({ where: { id: old.id }, data: { isMain: false, version: old.version + 1, updatedAt: now }, select: { id: true } })
    const { count } = await tx.styleImage.updateMany({ where: { id: pictureId, version }, data: { isMain: true, version: version + 1, updatedAt: now } })
    if (count !== 1) throw new StaleVersionError('StyleImage', pictureId, row.version, version)
    if (old) tools.audit({ recordType: 'StyleImage', recordId: old.id, companyId: style.companyId, before: { isMain: true }, after: { isMain: false } })
    tools.audit({ recordType: 'StyleImage', recordId: pictureId, companyId: style.companyId, before: { isMain: false }, after: { isMain: true } })
    tools.emit({ type: 'style.pictures_changed', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, change: 'MAIN', pictureIds: old ? [pictureId, old.id] : [pictureId] } })
  })
  return picturesView(request, styleId)
}

/** PUT /product/styles/:styleId/pictures/order. */
export async function orderPictures(request: FastifyRequest, styleId: string, body: OrderPicturesBody, idempotencyKey?: string): Promise<StylePicturesView> {
  await writable(request, styleId)
  await onPictures(request, 'product.pictures.order', idempotencyKey, { styleId, ...body }, async (tools) => {
    const { tx, now } = tools
    const style = await lockAndAsk(tools, styleId, 'DETAILS')
    const pictures = await readPictures(tx, styleId)
    const problems = orderProblems(
      pictures.map((picture) => picture.id),
      body.ids,
    )
    if (problems.length > 0) throw new ConflictError(problems[0]!.message)
    const moved: string[] = []
    for (const [seq, id] of body.ids.entries()) {
      const picture = pictures.find((entry) => entry.id === id)!
      if (picture.seq === seq) continue
      await tx.styleImage.update({ where: { id }, data: { seq, version: picture.version + 1, updatedAt: now }, select: { id: true } })
      moved.push(id)
    }
    if (moved.length === 0) return
    tools.audit({ recordType: 'Style', recordId: styleId, companyId: style.companyId, before: { pictures: pictures.map((picture) => picture.id) }, after: { pictures: [...body.ids] } })
    tools.emit({ type: 'style.pictures_changed', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, change: 'ORDER', pictureIds: moved } })
  })
  return picturesView(request, styleId)
}

/** DELETE /product/styles/:styleId/pictures/:pictureId?version. */
export async function removePicture(request: FastifyRequest, styleId: string, pictureId: string, version: number, idempotencyKey?: string): Promise<StylePicturesView> {
  await writable(request, styleId)
  await onPictures(request, 'product.pictures.remove', idempotencyKey, { styleId, pictureId, version }, async (tools) => {
    const { tx, now } = tools
    const before = await tx.styleImage.findUnique({ where: { id: pictureId }, select: { revisionId: true, styleId: true } })
    if (!before || before.styleId !== styleId) throw new NotFoundError('Picture not found.')
    const shown = await revisionOf(tools, styleId, before.revisionId)
    const style = await lockAndAsk(tools, styleId, pictureEditKind(shown))
    const row = await pictureOf(tools, styleId, pictureId, version)
    if (shown && shown.status !== 'DRAFT') throw new InvalidStateError(`This picture shows revision ${shown.revision}, which is ${shown.status === 'RELEASED' ? 'released' : 'obsolete'}: it stays with it.`)
    const pictures = await readPictures(tx, styleId)
    const heir = mainAfterRemoval(
      pictures.map((picture) => ({ ...picture, createdAt: picture.createdAt.toISOString() })),
      pictureId,
    )
    await tx.styleImage.delete({ where: { id: pictureId }, select: { id: true } })
    if (heir) await tx.styleImage.update({ where: { id: heir.id }, data: { isMain: true, version: heir.version + 1, updatedAt: now }, select: { id: true } })
    tools.audit({ recordType: 'StyleImage', recordId: pictureId, companyId: style.companyId, before: { styleId, ...auditedOf(row) }, after: null })
    if (heir) tools.audit({ recordType: 'StyleImage', recordId: heir.id, companyId: style.companyId, before: { isMain: false }, after: { isMain: true } })
    tools.emit({ type: 'style.pictures_changed', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, change: 'REMOVED', pictureIds: heir ? [pictureId, heir.id] : [pictureId] } })
  })
  return picturesView(request, styleId)
}
