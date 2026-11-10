import { ARTWORK_APPROVE, ARTWORK_MANAGE } from '@nexus/factory-domain/compliance/label-artwork/permissions'
import { ARTWORK_FILE_KINDS, approvedNow, artworkRefusal, inForceAt, nextVersionNo, noteProblems, type ArtworkAct } from '@nexus/factory-domain/compliance/label-artwork/rules'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { mayWrite } from '../../product/materials/store'
import { officeOf, readTemplate, type TemplateRow } from '../labels/store'
import { namesFor } from '../register-of-rules/common'
import type { ArtworkView } from './contract'
import { ARTWORK_SELECT, artworkFact, guarded, readArtwork, type ArtworkRow, type Reader } from './store'

/**
 * Label artwork versions (B-W2b-259; PRD-347; design compliance.labels › Artwork & approval, pop:lb-approve). A label
 * revision's proof (a PDF or picture uploaded as a file of the label template) is added as a DRAFT version, approved by a
 * person other than its author — approving retires the version approved before, so one proof is in force per label
 * revision —, retired, or removed while a draft. The table is B-W2b-218's LabelArtworkVersion: the database refuses the
 * author as approver, a second approved version, an approval on a retired label and any change once out of DRAFT but the
 * retirement; the rules say it first in words (factory-domain compliance/label-artwork).
 *
 * "Each version stored and linked to work orders; reprints use the same version": a work order's labels follow the version in
 * force at its first print (the read below names it per work order released with the label; B-W2b-254's gate check
 * `label.artwork` in gate-plug.ts holds a label print without approved artwork where a requirement asks for it).
 *
 * Every write is ONE command: the version's own compare-and-set where it exists, an audit row per version touched,
 * `label_artwork.changed`. Reading is the label's view over its company; writing compliance.labels.manage; approving
 * compliance.artwork.approve. A database refusal answers 409 in words.
 */

const label = (row: TemplateRow) => `${row.code} r${row.revision}`

async function viewOf(db: Reader, context: OfficeContext, template: TemplateRow): Promise<ArtworkView> {
  const actor = actorOf(context)
  const rows = await readArtwork(db, template.id)
  const files = new Map(
    (await db.storedFile.findMany({ where: { id: { in: rows.map((row) => row.fileId) } }, select: { id: true, originalName: true, contentType: true, status: true } })).map((file) => [file.id, file]),
  )
  const person = await namesFor(db, rows.flatMap((row) => [row.authorId ?? row.createdById, row.approvedById]))
  const mayApprove = mayWrite(actor, ARTWORK_APPROVE, template.companyId)
  const facts = rows.map(artworkFact)
  // The work orders released with this label revision (that the reader may see) and the version their labels follow.
  const orders = (await db.workOrder.findMany({ where: { labelTemplateId: template.id }, select: { id: true, number: true, status: true, companyId: true, siteId: true }, orderBy: [{ number: 'desc' }], take: 50 })).filter((order) =>
    can(actor, WORKORDERS_VIEW, { companyId: order.companyId, siteId: order.siteId }),
  )
  const firstPrints = new Map<string, Date>()
  for (const order of orders) {
    const first = await db.garmentLabelPrint.findFirst({ where: { workOrderId: order.id }, select: { createdAt: true }, orderBy: [{ createdAt: 'asc' }] })
    if (first) firstPrints.set(order.id, first.createdAt)
  }
  return {
    label: { id: template.id, code: template.code, revision: template.revision, name: template.name, status: template.status, kind: template.kind, companyId: template.companyId, styleId: template.styleId },
    versions: rows.map((row, index) => {
      const fact = facts[index]!
      const file = files.get(row.fileId)
      const held = mayApprove ? artworkRefusal('APPROVE', fact, { actorId: context.actorId, templateRetired: template.status === 'RETIRED' }) : 'You do not approve label artwork.'
      return {
        id: row.id,
        versionNo: row.versionNo,
        status: row.status,
        file: file ? { id: file.id, name: file.originalName, contentType: file.contentType, status: file.status } : null,
        author: person(fact.authorId),
        byYou: fact.authorId === context.actorId,
        approvedAt: row.approvedAt ? toUtcIso(row.approvedAt) : null,
        approvedBy: person(row.approvedById),
        retiredAt: row.retiredAt ? toUtcIso(row.retiredAt) : null,
        note: row.note,
        createdAt: toUtcIso(row.createdAt),
        version: row.version,
        approveHeld: held,
      }
    }),
    approvedId: approvedNow(rows)?.id ?? null,
    workOrders: orders.map((order) => {
      const first = firstPrints.get(order.id) ?? null
      const followed = first ? inForceAt(rows, first) : null
      return { id: order.id, number: order.number, status: order.status, firstPrintAt: first ? toUtcIso(first) : null, artwork: followed ? { id: followed.id, versionNo: followed.versionNo } : null }
    }),
    mayManage: mayWrite(actor, ARTWORK_MANAGE, template.companyId),
    mayApprove,
    asOf: businessDate(serverClock.now()),
  }
}

