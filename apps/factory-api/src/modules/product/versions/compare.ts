import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { exactCells, missingView, prepareSheet, shownCost, type ExactCell } from '@nexus/factory-domain/costing/sheet'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { compareSpecs, differsOf, differsWords, type CompareLine, type CompareSection, type SpecSnapshot } from '@nexus/factory-domain/product/versions/compare'
import type { CompareQuery, CostSectionView, VersionsCompareView } from '@nexus/factory-domain/product/versions/contracts'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { companyFor, loadCostFacts, type CostingCompany } from '../../costing/store'
import { contextOf, readStyleFor, type BomStyleRow } from '../bom/store'
import { headOf, readSnapshots, revisionOfStyle, type Db, type RevisionRow } from './read'

/**
 * Two revisions of a style compared (B-W2b-220; PRD-168, PRD-085, VS1:01): GET /product/styles/:styleId/versions/compare
 * ?from&to[&companyId]. Every part (factory-domain product/versions/compare) as VersionCompare's sections, the parts that
 * differ in words, and — for a caller with the cost grain and costing.view over the company it is costed for — the cost
 * section: both revisions priced with today's inputs (costing, B-W1-16), per colourway the cost per garment of each size.
 * A read: no command(), nothing written.
 */

/** The two revisions, both of this style (a revision of another style is not found, 404). */
async function pairOf(db: Db, styleId: string, query: Pick<CompareQuery, 'from' | 'to'>): Promise<[RevisionRow, RevisionRow]> {
  const from = await revisionOfStyle(db, styleId, query.from)
  const to = await revisionOfStyle(db, styleId, query.to)
  if (!from || !to) throw new NotFoundError('Revision not found.')
  return [from, to]
}

/** The cost section: one line per colourway (either side's), the cost per garment of each size; the base size's parts as fields. */
export function costSectionOf(
  style: Pick<BomStyleRow, 'sizes' | 'baseSize'>,
  colourways: ReadonlyMap<string, { code: string; name: string }>,
  before: readonly ExactCell[],
  after: readonly ExactCell[],
): Pick<CostSectionView, 'label' | 'fields' | 'sizes' | 'lines' | 'totals' | 'summary'> {
  const fields = [
    { id: 'material', label: `Material (size ${style.baseSize})` },
    { id: 'labour', label: `Labour (size ${style.baseSize})` },
    { id: 'overhead', label: `Overhead (size ${style.baseSize})` },
  ]
  const order = [...new Set([...after.map((cell) => cell.colourwayId), ...before.map((cell) => cell.colourwayId)])]
  const sideOf = (cells: readonly ExactCell[], colourwayId: string) => {
    const own = cells.filter((cell) => cell.colourwayId === colourwayId)
    if (own.length === 0) return null
    const base = own.find((cell) => cell.size === style.baseSize) ?? null
    const known = (cell: ExactCell | null, value: (cell: ExactCell) => string | null) => (cell === null ? null : value(cell))
    return {
      fields: {
        material: known(base, (cell) => (cell.materialComplete ? shownCost(cell.material) : null)),
        labour: known(base, (cell) => (cell.labourComplete ? shownCost(cell.labourCost) : null)),
        overhead: known(base, (cell) => (cell.overhead ? shownCost(cell.overhead.amount) : null)),
      },
      // A cell with a missing input has no total: it is left out (the section's `missing` says why).
      sizes: Object.fromEntries(own.filter((cell) => cell.missing.length === 0).map((cell) => [cell.size, shownCost(cell.knownTotal)])),
    }
  }
  const lines: CompareLine[] = order.map((colourwayId) => {
    const colourway = colourways.get(colourwayId)
    return { id: colourwayId, label: colourway ? `${colourway.code} ${colourway.name}` : colourwayId, detail: null, before: sideOf(before, colourwayId), after: sideOf(after, colourwayId) }
  })
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 }
  for (const line of lines) {
    if (!line.before) summary.added++
    else if (!line.after) summary.removed++
    else if (JSON.stringify(line.before) !== JSON.stringify(line.after)) summary.changed++
    else summary.unchanged++
  }
  const first = order[0]
  const baseTotal = (cells: readonly ExactCell[]) => {
    const cell = cells.find((entry) => entry.colourwayId === first && entry.size === style.baseSize)
    return cell && cell.missing.length === 0 ? shownCost(cell.knownTotal) : null
  }
  const label = first ? `Cost per garment (${colourways.get(first)?.code ?? ''} ${style.baseSize})` : 'Cost per garment'
  return { label: 'Cost', fields, sizes: [...style.sizes], lines, totals: first ? [{ id: 'base', label, before: baseTotal(before), after: baseTotal(after) }] : [], summary }
}

