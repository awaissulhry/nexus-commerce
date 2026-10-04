import { FULL_NEEDS_LIVE_READ, fullUpdateChange, type StudioPublishChange, type StudioPublishFieldWrite, type StudioPublishIssue, type StudioPublishRemoval,
  type StudioPublishValue } from '@nexus/shared/studio-publication'
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
  /**
   * Build shape v2 — the item is reviewed as Full update: every field it sends is ticked and locked, and the selection
   * sends the whole Revise (`publication.full.xml`) or nothing. `removals`: what eBay holds that Nexus does not;
   * `fullIssues`: why it cannot be sent (errors) and what stays as on eBay (warnings).
   */
  full?: true
  removals?: StudioPublishRemoval[]
  fullIssues?: StudioPublishIssue[]
}

const unknown = (reason: string): StudioPublishValue => ({ state: 'unknown', reason })
const known = (value: unknown): StudioPublishValue => value == null || value === '' || (Array.isArray(value) && !value.length) ? { state: 'absent' } : { state: 'value', value }
const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(ebayXmlObject(value)).filter(([key, value]) => !['SKU', 'StartPrice', 'Quantity', 'SellingStatus'].includes(key) && !(key === '#text' && typeof value === 'string' && !value.trim())).map(([key, value]) => [key, strip(value)])) : value
const pictures = (item: Record<string, unknown>) => ebayXmlList(ebayXmlObject(item.PictureDetails).PictureURL).map(ebayXmlText).filter((value): value is string => value !== null)

/**
 * eBay copies every picture to its own picture service, and GetItem can show ITS address (i.ebayimg.com) in PictureURL —
 * with the seller's original in ExternalPictureURL when eBay keeps it. The live read is compared on the seller's
 * addresses when eBay returns them; a read that still shows eBay's addresses is eBay's own copy and is never compared
 * (one-click "Nexus wins", Owner 2026-10-04: otherwise every picture line would differ and be resent on every Publish).
 */