/** GET /compliance/label-artwork/templates/:templateId */
export async function readLabelArtwork(caller: CommandCaller, templateId: string): Promise<ArtworkView> {
  const context = officeOf(caller)
  const template = await readTemplate(caller, templateId)
  return caller.withClient((db) => viewOf(db, context, template))
}

function assertMay(context: OfficeContext, permission: typeof ARTWORK_MANAGE | typeof ARTWORK_APPROVE, companyId: string | null): void {
  if (!mayWrite(actorOf(context), permission, companyId)) throw new ForbiddenError(companyId === null ? 'Artwork of a label for every company is kept only by a role over every company.' : undefined)
}

/** POST /compliance/label-artwork/templates/:templateId/versions — a DRAFT proof, the next number of the label revision. */
export async function addArtwork(caller: CommandCaller, templateId: string, body: { readonly fileId: string; readonly note?: string | null | undefined }, idempotencyKey?: string): Promise<{ artwork: ArtworkView; replayed: boolean }> {
  const context = officeOf(caller)
  const template = await readTemplate(caller, templateId)
  assertMay(context, ARTWORK_MANAGE, template.companyId)
  const issues = noteProblems(body.note)
  if (issues.length > 0) throw new ValidationError('The artwork is not valid.', issues)
  if (template.status === 'RETIRED') throw new InvalidStateError(`Label ${label(template)} is retired: it takes no new artwork. Add it to the label's current revision.`)
  const note = body.note?.trim() || null

  return guarded(async () => {
    const outcome = await command(caller, { name: 'compliance.labelArtwork.add', idempotencyKey, input: { templateId, ...body } }, async (tools) => {
      const { tx, now } = tools
      // One number at a time per label revision: its row FOR UPDATE.
      await tx.$queryRaw`SELECT "id" FROM "LabelTemplate" WHERE "id" = ${templateId}::uuid FOR UPDATE`
      const file = await tx.storedFile.findUnique({ where: { id: body.fileId }, select: { id: true, recordType: true, recordId: true, kind: true, status: true, deletedAt: true } })
      if (!file || file.recordType !== 'LabelTemplate' || file.recordId !== templateId) {
        throw new ValidationError('The proof is not a file of this label.', [{ path: 'body/fileId', message: 'Upload the proof as a file of this label first (POST /files with recordType "LabelTemplate").' }])
      }
      if (file.status !== 'AVAILABLE' || file.deletedAt !== null) throw new ValidationError('The proof is not available.', [{ path: 'body/fileId', message: `The file is ${file.status.toLowerCase().replace('_', ' ')}: complete its upload first.` }])
      if (!(ARTWORK_FILE_KINDS as readonly string[]).includes(file.kind)) throw new ValidationError('The proof is a PDF or a picture.', [{ path: 'body/fileId', message: 'Upload the proof as a document or a photo.' }])
      const versions = await readArtwork(tx, templateId)
      const id = newId()
      const versionNo = nextVersionNo(versions)
      await tx.labelArtworkVersion.create({ data: { id, templateId, versionNo, fileId: file.id, status: 'DRAFT', authorId: context.actorId, note, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
      tools.audit({ recordType: 'LabelArtworkVersion', recordId: id, companyId: template.companyId, after: { templateId, versionNo, fileId: file.id, status: 'DRAFT', note } })
      tools.emit({ type: 'label_artwork.changed', subject: templateId, companyId: template.companyId, payload: { templateId, code: template.code, revision: template.revision, artworkId: id, versionNo, status: 'DRAFT', change: 'ADDED', replacedId: null } })
      return viewOf(tx, context, template)
    })
    return { artwork: outcome.result, replayed: outcome.replayed }
  })
}

/** The artwork row named and its label (the reader's: else not found). */
async function namedArtwork(caller: CommandCaller, artworkId: string): Promise<{ row: ArtworkRow; template: TemplateRow }> {
  if (!isUuid(artworkId)) throw new NotFoundError('Artwork not found.')
  const row = await caller.withClient((db) => db.labelArtworkVersion.findUnique({ where: { id: artworkId }, select: ARTWORK_SELECT }))
  if (!row) throw new NotFoundError('Artwork not found.')
  const template = await readTemplate(caller, row.templateId).catch(() => {
    throw new NotFoundError('Artwork not found.')
  })
  return { row: row as ArtworkRow, template }
}

async function act(caller: CommandCaller, artworkId: string, what: ArtworkAct, body: { readonly version: number; readonly reason?: string | undefined }, idempotencyKey: string | undefined): Promise<ArtworkView> {
  const context = officeOf(caller)
  const { row, template } = await namedArtwork(caller, artworkId)
  assertMay(context, what === 'APPROVE' ? ARTWORK_APPROVE : ARTWORK_MANAGE, template.companyId)
  const before = artworkFact(row)
  const refusal = artworkRefusal(what, before, { actorId: context.actorId, templateRetired: template.status === 'RETIRED' })
  if (refusal) throw new InvalidStateError(refusal)
  const reason = body.reason?.trim() || undefined
  const name = what === 'APPROVE' ? 'compliance.labelArtwork.approve' : what === 'RETIRE' ? 'compliance.labelArtwork.retire' : 'compliance.labelArtwork.remove'

  return guarded(async () => {
    const { result } = await command(caller, { name, idempotencyKey, input: { artworkId, ...body }, record: { type: 'LabelArtworkVersion', id: artworkId, expectedVersion: body.version } }, async (tools: CommandTools) => {
      const { tx, now } = tools
      // The row is locked and its version checked: decide again on what is there now.
      const current = (await tx.labelArtworkVersion.findUniqueOrThrow({ where: { id: artworkId }, select: ARTWORK_SELECT })) as ArtworkRow
      const again = artworkRefusal(what, artworkFact(current), { actorId: context.actorId, templateRetired: template.status === 'RETIRED' })
      if (again) throw new InvalidStateError(again)
      const base = { templateId: template.id, code: template.code, revision: template.revision, artworkId, versionNo: current.versionNo }
      if (what === 'REMOVE') {
        await tx.labelArtworkVersion.delete({ where: { id: artworkId }, select: { id: true } })
        tools.audit({ recordType: 'LabelArtworkVersion', recordId: artworkId, companyId: template.companyId, before: { status: 'DRAFT', versionNo: current.versionNo, fileId: current.fileId }, ...(reason ? { reason } : {}) })
        tools.emit({ type: 'label_artwork.changed', subject: template.id, companyId: template.companyId, payload: { ...base, status: null, change: 'REMOVED', replacedId: null } })
        return viewOf(tx, context, template)
      }
      if (what === 'RETIRE') {
        await tx.labelArtworkVersion.update({ where: { id: artworkId }, data: { status: 'RETIRED', retiredAt: now, updatedAt: now }, select: { id: true } })
        tools.audit({ recordType: 'LabelArtworkVersion', recordId: artworkId, companyId: template.companyId, before: { status: current.status }, after: { status: 'RETIRED' }, ...(reason ? { reason } : {}) })
        tools.emit({ type: 'label_artwork.changed', subject: template.id, companyId: template.companyId, payload: { ...base, status: 'RETIRED', change: 'RETIRED', replacedId: null } })
        return viewOf(tx, context, template)
      }
      // APPROVE: the version approved before is retired first (one approved proof per label revision).
      const previous = await tx.labelArtworkVersion.findFirst({ where: { templateId: template.id, status: 'APPROVED', id: { not: artworkId } }, select: { id: true, versionNo: true } })
      if (previous) {
        await tx.labelArtworkVersion.update({ where: { id: previous.id }, data: { status: 'RETIRED', retiredAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        tools.audit({ recordType: 'LabelArtworkVersion', recordId: previous.id, companyId: template.companyId, before: { status: 'APPROVED' }, after: { status: 'RETIRED', replacedBy: artworkId } })
      }
      await tx.labelArtworkVersion.update({ where: { id: artworkId }, data: { status: 'APPROVED', approvedAt: now, approvedById: context.actorId, updatedAt: now }, select: { id: true } })
      tools.audit({ recordType: 'LabelArtworkVersion', recordId: artworkId, companyId: template.companyId, before: { status: 'DRAFT' }, after: { status: 'APPROVED', replaced: previous?.id ?? null }, ...(reason ? { reason } : {}) })
      tools.emit({ type: 'label_artwork.changed', subject: template.id, companyId: template.companyId, payload: { ...base, status: 'APPROVED', change: 'APPROVED', replacedId: previous?.id ?? null } })
      return viewOf(tx, context, template)
    })
    return result
  })
}

/** POST /compliance/label-artwork/versions/:artworkId/approve */
export const approveArtwork = (caller: CommandCaller, artworkId: string, body: { version: number; reason?: string | undefined }, key?: string) => act(caller, artworkId, 'APPROVE', body, key)
/** POST /compliance/label-artwork/versions/:artworkId/retire */
export const retireArtwork = (caller: CommandCaller, artworkId: string, body: { version: number; reason?: string | undefined }, key?: string) => act(caller, artworkId, 'RETIRE', body, key)
/** DELETE /compliance/label-artwork/versions/:artworkId?version= */
export const removeArtwork = (caller: CommandCaller, artworkId: string, version: number, key?: string) => act(caller, artworkId, 'REMOVE', { version }, key)
