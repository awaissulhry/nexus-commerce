import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { costingCurrency, type CostingMaterial } from '@nexus/factory-domain/costing/inputs'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import type { CostFacts } from '@nexus/factory-domain/costing/sheet'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller, CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { contextOf, findRevision, readColourways, readLines, type RevisionRow } from '../product/bom/store'
import { readSteps } from '../product/routing/read'
import { processCostingInputs } from './inputs'

/**
 * What a cost sheet is computed from, read with one client (no relation selects: inside a transaction Prisma would send
 * them at once on its one connection): the style and the company it is costed for, the revision's BOM lines
 * (modules/product/bom) and routing steps (modules/product/routing), the materials with their standard purchase price
 * and when it was last set, the labour rates and overhead rules (./inputs). Who may see it: costing.view over the
 * style's company, and over the company asked for when the style is tenant-wide. Reads only.
 */

export const STYLE_COLUMNS = { id: true, code: true, name: true, companyId: true, status: true, sizes: true, baseSize: true } as const satisfies Prisma.StyleSelect
export type CostingStyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_COLUMNS }>

const MATERIAL_COLUMNS = {
  id: true,
  code: true,
  name: true,
  kind: true,
  baseUom: true,
  purchaseUom: true,
  purchaseFactor: true,
  consumptionUom: true,
  consumptionFactor: true,
  standardCost: true,
  currency: true,
  updatedAt: true,
} as const satisfies Prisma.ItemSelect

const text = (value: { toString(): string }): string => decimalText(value.toString())

/** The style as the caller may see its cost; another company's (outside the caller's grants) or another tenant's is not found. */
export async function readStyleFor(caller: CommandCaller, styleId: string): Promise<CostingStyleRow> {
  const context = contextOf(caller)
  if (!isUuid(styleId)) throw new NotFoundError('Style not found.')
  const row = await caller.withClient((client) => client.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS }))
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Style not found.')
  return row
}

/** The company a sheet is costed for, with its currency: the style's own; for a tenant-wide style the one asked for, or none. */
export interface CostingCompany {
  readonly id: string | null
  readonly currency: string
}

export async function companyFor(caller: CommandCaller, style: CostingStyleRow, asked: string | undefined, path: string): Promise<CostingCompany> {
  const context = contextOf(caller)
  if (style.companyId !== null && asked !== undefined && asked !== style.companyId) {
    throw new ValidationError('The cost sheet is not valid.', [{ path, message: "This style belongs to one company: its cost is that company's." }])
  }
  const companyId = style.companyId ?? asked ?? null
  if (companyId === null) return { id: null, currency: costingCurrency(null) }
  const row = await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true, currency: true } }))
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  return { id: row.id, currency: costingCurrency(row.currency) }
}

export { findRevision, type RevisionRow }

/**
 * When each material's standard price was last set: the newest audit row of the material that wrote its standard cost
 * (a create, the cost route, a base-unit change, an import); else the material's last change (a seeded row has no audit
 * row; its price is no newer than that).
 */
async function priceDates(client: FactoryClient | CommandTx, itemIds: readonly string[]): Promise<Map<string, Date>> {
  if (itemIds.length === 0) return new Map()
  const rows = await client.$queryRaw<{ recordId: string; at: Date }[]>`
    SELECT DISTINCT ON ("recordId") "recordId"::text AS "recordId", "at"
    FROM "AuditLog"
    WHERE "recordType" = 'Item' AND "recordId" = ANY(${[...itemIds]}::uuid[]) AND ("after" -> 'standardCost') IS NOT NULL
    ORDER BY "recordId", "at" DESC`
  return new Map(rows.map((row) => [row.recordId, row.at]))
}

/** The materials these lines name, as costing reads them. */
export async function readCostingMaterials(client: FactoryClient | CommandTx, itemIds: readonly string[]): Promise<Map<string, CostingMaterial>> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return new Map()
  const rows = await client.item.findMany({ where: { id: { in: ids } }, select: MATERIAL_COLUMNS })
  const dates = await priceDates(client, ids)
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        code: row.code,
        name: row.name,
        // W2a wave 5: never FINISHED here (a finished garment's item is no material, and no BOM line names one: …_production_w2a_guards).
        kind: row.kind as CostingMaterial['kind'],
        units: { baseUom: row.baseUom, purchaseUom: row.purchaseUom, purchaseFactor: text(row.purchaseFactor), consumptionUom: row.consumptionUom, consumptionFactor: text(row.consumptionFactor) },
        standardCost: row.standardCost === null ? null : text(row.standardCost),
        currency: row.currency,
        priceAsOf: row.standardCost === null ? null : toUtcIso(dates.get(row.id) ?? row.updatedAt),
      },
    ]),
  )
}

/** Everything one revision's sheet is computed from, and the active colourways it is costed in. */
export interface LoadedCost {
  readonly facts: CostFacts
  readonly colourways: readonly { readonly id: string; readonly code: string; readonly name: string }[]
}

export async function loadCostFacts(client: FactoryClient | CommandTx, style: CostingStyleRow, revision: RevisionRow, company: CostingCompany, now: Date): Promise<LoadedCost> {
  const all = await readColourways(client, style.id)
  const colourways = all.filter((colourway) => colourway.status === 'ACTIVE')
  const lines = await readLines(client, revision.id, { sizes: style.sizes, colourwayIds: all.map((colourway) => colourway.id) })
  const materials = await readCostingMaterials(client, lines.map((line) => line.itemId))
  const steps = await readSteps(client, revision.id)
  const inputs = processCostingInputs()
  const rates = await inputs.labourRates(client, company.id)
  const overheads = await inputs.overheadRules(client, company.id)
  return {
    colourways: colourways.map((colourway) => ({ id: colourway.id, code: colourway.code, name: colourway.name })),
    facts: {
      currency: company.currency,
      companyId: company.id,
      on: businessDate(now),
      sizes: [...style.sizes],
      colourwayIds: colourways.map((colourway) => colourway.id),
      lines,
      materials,
      steps: steps.map((step) => ({ id: step.id, workCentreKind: step.workCentreKind, standardMinutes: step.standardMinutes })),
      rates,
      overheads,
    },
  }
}
