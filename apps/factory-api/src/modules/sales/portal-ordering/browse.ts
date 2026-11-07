import type { FastifyInstance, FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { lowestPrice, PPE_WORDS, priceShown, rangeLabel, type RangeFilter } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { appClock } from '../../../platform/portal/tasks/clock'
import { portalReader } from '../portal-orders/access'
import { readCatalogue, type CatalogueStyle } from './catalogue'

/**
 * The customer's catalogue in the portal (B-W2b-190, SAL-071; design portal.customer.catalogue "Styles you can buy",
 * filters and the style detail). Partner sessions with portal.catalogue.view; read in the tenant's scope as the person
 * (./catalogue). Prices only with the price grain (the contract marks them).
 *
 *   GET /portal/catalogue?q=&category=&season=&ppe=&range=   the styles you can buy: code, name, colours with their sizes,
 *                                                            the size range, the certificate class, your price ("from"),
 *                                                            own label or open range; the filters' values with counts
 *   GET /portal/catalogue/:styleId                           one style: colours, sizes per colour, price per colour, the
 *                                                            PPE category, standard and class, the revision it is made to
 */

type PpeCategory = keyof typeof PPE_WORDS

const ppeOf = (style: CatalogueStyle) => ({ category: style.ppeCategory, standard: style.ppeStandard, class: style.ppeClass, words: PPE_WORDS[style.ppeCategory as PpeCategory] ?? { it: style.ppeCategory, en: style.ppeCategory } })

function cardOf(style: CatalogueStyle) {
  const available = style.colourways.filter((colourway) => colourway.available)
  const sizes = style.range.filter((size) => available.some((colourway) => colourway.offered.includes(size)))
  return {
    id: style.id,
    code: style.code,
    name: style.name,
    nameI18n: style.nameI18n,
    productType: style.productType,
    season: style.season,
    ownLabel: style.ownLabel,
    colours: available.map((colourway) => ({ id: colourway.id, code: colourway.code, name: colourway.name })),
    sizes,
    range: rangeLabel(sizes),
    ppe: ppeOf(style),
    priceFrom: asMoney('price', lowestPrice(available.map((colourway) => colourway.price))),
  }
}

export interface CatalogueQuery {
  readonly q?: string | undefined
  readonly category?: string | undefined
  readonly season?: string | undefined
  readonly ppe?: string | undefined
  readonly range: RangeFilter
}

const count = (values: readonly (string | null)[]) => {
  const counts = new Map<string, number>()
  for (const value of values) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, n]) => ({ value, count: n }))
}

export async function browseCatalogue(app: FastifyInstance, request: FastifyRequest, query: CatalogueQuery) {
  const reader = portalReader(app, request)
  const now = appClock(app).now()
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: reader.session.company.id, partyId: reader.session.partyId, day: businessDate(now) }))
  const all = [...catalogue.styles.values()]
  const q = query.q?.trim().toLowerCase()
  const matches = all.filter((style) => {
    if (q && !`${style.code} ${style.name} ${style.nameI18n?.it ?? ''} ${style.nameI18n?.en ?? ''}`.toLowerCase().includes(q)) return false
    if (query.category && style.productType !== query.category) return false
    if (query.season && style.season !== query.season) return false
    if (query.ppe && style.ppeCategory !== query.ppe) return false
    if (query.range === 'OWN_LABEL' && !style.ownLabel) return false
    if (query.range === 'OPEN_RANGE' && style.ownLabel) return false
    return true
  })
  return {
    styles: matches.map(cardOf),
    count: matches.length,
    total: all.length,
    facets: {
      categories: count(all.map((style) => style.productType)),
      seasons: count(all.map((style) => style.season)),
      ppe: count(all.map((style) => style.ppeCategory)),
      ownLabel: all.filter((style) => style.ownLabel).length,
      openRange: all.filter((style) => !style.ownLabel).length,
    },
    currency: catalogue.currency,
    asOf: toUtcIso(now),
    seesPrices: reader.seesPrices,
  }
}

export async function catalogueStyle(app: FastifyInstance, request: FastifyRequest, styleId: string) {
  const reader = portalReader(app, request)
  if (!isUuid(styleId)) throw new NotFoundError('Style not found.')
  const now = appClock(app).now()
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: reader.session.company.id, partyId: reader.session.partyId, day: businessDate(now), styleIds: [styleId] }))
  const style = catalogue.styles.get(styleId)
  // Not in the customer's catalogue: the same answer as a style that does not exist.
  if (!style) throw new NotFoundError('Style not found.')
  return {
    style: {
      ...cardOf(style),
      description: style.description,
      baseSize: style.baseSize,
      revision: style.revisionNow,
      colourways: style.colourways
        .filter((colourway) => colourway.available)
        .map((colourway) => ({ id: colourway.id, code: colourway.code, name: colourway.name, sizes: style.range.map((size) => ({ size, offered: colourway.offered.includes(size) })), price: asMoney('price', colourway.price === null ? null : priceShown(colourway.price)) })),
    },
    currency: catalogue.currency,
    asOf: toUtcIso(now),
    seesPrices: reader.seesPrices,
  }
}
