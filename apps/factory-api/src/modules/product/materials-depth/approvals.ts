import type { MaterialApprovalsView } from '@nexus/factory-domain/product/materials-depth/contracts'
import type { MaterialApproval } from '@nexus/factory-domain/product/materials-depth/rules'
import type { CommandCaller } from '../../../core/command'
import { readRevisionFor } from '../bom/store'

/**
 * The approvals of the materials a style's revision names (B-W2b-238; PRD-035; design products.styles Compliance › Material
 * checks "Blocked or unapproved materials"): GET /product/styles/:styleId/revisions/:revisionId/material-approvals, office,
 * product.bom.view over the style's company (another company's style is not found, as W1's BOM routes). Every material of
 * its lines and of their alternates, blocked first, then conditional, pending and approved, each with the lines that name
 * it. `releasable`: no blocked material (the database refuses the release of a revision whose lines name one, B-W2b-223's
 * check also an alternate). No money.
 */

const ORDER: Readonly<Record<MaterialApproval, number>> = { BLOCKED: 0, CONDITIONAL: 1, PENDING: 2, APPROVED: 3 }

export async function materialApprovals(caller: CommandCaller, styleId: string, revisionId: string): Promise<MaterialApprovalsView> {
  const { style, revision } = await readRevisionFor(caller, styleId, revisionId)
  return caller.withClient(async (db) => {
    const lines = await db.bomLine.findMany({ where: { revisionId }, select: { seq: true, itemId: true }, orderBy: { seq: 'asc' } })
    const alternates = await db.bomLineAlternate.findMany({ where: { revisionId }, select: { itemId: true, bomLine: { select: { seq: true } } } })
    const named = new Map<string, { seqs: Set<number>; asLine: boolean }>()
    for (const line of lines) {
      const entry = named.get(line.itemId) ?? { seqs: new Set<number>(), asLine: false }
      entry.seqs.add(line.seq)
      entry.asLine = true
      named.set(line.itemId, entry)
    }
    for (const alternate of alternates) {
      const entry = named.get(alternate.itemId) ?? { seqs: new Set<number>(), asLine: false }
      entry.seqs.add(alternate.bomLine.seq)
      named.set(alternate.itemId, entry)
    }
    const items =
      named.size === 0
        ? []
        : await db.item.findMany({ where: { id: { in: [...named.keys()] } }, select: { id: true, code: true, name: true, kind: true, approval: true, approvalNote: true, isPpeComponent: true } })
    const materials = items
      .map((item) => {
        const entry = named.get(item.id)!
        return {
          itemId: item.id,
          code: item.code,
          name: item.name,
          kind: item.kind as MaterialApprovalsView['materials'][number]['kind'],
          approval: item.approval as MaterialApproval,
          note: item.approvalNote,
          isPpeComponent: item.isPpeComponent,
          lines: [...entry.seqs].sort((a, b) => a - b),
          alternateOnly: !entry.asLine,
        }
      })
      .sort((a, b) => ORDER[a.approval] - ORDER[b.approval] || (a.lines[0] ?? 0) - (b.lines[0] ?? 0) || (a.code < b.code ? -1 : 1))
    const count = (approval: MaterialApproval) => materials.filter((material) => material.approval === approval).length
    return {
      style: { id: style.id, code: style.code },
      revision: { id: revision.id, revision: revision.revision, status: revision.status },
      materials,
      counts: { blocked: count('BLOCKED'), conditional: count('CONDITIONAL'), pending: count('PENDING'), approved: count('APPROVED') },
      releasable: count('BLOCKED') === 0,
    }
  })
}
