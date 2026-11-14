import type { FactoryClient } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CostingMaterial } from '@nexus/factory-domain/costing/inputs'
import { rolledLineOf, notCostedWords, subColourwayOf, tooDeep, type RolledLine, type SubSizeCost } from '@nexus/factory-domain/costing/rollup/rules'
import { componentsOf, type ComponentFacts, type Components } from '@nexus/factory-domain/costing/sheet-components/components'
import { splitBySize } from '@nexus/factory-domain/costing/sheet-components/split'
import type { BomLineData } from '@nexus/factory-domain/product/bom/rules'
import type { CommandTx } from '../../../core/command'
import { findRevision, type RevisionRow } from '../../product/bom/store'
import { readTargets, type TargetRecord } from '../../product/bom-structure/store'
import { STYLE_COLUMNS, type CostingStyleRow } from '../store'
import type { ComponentCompany, ComponentOptions, LoadedComponents } from '../sheet-components/store'

/**
 * The multi-level cost roll-up, read (B-W2b-423; FIN-019, KS4:02): for a revision's lines that take a sub-assembly (B-W2b-223's
 * BomLine.subAssemblyRevisionId), the sub-assembly's own cost sheet components for one output batch in each of its sizes, in
 * the colourway that serves the parent's, for the same company and day, its own sub-assemblies rolled up the same way (the
 * loader is B-W2b-418's `loadComponentFacts`, which calls this for every level: passed in, so the two files do not import
 * each other). Neither the per-garment overhead nor the packaging master is costed on a sub-assembly (the garment takes them).
 * Reads only, one query after another (a transaction client runs one at a time).
 */

type Reader = FactoryClient | CommandTx

export type LoadFacts = (db: Reader, style: CostingStyleRow, revision: RevisionRow, company: ComponentCompany, on: BusinessDate, options: ComponentOptions) => Promise<LoadedComponents>

export interface RollupInput {
  readonly revisionId: string
  readonly lines: readonly BomLineData[]
  readonly materials: ReadonlyMap<string, CostingMaterial>
  readonly sizes: readonly string[]
  readonly colourwayCode: string
  readonly company: ComponentCompany
  readonly on: BusinessDate
  /** 1: the revision costed; its sub-assemblies are level 2 … */
  readonly level: number
  /** The revisions above, top first (a circle is never walked). */
  readonly path: readonly string[]
  readonly priceOverrides?: ReadonlyMap<string, string> | undefined
}

/**
 * The sub-assembly's facts as a roll-up costs them: its own labour's overhead, never the per-garment overhead (an every-kind
 * PER_UNIT rule: the garment it goes into takes it once), no packaging master, no carton.
 */
export const asSubAssembly = (facts: ComponentFacts): ComponentFacts => ({
  ...facts,
  overheadRules: facts.overheadRules.filter((rule) => !(rule.basis === 'PER_UNIT' && rule.workCentreKind === null)),
  packaging: { ...facts.packaging, defaults: [] },
  piecesPerCarton: null,
})

/** One sub-assembly's cost per its own size (its components' total for one output batch). */
export function sizeCostsOf(components: Components, sizes: readonly string[]): Map<string, SubSizeCost> {
  return new Map(
    splitBySize(components.lines, sizes, components.missing).map((split) => [
      split.size,
      {
        size: split.size,
        categories: split.categories.map((entry) => ({ category: entry.category, amount: entry.amount })),
        knownTotal: split.knownTotal,
        total: split.total,
        missing: components.missing.filter((entry) => entry.size === null || entry.size === split.size).map((entry) => entry.message),
      },
    ]),
  )
}

/** A sub-assembly costed at one level: its components and facts (for the roll-up route's tree). */
export interface CostedSubAssembly {
  readonly target: TargetRecord
  readonly colourway: { readonly id: string; readonly code: string }
  readonly facts: ComponentFacts
  readonly components: Components
  readonly costs: Map<string, SubSizeCost>
}

/** The sub-assembly lines of a revision, each costed per parent size; `costed` collects what was costed (by line id). */
export async function rolledUpFor(db: Reader, input: RollupInput, load: LoadFacts, costed?: Map<string, CostedSubAssembly>): Promise<Map<string, RolledLine>> {
  const ids = new Set(input.lines.map((line) => line.id))
  if (ids.size === 0) return new Map()
  const links = (await db.bomLine.findMany({ where: { revisionId: input.revisionId, subAssemblyRevisionId: { not: null } }, select: { id: true, subAssemblyRevisionId: true } })).filter((row) => ids.has(row.id))
  if (links.length === 0) return new Map()
  const targets = await readTargets(db, links.map((row) => row.subAssemblyRevisionId!))
  const cache = new Map<string, CostedSubAssembly | null>()
  const out = new Map<string, RolledLine>()
  for (const link of links) {
    const line = input.lines.find((entry) => entry.id === link.id)!
    const material = input.materials.get(line.itemId)
    const target = targets.get(link.subAssemblyRevisionId!)
    if (!material || !target) continue // not read: the line is costed missing by its material (never at a guess)
    const head = { id: line.id, seq: line.seq, uom: line.uom, itemCode: material.code }
    const base = { line: head, units: material.units, target, parentSizes: input.sizes, parentColourwayCode: input.colourwayCode }
    if (tooDeep(input.level + 1) || input.path.includes(target.revisionId)) {
      out.set(line.id, rolledLineOf({ ...base, costs: null, notCosted: { code: input.path.includes(target.revisionId) ? 'NOT_READ' : 'TOO_DEEP', message: notCostedWords(input.path.includes(target.revisionId) ? 'NOT_READ' : 'TOO_DEEP', head, target) } }))
      continue
    }
    const colourway = subColourwayOf(target, input.colourwayCode)
    if (colourway === null) {
      out.set(line.id, rolledLineOf({ ...base, costs: null }))
      continue
    }
    const key = `${target.revisionId}:${colourway.id}`
    if (!cache.has(key)) {
      const style = await db.style.findUnique({ where: { id: target.styleId }, select: STYLE_COLUMNS })
      if (!style) cache.set(key, null)
      else {
        const revision = await findRevision(db, style.id, target.revisionId)
        const loaded = await load(db, style, revision, input.company, input.on, { colourwayId: colourway.id, rollup: { level: input.level + 1, path: [...input.path, target.revisionId] }, priceOverrides: input.priceOverrides })
        const facts = asSubAssembly(loaded.facts)
        const components = componentsOf(facts)
        cache.set(key, { target, colourway, facts, components, costs: sizeCostsOf(components, style.sizes) })
      }
    }
    const sub = cache.get(key) ?? null
    if (sub && costed) costed.set(line.id, sub)
    out.set(line.id, rolledLineOf({ ...base, costs: sub?.costs ?? null, ...(sub ? {} : { notCosted: { code: 'NOT_READ' as const, message: notCostedWords('NOT_READ', head, target) } }) }))
  }
  return out
}
