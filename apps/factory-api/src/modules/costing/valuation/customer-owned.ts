import type { ValuationRowView } from '@nexus/factory-domain/costing/valuation/contracts'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { unique, type Reader } from '../actual/store'

/**
 * A customer's own material is never valued (B-W2b-407; FIN-045: brand-supplied leather for cut-make-trim orders is
 * tracked, never valued in our stock, and only our labour and trims are billed; the guard of W2b-5, B-W2b-309, holds it
 * in stock: a CUSTOMER_SUPPLIED receipt's lots carry Lot.ownerPartyId and their moves are never valued). This holds it in
 * costing and margins, from one place:
 *
 *   ownedLots              which lots are a customer's own (and whose): cost of goods sold costs their garments at
 *                          nothing, landed cost never lands on them, a purchase price variance is never taken on them
 *                          (the database refuses each too)
 *   markCustomerOwned      the stock valuation's rows of such lots: their quantity stays (it is tracked), their value is
 *                          none, and they are no "move without a cost" (nothing is missing: nothing is to be valued)
 * The cost sheet already leaves a customer-supplied BOM line out of the standard (B-W2b-228) and the work-order ledger
 * never costs an issue of such a lot (B-W2b-309), so margins hold it out by themselves.
 */

/** The customer's own lots among these (lot → its owner, the customer). */
export async function ownedLots(db: Reader, lotIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = unique(lotIds)
  if (ids.length === 0) return new Map()
  const rows = await db.lot.findMany({ where: { id: { in: ids }, ownerPartyId: { not: null } }, select: { id: true, ownerPartyId: true } })
  return new Map(rows.map((row) => [row.id, row.ownerPartyId!]))
}

/** The words of a customer's own lot in the valuation. */
const ownedWords = (customer: string): string =>
  `${customer}'s own material, sent for their orders (cut-make-trim): tracked by quantity, never valued in our stock.`

/** The valuation rows with a customer's own lots marked: no value, nothing missing, the customer named. */
export async function markCustomerOwned(db: Reader, rows: readonly ValuationRowView[]): Promise<{ rows: ValuationRowView[]; owned: number }> {
  const owned = await ownedLots(db, rows.map((row) => row.lot?.id ?? null))
  if (owned.size === 0) return { rows: [...rows], owned: 0 }
  const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(owned.values())] } }, select: { id: true, legalName: true, tradeName: true } })).map((row) => [row.id, row.tradeName ?? row.legalName]))
  let count = 0
  const marked = rows.map((row) => {
    const owner = row.lot ? owned.get(row.lot.id) : undefined
    if (!owner) return row
    count += 1
    const name = parties.get(owner) ?? ''
    return { ...row, value: asMoney('cost', 0), unitCost: asMoney('cost', null), unvaluedMoves: 0, dependsOnMethod: false, customerOwned: { id: owner, name }, words: ownedWords(name) }
  })
  return { rows: marked, owned: count }
}
