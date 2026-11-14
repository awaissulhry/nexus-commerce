import { ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { RollupQuery, RollupView } from '@nexus/factory-domain/costing/rollup/contracts'
import { batchesOf } from '@nexus/factory-domain/costing/rollup/rules'
import { componentsOf, type ComponentFacts, type ComponentLine } from '@nexus/factory-domain/costing/sheet-components/components'
import { COMPONENT_REFUSAL_WORDS } from '@nexus/factory-domain/costing/sheet-components/rules'
import { splitBySize, type SplitLine } from '@nexus/factory-domain/costing/sheet-components/split'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { lineNeed } from '@nexus/factory-domain/product/bom/requirements'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { findRevision } from '../../product/bom/store'
import { loadComponentFacts, type ComponentCompany } from '../sheet-components/store'
import { companyFor, readStyleFor } from '../store'
import { rolledUpFor, type CostedSubAssembly } from './store'

/**
 * GET /costing/styles/:styleId/revisions/:revisionId/rollup (B-W2b-423; FIN-019, KS4:02; design products.styles › Materials
 * (BOM) › "Sub-assemblies" with its cost column): the revision's components — the garment without options, B-W2b-418's
 * computation — with every sub-assembly line at its own cost, and the tree of its sub-assemblies level by level: the line that
 * takes each, the size and colourway that serve the parent, the output batches one garment takes, its cost per batch and per
 * base unit of the component, and its own split. costing.view over the style's company (a tenant-wide style: over the company
 * asked for). A read: nothing is written.
 */

type Node = RollupView['tree'][number]

const lineView = (line: ComponentLine) => ({
  seq: null,
  category: line.category,
  source: line.source,
  sourceRecordType: line.sourceRecordType,
  sourceRecordId: line.sourceRecordId,
  itemId: line.itemId,
  workCentreKind: line.workCentreKind,
  label: line.label,
  size: line.size,
  quantity: line.quantity,
  uom: line.uom,
  unitCost: asMoney('cost', line.unitCost),
  cost: asMoney('cost', line.cost),
  pct: asMoney('cost', line.pct),
  note: line.note,
})

export const splitView = (lines: readonly SplitLine[], sizes: readonly string[], missing: readonly { readonly size: string | null }[]) =>
  splitBySize(lines, sizes, missing).map((size) => ({
    size: size.size,
    categories: size.categories.map((entry) => ({ category: entry.category, amount: asMoney('cost', entry.amount) })),
    knownTotal: asMoney('cost', size.knownTotal),
    total: asMoney('cost', size.total),
    complete: size.complete,
  }))

export async function revisionRollup(caller: CommandCaller, styleId: string, revisionId: string, query: RollupQuery): Promise<RollupView> {
  const style = await readStyleFor(caller, styleId)
  const company = await companyFor(caller, style, query.companyId, 'querystring/companyId')
  if (company.id === null) throw new ValidationError(COMPONENT_REFUSAL_WORDS.NO_COMPANY, [{ path: 'querystring/companyId', message: COMPONENT_REFUSAL_WORDS.NO_COMPANY }])
  const now = serverClock.now()
  const on = businessDate(now)
  const costedFor: ComponentCompany = { id: company.id, currency: company.currency }
  return caller.withClient(async (db) => {
    const revision = await findRevision(db, styleId, revisionId)
    const loaded = await loadComponentFacts(db, style, revision, costedFor, on, query)
    const { lines, missing } = componentsOf(loaded.facts)
    const tree: Node[] = []
    let levels = 1
    const walk = async (atRevision: string, facts: ComponentFacts, colourwayCode: string, level: number, path: readonly string[], via: readonly string[]): Promise<void> => {
      const costed = new Map<string, CostedSubAssembly>()
      await rolledUpFor(db, { revisionId: atRevision, lines: facts.lines, materials: facts.materials, sizes: facts.sizes, colourwayCode, company: costedFor, on, level, path }, loadComponentFacts, costed)
      for (const line of [...facts.lines].sort((a, b) => a.seq - b.seq)) {
        const rolled = facts.rolledUp?.get(line.id)
        const material = facts.materials.get(line.itemId)
        if (!rolled || !material) continue
        const sub = costed.get(line.id)
        levels = Math.max(levels, level + 1)
        tree.push({
          level: level + 1,
          lineId: line.id,
          seq: line.seq,
          via: [...via],
          item: { id: material.id, code: material.code, name: material.name },
          subAssembly: { ...rolled.target },
          colourway: rolled.colourway,
          sizes: facts.sizes.map((size) => {
            const at = rolled.bySize.get(size)
            const need = lineNeed(line, size, material.units)
            return {
              size,
              subSize: at?.ok ? at.subSize : null,
              batches: at && need ? batchesOf(need.base, at) : null,
              perBatch: asMoney('cost', at?.ok ? at.perBatch : null),
              perBaseUnit: asMoney('cost', at?.ok ? at.perBaseUnit : null),
              problem: at && !at.ok ? { code: at.code, message: at.message } : null,
            }
          }),
          own: sub ? splitView(sub.components.lines, sub.facts.sizes, sub.components.missing) : [],
        })
        if (sub) await walk(sub.target.revisionId, sub.facts, sub.colourway.code, level + 1, [...path, sub.target.revisionId], [...via, line.id])
      }
    }
    await walk(revision.id, loaded.facts, loaded.colourway.code, 1, [revision.id], [])
    return {
      style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, baseSize: style.baseSize },
      revision: { id: revision.id, revision: revision.revision, status: revision.status },
      companyId: company.id!,
      currency: company.currency,
      on,
      colourway: loaded.colourway,
      sizes: [...style.sizes],
      lines: lines.map(lineView),
      split: splitView(lines, style.sizes, missing),
      complete: missing.length === 0 && lines.length > 0,
      missing,
      tree,
      levels,
      computedAt: toUtcIso(now),
    }
  })
}
