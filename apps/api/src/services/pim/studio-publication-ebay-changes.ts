import type { StudioPublishChange, StudioPublishFieldWrite, StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import type { EbayPublication } from './studio-publication-ebay.js'
import { planPublicationChanges, publicationChangeId, selectPublicationChanges, type PublicationChangeInput } from './studio-publication-changes.js'
import { compareEbayContent, ebayAspectKey, ebayContentFromItem, ebayXmlList, ebayXmlObject, ebayXmlText, parseEbayItemDocument } from '../channel-drift/ebay-content-compare.js'
import { escapeXml } from '../ebay-trading-api.service.js'

type ProductIdentity = { productId: string; sku: string }
export interface EbayChangePlan {
  kind: 'ebay-changes'
  changes: StudioPublishChange[]
  remoteRevision: string
  publication: EbayPublication
  products: ProductIdentity[]
  ownerProductId: string
  liveSpecifics: Record<string, string[]>
  aspectNames: Record<string, string>
  createWrites: Record<string, StudioPublishFieldWrite[]>
}

const unknown = (reason: string): StudioPublishValue => ({ state: 'unknown', reason })
const known = (value: unknown): StudioPublishValue => value == null || value === '' || (Array.isArray(value) && !value.length) ? { state: 'absent' } : { state: 'value', value }
const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(ebayXmlObject(value)).filter(([key, value]) => !['SKU', 'StartPrice', 'Quantity', 'SellingStatus'].includes(key) && !(key === '#text' && typeof value === 'string' && !value.trim())).map(([key, value]) => [key, strip(value)])) : value
const pictures = (item: Record<string, unknown>) => ebayXmlList(ebayXmlObject(item.PictureDetails).PictureURL).map(ebayXmlText).filter((value): value is string => value !== null)
const variants = (item: Record<string, unknown>) => ebayXmlList(ebayXmlObject(item.Variations).Variation).map(ebayXmlObject)
const aspectMap = (specifics: Record<string, string[]>) => {
  const result = new Map<string, { name: string; values: string[] }>()
  for (const [name, values] of Object.entries(specifics)) {
    const key = ebayAspectKey(name), old = result.get(key)
    result.set(key, { name: old?.name ?? name, values: [...(old?.values ?? []), ...values] })
  }
  return result
}
const ignoredRoots = new Set(['ItemID', 'SKU', 'InventoryTrackingMethod', 'Title', 'Description', 'ItemSpecifics', 'PictureDetails', 'Variations', 'VariationSpecificsSet', 'Pictures', 'StartPrice', 'Quantity', 'SellingStatus', '#text'])

