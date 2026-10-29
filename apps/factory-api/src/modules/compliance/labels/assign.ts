import { LABELS_VIEW } from '@nexus/factory-domain/compliance/labels/permissions'
import { styleWarnings, type LabelTemplateStatus } from '@nexus/factory-domain/compliance/labels/rules'
import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { bumpRevision, findRevision, lockStyleRow } from '../../product/bom/store'
import type { TemplateView } from './contract'
import { assertMayManage, factsOf, labelCommand, labelStyleOf, markingProblems, officeOf, readVisibleStyle, STYLE_SELECT, TEMPLATE_SELECT, templateView } from './store'

/**
 * A draft style revision names its garment label template (B-W1-19; A1 §2.5: the revision freezes BOM, routing and label;
 * B-W1-38's release needs the named template ACTIVE). PUT /product/styles/:styleId/revisions/:revisionId/label, with
 * compliance.labels.manage over the style's company. One command:
 *
 *   the style row FOR UPDATE (the lock every write to a style's revisions takes first, product/bom) → the revision a
 *   DRAFT of this style (409 otherwise: a released revision is frozen, the …_product_guards trigger) and its version
 *   compared and set → the template row FOR SHARE (it cannot be retired or revised under the check) → the template is of
 *   this style or shared, of the style's company or every company, not RETIRED, and marks this style without a problem
 *   (a PPE style's standard and class, the CE notified body only and always for category III, the brand as maker) →
 *   the revision names it.
 *
 * A DRAFT template may be named (the label is built beside the revision); the release then waits for it to be ACTIVE.
 * `labelTemplateId: null` takes the label off the draft.
 */
export async function assignLabel(caller: CommandCaller, styleId: string, revisionId: string, input: { labelTemplateId: string | null; version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const style = await caller.withClient((client) => readVisibleStyle(client, context, styleId))
  assertMayManage(context, style.companyId)
  if (!isUuid(revisionId)) throw new NotFoundError('Revision not found.')

  const { result } = await labelCommand(caller, { name: 'compliance.labels.assign', idempotencyKey, input: { styleId, revisionId, ...input } }, async ({ tx, audit, emit, now }) => {
    const locked = await lockStyleRow(tx, styleId)
    const before = await findRevision(tx, styleId, revisionId)
    if (before.status !== 'DRAFT') {
      throw new InvalidStateError(`Revision ${before.revision} of style ${locked.code} is ${before.status.toLowerCase()}: its label is frozen with it. Start a new revision to name another label.`)
    }
    if (locked.status === 'ARCHIVED') throw new InvalidStateError(`Style ${locked.code} is archived: reactivate it before changing a revision.`)

    let template: TemplateView | null = null
    let warnings: Issue[] = []
    if (input.labelTemplateId !== null) {
      await tx.$queryRaw`SELECT "id" FROM "LabelTemplate" WHERE "id" = ${input.labelTemplateId}::uuid FOR SHARE`
      const row = await tx.labelTemplate.findUnique({ where: { id: input.labelTemplateId }, select: TEMPLATE_SELECT })
      if (!row || !can(actorOf(context), LABELS_VIEW, { companyId: row.companyId })) {
        throw new ValidationError('The label is not valid.', [{ path: 'body/labelTemplateId', message: 'No such label.' }])
      }
      const fresh = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_SELECT })
      const refusals: Issue[] = []
      if (row.styleId !== null && row.styleId !== styleId) refusals.push({ path: 'body/labelTemplateId', message: `Label ${row.code} r${row.revision} is another style's label.` })
      if (row.companyId !== null && row.companyId !== fresh.companyId) {
        refusals.push({ path: 'body/labelTemplateId', message: `Label ${row.code} r${row.revision} belongs to another company than style ${fresh.code}.` })
      }
      if (refusals.length > 0) throw new ValidationError('The label is not valid for this style.', refusals)
      if (row.status === 'RETIRED') throw new InvalidStateError(`Label ${row.code} r${row.revision} is retired: name an active label, or a new revision of it.`)
      const problems = markingProblems(row, fresh)
      if (problems.length > 0) {
        throw new DomainError('invalid_state', `Label ${row.code} r${row.revision} cannot mark style ${fresh.code}: ${problems.length} problem(s) to fix first.`, problems)
      }
      warnings = [
        ...styleWarnings(factsOf(row), labelStyleOf(fresh)),
        ...(row.status !== 'ACTIVE' ? [{ path: 'body/labelTemplateId', message: `Label ${row.code} r${row.revision} is ${(row.status as LabelTemplateStatus).toLowerCase()}: the revision is released only once it is active.` }] : []),
      ]
      template = templateView(row, fresh, businessDate(now))
    }

    const version = await bumpRevision(tx, revisionId, input.version, now)
    await tx.styleRevision.update({ where: { id: revisionId }, data: { labelTemplateId: input.labelTemplateId }, select: { id: true } })
    audit({
      action: 'compliance.labels.assign',
      recordType: 'StyleRevision',
      recordId: revisionId,
      companyId: style.companyId,
      before: { labelTemplateId: before.labelTemplateId },
      after: { labelTemplateId: input.labelTemplateId },
    })
    emit({
      type: 'compliance.label_assigned',
      subject: revisionId,
      companyId: style.companyId,
      payload: { styleId, styleRevisionId: revisionId, revision: before.revision, labelTemplateId: input.labelTemplateId, previousLabelTemplateId: before.labelTemplateId },
    })
    return {
      revision: { id: revisionId, styleId, revision: before.revision, status: before.status, labelTemplateId: input.labelTemplateId, version },
      template,
      warnings,
    }
  })
  return result
}
