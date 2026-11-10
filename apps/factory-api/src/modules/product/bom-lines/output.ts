import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import type { BomDepthView, SetOutputBody } from '@nexus/factory-domain/product/bom-lines/contracts'
import { outputProblems } from '@nexus/factory-domain/product/bom-lines/rules'
import { command, type CommandCaller } from '../../../core/command'
import { assertMayWrite, contextOf, lockDraft, readRevisionFor } from '../bom/store'
import { depthInTx, guarded, invalid, prefixed } from './store'

/**
 * What a draft revision's BOM makes (B-W2b-228; PRD-099): PCS, PAIR or SET (gloves and sleeves cut in pairs, a protector kit);
 * every line's quantity is per that output, and a parent that takes the revision as a sub-assembly counts its batches by it
 * (B-W2b-223's explosion). W1's `lockDraft` first (the style row FOR UPDATE, B-W2b-221's edit rule DRAFT, the revision
 * compared and set); frozen with the revision once released (B-W2b-205's guard). The database takes 1 to 1000 units; work
 * orders, costing and planning still count one unit per output, so more than one is refused in words for now
 * (factory-domain product/bom-lines `outputProblems`). Audit row on the revision; W1's `style.bom_changed` (no line).
 */
export async function setOutput(caller: CommandCaller, styleId: string, revisionId: string, body: SetOutputBody, idempotencyKey?: string): Promise<BomDepthView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)
  const problems = outputProblems(body.outputQuantity, body.outputUom)
  if (problems.length > 0) throw invalid(prefixed(problems), 'output')

  const { result } = await guarded(() =>
    command(caller, { name: 'product.bomLines.setOutput', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
      const { tx } = tools
      const draft = await lockDraft(tools, styleId, revisionId, body.version)
      const before = await tx.styleRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { outputQuantity: true, outputUom: true } })
      const changed = before.outputQuantity !== body.outputQuantity || before.outputUom !== body.outputUom
      if (changed) await tx.styleRevision.update({ where: { id: revisionId }, data: { outputQuantity: body.outputQuantity, outputUom: body.outputUom }, select: { id: true } })
      tools.audit({
        recordType: 'StyleRevision',
        recordId: revisionId,
        companyId: draft.style.companyId,
        before: { outputQuantity: before.outputQuantity, outputUom: before.outputUom },
        after: { outputQuantity: body.outputQuantity, outputUom: body.outputUom, version: draft.version },
      })
      tools.emit({
        type: 'style.bom_changed',
        subject: styleId,
        companyId: draft.style.companyId,
        payload: { styleId, code: draft.style.code, revisionId, revision: draft.revision, lineIds: [] },
      })
      return depthInTx(tools, styleId, revisionId)
    }),
  )
  return result
}
