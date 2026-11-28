import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { componentsOf, type ComponentLine, type MissingComponent } from '@nexus/factory-domain/costing/sheet-components/components'
import { splitBySize } from '@nexus/factory-domain/costing/sheet-components/split'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'
import { rulesInForce, settingsRowsFor } from '../../sales/quotes/rules'
import { loadComponentFacts } from '../sheet-components/store'
import type { CostingStyleRow, RevisionRow } from '../store'

/**
 * owb-pd3 (S4) — the reads price against cost and Keep share, so both count with ONE number:
 *   costNowOf   the cost of one piece now, in the style's base size (else its first size), for one company: the revision's live
 *               components (B-W2b-418's computation, the same one Keep writes as a cost sheet version); a part missing → no total
 *   keptOf      the kept standard cost: the dearest FROZEN StandardCost in force today of the style's finished items for the
 *               company, in EUR (what owb-pd1's list margin reads as KEPT), with its number and the day it was kept
 *   targetOf    the margin target: SalesSettings.marginFloorPct of the company (its own row, else the tenant's), as data
 */

type Reader = FactoryClient | CommandTx
const text = (value: { toString(): string }): string => decimalText(value.toString())

export interface CostNow {
  readonly baseSize: string | null
  readonly colourwayId: string
  readonly colourwayCode: string
  readonly lines: readonly ComponentLine[]
  readonly missing: readonly MissingComponent[]
  /** The base size's cost of one piece (six decimals); null while a part is missing. */
  readonly total: string | null
  readonly computed: ReturnType<typeof componentsOf>
  readonly on: BusinessDate
  readonly pieceRateSiteId: string | null
}

export async function costNowOf(db: Reader, style: CostingStyleRow, revision: RevisionRow, company: { readonly id: string; readonly currency: string }, on: BusinessDate): Promise<CostNow> {
  const loaded = await loadComponentFacts(db, style, revision, company, on, {})
  const computed = componentsOf(loaded.facts)
  const baseSize = style.baseSize ?? style.sizes[0] ?? null
  const split = baseSize === null ? [] : splitBySize(computed.lines, style.sizes, computed.missing)
  const cell = split.find((entry) => entry.size === baseSize)
  return {
    baseSize,
    colourwayId: loaded.colourway.id,
    colourwayCode: loaded.colourway.code,
    lines: computed.lines,
    missing: computed.missing,
    total: cell && cell.complete && cell.total !== null ? cell.total : null,
    computed,
    on,
    pieceRateSiteId: loaded.pieceRate.siteId,
  }
}

export interface KeptCost {
  readonly amount: string
  readonly version: number
  readonly keptAt: string
  readonly standardId: string
}

const dayValue = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

/** The finished items of a style (its SKUs' FINISHED items). */
export async function finishedItemsOf(db: Reader, styleId: string): Promise<{ id: string; variantId: string | null }[]> {
  const variants = await db.variant.findMany({ where: { styleId }, select: { id: true } })
  if (variants.length === 0) return []
  return db.item.findMany({ where: { variantId: { in: variants.map((variant) => variant.id) }, kind: 'FINISHED' }, select: { id: true, variantId: true } })
}

/** The kept standard cost of a style for a company on a day (see the module comment); null: none kept. */
export async function keptOf(db: Reader, styleId: string, companyId: string, day: BusinessDate): Promise<KeptCost | null> {
  const items = await finishedItemsOf(db, styleId)
  if (items.length === 0) return null
  const on = dayValue(day)
  const standards = await db.standardCost.findMany({
    where: { companyId, itemId: { in: items.map((item) => item.id) }, status: 'FROZEN', currency: 'EUR', validFrom: { lte: on }, OR: [{ validTo: null }, { validTo: { gte: on } }] },
    select: { id: true, itemId: true, unitCost: true, frozenAt: true, validFrom: true, breakdown: true },
  })
  if (standards.length === 0) return null
  const dearest = standards.reduce((top, row) => (new Dec(row.unitCost.toString()).gt(new Dec(top.unitCost.toString())) ? row : top))
  return { amount: text(dearest.unitCost), version: await numberOf(db, dearest, companyId), keptAt: (dearest.frozenAt ?? dearest.validFrom).toISOString(), standardId: dearest.id }
}

/** A kept standard's number: the cost sheet version Keep wrote it from, else how many frozen standards of the item came before, plus one. */
async function numberOf(db: Reader, row: { readonly itemId: string; readonly validFrom: Date; readonly breakdown: Prisma.JsonValue | null }, companyId: string): Promise<number> {
  const breakdown = row.breakdown && typeof row.breakdown === 'object' && !Array.isArray(row.breakdown) ? (row.breakdown as Record<string, unknown>) : null
  if (breakdown && typeof breakdown.sheetVersion === 'number') return breakdown.sheetVersion
  return (await db.standardCost.count({ where: { companyId, itemId: row.itemId, status: 'FROZEN', validFrom: { lt: row.validFrom } } })) + 1
}

/** The margin target of a company, a share of the price (0 when nothing is set). */
export async function targetOf(db: Reader, companyId: string): Promise<string> {
  return rulesInForce(await settingsRowsFor(db, companyId), companyId).marginFloorPct
}
