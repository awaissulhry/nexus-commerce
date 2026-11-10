import { NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import type { LineOptionBody, LineOptionView } from '@nexus/factory-domain/product/options/contracts'
import { command, type CommandCaller } from '../../../core/command'
import { assertMayWrite, lockDraft, readRevisionFor } from '../bom/store'
import { contextOf, invalid, lockValuesShared, optionsGuarded } from './store'

/**
 * A draft BOM line only for one option (B-W2b-229; PRD-081 "option-dependent BOM lines"; B-W2b-211's BomLine.optionValueId):
 *
 *   PUT /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/option   {version (the revision's), optionValueId | null}
 *
 * product.bom.manage over the style's company. W1's lockDraft first (the style row, the revision a DRAFT, B-W2b-221's edit
 * rule DRAFT, the revision's version compared and set), then the value FOR SHARE: an ACTIVE value of a group the style offers
 * ACTIVE (the database's BomLine_w2b4_structure rule, said first). null: the line is for every garment again. The explosion
 * (B-W2b-223) takes the line only when its value is chosen. Audit rows on the line and the revision; W1's style.bom_changed.
 */
export async function setLineOption(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, body: LineOptionBody, idempotencyKey?: string): Promise<LineOptionView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)
  const { result } = await optionsGuarded(() =>
    command(caller, { name: 'product.options.setLineOption', idempotencyKey, input: { styleId, revisionId, lineId, ...body } }, async (tools) => {
      const { tx } = tools
      const draft = await lockDraft(tools, styleId, revisionId, body.version)
      const line = isUuid(lineId) ? await tx.bomLine.findFirst({ where: { id: lineId, revisionId }, select: { id: true, seq: true, itemId: true, optionValueId: true } }) : null
      if (!line) throw new NotFoundError('BOM line not found.')
      const issues: Issue[] = []
      let label: string | null = null
      if (body.optionValueId !== null) {
        await lockValuesShared(tx, [body.optionValueId])
        const value = await tx.optionValue.findUnique({ where: { id: body.optionValueId }, select: { code: true, groupId: true, status: true } })
        const group = value ? await tx.optionGroup.findUnique({ where: { id: value.groupId }, select: { code: true } }) : null
        const offered = value ? await tx.styleOptionGroup.findFirst({ where: { styleId, groupId: value.groupId, status: 'ACTIVE' }, select: { id: true } }) : null
        if (!value) issues.push({ path: 'body/optionValueId', message: 'No such option.' })
        else if (body.optionValueId !== line.optionValueId && value.status !== 'ACTIVE') issues.push({ path: 'body/optionValueId', message: `Option ${value.code} is archived.` })
        else if (body.optionValueId !== line.optionValueId && !offered) issues.push({ path: 'body/optionValueId', message: `Style ${draft.style.code} does not offer ${group?.code ?? 'its group'}: offer the group on the style first.` })
        label = `${group?.code ?? '?'}: ${value?.code ?? '?'}`
      }
      if (issues.length > 0) throw invalid(issues, 'BOM line')
      if (body.optionValueId !== line.optionValueId) {
        await tx.bomLine.update({ where: { id: line.id }, data: { optionValueId: body.optionValueId, updatedAt: tools.now }, select: { id: true } })
        tools.emit({
          type: 'style.bom_changed',
          subject: styleId,
          companyId: draft.style.companyId,
          payload: { styleId, code: draft.style.code, revisionId, revision: draft.revision, lineIds: [line.id] },
        })
      }
      tools.audit({ recordType: 'BomLine', recordId: line.id, companyId: draft.style.companyId, before: { optionValueId: line.optionValueId }, after: { optionValueId: body.optionValueId } })
      tools.audit({ recordType: 'StyleRevision', recordId: revisionId, companyId: draft.style.companyId, after: { bom: { option: { lineId: line.id, optionValueId: body.optionValueId } }, version: draft.version } })
      const item = await tx.item.findUniqueOrThrow({ where: { id: line.itemId }, select: { id: true, code: true, name: true } })
      return {
        line: { id: line.id, seq: line.seq, item: { ...item }, optionValueId: body.optionValueId, option: label },
        revision: { id: revisionId, revision: draft.revision, version: draft.version },
      }
    }),
  )
  return result
}
