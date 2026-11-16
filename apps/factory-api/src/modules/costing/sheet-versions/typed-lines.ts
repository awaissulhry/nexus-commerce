import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { lineCost } from '@nexus/factory-domain/costing/sheet-components/rules'
import type { TypedLineBody } from '@nexus/factory-domain/costing/sheet-versions/contracts'
import { commissionCost, typedLineProblems } from '@nexus/factory-domain/costing/sheet-versions/rules'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { refused, versionRefusalOf } from './refusals'
import { readSheetFor, SHEET_COLUMNS, textOrNull, type SheetRow } from './store'
import { assertDraft, assertManage, emitChanged, sendBack, versionRowOf } from './versions'

/**
 * Lines typed on a draft version (B-W2b-GB02, G054; B-W2b-430 gap 1 "no route types a line on a version", B-W2b-418 gap 6;
 * FIN-012 commissions; design products.styles › Cost › Cost sheet "Commissions (W2b)"): a person types a line the components
 * do not make — an agent's commission, a royalty or a payment fee (COMMISSION: a percent of the version's target price, or an
 * amount per garment), or a figure the components do not know (a packaging part, a workshop's extra, freight, duty,
 * overhead) — and removes a typed line again. Only a DRAFT takes them (an approved version is locked: a change is a new
 * version); a waiting request for its yes is sent back, as for any change of the draft. A typed line keeps its place when
 * the components are written again (B-W2b-418) and is copied with a new version. A commission in percent follows the target
 * price (versions.ts recountCommissions, in updateVersion: the target price is not cleared while one stays). costing.sheets.manage over the
 * sheet's company; every figure needs the cost grain.
 */

const text = (value: { toString(): string }): string => decimalText(value.toString())

/** The place of a new line: the next ten after the sheet's last line (10 for the first). */
async function nextSeq(tools: CommandTools, sheetId: string): Promise<number> {
  const last = await tools.tx.costSheetLine.findFirst({ where: { costSheetId: sheetId }, select: { seq: true }, orderBy: { seq: 'desc' } })
  return last ? Math.floor(last.seq / 10) * 10 + 10 : 10
}

/**
 * costing.addTypedLine — POST /costing/cost-sheets/:sheetId/typed-lines: a typed line on a draft (a commission in percent of
 * the target price, or quantity × unit cost); the version as a list row.
 */
export async function addTypedLine(caller: CommandCaller, sheetId: string, body: TypedLineBody, idempotencyKey?: string) {
  const seen = await readSheetFor(caller, sheetId)
  assertManage(caller, seen.companyId)
  assertDraft(seen)
  const issues = typedLineProblems(body)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const { result } = await command(caller, { name: 'costing.addTypedLine', idempotencyKey, input: { sheetId, ...body }, record: { type: 'CostSheet', id: sheetId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const sheet: SheetRow = await tx.costSheet.findUniqueOrThrow({ where: { id: sheetId }, select: SHEET_COLUMNS })
    assertDraft(sheet)
    if (body.size) {
      const style = await tx.style.findUniqueOrThrow({ where: { id: sheet.styleId }, select: { sizes: true } })
      if (!style.sizes.includes(body.size)) throw new ValidationError("The size is not in the style's range.", [{ path: 'body/size', message: `Expected one of ${style.sizes.join(', ')}.` }])
    }
    const target = textOrNull(sheet.targetPrice)
    if (body.pct !== undefined && target === null) throw refused('NEEDS_TARGET')
    const quantity = body.pct !== undefined ? '1' : (body.quantity ?? '1')
    const unitCost = body.pct !== undefined ? commissionCost(target!, body.pct) : body.unitCost!
    const cost = lineCost(quantity, unitCost)
    const id = newId()
    const seq = await nextSeq(tools, sheetId)
    await tx.costSheetLine.create({
      data: { id, costSheetId: sheetId, seq, category: body.category, source: 'TYPED', label: body.label, size: body.size ?? null, quantity, unitCost, cost, pct: body.pct ?? null, note: body.note ?? null, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
      select: { id: true },
    })
    await sendBack(tools, sheetId, 'The draft changed: send it for its yes again.')
    await tx.costSheet.update({ where: { id: sheetId }, data: { approvalTaskId: null, updatedAt: now }, select: { id: true } })
    tools.audit({ recordType: 'CostSheet', recordId: sheetId, companyId: sheet.companyId, after: { typedLine: { id, seq, category: body.category, label: body.label, size: body.size ?? null, quantity, unitCost: markMoney('cost', unitCost), cost: markMoney('cost', cost), pct: markMoney('cost', body.pct ?? null) } } })
    emitChanged(tools, sheet, 'DRAFT', 'updated')
    return { sheet: await versionRowOf(tx, sheetId) }
  }).catch((error: unknown) => {
    throw versionRefusalOf(error)
  })
  return result
}

/** costing.removeTypedLine — DELETE /costing/cost-sheets/:sheetId/typed-lines/:lineId?version: a typed line of a draft removed. */
export async function removeTypedLine(caller: CommandCaller, sheetId: string, lineId: string, version: number, idempotencyKey?: string) {
  const seen = await readSheetFor(caller, sheetId)
  assertManage(caller, seen.companyId)
  assertDraft(seen)
  const { result } = await command(caller, { name: 'costing.removeTypedLine', idempotencyKey, input: { sheetId, lineId, version }, record: { type: 'CostSheet', id: sheetId, expectedVersion: version } }, async (tools) => {
    const { tx, now } = tools
    const sheet: SheetRow = await tx.costSheet.findUniqueOrThrow({ where: { id: sheetId }, select: SHEET_COLUMNS })
    assertDraft(sheet)
    const line = isUuid(lineId) ? await tx.costSheetLine.findFirst({ where: { id: lineId, costSheetId: sheetId }, select: { id: true, seq: true, source: true, category: true, label: true, cost: true } }) : null
    if (!line) throw new ValidationError('The line is not a line of this version.', [{ path: 'params/lineId', message: 'Not a line of this version.' }])
    if (line.source !== 'TYPED') throw refused('NOT_TYPED')
    await tx.costSheetLine.delete({ where: { id: line.id }, select: { id: true } })
    await sendBack(tools, sheetId, 'The draft changed: send it for its yes again.')
    await tx.costSheet.update({ where: { id: sheetId }, data: { approvalTaskId: null, updatedAt: now }, select: { id: true } })
    tools.audit({ recordType: 'CostSheet', recordId: sheetId, companyId: sheet.companyId, before: { typedLine: { id: line.id, seq: line.seq, category: line.category, label: line.label, cost: markMoney('cost', text(line.cost)) } }, after: { typedLine: null } })
    emitChanged(tools, sheet, 'DRAFT', 'updated')
    return { sheet: await versionRowOf(tx, sheetId) }
  }).catch((error: unknown) => {
    throw versionRefusalOf(error)
  })
  return result
}
