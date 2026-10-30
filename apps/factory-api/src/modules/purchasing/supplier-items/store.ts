import type { Prisma } from '@nexus/factory-db'
import { grantsFor, can, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalText, type Uom } from '@nexus/factory-domain/product/units/units'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_SOURCES_MANAGE } from '@nexus/factory-domain/purchasing/sources/permissions'
import { factorOf, type SourceFacts, type SourcePreference, type SourceStatus } from '@nexus/factory-domain/purchasing/sources/sources'
import { dayOf, decimal, ITEM_COLUMNS, unitsOf, type ItemRow, type Reader } from '../store'

/**
 * Approved sources as purchasing reads them (factory-db sourcing.prisma SupplierItem; B-W2a-10): the columns every read
 * names, the rules' facts of a row, the ACTIVE sources of some materials (whoever asks: which supplier is approved for a
 * material does not depend on the caller's scope), who may keep one, and the view the routes answer with its material,
 * colour, supplier, company and last purchase. Prices are costs (marked money.cost).
 */

export const SOURCE_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  itemId: true,
  itemColourId: true,
  supplierArticleCode: true,
  supplierColourCode: true,
  description: true,
  purchaseUom: true,
  purchaseFactor: true,
  unitPrice: true,
  currency: true,
  minOrderQty: true,
  orderMultiple: true,
  leadTimeDays: true,
  preference: true,
  status: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.SupplierItemSelect
export type SourceRow = Prisma.SupplierItemGetPayload<{ select: typeof SOURCE_COLUMNS }>

/** A row as the domain rules read it. */
export const factsOf = (row: SourceRow): SourceFacts => ({
  id: row.id,
  companyId: row.companyId,
  partyId: row.partyId,
  itemId: row.itemId,
  itemColourId: row.itemColourId,
  preference: row.preference as SourcePreference,
  status: row.status as SourceStatus,
  purchaseUom: row.purchaseUom as Uom,
  unitPrice: decimal(row.unitPrice),
  currency: row.currency,
  minOrderQty: decimal(row.minOrderQty),
  orderMultiple: decimal(row.orderMultiple),
  leadTimeDays: row.leadTimeDays,
  supplierArticleCode: row.supplierArticleCode,
  supplierColourCode: row.supplierColourCode,
})

/** Every source of one material (any status), for the one-each rules. */
export const sourcesOfItem = (db: Reader, itemId: string): Promise<SourceRow[]> => db.supplierItem.findMany({ where: { itemId }, select: SOURCE_COLUMNS, orderBy: { id: 'asc' } })

/** The ACTIVE sources of these materials, as facts. */
export async function activeSourcesOf(db: Reader, itemIds: readonly string[]): Promise<SourceFacts[]> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return []
  return (await db.supplierItem.findMany({ where: { itemId: { in: ids }, status: 'ACTIVE' }, select: SOURCE_COLUMNS, orderBy: { id: 'asc' } })).map(factsOf)
}

/**
 * May the actor keep a source of this scope? One company's source: a grant over that company (and the supplier). A source
 * for every company is shared by all of them, so only a grant that reaches every company keeps it.
 */
export function mayKeep(actor: Actor, scope: { readonly companyId: string | null; readonly partyId: string }): boolean {
  if (scope.companyId !== null) return can(actor, PURCHASING_SOURCES_MANAGE, { companyId: scope.companyId, partyId: scope.partyId })
  return can(actor, PURCHASING_SOURCES_MANAGE, { partyId: scope.partyId }) && grantsFor(actor, PURCHASING_SOURCES_MANAGE).some((grant) => grant.companies === 'all' && (grant.parties === 'all' || grant.parties.includes(scope.partyId)))
}

