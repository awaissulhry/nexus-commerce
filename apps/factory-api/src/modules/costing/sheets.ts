import type { Issue } from '@nexus/factory-domain/core/errors'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CompareCostQuery, CostCellsBody, CostCellsView, CostDiffView, CostSheetQuery, CostSheetView } from '@nexus/factory-domain/costing/contracts'
import { diffCostCells } from '@nexus/factory-domain/costing/diff'
import { costSheet, exactCell, exactCells, missingView, prepareSheet, quantityCost } from '@nexus/factory-domain/costing/sheet'
import type { CommandCaller } from '../../core/command'
import { serverClock } from '../../core/time'
import { companyFor, findRevision, loadCostFacts, readStyleFor, type CostingStyleRow, type RevisionRow } from './store'

/**
 * The cost sheet's reads (B-W1-16): a revision's sheet, two revisions compared, and the cells a quote asks for. Each
 * checks the style (and the company asked for) first, then reads everything with one client and computes with
 * factory-domain costing. Reads only, so no command(): nothing is written, audited or emitted.
 */

const styleRef = (style: CostingStyleRow) => ({ id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status, baseSize: style.baseSize })
const revisionRef = (revision: RevisionRow) => ({ id: revision.id, revision: revision.revision, status: revision.status, version: revision.version })

/** A revision's cost sheet: every active colourway × every size of the range (SCR-044). */
export async function costSheetOf(caller: CommandCaller, styleId: string, revisionId: string, query: CostSheetQuery): Promise<CostSheetView> {
  const style = await readStyleFor(caller, styleId)
  const company = await companyFor(caller, style, query.companyId, 'querystring/companyId')
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const revision = await findRevision(client, styleId, revisionId)
    const { facts, colourways } = await loadCostFacts(client, style, revision, company, now)
    return {
      style: styleRef(style),
      revision: revisionRef(revision),
      estimate: revision.status === 'DRAFT',
      sizes: [...style.sizes],
      colourways: [...colourways],
      computedAt: toUtcIso(now),
      ...costSheet(facts),
    }
  })
}

/** Two revisions of the style compared, both priced with today's inputs. */
export async function compareCostSheets(caller: CommandCaller, styleId: string, query: CompareCostQuery): Promise<CostDiffView> {
  const style = await readStyleFor(caller, styleId)
  const company = await companyFor(caller, style, query.companyId, 'querystring/companyId')
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const from = await findRevision(client, styleId, query.from)
    const to = await findRevision(client, styleId, query.to)
    const side = async (revision: RevisionRow) => {
      const sheet = prepareSheet((await loadCostFacts(client, style, revision, company, now)).facts)
      const cells = exactCells(sheet)
      return { ref: { ...revisionRef(revision), complete: cells.length > 0 && cells.every((cell) => cell.missing.length === 0), missing: missingView(sheet, cells) }, cells, sheet }
    }
    const left = await side(from)
    const right = await side(to)
    const diff = diffCostCells(left.cells, right.cells)
    return {
      style: styleRef(style),
      from: left.ref,
      to: right.ref,
      currency: company.currency,
      companyId: company.id,
      on: right.sheet.facts.on,
      computedAt: toUtcIso(now),
      cells: diff.cells,
      unchanged: diff.unchanged,
    }
  })
}

/**
 * The cost of the cells a quote names (B-W1-21: style + revision + colourway × size, optionally a quantity): per cell
 * the cost per garment and, for a quantity, its minutes and amount. A colourway that is not an active one of the style,
 * or a size outside its range, is refused (400) with the cell's path.
 */
export async function costCells(caller: CommandCaller, body: CostCellsBody): Promise<CostCellsView> {
  const style = await readStyleFor(caller, body.styleId)
  const company = await companyFor(caller, style, body.companyId, 'body/companyId')
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const revision = await findRevision(client, style.id, body.revisionId)
    const { facts } = await loadCostFacts(client, style, revision, company, now)
    const issues: Issue[] = []
    body.cells.forEach((cell, index) => {
      if (!facts.colourwayIds.includes(cell.colourwayId)) issues.push({ path: `body/cells/${index}/colourwayId`, message: 'Not an active colourway of this style.' })
      if (!facts.sizes.includes(cell.size)) issues.push({ path: `body/cells/${index}/size`, message: `Not a size of this style's range (${facts.sizes.join(', ')}).` })
    })
    if (issues.length > 0) throw new ValidationError('The cells are not valid.', issues)
    const sheet = prepareSheet(facts)
    const exact = body.cells.map((cell) => exactCell(sheet, cell.colourwayId, cell.size))
    const cells = exact.map((cell, index) => {
      try {
        return quantityCost(cell, body.cells[index]!.quantity ?? null, facts.currency)
      } catch (error) {
        if (error instanceof ValidationError) throw new ValidationError(error.message, (error.issues ?? []).map((issue) => ({ ...issue, path: `body/cells/${index}/${issue.path}` })))
        throw error
      }
    })
    return {
      style: styleRef(style),
      revision: revisionRef(revision),
      estimate: revision.status === 'DRAFT',
      currency: facts.currency,
      companyId: facts.companyId,
      on: facts.on,
      computedAt: toUtcIso(now),
      complete: exact.every((cell) => cell.missing.length === 0),
      missing: missingView(sheet, exact),
      cells,
    }
  })
}
