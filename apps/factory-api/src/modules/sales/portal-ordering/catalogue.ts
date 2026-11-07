import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { priceFrom } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { mayOffer, offeredSizes, type LineFacts } from '@nexus/factory-domain/sales/portal-ordering/rules'
import type { CatalogueEntry } from '@nexus/factory-domain/sales/portal-ordering/upload'
import type { ReorderFacts } from '@nexus/factory-domain/sales/portal-ordering/reorder'
import type { CommandTx } from '../../../core/command'
import { priceChainOf, type PriceChain } from '../pricelists/store'

/**
 * The customer's catalogue (B-W2b-190, SAL-071; design portal.customer.catalogue "Only the styles this customer may buy,
 * with their prices"): read in the tenant's scope as the portal person (styles, colourways, variants and price lists are
 * the office's tables; the partner role reads none of them), for ONE customer of ONE company on one day.
 *
 *   prices     the customer's price list chain (sales/pricelists priceChainOf, as quotes and orders read it): the list
 *              its assignment in force names (PartyPriceListAssignment, B-W2b-03; else Party.priceListId), the lists
 *              it falls back to, else the company's BASE list; a colourway's own price, else the style's
 *   styles     a style the chain prices, ACTIVE, of the company (or every company), the open range or the customer's
 *              own label (factory-domain sales/portal-ordering mayOffer)
 *   colourways a colourway is available when ACTIVE, priced, and it offers at least one size (an ACTIVE variant); a
 *              style is in the catalogue when one of its colourways is available
 *
 * `facts` answers any style and colourway (a draft's line, an old order's line): in the catalogue or not, with its code.
 */

export interface CatalogueColourway {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly available: boolean
  readonly offered: readonly string[]
  /** The customer's net price (list rounding); null: no list prices it. */
  readonly price: string | null
}

export interface CatalogueStyle {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly nameI18n: { readonly it?: string; readonly en?: string } | null
  readonly description: string | null
  readonly productType: string
  readonly season: string | null
  readonly ownLabel: boolean
  readonly range: readonly string[]
  readonly baseSize: string | null
  readonly ppeCategory: string
  readonly ppeStandard: string | null
  readonly ppeClass: string | null
  readonly revisionNow: number | null
  readonly colourways: readonly CatalogueColourway[]
}

export interface CustomerCatalogue {
  readonly currency: string
  readonly chain: PriceChain
  /** Styles in the catalogue (at least one colourway available), by id. */
  readonly styles: ReadonlyMap<string, CatalogueStyle>
  /** Every style asked for, sold or not: id → code (for words about a style no longer sold). */
  readonly codes: ReadonlyMap<string, { readonly code: string; readonly name: string }>
  /** Colourways of every style asked for: id → its style, code, name. */
  readonly colourways: ReadonlyMap<string, { readonly styleId: string; readonly code: string; readonly name: string }>
}

const dayValue = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

/** The list the customer is priced from today: its assignment in force, else the party's list. */
async function partyListOf(db: FactoryClient | CommandTx, partyId: string, day: BusinessDate): Promise<string | null> {
  const at = dayValue(day)
  const assigned = await db.partyPriceListAssignment.findFirst({ where: { partyId, validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gte: at } }] }, orderBy: { validFrom: 'desc' }, select: { priceListId: true } })
  if (assigned) return assigned.priceListId
  return (await db.party.findUnique({ where: { id: partyId }, select: { priceListId: true } }))?.priceListId ?? null
}

const STYLE_SELECT = {
  id: true,
  code: true,
  name: true,
  nameI18n: true,
  description: true,
  productType: true,
  season: true,
  status: true,
  companyId: true,
  brandPartyId: true,
  sizes: true,
  baseSize: true,
  ppeCategory: true,
  ppeStandard: true,
  ppeClass: true,
  colourways: { select: { id: true, code: true, name: true, status: true }, orderBy: { code: 'asc' } },
} as const satisfies Prisma.StyleSelect

/**
 * The catalogue of a customer of a company on a day. `styleIds`: only these styles (a draft's, an order's); undefined:
 * every style the chain prices.
 */