const EBAY_PHOTO_HOST = /^https?:\/\/([a-z0-9-]+\.)*ebayimg\.com(\/|$)/i
export const EBAY_PHOTO_COPY = 'eBay shows its own copy of the photos, so Nexus cannot compare them. Tick it to send Nexus\'s photos.'
const urlTexts = (value: unknown) => ebayXmlList(value).map(ebayXmlText).filter((url): url is string => url !== null)
/** The live gallery as the seller's addresses: ExternalPictureURL when eBay returned it, else PictureURL. */
const livePictures = (item: Record<string, unknown>) => {
  const details = ebayXmlObject(item.PictureDetails), external = urlTexts(details.ExternalPictureURL)
  return external.length ? external : urlTexts(details.PictureURL)
}
/** The live variation picture sets with the seller's addresses (ExternalPictureURL, when returned) in PictureURL. */
function liveVariationPictures(value: unknown): unknown {
  if (value === undefined) return value
  const sellerSet = (set: unknown) => {
    const { ExternalPictureURL: external, ...rest } = ebayXmlObject(set)
    const urls = urlTexts(external)
    return urls.length ? { ...rest, PictureURL: urls.length === 1 ? urls[0] : urls } : rest
  }
  const collection = ebayXmlObject(value), sets = collection.VariationSpecificPictureSet
  return sets === undefined ? collection : { ...collection, VariationSpecificPictureSet: Array.isArray(sets) ? sets.map(sellerSet) : sellerSet(sets) }
}
const variationPictureUrls = (value: unknown) => ebayXmlList(ebayXmlObject(value).VariationSpecificPictureSet).flatMap(set => urlTexts(ebayXmlObject(set).PictureURL))
const ebayHosted = (urls: string[]) => urls.some(url => EBAY_PHOTO_HOST.test(url))
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
    // eBay allows 12 pictures per variation value (the listing gallery allows 24).
    if (!value?.trim() || seen.has(value) || !urls.length || urls.length > 12 || urls.some(url => !url || !/^https:\/\//i.test(url))) throw new Error('The variation picture collection is incomplete or invalid.')
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

export interface EbayChangeOptions {
  /** Build shape v2 — the item is reviewed as Full update (its main row asked for it). A new item is created whole anyway. */
  full?: boolean
}

/** The item fields whose removal a Full update sends (`<DeletedField>`); any other eBay value Nexus lacks stays. */
const FULL_REMOVABLE_ROOTS = new Set(['SubTitle'])
const FULL_FIELD_NOTE = (label: string) => `${label}: no eBay field of its own here; a Full update sends the eBay fields above.`

/** Base preparation owns the fresh GetItem read. No second read or provider write occurs here. */
export async function prepareEbayChanges(facts: PublicationFacts, publication: EbayPublication, baselineValues: Map<string, StudioPublishValue>,
  options: EbayChangeOptions = {}): Promise<EbayChangePlan> {
  const identities = publication.products
  const live = publication.liveContent ?? null
  const liveSkus = new Set(variants(live ?? {}).map(variant => ebayXmlText(variant.SKU)))
  const products = publication.itemId ? identities.filter(product => facts.listings.some(listing => listing.productId === product.productId && listing.externalListingId === publication.itemId
    && listing.channel === facts.scope.channel && listing.marketplace === facts.scope.marketplace && listing.channelConnectionId === facts.scope.accountId && listing.aliasKey === (facts.destination.aliasKey ?? ''))
    && (product.productId === facts.parent.id || liveSkus.has(product.sku))) : identities
  const owner = products.find(product => product.productId === facts.parent.id) ?? products[0] ?? identities[0]
  if (!owner) throw new Error('No included eBay product can own this listing publication.')
  const readError = publication.liveReadError ?? 'The current eBay content could not be read.'
  // Build shape v2 — a Full update reviews the Revise it sends (`publication.full.xml`), which needs the live read.
  const full = !!options.full && !!publication.itemId
  const fullIssues: StudioPublishIssue[] = []
  const blockFull = (message: string) => fullIssues.push({ productId: owner.productId, sku: owner.sku, severity: 'error', message: `${owner.sku}: ${message}` })
  if (full && !live) blockFull(FULL_NEEDS_LIVE_READ('eBay', readError))
  else if (full && !publication.full) blockFull('The Full update could not be prepared. Review again.')
  for (const blocker of full ? publication.full?.blockers ?? [] : []) blockFull(blocker)
  /** A field Full update cannot send whole (an empty title…) blocks it: its Revise would send the field as it is. */
  const must = (reason: string | undefined) => { if (full && reason && live) blockFull(`Full update cannot be sent: ${reason}`); return reason }
  const current = parseEbayItemDocument(full && publication.full?.xml ? publication.full.xml : publication.xml)
  const ours = ebayContentFromItem(current), theirs = live ? ebayContentFromItem(live) : null
  const ourAspects = aspectMap(ours.itemSpecifics), theirAspects = aspectMap(theirs?.itemSpecifics ?? {})
  const aspectNames: Record<string, string> = {}, inputs: PublicationChangeInput[] = []
  const add = (product: ProductIdentity, field: string, label: string, current: StudioPublishValue, channel: StudioPublishValue, refusal?: string, channelCopy?: string) => {
    const lastAccepted = baselineValues.get(publicationChangeId(product.productId, field)) ?? unknown('No accepted publish record for this field.')
    inputs.push({ ...product, field, label, current, lastAccepted, channel,
      currentMatchesChannel: comparison(field, current, live), acceptedMatchesChannel: comparison(field, lastAccepted, live),
      ...(publication.itemId && !live ? { refusal: readError } : refusal ? { refusal } : {}), ...(channelCopy ? { channelCopy } : {}) })
  }
  const channel = (value: unknown) => live ? known(value) : unknown(readError)
  // A Full update sends eBay's own seller SKU (it never changes it); a narrow revise refuses the row.
  add(owner, 'SKU', 'Seller SKU', known(ebayXmlText(current.SKU)), channel(ebayXmlText(live?.SKU)), full ? undefined : 'Changing the seller SKU is unsupported by change-only Publish.')
  add(owner, 'title', 'Title', known(ours.title), channel(theirs?.title), must(!ours.title?.trim() ? 'A title is required; it cannot be cleared.' : undefined))
  const description = ebayXmlText(current.Description)
  add(owner, 'description', 'Description', known(description), channel(ebayXmlText(live?.Description)), must(!description?.trim() ? 'Clearing the description is unsupported; eBay requires a description.' : undefined))
  const gallery = pictures(current), liveGallery = live ? livePictures(live) : null
  add(owner, 'pictures', 'Listing pictures', known(gallery), channel(liveGallery), must(!gallery.length ? 'The gallery cannot be cleared; at least one picture is required.'
    : gallery.some(url => !/^https:\/\//i.test(url)) || gallery.length > 24 ? 'eBay requires at most 24 HTTPS picture URLs.' : undefined),
    liveGallery && ebayHosted(liveGallery) ? EBAY_PHOTO_COPY : undefined)

  // Baseline keys retain explicit deletions; channel-only catalogue aspects are preserved, never inferred as local deletions.
  // A Full update replaces the item specifics whole: every aspect eBay holds is a row, and one Nexus lacks is removed.
  const aspectKeys = new Set([...ourAspects.keys(), ...(full ? theirAspects.keys() : [])])
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
    const current = ours?.values.length ? known(ours.values) : full || authoredClears.has(key) ? { state: 'absent' as const }
      : unknown('This item specific is omitted; no valid authored clear was prepared.')
    add(owner, `aspect:${key}`, ours?.name ?? theirs?.name ?? key, current, channel(theirs?.values),
      must(!ours?.values.length && requiredAspects.has(key) ? 'This required item specific cannot be cleared.' : undefined))
  }
  const liveOnlyRemovable = full ? [...FULL_REMOVABLE_ROOTS].filter(root => live?.[root] !== undefined) : []
  for (const root of [...new Set([...Object.keys(current), ...priorRoots, ...liveOnlyRemovable])].filter(root => !ignoredRoots.has(root) && !root.startsWith('@_'))) {
    const ours = known(strip(current[root])), theirs = channel(live?.[root] === undefined ? null : strip(live[root]))
    // Full update: the Revise sends every root it holds; a root Nexus lacks is removed only where eBay allows it.
    const refusal = !full ? `${root}: this structural or policy update is unsupported by change-only Publish.`
      : ours.state === 'absent' && theirs.state === 'value' && !FULL_REMOVABLE_ROOTS.has(root) ? `${root}: Full update keeps eBay's value (Nexus holds none, and eBay cannot remove it here).` : undefined
    add(owner, root, root, ours, theirs, refusal)
  }
  const ourVariations = ebayXmlObject(current.Variations), rawLiveVariations = ebayXmlObject(live?.Variations)
  const liveVariations = { ...rawLiveVariations, ...(rawLiveVariations.Pictures !== undefined ? { Pictures: liveVariationPictures(rawLiveVariations.Pictures) } : {}) }
  for (const root of ['VariationSpecificsSet', 'Pictures']) if (ourVariations[root] !== undefined || liveVariations[root] !== undefined) {
    let refusal: string | undefined = full ? undefined : `${root}: this variation structure update is unsupported by change-only Publish.`
    if (root === 'Pictures') {
      try { variationPicturesXml(ourVariations.Pictures); refusal = undefined }
      catch (error) {
        refusal = error instanceof Error ? error.message : String(error)
        // Full update: no picture sets of Nexus's leave eBay's as they are; an invalid set would be sent, so it blocks.
        if (full) refusal = ourVariations.Pictures === undefined ? 'Full update keeps eBay\'s variation pictures: Nexus has none to send.' : must(refusal)
      }
    }
    add(owner, root, root === 'Pictures' ? 'Variation pictures' : 'Variation theme', known(strip(ourVariations[root])), channel(strip(liveVariations[root])),
      refusal, root === 'Pictures' && live && ebayHosted(variationPictureUrls(liveVariations.Pictures)) ? EBAY_PHOTO_COPY : undefined)
  }
  const currentVariants = variants(current), liveVariants = live ? variants(live) : []
  for (const product of identities) {
    const variant = currentVariants.find(variant => ebayXmlText(variant.SKU) === product.sku)
    const remote = liveVariants.find(variant => ebayXmlText(variant.SKU) === product.sku)
    const linked = products.some(linked => linked.productId === product.productId)
    if (variant || !linked) add(product, 'variation', linked ? 'Variation content' : 'New variation', known(variant ? strip(variant) : { sku: product.sku }), channel(remote ? strip(remote) : null),
      full ? undefined : 'Variation content requires price and quantity writes. It is not supported by change-only Publish; this variation will not be sent.')
  }
  // Full update — each eBay variation Nexus does not hold: deleted, or kept at quantity 0 when it has sales.
  for (const extra of full ? publication.full?.extras ?? [] : [])
    add(owner, `variation:${extra.sku}`, `Variation ${extra.sku}`, extra.action === 'delete' ? { state: 'absent' } : known({ Quantity: '0' }), channel(strip(extra.content)))
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
        full ? FULL_FIELD_NOTE(label) : `${label}: this field is unsupported by change-only Publish.`)
    }
  }
  const createWrites: Record<string, StudioPublishFieldWrite[]> = {}
  for (const input of inputs) if (input.current.state === 'value' && !input.field.startsWith('content:')) (createWrites[input.productId] ??= []).push({ field: input.field, value: input.current })
  let changes = publication.itemId ? planPublicationChanges(inputs, { channel: 'eBay' }) : planPublicationChanges([{ ...owner, field: '__create__', label: 'Create eBay listing', current: known(current), lastAccepted: unknown('No listing exists.'), channel: { state: 'absent' }, newListing: true }])
  const removals: StudioPublishRemoval[] = []
  if (full) {
    // Every field the Revise sends is ticked and locked; a field it cannot send keeps its reason (said once, below).
    const kept: string[] = []
    changes = changes.map((change, index) => {
      if (inputs[index].refusal !== undefined) { if (!change.field.startsWith('content:') && live) kept.push(change.label); return change }
      const sendable = change.current.state !== 'unknown' && change.channel.state !== 'unknown' && !(change.current.state === 'absent' && change.channel.state === 'absent')
      return sendable ? fullUpdateChange(change) : change
    })
    for (const change of changes) if (change.locked && change.current.state === 'absent' && change.channel.state === 'value' && !change.field.startsWith('variation:'))
      removals.push({ productId: change.productId, sku: change.sku, field: change.field, label: change.label, value: (change.channel as { value: unknown }).value })
    for (const extra of publication.full?.extras ?? []) removals.push({ productId: owner.productId, sku: extra.sku, field: 'variation',
      label: extra.action === 'delete' ? 'Variation removed from the listing' : 'Variation kept at quantity 0 (it has sales, so eBay keeps it)', value: extra.specifics })
    const nexusSku = ebayXmlText(parseEbayItemDocument(publication.xml).SKU)
    const warn = (message: string) => fullIssues.push({ productId: owner.productId, sku: owner.sku, severity: 'warning', message: `${owner.sku}: ${message}` })
    if (live && nexusSku && nexusSku !== ebayXmlText(live.SKU)) warn(`the seller SKU stays ${ebayXmlText(live.SKU) ?? 'empty'} on eBay (Nexus holds ${nexusSku}); a Full update never changes it.`)
    const keptAll = [...new Set([...kept, ...(publication.full?.keptRoots ?? [])])]
    if (live && keptAll.length) warn(`Full update leaves ${keptAll.length === 1 ? 'this field' : `these ${keptAll.length} fields`} as eBay holds ${keptAll.length === 1 ? 'it' : 'them'}: ${keptAll.join(', ')}.`)
    for (const sku of publication.full?.added ?? []) warn(`${sku} is new on this eBay item. Full update adds it at quantity 0 (it never sends stock); send its stock from the Matrix (Push quantity now) after the publish.`)
  }
  return { kind: 'ebay-changes', changes, remoteRevision: publication.liveRevision ?? (publication.itemId ? 'unavailable' : 'new'), publication,
    products: full ? identities : products, ownerProductId: owner.productId, liveSpecifics: theirs?.itemSpecifics ?? {}, aspectNames, createWrites,
    ...(full ? { full: true as const } : {}), ...(removals.length ? { removals } : {}), ...(fullIssues.length ? { fullIssues } : {}) }
}

