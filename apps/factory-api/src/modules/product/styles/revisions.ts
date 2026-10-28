import { ConflictError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CreateRevisionBody, RevisionView } from '@nexus/factory-domain/product/styles/contracts'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import { newRevisionRefusal, nextRevisionNumber } from '@nexus/factory-domain/product/styles/revisions'
import { command, type CommandCaller } from '../../../core/command'
import { assertMayWrite, contextOf, isUniqueViolation, lockStyle, readStyle, REVISION_COLUMNS, revisionViewOf } from './store'

/**
 * A style's revisions (plan A1 §2.5): the list, and the DRAFT shell of the next one (number and change note), which the
 * BOM and routing steps (B-W1-13, B-W1-14) fill, copy a released revision into, and release. One open DRAFT per style;
 * none on an archived style. The style row is locked first, so two starts number their revisions one after the other.
 */

/** The style's revisions, newest first. */
export async function listRevisions(caller: CommandCaller, styleId: string): Promise<RevisionView[]> {
  await readStyle(caller, styleId)
  const rows = await caller.withClient((client) => client.styleRevision.findMany({ where: { styleId }, select: REVISION_COLUMNS, orderBy: { revision: 'desc' } }))
  return rows.map(revisionViewOf)
}

/** product.styles.createRevision: the next revision, DRAFT, empty. */
export async function createRevision(caller: CommandCaller, styleId: string, body: CreateRevisionBody, idempotencyKey?: string): Promise<RevisionView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)

  const { result } = await command(caller, { name: 'product.styles.createRevision', idempotencyKey, input: { styleId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const style = await lockStyle(tx, styleId)
    const revisions = await tx.styleRevision.findMany({ where: { styleId }, select: { revision: true, status: true } })
    const refusal = newRevisionRefusal(style.status, revisions)
    if (refusal) throw new ConflictError(refusal)
    const id = newId()
    const revision = nextRevisionNumber(revisions)
    const row = await tx.styleRevision.create({
      data: { id, styleId, revision, status: 'DRAFT', changeNote: body.changeNote ?? null, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
      select: REVISION_COLUMNS,
    })
    tools.audit({ recordType: 'StyleRevision', recordId: id, companyId: style.companyId, after: { styleId, revision, status: 'DRAFT', changeNote: row.changeNote } })
    tools.audit({ recordType: 'Style', recordId: styleId, companyId: style.companyId, after: { revision: { id, revision, status: 'DRAFT' } } })
    tools.emit({ type: 'style.revision_created', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, revisionId: id, revision } })
    return revisionViewOf(row)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('Another revision was started at the same time: load the style again.')
    throw error
  })
  return result
}
