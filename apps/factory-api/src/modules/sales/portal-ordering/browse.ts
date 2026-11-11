import type { FastifyInstance, FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PPE_CATEGORIES, type PpeCategory } from '@nexus/factory-domain/product/styles/rules'
import { lowestPrice, PPE_WORDS, priceShown, rangeLabel, type RangeFilter } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { appClock } from '../../../platform/portal/tasks/clock'
import { portalReader } from '../portal-orders/access'
import { readCatalogue, type CatalogueStyle } from './catalogue'
// B-W2b-227: a style's names and descriptions per language (StyleText) on the cards and in the search.
import { catalogueTextsOf, type CatalogueTexts } from '../../product/style-texts/texts'

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

/**
 * B-W2b-278 (FU4:04): the PPE words are looked up by the style's own codes (Style.ppeCategory: NOT_PPE, CATEGORY_I …, the
 * product rules' PPE_CATEGORIES), never through a cast to the table's keys: a table keyed by other codes (B-W2b-190's NONE /
 * CAT_I, which B-W2b-F17 put right in the table) no longer compiles, so the catalogue's words come from the API, not the code.
 */
const isPpeCategory = (code: string): code is PpeCategory => (PPE_CATEGORIES as readonly string[]).includes(code)
const ppeWordsOf = (code: string) => (isPpeCategory(code) ? PPE_WORDS[code] : { it: code, en: code })

const ppeOf = (style: CatalogueStyle) => ({ category: style.ppeCategory, standard: style.ppeStandard, class: style.ppeClass, words: ppeWordsOf(style.ppeCategory) })

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

/** B-W2b-227: the card's Italian and English names from the style's texts (W1's nameI18n where no text gives one). */
function withTexts<Card extends { nameI18n: CatalogueStyle['nameI18n'] }>(card: Card, texts: CatalogueTexts | undefined): Card {
  if (!texts || Object.keys(texts.nameI18n).length === 0) return card
  return { ...card, nameI18n: { ...(card.nameI18n ?? {}), ...texts.nameI18n } }
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
  // B-W2b-227: the private-label filter stays readCatalogue's (mayOffer: another brand's own style is never offered); the
  // cards and the search read the style's names in every language.
  const texts = await reader.inTenant((db) => catalogueTextsOf(db, all.map((style) => style.id), reader.session.person.locale))
  const q = query.q?.trim().toLowerCase()
  const matches = all.filter((style) => {
    if (q && !`${style.code} ${style.name} ${style.nameI18n?.it ?? ''} ${style.nameI18n?.en ?? ''} ${(texts.get(style.id)?.names ?? []).join(' ')}`.toLowerCase().includes(q)) return false
    if (query.category && style.productType !== query.category) return false
    if (query.season && style.season !== query.season) return false
    if (query.ppe && style.ppeCategory !== query.ppe) return false
    if (query.range === 'OWN_LABEL' && !style.ownLabel) return false
    if (query.range === 'OPEN_RANGE' && style.ownLabel) return false
    return true
  })
  return {
    styles: matches.map((style) => withTexts(cardOf(style), texts.get(style.id))),
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
  const text = (await reader.inTenant((db) => catalogueTextsOf(db, [styleId], reader.session.person.locale))).get(styleId)
  return {
    style: {
      ...withTexts(cardOf(style), text),
      description: text?.own.longDescription ?? text?.own.shortDescription ?? style.description,
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