export function compileEbayChanges(plan: EbayChangePlan, selectedIds: string[]): EbayPublication & { products: ProductIdentity[]; fieldWrites: Record<string, StudioPublishFieldWrite[]> } {
  const selected = selectPublicationChanges(plan.changes, selectedIds)
  if (!selected.length) return { ...plan.publication, xml: '', products: [], fieldWrites: {} }
  if (!plan.publication.itemId) return { ...plan.publication, products: plan.products, fieldWrites: plan.createWrites }
  if (!plan.publication.liveRevision || !plan.publication.liveContent || !plan.products.length) throw new Error('A successful live eBay read and linked listing are required before sending changes.')
  if (plan.full) {
    // Build shape v2 — a Full update is ONE Revise of the whole listing: every locked field, or nothing.
    const locked = plan.changes.filter(change => change.locked)
    if (selected.some(change => !change.locked) || selected.length !== locked.length) throw new Error('A Full update sends the whole eBay listing. Tick all of its fields, or none.')
    const full = plan.publication.full
    if (!full?.xml || full.blockers.length) throw new Error('This Full update cannot be sent. Review again.')
    const fieldWrites: Record<string, StudioPublishFieldWrite[]> = {}
    for (const change of selected) {
      if (change.current.state === 'unknown') throw new Error('An unknown value cannot be sent to eBay.')
      ;(fieldWrites[change.productId] ??= []).push({ field: change.field, value: change.current })
    }
    return { ...plan.publication, xml: full.xml, products: plan.products, fieldWrites }
  }
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
export function ebayPublicationRequest(plan: EbayPublication, operationId: string): { operation: 'ReviseFixedPriceItem' | 'AddFixedPriceItem'; xml: string } {
  if (!plan.xml) throw new Error('There are no selected eBay changes to send.')
  const key = escapeXml(operationId.replace(/-/g, '').toUpperCase())
  return { operation: plan.itemId ? 'ReviseFixedPriceItem' : 'AddFixedPriceItem', xml: plan.itemId
    ? plan.xml.replace(/(<ReviseFixedPriceItemRequest\b[^>]*>)/, `$1<InvocationID>${key}</InvocationID>`)
    : plan.xml.replace('<Item>', `<Item><UUID>${key}</UUID>`) }
}
