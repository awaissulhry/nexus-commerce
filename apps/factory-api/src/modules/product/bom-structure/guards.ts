import { ConflictError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { removeGroupRowProblem, subAssemblyMaterialProblem } from '@nexus/factory-domain/product/bom-structure/rules'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'

/**
 * W1's BOM line writes meet B-W2b-206's and B-W2b-211's database rules on BomLine (B-W2b-223): each is said here in words
 * first, so the database's refusal never reaches a person as a 500. Called by W1's product/bom store.ts (one line each,
 * marked B-W2b-223): `writeLine` (a line added or changed by the BOM routes, the BOM import, the leather loss acceptance)
 * and `deleteLine` (a line removed). This file imports nothing of product/bom (that store imports it).
 *
 *   a material chosen     not BLOCKED (B-W2b-206: refused for use)
 *   a sub-assembly line   its material stays a COMPONENT we make (MAKE or MAKE_OR_BUY) counted in PCS, PAIR or SET
 *   customer-supplied     names no supplier (the customer sends it: it is not bought)
 *   alternates            the new material is none of the line's alternates; a PPE component as the new material needs a
 *                         certificate check on every alternate
 *   a group row           not removed while lines are grouped under it (ungroup them first)
 */

const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError('The BOM line is not valid.', issues)

interface LineBefore {
  readonly id: string
  readonly seq: number
  readonly itemId: string
  readonly uom: Uom
  readonly supplierId: string | null
}
interface LineAfter {
  readonly seq: number
  readonly itemId: string
  readonly uom: Uom
  readonly supplierId: string | null
}

/** Refuses in words what the database would refuse of this line write (`before` null: a new line). */
export async function assertLineKeepsStructure(tx: CommandTx, before: LineBefore | null, line: LineAfter): Promise<void> {
  const materialChanged = before === null || before.itemId !== line.itemId
  const item = await tx.item.findUnique({ where: { id: line.itemId }, select: { code: true, kind: true, sourcing: true, approval: true, approvalNote: true, isPpeComponent: true } })
  if (!item) return // W1's own check says "No such material."
  const issues: Issue[] = []
  if (materialChanged && item.approval === 'BLOCKED') {
    issues.push({ path: 'body/itemId', message: `${item.code} is blocked (refused for use); choose another material.${item.approvalNote ? ` Why: ${item.approvalNote}` : ''}` })
  }
  if (before !== null) {
    const stored = await tx.bomLine.findUnique({ where: { id: before.id }, select: { subAssemblyRevisionId: true, customerSuppliedByPartyId: true } })
    const customerSupplied = (stored?.customerSuppliedByPartyId ?? null) !== null
    if (stored?.subAssemblyRevisionId && (materialChanged || before.uom !== line.uom) && item.kind !== 'FINISHED') {
      const problem = subAssemblyMaterialProblem({ seq: line.seq, styleId: '', uom: line.uom, customerSupplied, material: { code: item.code, kind: item.kind, sourcing: item.sourcing } })
      if (problem) issues.push({ path: materialChanged ? 'body/itemId' : 'body/uom', message: `${problem} (It takes a sub-assembly: clear it first to use another material.)` })
    }
    if (customerSupplied && line.supplierId !== null && line.supplierId !== before.supplierId) {
      issues.push({ path: 'body/supplierId', message: `Line ${line.seq} is sent by the customer, so it is not bought: it names no supplier.` })
    }
    if (materialChanged) {
      const alternates = await tx.bomLineAlternate.findMany({ where: { bomLineId: before.id }, select: { priority: true, itemId: true, certificateCheck: true }, orderBy: { priority: 'asc' } })
      const same = alternates.find((alternate) => alternate.itemId === line.itemId)
      if (same) issues.push({ path: 'body/itemId', message: `${item.code} is alternate ${same.priority} of line ${line.seq}: remove that alternate first, or choose another material.` })
      const unchecked = alternates.filter((alternate) => !alternate.certificateCheck)
      if (item.isPpeComponent && unchecked.length > 0) {
        issues.push({ path: 'body/itemId', message: `${item.code} is a PPE component, so every alternate of line ${line.seq} needs a certificate check (alternate ${unchecked.map((alternate) => alternate.priority).join(', ')} has none).` })
      }
    }
  }
  if (issues.length > 0) throw invalid(issues)
}

/** Refuses (409, in words) to remove a line while lines are grouped under it. */
export async function assertNotGroupRow(tx: CommandTx, line: { readonly id: string; readonly seq: number }): Promise<void> {
  const under = await tx.bomLine.findMany({ where: { parentLineId: line.id }, select: { id: true, seq: true, parentLineId: true }, orderBy: { seq: 'asc' } })
  if (under.length === 0) return
  const problem = removeGroupRowProblem([{ id: line.id, seq: line.seq, parentLineId: null }, ...under], line.id)
  if (problem) throw new ConflictError(problem)
}
