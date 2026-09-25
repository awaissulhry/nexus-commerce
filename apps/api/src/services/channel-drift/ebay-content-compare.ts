/**
 * PLAN A-39 slice b2 (R-41, R-43) — what eBay HOLDS for a listing's title and item-level item specifics, against what the
 * studio builder WOULD SEND (`buildEbayListingInput`, extracted from `prepareEbayPublication`).
 *
 * Pure. The result feeds the ONE drift writer (`recordChannelReadback`) as source `ebay-content`.
 *
 * Rules, each a gate arm:
 *   · the title is compared as one normalised text (field `title`);
 *   · an item specific is compared per aspect NAME (case-insensitive, NFC, spaces collapsed) as a SET of normalised values
 *     (field `aspect:<our name>`) — eBay may return a multi-value aspect's values in any order;
 *   · ours present and theirs absent IS drift (`theirs: null`);
 *   · an aspect only eBay holds is NOT compared — we do not send it (eBay adds catalogue aspects of its own);
 *   · variation specifics are structure (the variation resolver owns them) and never read as item specifics.
 */
import type { DriftField } from '../channel-drift.service.js'
import { normaliseText, type Comparison, type NotCompared } from './amazon-content-compare.js'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

export const EBAY_CONTENT_SOURCE = 'ebay-content'

/** The coordinator's exact wording (R-43): a live shell's title and item specifics are never written by Nexus. */
export const EBAY_SHELL_REASON = 'shell listing: Nexus does not write a live shell\'s title or item specifics (the shared push is pool-only after creation)'

export interface EbayItemContent { title: string | null; itemSpecifics: Record<string, string[]> }

export const ebayXmlObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const ebayXmlList = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value]
export const ebayXmlText = (value: unknown): string | null => typeof value === 'string' ? value : typeof ebayXmlObject(value)['#text'] === 'string' ? ebayXmlObject(value)['#text'] as string : null

/** Parse only actual Item children; markup inside Description/CDATA is content, never fields. */
export function parseEbayItemDocument(xml: string): Record<string, unknown> {
  if (XMLValidator.validate(xml) !== true) throw new Error('The eBay XML content could not be parsed.')
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: false, htmlEntities: true }).parse(xml)
  const root = ebayXmlObject(parsed)
  return ebayXmlObject(root.Item ?? ebayXmlObject(root.GetItemResponse).Item
    ?? ebayXmlObject(root.ReviseFixedPriceItemRequest).Item ?? ebayXmlObject(root.AddFixedPriceItemRequest).Item)
}

const publicationRoots = ['SKU', 'InventoryTrackingMethod', 'Title', 'SubTitle', 'Description', 'PrimaryCategory', 'ConditionID', 'Country', 'Currency', 'Location', 'PostalCode',
  'ListingDuration', 'ItemSpecifics', 'StartPrice', 'Quantity', 'ProductListingDetails', 'Variations', 'PictureDetails', 'SellerProfiles',
  'DispatchTimeMax', 'VATDetails', 'BestOfferDetails', 'QuantityRestrictionPerBuyer']

/** The real GetItem preparation and revision digest use this same stable projection. */
export function parseEbayPublicationItem(xml: string): Record<string, unknown> {
  const item = parseEbayItemDocument(xml)
  return JSON.parse(JSON.stringify(Object.fromEntries(publicationRoots.filter(key => item[key] !== undefined).map(key => [key, item[key]])),
    (key, value) => key === 'QuantitySold' || (key === '#text' && typeof value === 'string' && !value.trim()) ? undefined : value))
}

export function ebayContentFromItem(item: Record<string, unknown>): EbayItemContent {
  const itemSpecifics: Record<string, string[]> = {}
  for (const entry of ebayXmlList(ebayXmlObject(item.ItemSpecifics).NameValueList)) {
    const nv = ebayXmlObject(entry), name = ebayXmlText(nv.Name)
    if (name === null) continue
    const values = ebayXmlList(nv.Value).map(ebayXmlText).filter((value): value is string => value !== null)
    itemSpecifics[name] = [...(itemSpecifics[name] ?? []), ...values]
  }
  return { title: ebayXmlText(item.Title), itemSpecifics }
}

/**
 * Title + item-level ItemSpecifics from a Trading XML (a GetItem answer, or an Add/Revise request the builder made).
 * EVERY `<Value>` of an aspect is kept (three older readers keep only the first); entities are decoded; the
 * `<Variations>` block is removed first, so a variation's specifics are never mistaken for the item's.
 */
export function parseEbayItemContent(xml: string): EbayItemContent {
  return ebayContentFromItem(parseEbayItemDocument(xml))
}

export const ebayAspectKey = (name: string) => normaliseText(name).toLowerCase()
const valueSet = (values: readonly unknown[]) => [...new Set(values.map(normaliseText).filter(Boolean))].sort()
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

/** Ours: the builder's `shared.title` and `shared.itemSpecifics` (a value may be one text or a list). */
export interface EbayOursContent { title: string; itemSpecifics: Record<string, string | string[]> }

export function compareEbayContent(ours: EbayOursContent, theirs: EbayItemContent): Comparison {
  const compared: string[] = []
  const differing: DriftField[] = []
  const notCompared: NotCompared[] = []

  const ourTitle = normaliseText(ours.title)
  if (!ourTitle) notCompared.push({ field: 'title', reason: 'no title of ours' })
  else {
    compared.push('title')
    const theirTitle = theirs.title === null ? null : normaliseText(theirs.title)
    if (theirTitle !== ourTitle) differing.push({ field: 'title', ours: ourTitle, theirs: theirTitle })
  }

  const theirsByName = new Map<string, string[]>()
  for (const [name, values] of Object.entries(theirs.itemSpecifics)) {
    const key = ebayAspectKey(name)
    theirsByName.set(key, [...(theirsByName.get(key) ?? []), ...values])
  }
  const ourKeys = new Set<string>()
  for (const [name, raw] of Object.entries(ours.itemSpecifics)) {
    const values = valueSet(Array.isArray(raw) ? raw : [raw])
    const field = `aspect:${name}`
    if (!values.length) { notCompared.push({ field, reason: 'no value of ours' }); continue }
    ourKeys.add(ebayAspectKey(name))
    compared.push(field)
    const theirValues = theirsByName.get(ebayAspectKey(name))
    if (!theirValues) { differing.push({ field, ours: values, theirs: null }); continue }
    const theirSet = valueSet(theirValues)
    if (!sameSet(values, theirSet)) differing.push({ field, ours: values, theirs: theirSet })
  }
  for (const [name] of Object.entries(theirs.itemSpecifics)) {
    if (!ourKeys.has(ebayAspectKey(name))) notCompared.push({ field: `aspect:${name}`, reason: 'we do not send this aspect' })
  }
  return { compared, differing, notCompared }
}
