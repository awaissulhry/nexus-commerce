import { InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import type { BomLineScaleBody, BomLineScaleView } from '@nexus/factory-domain/product/mtm-rules/contracts'
import { sameDecimal, scaleFactorOk } from '@nexus/factory-domain/product/mtm-rules/rules'
import { command, type CommandCaller } from '../../../core/command'
import { assertMayWrite, lockDraft, readRevisionFor } from '../bom/store'
import { contextOf, decimalOrNull } from './store'

/**
 * PUT /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/mtm-scale (B-W2b-248; PRD-204): a draft revision's
 * BOM line marked to scale for a made-to-measure unit (a point of the style's measurement template and the share of the
 * quantity that follows it, above 0 and at most 10), or unmarked (both null). A part of the revision's BOM: product.bom.manage
 * over the style's company; the write starts as every BOM write does (bom/store `lockDraft`: the style row FOR UPDATE, the
 * revision a DRAFT at the version sent, B-W2b-221's edit rule), and says the database's rules (BomLine_mtm_scale) in words
 * first: both or neither, the factor's range, an active point of the style's template; a style not made to measure (PRD-017)
 * marks no line. Audited on the line and the revision; W1's `style.bom_changed`.
 */

const invalid = (issues: Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The BOM line cannot be marked like this.', issues)
const blank = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim())

export async function setLineScale(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, body: BomLineScaleBody, idempotencyKey?: string): Promise<BomLineScaleView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)
  const pointCode = blank(body.pointCode)
  const typedFactor = blank(body.factor)
  const issues: Issue[] = []
  if ((pointCode === null) !== (typedFactor === null)) issues.push({ path: pointCode === null ? 'body/pointCode' : 'body/factor', message: 'A point and its factor, or neither (the line then takes the base size’s quantity).' })
  if (typedFactor !== null && !scaleFactorOk(typedFactor)) issues.push({ path: 'body/factor', message: 'The share of the quantity that follows the point: above 0, at most 10, at most 4 decimals ("1", "0.8").' })
  if (issues.length > 0) throw invalid(issues)
  const factor = decimalOrNull(typedFactor)

  const { result } = await command(caller, { name: 'product.mtmRules.scaleLine', idempotencyKey, input: { styleId, revisionId, lineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const draft = await lockDraft(tools, styleId, revisionId, body.version)
    const line = isUuid(lineId) ? await tx.bomLine.findFirst({ where: { id: lineId, revisionId }, select: { id: true, seq: true, mtmScalePointId: true, mtmScaleFactor: true } }) : null
    if (!line) throw new NotFoundError('BOM line not found.')
    let point: { id: string; code: string } | null = null
    if (pointCode !== null) {
      const facts = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { code: true, mtmAllowed: true, measurementTemplateId: true } })
      if (!facts.mtmAllowed) throw new InvalidStateError(`Style ${facts.code} is not made to measure: its BOM lines are not marked to scale.`)
      if (facts.measurementTemplateId === null) throw new InvalidStateError(`Style ${facts.code} has no measurement template: choose it before marking a line to scale.`)
      const found = await tx.measurementPoint.findFirst({ where: { templateId: facts.measurementTemplateId, code: pointCode }, select: { id: true, code: true, status: true } })
      if (!found || found.status !== 'ACTIVE') throw invalid([{ path: 'body/pointCode', message: `${pointCode} is not an active point of the measurement template of ${facts.code}.` }])
      point = { id: found.id, code: found.code }
    }
    const beforePoint = line.mtmScalePointId === null ? null : await tx.measurementPoint.findUnique({ where: { id: line.mtmScalePointId }, select: { code: true } })
    const before = line.mtmScalePointId === null ? null : { pointCode: beforePoint?.code ?? null, factor: decimalOrNull(line.mtmScaleFactor) }
    const after = point === null ? null : { pointCode: point.code, factor }
    const same = (point?.id ?? null) === line.mtmScalePointId && sameDecimal(factor, decimalOrNull(line.mtmScaleFactor))
    if (!same) {
      await tx.bomLine.update({ where: { id: line.id }, data: { mtmScalePointId: point?.id ?? null, mtmScaleFactor: factor, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ recordType: 'BomLine', recordId: line.id, companyId: draft.style.companyId, before: { mtmScale: before }, after: { mtmScale: after } })
    }
    tools.audit({ recordType: 'StyleRevision', recordId: draft.revisionId, companyId: draft.style.companyId, after: { bom: { mtmScale: { line: line.id, ...(after ?? { pointCode: null, factor: null }) } }, version: draft.version } })
    tools.emit({
      type: 'style.bom_changed',
      subject: draft.style.id,
      companyId: draft.style.companyId,
      payload: { styleId: draft.style.id, code: draft.style.code, revisionId: draft.revisionId, revision: draft.revision, lineIds: same ? [] : [line.id] },
    })
    return {
      line: { id: line.id, seq: line.seq, scale: point === null ? null : { pointId: point.id, pointCode: point.code, factor: factor! } },
      revision: { id: draft.revisionId, version: draft.version },
    }
  })
  return result
}