/** Both revisions priced for the cost section, or null when the caller may not see this style's cost. */
async function costOf(caller: CommandCaller, style: BomStyleRow, from: RevisionRow, to: RevisionRow, companyId: string | undefined): Promise<CostSectionView | null> {
  let company: CostingCompany
  try {
    company = await companyFor(caller, style, companyId, 'querystring/companyId')
  } catch (error) {
    // Not costing.view over the style's (or the asked) company: no cost, the rest of the compare stands.
    if (error instanceof NotFoundError) return null
    throw error
  }
  if (company.id === null && !can(actorOf(contextOf(caller)), COSTING_VIEW, { companyId: null })) return null
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const left = await loadCostFacts(client, style, from, company, now)
    const right = await loadCostFacts(client, style, to, company, now)
    const leftSheet = prepareSheet(left.facts)
    const rightSheet = prepareSheet(right.facts)
    const leftCells = exactCells(leftSheet)
    const rightCells = exactCells(rightSheet)
    const colourways = new Map([...left.colourways, ...right.colourways].map((colourway) => [colourway.id, { code: colourway.code, name: colourway.name }]))
    const missing = new Map<string, { code: string; message: string }>()
    for (const entry of [...missingView(leftSheet, leftCells), ...missingView(rightSheet, rightCells)]) missing.set(`${entry.code}:${entry.message}`, { code: entry.code, message: entry.message })
    const complete = (cells: readonly ExactCell[]) => cells.length > 0 && cells.every((cell) => cell.missing.length === 0)
    return {
      id: 'cost' as const,
      ...costSectionOf(style, colourways, leftCells, rightCells),
      currency: company.currency,
      companyId: company.id,
      on: rightSheet.facts.on,
      computedAt: toUtcIso(now),
      complete: { before: complete(leftCells), after: complete(rightCells) },
      missing: [...missing.values()],
    }
  })
}

export async function compareVersions(caller: CommandCaller, styleId: string, query: CompareQuery): Promise<VersionsCompareView> {
  const style = await readStyleFor(caller, styleId)
  if (query.from === query.to) throw new ValidationError('Pick two different revisions.', [{ path: 'querystring/to', message: 'The same revision as `from`.' }])
  const { from, to, snapshots } = await caller.withClient(async (client) => {
    const [from, to] = await pairOf(client, styleId, query)
    const snapshots = await readSnapshots(client, [from, to])
    return { from, to, snapshots: snapshots as [SpecSnapshot, SpecSnapshot] }
  })
  const sections: CompareSection[] = compareSpecs(snapshots[0], snapshots[1], style.sizes)
  const differs = differsOf(sections)
  // The cost only for the cost grain (the filter would drop it anyway: it is not even computed).
  const grains = heldGrains(actorOf(contextOf(caller)))
  const cost = grains.has('cost') ? await costOf(caller, style, from, to, query.companyId) : undefined
  return {
    style: { id: style.id, code: style.code, name: style.name, sizes: [...style.sizes] },
    before: headOf(from),
    after: headOf(to),
    sections: sections.map((entry) => ({ ...entry, fields: [...entry.fields], sizes: [...entry.sizes], lines: [...entry.lines], totals: [...entry.totals] })),
    differs,
    words: differsWords(differs),
    ...(cost === undefined ? {} : { cost: asMoney('cost', cost) }),
  }
}

export { pairOf }
