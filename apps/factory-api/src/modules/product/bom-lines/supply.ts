import { NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import type { BomDepthView, ChangeSupplyBody, SetSupplyBody } from '@nexus/factory-domain/product/bom-lines/contracts'
import { customerProblems } from '@nexus/factory-domain/product/bom-lines/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertMayWrite, contextOf, lockDraft, readRevisionFor, type LockedDraft } from '../bom/store'
import { depthInTx, guarded, invalid, lineFor, prefixed, readDepthLines, readParties, recordChange, type DepthLine, type PartyFacts } from './store'

/**
 * A draft line's supply (B-W2b-228; PRD-084, PRD-108; design style.bom.lines "Customer-supplied (W2b)"): the customer or brand
 * that sends its material (cut-make-trim: no cost, no purchase; null: we buy it) and whether it goes in the kit a workshop
 * receives (`issueToSubcontract`, read by purchasing/subcontracting/kit-lines.ts); one line, or the list's selection at once.
 * Every write sends the revision's version and starts with W1's `lockDraft` (the style row FOR UPDATE, B-W2b-221's edit rule
 * DRAFT, the revision compared and set), then holds the party named FOR SHARE. The database's rules (…_bom_options_w2b_guards
 * `BomLine_w2b4_structure`: a CUSTOMER or BRAND party, never with a supplier, never on a sub-assembly) are said in words first
 * (factory-domain product/bom-lines `customerProblems`, 400). Audit rows on each line and on the revision; W1's
 * `style.bom_changed` with the lines changed.
 */

interface Supply {
  readonly customerSuppliedByPartyId: string | null
  readonly issueToSubcontract: boolean
}

const auditedSupply = (supply: Supply): Record<string, unknown> => ({ customerSuppliedByPartyId: supply.customerSuppliedByPartyId, issueToSubcontract: supply.issueToSubcontract })

/** Why the lines cannot take their next supply (each line's issues under `at(line)`). Locks the parties newly named first. */
async function supplyIssues(tools: CommandTools, draft: LockedDraft, planned: readonly { line: DepthLine; next: Supply; at: string }[]): Promise<Issue[]> {
  const named = planned.filter(({ line, next }) => next.customerSuppliedByPartyId !== null && next.customerSuppliedByPartyId !== line.customerSuppliedByPartyId)
  if (named.length === 0) return []
  const parties = await readParties(tools.tx, named.map(({ next }) => next.customerSuppliedByPartyId), true)
  const suppliers: ReadonlyMap<string, PartyFacts> = await readParties(tools.tx, named.map(({ line }) => line.supplierId))
  return named.flatMap(({ line, next, at }) =>
    prefixed(
      customerProblems(
        { seq: line.seq, supplier: line.supplierId === null ? null : { id: line.supplierId, code: suppliers.get(line.supplierId)?.code ?? '?' }, subAssembly: line.subAssemblyRevisionId !== null },
        parties.get(next.customerSuppliedByPartyId!),
        { companyId: draft.style.companyId, fresh: true },
      ),
      at,
    ),
  )
}

async function writeSupply(tools: CommandTools, draft: LockedDraft, line: DepthLine, next: Supply): Promise<boolean> {
  if (line.customerSuppliedByPartyId === next.customerSuppliedByPartyId && line.issueToSubcontract === next.issueToSubcontract) return false
  await tools.tx.bomLine.update({ where: { id: line.id }, data: { ...next, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
  tools.audit({ recordType: 'BomLine', recordId: line.id, companyId: draft.style.companyId, before: auditedSupply(line), after: auditedSupply(next) })
  return true
}

const nextOf = (line: DepthLine, body: { customerSuppliedByPartyId?: string | null | undefined; issueToSubcontract?: boolean | undefined }): Supply => ({
  customerSuppliedByPartyId: body.customerSuppliedByPartyId === undefined ? line.customerSuppliedByPartyId : body.customerSuppliedByPartyId,
  issueToSubcontract: body.issueToSubcontract ?? line.issueToSubcontract,
})

/** product.bomLines.setSupply: one line's customer and workshop mark (what is left out stays). */
export async function setSupply(caller: CommandCaller, styleId: string, revisionId: string, lineId: string, body: SetSupplyBody, idempotencyKey?: string): Promise<BomDepthView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await guarded(() =>
    command(caller, { name: 'product.bomLines.setSupply', idempotencyKey, input: { styleId, revisionId, lineId, ...body } }, async (tools) => {
      const draft = await lockDraft(tools, styleId, revisionId, body.version)
      const line = await lineFor(tools.tx, revisionId, lineId)
      const next = nextOf(line, body)
      const issues = await supplyIssues(tools, draft, [{ line, next, at: 'body' }])
      if (issues.length > 0) throw invalid(issues)
      const changed = await writeSupply(tools, draft, line, next)
      recordChange(tools, draft, changed ? [line.id] : [], { supply: { line: line.id, ...auditedSupply(next) } })
      return depthInTx(tools, styleId, revisionId)
    }),
  )
  return result
}

/** product.bomLines.changeSupply: the list's selection given one customer (null: we buy them) and/or one workshop mark. */
export async function changeSupply(caller: CommandCaller, styleId: string, revisionId: string, body: ChangeSupplyBody, idempotencyKey?: string): Promise<BomDepthView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)
  if (new Set(body.lineIds).size !== body.lineIds.length) throw invalid([{ path: 'body/lineIds', message: 'Each line once.' }])

  const { result } = await guarded(() =>
    command(caller, { name: 'product.bomLines.changeSupply', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
      const draft = await lockDraft(tools, styleId, revisionId, body.version)
      const lines = await readDepthLines(tools.tx, revisionId)
      const unknown = body.lineIds.filter((id) => !lines.some((line) => line.id === id))
      if (unknown.length > 0) throw new NotFoundError(`${unknown.length} BOM line(s) are not of this revision.`)
      const planned = body.lineIds.map((id, index) => {
        const line = lines.find((entry) => entry.id === id)!
        return { line, next: nextOf(line, body), at: `body/lineIds/${index}` }
      })
      const issues = await supplyIssues(tools, draft, planned)
      if (issues.length > 0) throw invalid(issues, 'selection')
      const changedIds: string[] = []
      for (const { line, next } of [...planned].sort((a, b) => a.line.seq - b.line.seq)) if (await writeSupply(tools, draft, line, next)) changedIds.push(line.id)
      recordChange(tools, draft, changedIds, {
        supply: {
          lines: changedIds,
          ...(body.customerSuppliedByPartyId === undefined ? {} : { customerSuppliedByPartyId: body.customerSuppliedByPartyId }),
          ...(body.issueToSubcontract === undefined ? {} : { issueToSubcontract: body.issueToSubcontract }),
        },
      })
      return depthInTx(tools, styleId, revisionId)
    }),
  )
  return result
}