export async function readCatalogue(db: FactoryClient | CommandTx, input: { readonly companyId: string; readonly partyId: string; readonly day: BusinessDate; readonly styleIds?: readonly string[] }): Promise<CustomerCatalogue> {
  const company = await db.company.findUnique({ where: { id: input.companyId }, select: { currency: true } })
  const currency = company?.currency ?? 'EUR'
  const chain = await priceChainOf(db, { companyId: input.companyId, currency, partyListId: await partyListOf(db, input.partyId, input.day), pinnedVersionId: null, day: input.day, styleIds: input.styleIds })
  const priced = new Set(chain.levels.flatMap((level) => (level.versionId === null ? [] : level.entries.map((entry) => entry.styleId))))
  const wanted = input.styleIds ? [...new Set(input.styleIds)] : [...priced]
  const rows = wanted.length === 0 ? [] : await db.style.findMany({ where: { id: { in: wanted } }, select: STYLE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const offered = rows.filter((row) => priced.has(row.id) && mayOffer({ status: row.status, companyId: row.companyId, brandPartyId: row.brandPartyId }, input.partyId, input.companyId))
  const ids = offered.map((row) => row.id)
  const variants = ids.length === 0 ? [] : await db.variant.findMany({ where: { styleId: { in: ids }, status: 'ACTIVE' }, select: { styleId: true, colourwayId: true, size: true } })
  const revisions = ids.length === 0 ? [] : await db.styleRevision.findMany({ where: { styleId: { in: ids }, status: 'RELEASED' }, select: { styleId: true, revision: true }, orderBy: { revision: 'desc' } })
  const styles = new Map<string, CatalogueStyle>()
  for (const row of offered) {
    const colourways = row.colourways.map((colourway) => {
      const sizes = offeredSizes(row.sizes, variants.filter((variant) => variant.styleId === row.id && variant.colourwayId === colourway.id).map((variant) => variant.size))
      const price = priceFrom(chain.levels, row.id, colourway.id)?.unitPrice ?? null
      return { id: colourway.id, code: colourway.code, name: colourway.name, available: colourway.status === 'ACTIVE' && price !== null && sizes.length > 0, offered: sizes, price }
    })
    if (!colourways.some((colourway) => colourway.available)) continue
    styles.set(row.id, {
      id: row.id,
      code: row.code,
      name: row.name,
      nameI18n: (row.nameI18n ?? null) as CatalogueStyle['nameI18n'],
      description: row.description,
      productType: row.productType,
      season: row.season,
      ownLabel: row.brandPartyId === input.partyId,
      range: row.sizes,
      baseSize: row.baseSize,
      ppeCategory: row.ppeCategory,
      ppeStandard: row.ppeStandard,
      ppeClass: row.ppeClass,
      revisionNow: revisions.find((revision) => revision.styleId === row.id)?.revision ?? null,
      colourways,
    })
  }
  return {
    currency,
    chain,
    styles,
    codes: new Map(rows.map((row) => [row.id, { code: row.code, name: row.name }])),
    colourways: new Map(rows.flatMap((row) => row.colourways.map((colourway) => [colourway.id, { styleId: row.id, code: colourway.code, name: colourway.name }] as const))),
  }
}

/** A line's facts as the catalogue holds them today (null: the style is unknown). */
export function factsOf(catalogue: CustomerCatalogue, styleId: string, colourwayId: string): ReorderFacts | null {
  const style = catalogue.styles.get(styleId)
  const code = catalogue.codes.get(styleId)
  if (!style) {
    if (!code) return null
    const colourway = catalogue.colourways.get(colourwayId)
    return { styleCode: code.code, sold: false, colourwayName: colourway?.name ?? '', colourwayActive: false, offered: [], priceNow: null, revisionNow: null }
  }
  const colourway = style.colourways.find((entry) => entry.id === colourwayId)
  const facts: LineFacts = {
    styleCode: style.code,
    sold: true,
    colourwayName: colourway?.name ?? catalogue.colourways.get(colourwayId)?.name ?? '',
    colourwayActive: colourway?.available ?? false,
    offered: colourway?.offered ?? [],
    priceNow: colourway?.available ? colourway.price : null,
  }
  return { ...facts, revisionNow: style.revisionNow }
}

/** The catalogue as the upload's check reads it: by style code (upper case), available colourways only. */
export function uploadIndexOf(catalogue: CustomerCatalogue): Map<string, CatalogueEntry> {
  return new Map(
    [...catalogue.styles.values()].map((style) => [
      style.code.toUpperCase(),
      { styleId: style.id, styleCode: style.code, colourways: style.colourways.filter((colourway) => colourway.available).map((colourway) => ({ id: colourway.id, code: colourway.code, name: colourway.name, offered: colourway.offered })) },
    ]),
  )
}