/** One lock per material: the one-each rules (a duplicate, two primaries) hold under it. */
export const lockSourcesOf = (tx: Prisma.TransactionClient, tenantId: string, itemId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.supplier-item', ${tenantId}::uuid, ${itemId}::uuid), 0))`

// ---- the view ---------------------------------------------------------------------------------------------------------

interface LastPurchase {
  readonly partyId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly purchaseOrderId: string
  readonly number: string
  readonly status: string
  readonly orderDate: Date
  readonly quantity: Prisma.Decimal
  readonly uom: string
  readonly unitPrice: Prisma.Decimal
  readonly currency: string
}

/** The latest sent purchase order line per supplier, material and colour (one query, the newest first). */
async function lastPurchasesOf(db: Reader, rows: readonly SourceRow[]): Promise<LastPurchase[]> {
  const partyIds = [...new Set(rows.map((row) => row.partyId))]
  const itemIds = [...new Set(rows.map((row) => row.itemId))]
  if (partyIds.length === 0) return []
  return db.$queryRaw<LastPurchase[]>`
    SELECT DISTINCT ON (l."partyId", l."itemId", l."itemColourId")
           l."partyId", l."itemId", l."itemColourId", o.id AS "purchaseOrderId", o.number, o.status::text AS status, o."orderDate",
           l.quantity, l.uom::text AS uom, l."unitPrice", o.currency
      FROM "PurchaseOrderLine" l JOIN "PurchaseOrder" o ON o.id = l."purchaseOrderId"
     WHERE l."partyId" = ANY(${partyIds}::uuid[]) AND l."itemId" = ANY(${itemIds}::uuid[]) AND o.status NOT IN ('DRAFT', 'CANCELLED')
     ORDER BY l."partyId", l."itemId", l."itemColourId", o."orderDate" DESC, o."sentAt" DESC NULLS LAST, l.id DESC`
}

export type SourceView = Awaited<ReturnType<typeof sourceViews>>[number]

/** The rows as the routes answer them; the prices (the source's and the last purchase's) only for a caller with the cost grain. */
export async function sourceViews(db: Reader, rows: readonly SourceRow[], withCost: boolean) {
  const itemIds = [...new Set(rows.map((row) => row.itemId))]
  const colourIds = [...new Set(rows.flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))]
  const partyIds = [...new Set(rows.map((row) => row.partyId))]
  const companyIds = [...new Set(rows.flatMap((row) => (row.companyId ? [row.companyId] : [])))]
  const [items, colours, parties, companies, purchases] = [
    itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: ITEM_COLUMNS }),
    colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } }),
    partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, tradeName: true, status: true, leadTimeDays: true } }),
    companyIds.length === 0 ? [] : await db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, code: true, legalName: true, tradeName: true } }),
    await lastPurchasesOf(db, rows),
  ]
  const itemOf = new Map<string, ItemRow>(items.map((item) => [item.id, item]))
  const colourOf = new Map(colours.map((colour) => [colour.id, colour]))
  const partyOf = new Map(parties.map((party) => [party.id, party]))
  const companyOf = new Map(companies.map((company) => [company.id, company]))
  return rows.map((row) => {
    const item = itemOf.get(row.itemId)!
    const party = partyOf.get(row.partyId)!
    const company = row.companyId ? companyOf.get(row.companyId) : undefined
    const colour = row.itemColourId ? colourOf.get(row.itemColourId) : undefined
    const factor = factorOf(row.purchaseUom as Uom, unitsOf(item))
    const last = purchases
      .filter((line) => line.partyId === row.partyId && line.itemId === row.itemId && (row.itemColourId === null || line.itemColourId === row.itemColourId))
      .sort((a, b) => b.orderDate.getTime() - a.orderDate.getTime())[0]
    return {
      id: row.id,
      companyId: row.companyId,
      company: company ? { code: company.code, name: company.tradeName ?? company.legalName } : null,
      partyId: row.partyId,
      supplier: { code: party.code, name: party.tradeName ?? party.legalName, status: party.status },
      itemId: row.itemId,
      item: { code: item.code, name: item.name, kind: item.kind, status: item.status, baseUom: item.baseUom, purchaseUom: item.purchaseUom },
      itemColourId: row.itemColourId,
      colour: colour ? { code: colour.code, name: colour.name } : null,
      supplierArticleCode: row.supplierArticleCode,
      supplierColourCode: row.supplierColourCode,
      description: row.description,
      purchaseUom: row.purchaseUom,
      purchaseFactor: factor === null ? decimal(row.purchaseFactor)! : decimalText(factor),
      baseUom: item.baseUom,
      unitUsable: factor !== null,
      ...(withCost ? { unitPrice: asMoney('cost', decimal(row.unitPrice)) } : {}),
      currency: row.currency,
      minOrderQty: decimal(row.minOrderQty),
      orderMultiple: decimal(row.orderMultiple),
      leadTimeDays: row.leadTimeDays,
      supplierLeadTimeDays: party.leadTimeDays,
      preference: row.preference as SourcePreference,
      status: row.status as SourceStatus,
      note: row.note,
      lastPurchase: last
        ? {
            purchaseOrderId: last.purchaseOrderId,
            number: last.number,
            status: last.status as PurchaseOrderStatus,
            orderDate: dayOf(last.orderDate)!,
            quantity: decimal(last.quantity)!,
            uom: last.uom as Uom,
            ...(withCost ? { unitPrice: asMoney('cost', decimal(last.unitPrice)!) } : {}),
            currency: last.currency,
          }
        : null,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      updatedAt: toUtcIso(row.updatedAt),
      createdById: row.createdById,
    }
  })
}
