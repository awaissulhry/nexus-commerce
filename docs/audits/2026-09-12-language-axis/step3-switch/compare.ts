import { projectCellValue } from '../../../../apps/api/src/services/pim/sheet-values.js'
/** Post-switch comparison against the immutable resolver accepted at Q-LX3-1. Offline hydrated inputs only. */
import { resolveAttributes, type ProductLike } from '../../../../apps/api/src/services/pim/attribute-resolver.js'
import { CONTENT_COLUMNS, PRIMARY_CONTENT_LOCALE, sourceContent } from '../../../../apps/api/src/services/pim/content-locale.js'
import { contentPathAddress, type ContentProduct, type ContentListing, type Coordinate, type ResolvedContent } from '../../../../apps/api/src/services/pim/content-resolver.js'
import { marketLanguages } from '../../../../apps/api/src/services/pim/market-languages.js'
import { normalizeLanguage } from '../../../../apps/api/src/services/pim/content-language.js'
import { etsyContentState } from '../../../../apps/api/src/services/etsy/information-content.js'
import { informationContentState } from '../../../../apps/api/src/services/shopify/listing-information-plan.js'
import { resolveSourcePath } from '../../../../apps/api/src/services/pim/resolve-channel-field.js'
import { globalContentLocales } from '../../../../apps/api/src/services/pim/global-content.js'
import { shopifyProductSpec } from '../../../../apps/api/src/services/pim/channel-specs/store.js'
import { acceptedResolveContentBatch, acceptedResolveContentPath } from './accepted-reference.mjs'
type Row = Record<string, any>
const equalContent = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const object = (v: any): Row => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
const workspace = (row: Row) => row.workspaceId ?? null
const id = (row: Row, key = row.id) => JSON.stringify([workspace(row), key])
export function compareSwitchedReaders(data: {
  acceptedDiffs?: Row[]
  products: Row[]; listings: Row[]; marketplaces: Row[]; translations: Row[]
  localizableKeysByProduct?: Record<string, string[]>
  /** The actual existing syndication extractor, extracted and hashed by the audit builder to avoid route bootstrap. */
  extractLocaleTitle: (product: Row, listing: Row, languages: readonly string[], requested: string) => string | null
  productResolvedContent: (product: any, language: string) => any
  sheetValueForColumn: (col: any, product: Row, resolved: Row) => unknown
}) {
  const products: Row[] = data.products.map(product => ({ ...product, translations: data.translations.filter(row => id(row, row.productId) === id(product)) }))
  const productMap = new Map(products.map(product => [id(product), product]))
  const counts: Record<string, { compared: number; valueDiffs: number; languageDiffs: number; reviewDiffs: number; diffs: number }> = {}
  const diffs: Row[] = []
  const receiptKey = (row: Row) => JSON.stringify([row.reader, row.workspaceId, row.productId, row.listingId ?? null, row.coordinate ?? null, row.field, row.language, row.path ?? row.old?.path ?? null])
  const accepted = new Map((data.acceptedDiffs ?? []).map(row => [receiptKey(row), row]))
  const checked = new Set<string>(), receiptDiffs: Row[] = []
  const coveredListings = new Set<string>(), coordinates = new Set<string>()
  const observe = (reader: string, product: Row, parent: Row | undefined, listing: Row | undefined, coordinate: Coordinate | null, field: string, language: string, old: Row, next: ResolvedContent) => {
    const key = JSON.stringify([reader, field, language])
    const count = counts[key] ??= { compared: 0, valueDiffs: 0, languageDiffs: 0, reviewDiffs: 0, diffs: 0 }
    count.compared++
    const wireList = ['global-content', 'product-content', 'sheet-wire'].includes(reader) && ['bulletPoints', 'keywords'].includes(field)
    const expected = reader === 'sheet-wire' && wireList ? projectCellValue({ shape: 'list' }, next.value) ?? [] : wireList && next.value == null ? [] : next.value
    const valueChanged = !equalContent(old.value, expected)
    const actualLanguage = old.language ?? old.effectiveLocale
    const languageChanged = actualLanguage !== undefined && actualLanguage !== next.language
    const reviewChanged = false
    const receipt = receiptKey({ reader, productId: product.id, workspaceId: workspace(product), listingId: listing?.id ?? null, coordinate, field, language, path: old.path })
    const prior = accepted.get(receipt)
    if (prior) {
      checked.add(receipt)
      const value = reader === 'sheet-wire' && wireList ? projectCellValue({ shape: 'list' }, prior.next.value) ?? [] : wireList && prior.next.value == null ? [] : prior.next.value
      if (!equalContent(old.value, value)) receiptDiffs.push({ reader, productId: product.id, field, language, actual: old.value, acceptedNext: value })
    }
    if (!valueChanged && !languageChanged) return
    count.valueDiffs += Number(valueChanged); count.languageDiffs += Number(languageChanged); count.diffs++
    diffs.push({ reader, productId: product.id, sku: product.sku, workspaceId: workspace(product), listingId: listing?.id ?? null,
      coordinate, field, language, valueChanged, languageChanged, actual: old, expected: { ...next, value: expected } })

  }
  for (const product of products) {
    const parent = product.parentId ? productMap.get(id(product, product.parentId)) : undefined
    if (product.parentId && !parent) throw new Error(`Missing parent for ${product.id}`)
    const localizableKeys = data.localizableKeysByProduct?.[id(product)] ?? []
    const fields = [...Object.keys(CONTENT_COLUMNS), ...localizableKeys]
    const markets = data.marketplaces.filter(market => workspace(market) === workspace(product))
    const sharedLanguages = [...new Set([normalizeLanguage(PRIMARY_CONTENT_LOCALE), ...markets.flatMap(m => marketLanguages(m.channel, m.code, markets as any)), ...[product, parent].filter(Boolean).flatMap(p => p!.translations.map(row => normalizeLanguage(row.language)))])].sort()
    const global = globalContentLocales(product as ProductLike, (parent ?? null) as ProductLike | null, sharedLanguages)
    const scopes: Array<{ coordinate: Coordinate | null; listing?: Row; languages: string[] }> = [{ coordinate: null, languages: sharedLanguages }]
    for (const market of markets) {
      const marketListings = data.listings.filter(l => workspace(l) === workspace(product) && l.channel === market.channel && (l.marketplace && l.marketplace !== 'DEFAULT' ? l.marketplace : l.region) === market.code)
      const languages = marketLanguages(market.channel, market.code, markets as any)
      const coordinateOf = (listing?: Row): Coordinate => ({ channel: market.channel, market: market.code, ...(listing?.channelConnectionId ? { accountId: listing.channelConnectionId } : {}), ...(listing?.aliasId || listing?.aliasKey ? { aliasId: listing.aliasId ?? listing.aliasKey } : {}) })
      const marketCoordinates = [...new Map((marketListings.length ? marketListings : [undefined]).map(listing => { const coordinate = coordinateOf(listing); return [JSON.stringify(coordinate), coordinate] })).values()]
      // Cross EVERY product with EVERY observed account/alias coordinate in its workspace,
      // including products with no listing there. Never replace an absent listing with a peer's row.
      for (const coordinate of marketCoordinates) {
        const matches = marketListings.filter(l => id(l, l.productId) === id(product) && JSON.stringify(coordinateOf(l)) === JSON.stringify(coordinate))
        if (matches.length > 1) throw new Error(`Ambiguous listings for ${product.id} at ${JSON.stringify(coordinate)}`)
        const listing = matches[0]
        if (listing) coveredListings.add(id(listing))
        scopes.push({ coordinate, listing, languages })
      }
    }
    for (const scope of scopes) {
      const { coordinate, listing, languages } = scope
      if (coordinate) coordinates.add(JSON.stringify([workspace(product), coordinate]))
      const hydratedListing: ContentListing | null = listing ? { ...listing, id: listing.id, productId: listing.productId, coordinate: coordinate!, languages } : null
      const batch = acceptedResolveContentBatch({ members: [{ product: product as ContentProduct, parent: parent as ContentProduct, listing: hydratedListing, localizableKeys }], fields, addresses: languages.map(requested => ({ requested, ...(coordinate ? { coordinate } : {}) })) })
      for (const row of batch) {
        const language = row.address.requested
        const old = resolveAttributes({ product: product as ProductLike, parent: (parent ?? null) as ProductLike | null, channelListing: listing as any, marketLanguages: languages, coordinate: coordinate ?? undefined, locale: language, localizableKeys })
        const oldProduct = !coordinate ? data.productResolvedContent?.({ ...product, parent }, language) : undefined
        for (const field of fields) {
          const next = row.fields[field]
          observe(coordinate ? 'attribute-coordinate' : 'attribute-shared', product, parent, listing, coordinate, field, language, old[field] ?? { value: null }, next)
          observe('sheet-wire', product, parent, listing, coordinate, field, language, { ...old[field], value: data.sheetValueForColumn({ key: field === 'title' ? 'name' : field, kind: 'text', storage: field === 'title' ? 'column' : 'localizedContent', shape: ['bulletPoints', 'keywords'].includes(field) ? 'list' : 'scalar' }, product, old) }, next)
          if (!coordinate) observe('sourceContent', product, parent, undefined, null, field, language, { value: sourceContent({ ...product, parent }, field, language) }, next)
          if (!coordinate && field in CONTENT_COLUMNS) {
            observe('global-content', product, parent, undefined, null, field, language, { ...old[field], value: global[language]?.[field as keyof typeof global[string]] }, next)
            if (oldProduct) observe('product-content', product, parent, undefined, null, field, language, oldProduct.fields[CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]], next)
          }
          if (listing?.channel === 'ETSY' && ['title', 'description'].includes(field)) observe('etsyContentState', product, parent, listing, coordinate, field, language, etsyContentState({ ...listing, product: { ...product, parent }, languages }, language, field) ?? { value: null }, next)
          if (listing?.channel === 'AMAZON' && field === 'title' && data.extractLocaleTitle) observe('syndication-title', product, parent, listing, coordinate, field, language, { value: data.extractLocaleTitle({ ...product, parent }, listing, languages, language) }, next)
          if (listing?.channel === 'SHOPIFY' && ['title', 'description'].includes(field)) {
            const spec = shopifyProductSpec(null, coordinate?.accountId).fields.find(spec => spec.masterKey === (field === 'title' ? 'name' : field))!
            const stored = informationContentState({ ...listing, product: { ...product, parent }, languages } as any, spec)
            observe('shopify-information-native', product, parent, listing, coordinate, field, language, { value: stored.value }, next)

          }
        }
        if (coordinate) {
          const market = markets.find(m => m.channel === coordinate.channel && m.code === coordinate.market)!
          const mapping = object(market.schemaMapping), category = listing?.platformAttributes?.productType ?? product.productType
          const rules = { ...object(mapping.fields), ...object(mapping.byProductType?.[category]) }
          const paths = [...new Set(Object.values(rules).flatMap(rule => [rule.source, rule.fallback].filter((path): path is string => typeof path === 'string' && !!path)))]
          for (const path of paths) {
            const parsed = contentPathAddress(path, language, localizableKeys)
            if (!parsed) continue
            const next = acceptedResolveContentPath({ product: product as ContentProduct, parent: parent as ContentProduct, listing: hydratedListing, address: { requested: language, coordinate }, localizableKeys, path })!
            const flat = Object.fromEntries(Object.entries(old).map(([field, hit]) => [field, hit.value]))
            const value = resolveSourcePath(path, flat, { ...product, parent, contentListing: hydratedListing } as ProductLike, language)
            observe('mapping-source', product, parent, listing, coordinate, parsed.field, language, { value, path }, next)
          }
        }
      }
    }
  }
  if (coveredListings.size !== data.listings.length) throw new Error(`Listing coverage mismatch: ${coveredListings.size}/${data.listings.length}`)
  return { counts: Object.entries(counts).map(([key, counts]) => { const [reader, field, language] = JSON.parse(key); return { reader, field, language, ...counts } }), acceptedReceipt: { expected: accepted.size, checked: checked.size, missing: [...accepted.keys()].filter(key => !checked.has(key)), diffs: receiptDiffs }, diffs, coveredListings: coveredListings.size, coordinates: coordinates.size }
}
