import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { holds, NO_ROWS, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { PriceAgainstCostQuery, PriceAgainstCostView } from '@nexus/factory-domain/costing/keep/contracts'
import { earnedOf, flagOf, floorPriceOf, marginPctOf, PRICE_AGAINST_COST_CURRENCY } from '@nexus/factory-domain/costing/keep/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { PRICE_LISTS_VIEW } from '@nexus/factory-domain/sales/pricelists/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf, findRevision } from '../../product/bom/store'
import { companyFor, readStyleFor } from '../store'
import { costNowOf, keptOf, targetOf } from './store'

/**
 * owb-pd3 step 3.1 (S4; design plan § 5zh "Price against cost"; brief owb-pd-server.md § Shape "pd3") — GET
 * /costing/styles/:styleId/price-against-cost?revisionId=: one row for each agreed price of the product — each entry of a CUSTOMER
 * price list in force today (ACTIVE list and version, the entry's own days) for each customer priced from that list, the entry's
 * price (from 1 piece) and each of its quantity breaks (its own price, or the version's discount on the entry's price) — against
 * ONE cost: the kept standard cost (the dearest frozen StandardCost in force of the product's finished items), else the cost now
 * (the revision's live components, base size). What it earns, the margin (a share of the PRICE), the flag against the company's
 * target (SalesSettings.marginFloorPct), and the lowest price that keeps the target. EUR only (R58 a): a list in another currency
 * keeps its rows without a cost. Who: costing.view over the style's company (the brand wall: another customer's private-label
 * product is not found), and the price, cost and margin grains (403 in words otherwise); the lists through pricelists.view.
 */

type Reader = FactoryClient | CommandTx
const text = (value: { toString(): string }): string => decimalText(value.toString())
const dayValue = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)
const inForceOn = (day: Date) => ({ AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: day } }] }, { OR: [{ validTo: null }, { validTo: { gte: day } }] }] })
const LIST_SCOPE = { company: { field: 'companyId', nullable: true } } as const
const PARTY_SCOPE = { party: 'id' } as const

/** The grains this read needs, all three: a price, a cost and what one earns over the other. */
export const PRICE_AGAINST_COST_GRAINS = ['money.price', 'money.cost', 'money.margin'] as const
export const NO_GRAINS_WORDS = 'Prices against costs need the price, the cost and the margin right.'

interface AgreedRow {
  readonly customer: { readonly id: string; readonly code: string; readonly name: string }
  readonly material: string | null
  readonly minQty: number
  readonly price: string
  readonly currency: string
}