function variationPicturesXml(value: unknown): string {
  const collection = ebayXmlObject(value), name = ebayXmlText(collection.VariationSpecificName)
  const sets = ebayXmlList(collection.VariationSpecificPictureSet).map(ebayXmlObject)
  if (!name?.trim() || !sets.length) throw new Error('Clearing variation pictures is unsupported; choose a complete picture collection.')
  const seen = new Set<string>()
  const rendered = sets.map(set => {
    const value = ebayXmlText(set.VariationSpecificValue), urls = ebayXmlList(set.PictureURL).map(ebayXmlText)
    if (!value?.trim() || seen.has(value) || !urls.length || urls.length > 24 || urls.some(url => !url || !/^https:\/\//i.test(url))) throw new Error('The variation picture collection is incomplete or invalid.')
    seen.add(value)
    return `<VariationSpecificPictureSet><VariationSpecificValue>${escapeXml(value)}</VariationSpecificValue>${urls.map(url => `<PictureURL>${escapeXml(url!)}</PictureURL>`).join('')}</VariationSpecificPictureSet>`
  })
  return `<Pictures><VariationSpecificName>${escapeXml(name)}</VariationSpecificName>${rendered.join('')}</Pictures>`
}

function comparison(field: string, value: StudioPublishValue, live: Record<string, unknown> | null): boolean | undefined {
  if (!live || value.state !== 'value') return undefined
  const content = ebayContentFromItem(live)
  if (field === 'title') {
    const result = compareEbayContent({ title: String(value.value), itemSpecifics: {} }, content)
    return result.compared.includes('title') ? !result.differing.some(entry => entry.field === 'title') : undefined
  }
  if (field.startsWith('aspect:')) {
    const name = field.slice(7), result = compareEbayContent({ title: '', itemSpecifics: { [name]: value.value as string[] } }, content)
    return result.compared.includes(`aspect:${name}`) ? !result.differing.some(entry => entry.field === `aspect:${name}`) : undefined
  }
  return undefined
}

/** Base preparation owns the fresh GetItem read. No second read or provider write occurs here. */
export async function prepareEbayChanges(facts: PublicationFacts, publication: EbayPublication, baselineValues: Map<string, StudioPublishValue>): Promise<EbayChangePlan> {
  const identities = publication.products
  const live = publication.liveContent ?? null
  const liveSkus = new Set(variants(live ?? {}).map(variant => ebayXmlText(variant.SKU)))
  const products = publication.itemId ? identities.filter(product => facts.listings.some(listing => listing.productId === product.productId && listing.externalListingId === publication.itemId
    && listing.channel === facts.scope.channel && listing.marketplace === facts.scope.marketplace && listing.channelConnectionId === facts.scope.accountId && listing.aliasKey === (facts.destination.aliasKey ?? ''))
    && (product.productId === facts.parent.id || liveSkus.has(product.sku))) : identities
  const owner = products.find(product => product.productId === facts.parent.id) ?? products[0] ?? identities[0]
  if (!owner) throw new Error('No included eBay product can own this listing publication.')
  const current = parseEbayItemDocument(publication.xml)
  const ours = ebayContentFromItem(current), theirs = live ? ebayContentFromItem(live) : null
  const ourAspects = aspectMap(ours.itemSpecifics), theirAspects = aspectMap(theirs?.itemSpecifics ?? {})
  const aspectNames: Record<string, string> = {}, inputs: PublicationChangeInput[] = []
  const readError = publication.liveReadError ?? 'The current eBay content could not be read.'
  const add = (product: ProductIdentity, field: string, label: string, current: StudioPublishValue, channel: StudioPublishValue, refusal?: string) => {
    const lastAccepted = baselineValues.get(publicationChangeId(product.productId, field)) ?? unknown('No accepted publish record for this field.')
    inputs.push({ ...product, field, label, current, lastAccepted, channel,
      currentMatchesChannel: comparison(field, current, live), acceptedMatchesChannel: comparison(field, lastAccepted, live),
      ...(publication.itemId && !live ? { refusal: readError } : refusal ? { refusal } : {}) })
  }
  const channel = (value: unknown) => live ? known(value) : unknown(readError)
  add(owner, 'SKU', 'Seller SKU', known(ebayXmlText(current.SKU)), channel(ebayXmlText(live?.SKU)), 'Changing the seller SKU is unsupported by change-only Publish.')
  add(owner, 'title', 'Title', known(ours.title), channel(theirs?.title), !ours.title?.trim() ? 'A title is required; it cannot be cleared.' : undefined)
  const description = ebayXmlText(current.Description)
  add(owner, 'description', 'Description', known(description), channel(ebayXmlText(live?.Description)), !description?.trim() ? 'Clearing the description is unsupported; eBay requires a description.' : undefined)
  const gallery = pictures(current)
  add(owner, 'pictures', 'Listing pictures', known(gallery), channel(live ? pictures(live) : null), !gallery.length ? 'The gallery cannot be cleared; at least one picture is required.'
    : gallery.some(url => !/^https:\/\//i.test(url)) || gallery.length > 24 ? 'eBay requires at most 24 HTTPS picture URLs.' : undefined)

  // Baseline keys retain explicit deletions; channel-only catalogue aspects are preserved, never inferred as local deletions.
  const aspectKeys = new Set(ourAspects.keys())
  const priorRoots = new Set<string>()
  for (const key of baselineValues.keys()) {
    const coordinate: unknown = JSON.parse(key)
    if (!Array.isArray(coordinate) || coordinate[0] !== owner.productId || typeof coordinate[1] !== 'string') continue
    if (coordinate[1].startsWith('aspect:')) aspectKeys.add(coordinate[1].slice(7))
    else if (/^[A-Z][A-Za-z]*$/.test(coordinate[1])) priorRoots.add(coordinate[1])
  }
  const requiredAspects = new Set<string>(), authoredClears = new Set<string>()
  for (const field of facts.resolved[0]?.catalogue?.fields ?? []) {
    const store = field.channelStore
    if (store?.kind !== 'platformAttributes' || store.path[0] !== 'itemSpecifics' || !store.path[1]) continue
    const cell = facts.resolved[0]?.products.find(product => product.productId === owner.productId)?.cells[field.fieldKey]
    if (!cell) continue
    const key = ebayAspectKey(store.path[1]); aspectKeys.add(key)
    if (cell.required) requiredAspects.add(key)
    if (cell.status === 'mapped' && cell.provenance === 'override' && cell.needsTranslation === false
      && Array.isArray(cell.errors) && cell.errors.length === 0
      && (cell.value === null || cell.value === '' || (Array.isArray(cell.value) && cell.value.length === 0))) authoredClears.add(key)
  }
  for (const key of aspectKeys) {
    const ours = ourAspects.get(key), theirs = theirAspects.get(key)
    aspectNames[key] = theirs?.name ?? ours?.name ?? key
    const current = ours?.values.length ? known(ours.values) : authoredClears.has(key) ? { state: 'absent' as const }
      : unknown('This item specific is omitted; no valid authored clear was prepared.')
    add(owner, `aspect:${key}`, ours?.name ?? theirs?.name ?? key, current, channel(theirs?.values),
      !ours?.values.length && requiredAspects.has(key) ? 'This required item specific cannot be cleared.' : undefined)
  }
  for (const root of [...new Set([...Object.keys(current), ...priorRoots])].filter(root => !ignoredRoots.has(root) && !root.startsWith('@_'))) {
    add(owner, root, root, known(strip(current[root])), channel(live?.[root] === undefined ? null : strip(live[root])), `${root}: this structural or policy update is unsupported by change-only Publish.`)
  }
  const ourVariations = ebayXmlObject(current.Variations), liveVariations = ebayXmlObject(live?.Variations)
  for (const root of ['VariationSpecificsSet', 'Pictures']) if (ourVariations[root] !== undefined || liveVariations[root] !== undefined) {
    let refusal: string | undefined = `${root}: this variation structure update is unsupported by change-only Publish.`
    if (root === 'Pictures') {
      try { variationPicturesXml(ourVariations.Pictures); refusal = undefined }
      catch (error) { refusal = error instanceof Error ? error.message : String(error) }
    }
    add(owner, root, root === 'Pictures' ? 'Variation pictures' : 'Variation theme', known(strip(ourVariations[root])), channel(strip(liveVariations[root])),
      refusal)
  }
  const currentVariants = variants(current), liveVariants = live ? variants(live) : []
  for (const product of identities) {
    const variant = currentVariants.find(variant => ebayXmlText(variant.SKU) === product.sku)
    const remote = liveVariants.find(variant => ebayXmlText(variant.SKU) === product.sku)
    const linked = products.some(linked => linked.productId === product.productId)
    if (variant || !linked) add(product, 'variation', linked ? 'Variation content' : 'New variation', known(variant ? strip(variant) : { sku: product.sku }), channel(remote ? strip(remote) : null),
      'Variation content requires price and quantity writes. It is not supported by change-only Publish; this variation will not be sent.')
  }
  // Fields omitted by the legacy full builder still have an honest refused review row.
  for (const row of facts.resolved[0]?.products ?? []) {
    const product = identities.find(product => product.productId === row.productId)
    if (!product) continue
    for (const [field, raw] of Object.entries(row.cells)) {
      const cell = ebayXmlObject(raw), label = typeof cell.label === 'string' ? cell.label : field
      if (['price', 'quantity'].includes(field) || ((cell.value == null || cell.value === '') && !baselineValues.has(publicationChangeId(product.productId, `content:${field}`)))) continue
      const spec = facts.resolved[0]?.catalogue?.fields.find(spec => spec.fieldKey === field)
      if (product.productId === owner.productId && (['title', 'description', 'imageUrls', 'descriptionThemeId'].includes(field)
        || (spec?.channelStore?.kind === 'platformAttributes' && spec.channelStore.path[0] === 'itemSpecifics'))) continue
      add(product, `content:${field}`, label, known(cell.value), unknown('This field has no supported eBay comparison in this publisher.'),
        `${label}: this field is unsupported by change-only Publish.`)
    }
  }
  const createWrites: Record<string, StudioPublishFieldWrite[]> = {}
  for (const input of inputs) if (input.current.state === 'value' && !input.field.startsWith('content:')) (createWrites[input.productId] ??= []).push({ field: input.field, value: input.current })
  const changes = publication.itemId ? planPublicationChanges(inputs) : planPublicationChanges([{ ...owner, field: '__create__', label: 'Create eBay listing', current: known(current), lastAccepted: unknown('No listing exists.'), channel: { state: 'absent' }, newListing: true }])
  return { kind: 'ebay-changes', changes, remoteRevision: publication.liveRevision ?? (publication.itemId ? 'unavailable' : 'new'), publication,
    products, ownerProductId: owner.productId, liveSpecifics: theirs?.itemSpecifics ?? {}, aspectNames, createWrites }
}

export function compileEbayChanges(plan: EbayChangePlan, selectedIds: string[]): EbayPublication & { products: ProductIdentity[]; fieldWrites: Record<string, StudioPublishFieldWrite[]> } {
  const selected = selectPublicationChanges(plan.changes, selectedIds)
  if (!selected.length) return { ...plan.publication, xml: '', products: [], fieldWrites: {} }
  if (!plan.publication.itemId) return { ...plan.publication, products: plan.products, fieldWrites: plan.createWrites }
  if (!plan.publication.liveRevision || !plan.publication.liveContent || !plan.products.length) throw new Error('A successful live eBay read and linked listing are required before sending changes.')
  const fields: string[] = [], deleted: string[] = [], fieldWrites: Record<string, StudioPublishFieldWrite[]> = {}
  const specifics = { ...plan.liveSpecifics }
  let aspectChanged = false
  for (const change of selected) {
    if (change.current.state === 'unknown') throw new Error('An unknown value cannot be sent to eBay.')
    const writes = fieldWrites[change.productId] ??= []
    writes.push({ field: change.field, value: change.current })
    const value = change.current.state === 'value' ? change.current.value : null
    if (change.field === 'title' || change.field === 'description') {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${change.label} cannot be cleared.`)
      const tag = change.field === 'title' ? 'Title' : 'Description'
      fields.push(`<${tag}>${escapeXml(value)}</${tag}>`)
    } else if (change.field === 'pictures') {
      if (!Array.isArray(value) || !value.length || value.some(url => typeof url !== 'string' || !/^https:\/\//i.test(url))) throw new Error('The picture gallery cannot be empty or invalid.')
      fields.push(`<PictureDetails>${value.map(url => `<PictureURL>${escapeXml(String(url))}</PictureURL>`).join('')}</PictureDetails>`)
    } else if (change.field === 'Pictures') {
      fields.push(`<Variations>${variationPicturesXml(value)}</Variations>`)
    } else if (change.field.startsWith('aspect:')) {
      const key = change.field.slice(7)
      for (const name of Object.keys(specifics)) if (ebayAspectKey(name) === key) delete specifics[name]
      if (value !== null) {
        if (!Array.isArray(value) || value.some(value => typeof value !== 'string')) throw new Error('The item specific values are invalid.')
        specifics[plan.aspectNames[key] ?? key] = value as string[]
      }
      aspectChanged = true
    } else throw new Error(`${change.label} has no supported narrow eBay write.`)
  }
  if (aspectChanged) {
    const entries = Object.entries(specifics).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    if (!entries.length) deleted.push('<DeletedField>Item.ItemSpecifics</DeletedField>')
    else fields.push(`<ItemSpecifics>${entries.map(([name, values]) => `<NameValueList><Name>${escapeXml(name)}</Name>${[...values].sort().map(value => `<Value>${escapeXml(value)}</Value>`).join('')}</NameValueList>`).join('')}</ItemSpecifics>`)
  }
  const trackedBySku = ebayXmlText(plan.publication.liveContent.InventoryTrackingMethod) === 'SKU'
  const liveSku = ebayXmlText(plan.publication.liveContent.SKU)
  if (trackedBySku && !liveSku) throw new Error('The SKU-managed eBay listing has no verified live SKU identifier.')
  const identifier = `<ItemID>${escapeXml(plan.publication.itemId)}</ItemID>${trackedBySku ? `<SKU>${escapeXml(liveSku!)}</SKU>` : ''}`
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${deleted.join('')}<Item>${identifier}${fields.join('')}</Item></ReviseFixedPriceItemRequest>`
  return { ...plan.publication, xml, products: plan.products, fieldWrites }
}

/** UUID belongs to Item; InvocationID is inherited from AbstractRequestType, beside Item. */
export function ebayPublicationRequest(plan: EbayPublication, operationId: string): { operation: string; xml: string } {
  if (!plan.xml) throw new Error('There are no selected eBay changes to send.')
  const key = escapeXml(operationId.replace(/-/g, '').toUpperCase())
  return { operation: plan.itemId ? 'ReviseFixedPriceItem' : 'AddFixedPriceItem', xml: plan.itemId
    ? plan.xml.replace(/(<ReviseFixedPriceItemRequest\b[^>]*>)/, `$1<InvocationID>${key}</InvocationID>`)
    : plan.xml.replace('<Item>', `<Item><UUID>${key}</UUID>`) }
}
