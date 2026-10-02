/**
 * S1 (MCP full control, section 08 §1.4 F10) — the unit cost of a DRAFT purchase-order line, in the PO's currency.
 *
 * The replenishment drafts (one product, or a selection grouped per supplier) wrote every line at cost 0, so a drafted
 * PO showed no value and its total never met the approval threshold. A line now carries the supplier's own price for
 * the product when that price is in the PO's currency (the supplier's default, else the master currency), else the
 * product's cost price when the PO is in the master currency; 0 only when neither is known. Two currencies are never
 * mixed in one PO.
 */
import prisma from '../../db.js'
import { masterCurrency } from '../fx-rate.service.js'

export interface DraftLineCosts {
  /** The PO's currency: the supplier's default, else the master currency. */
  currencyCode: string
  /** Unit cost in cents, in `currencyCode`, for one product of the draft. */
  costOf: (productId: string) => number
}

export async function draftLineCosts(supplierId: string | null, productIds: string[]): Promise<DraftLineCosts> {
  const master = masterCurrency()
  const supplier = supplierId ? await prisma.supplier.findUnique({ where: { id: supplierId }, select: { defaultCurrency: true } }) : null
  const currencyCode = (supplier?.defaultCurrency ?? master).toUpperCase()
  const [offers, products] = await Promise.all([
    supplierId
      ? prisma.supplierProduct.findMany({ where: { supplierId, productId: { in: productIds } }, select: { productId: true, costCents: true, currencyCode: true } })
      : Promise.resolve([] as Array<{ productId: string; costCents: number | null; currencyCode: string | null }>),
    prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, costPrice: true } }),
  ])
  const supplierCost = new Map<string, number>()
  for (const o of offers) {
    if (o.costCents != null && (o.currencyCode ?? currencyCode).toUpperCase() === currencyCode) supplierCost.set(o.productId, o.costCents)
  }
  const masterCost = new Map<string, number>()
  if (currencyCode === master) {
    for (const p of products) if (p.costPrice != null) masterCost.set(p.id, Math.round(Number(p.costPrice) * 100))
  }
  return { currencyCode, costOf: (productId) => supplierCost.get(productId) ?? masterCost.get(productId) ?? 0 }
}