/** Each agreed price of the style in force on a day, for each customer priced from its list (see the module comment). */
export async function agreedPricesOf(db: Reader, actor: Actor, styleId: string, day: BusinessDate): Promise<AgreedRow[]> {
  const lists = scopeWhere(actor, PRICE_LISTS_VIEW, LIST_SCOPE)
  if (lists === NO_ROWS) return []
  const on = dayValue(day)
  const entries = await db.priceListEntry.findMany({
    where: {
      styleId,
      ...inForceOn(on),
      listVersion: { is: { status: 'ACTIVE', AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: on } }] }, { OR: [{ validTo: null }, { validTo: { gte: on } }] }], list: { is: { AND: [lists as Prisma.PriceListWhereInput, { kind: 'CUSTOMER', status: 'ACTIVE' }] } } } },
    },
    select: {
      id: true,
      colourwayId: true,
      unitPrice: true,
      breaks: { select: { minQuantity: true, unitPrice: true, discountPct: true }, orderBy: { minQuantity: 'asc' } },
      listVersion: { select: { breaks: { where: { entryId: null }, select: { minQuantity: true, discountPct: true }, orderBy: { minQuantity: 'asc' } }, list: { select: { id: true, currency: true } } } },
    },
  })
  if (entries.length === 0) return []
  const listIds = [...new Set(entries.map((entry) => entry.listVersion.list.id))]
  const parties = scopeWhere(actor, PRICE_LISTS_VIEW, PARTY_SCOPE)
  const customers = parties === NO_ROWS ? [] : await db.party.findMany({ where: { AND: [parties as Prisma.PartyWhereInput, { priceListId: { in: listIds }, status: 'ACTIVE' }] }, select: { id: true, code: true, legalName: true, tradeName: true, priceListId: true }, orderBy: { code: 'asc' } })
  const colourwayIds = [...new Set(entries.flatMap((entry) => (entry.colourwayId ? [entry.colourwayId] : [])))]
  const colourways = new Map((colourwayIds.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]))
  const rows: AgreedRow[] = []
  for (const entry of entries) {
    const price = new Dec(entry.unitPrice.toString())
    const steps: { minQty: number; price: string }[] = [{ minQty: 1, price: text(price) }]
    for (const step of entry.breaks) if (step.unitPrice !== null) steps.push({ minQty: step.minQuantity, price: text(step.unitPrice) })
    for (const step of entry.listVersion.breaks) {
      if (step.discountPct === null || steps.some((own) => own.minQty === step.minQuantity)) continue
      steps.push({ minQty: step.minQuantity, price: text(price.times(new Dec(1).minus(new Dec(step.discountPct.toString()).dividedBy(100))).toDecimalPlaces(6)) })
    }
    const material = entry.colourwayId ? (colourways.get(entry.colourwayId) ?? null) : null
    for (const customer of customers.filter((party) => party.priceListId === entry.listVersion.list.id)) {
      for (const step of steps.sort((a, b) => a.minQty - b.minQty)) {
        rows.push({ customer: { id: customer.id, code: customer.code, name: customer.tradeName?.trim() || customer.legalName }, material, minQty: step.minQty, price: step.price, currency: entry.listVersion.list.currency })
      }
    }
  }
  return rows.sort((a, b) => (a.customer.code < b.customer.code ? -1 : a.customer.code > b.customer.code ? 1 : (a.material ?? '') < (b.material ?? '') ? -1 : (a.material ?? '') > (b.material ?? '') ? 1 : a.minQty - b.minQty))
}

export async function priceAgainstCost(caller: CommandCaller, styleId: string, query: PriceAgainstCostQuery): Promise<PriceAgainstCostView> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const style = await readStyleFor(caller, styleId)
  if (!PRICE_AGAINST_COST_GRAINS.every((grain) => holds(actor, grain))) throw new ForbiddenError(NO_GRAINS_WORDS)
  // A tenant-wide product is costed for the company the page works in.
  const asked = style.companyId === null && context.audience === 'office' ? context.companyId : undefined
  const company = await companyFor(caller, style, asked, 'querystring/companyId')
  const day = businessDate(serverClock.now())
  return caller.withClient(async (db) => {
    const revision = await findRevision(db, styleId, query.revisionId)
    const euro = company.id !== null && company.currency === PRICE_AGAINST_COST_CURRENCY
    const now = euro ? await costNowOf(db, style, revision, { id: company.id!, currency: company.currency }, day) : null
    const kept = euro ? await keptOf(db, styleId, company.id!, day) : null
    const targetPct = company.id !== null ? await targetOf(db, company.id) : '0'
    const costNow = now?.total ?? null
    const basis = kept?.amount ?? costNow
    const agreed = await agreedPricesOf(db, actor, styleId, day)
    return {
      currency: PRICE_AGAINST_COST_CURRENCY,
      targetPct,
      costNow: asMoney('cost', costNow),
      kept: kept ? { amount: asMoney('cost', kept.amount), version: kept.version, keptAt: kept.keptAt } : null,
      rows: agreed.map((row) => {
        const cost = row.currency === PRICE_AGAINST_COST_CURRENCY ? basis : null
        const marginPct = marginPctOf(row.price, cost)
        return {
          customer: row.customer,
          material: row.material,
          minQty: row.minQty,
          price: asMoney('price', row.price),
          cost: asMoney('cost', cost),
          earned: asMoney('margin', earnedOf(row.price, cost)),
          marginPct: asMoney('margin', marginPct),
          flag: flagOf(marginPct, targetPct),
        }
      }),
      lowestPriceForTarget: asMoney('cost', floorPriceOf(basis, targetPct)),
    }
  })
}
