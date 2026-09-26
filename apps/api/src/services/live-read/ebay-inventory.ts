/**
 * PE P3.1 — read one eBay Inventory-model listing as it is live: the inventory_item_group (title, description, pictures,
 * shared aspects, variesBy), each inventory_item (variant aspects, available quantity) and GetItem (the price buyers see).
 * Read only. A value that could not be read is `unread` with its reason, never an empty value that looks like "no change".
 *
 * Nexus never stores the group key; it is assumed to be the parent SKU. When eBay does not know that key, the items are
 * asked which group they belong to — exactly one answer is used, anything else is an error (never a guess).
 */
import { markLiveVariants, type LiveReadDestination, type LiveReadError, type LiveValue, type LiveVariations } from '@nexus/shared/live-read'
import { publicationDigest } from '../pim/studio-publication-plan.js'
import { ebayAspectKey, ebayXmlList, ebayXmlObject, ebayXmlText, parseEbayItemDocument } from '../channel-drift/ebay-content-compare.js'
import type { ServerLiveRead } from './types.js'

type Json = Record<string, unknown>
export interface EbayInventoryRaw { groupKey: string | null; group: Json | null; items: Record<string, Json>; item: Json | null }
export interface EbayInventoryReads {
  group(key: string): Promise<{ status: number; body: Json | null }>
  /** bulk_get_inventory_item for at most 25 SKUs. */
  items(skus: string[]): Promise<Array<{ sku: string; statusCode: number; inventoryItem: Json | null }>>
  getItem(): Promise<{ xml: string | null; error?: string }>
}
export type EbayInventoryDestination = LiveReadDestination & { itemId: string; parentSku: string }

const value = (v: unknown): LiveValue => v == null || v === '' || (Array.isArray(v) && !v.length) ? { state: 'absent' } : { state: 'value', value: v }
const unread = (reason: string): LiveValue => ({ state: 'unread', reason })
const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
const texts = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size))
/** What a content send is compiled from. Available quantity is left out: stock moves by itself and is echoed fresh at send. */
const contentOf = (item: Json) => { const { availability: _availability, ...rest } = item; return rest }

export async function readEbayInventoryListing(destination: EbayInventoryDestination, reads: EbayInventoryReads, now = () => new Date()): Promise<ServerLiveRead<EbayInventoryRaw>> {
  const { expectedSkus, itemId: _itemId, parentSku, ...where } = destination
  const errors: LiveReadError[] = []
  let groupKey: string | null = parentSku
  let group: { status: number; body: Json | null; error?: string } = await reads.group(parentSku).catch(error => ({ status: 0, body: null, error: message(error) }))
  if (group.status === 404) {
    const answers = await reads.items(expectedSkus.slice(0, 25)).catch(() => [])
    // bulk_get_inventory_item names the link `inventoryItemGroupKeys` (measured 2026-09-26); `groupIds` is the single-item form.
    const keys = [...new Set(answers.flatMap(a => texts(obj(a.inventoryItem).inventoryItemGroupKeys ?? obj(a.inventoryItem).groupIds)))]
    groupKey = keys.length === 1 ? keys[0] : null
    if (groupKey) group = await reads.group(groupKey).catch(error => ({ status: 0, body: null, error: message(error) }))
    else errors.push({ scope: 'item', reason: keys.length ? `The items belong to ${keys.length} eBay groups; the group cannot be chosen.` : 'eBay knows no group for these SKUs.' })
  }
  const groupBody = group.status === 200 ? group.body : null
  if (!groupBody && groupKey) errors.push({ scope: 'item', reason: group.error ? `The eBay group could not be read: ${group.error}.` : `The eBay group could not be read (${group.status}).` })
  const groupReason = errors.find(e => e.scope === 'item')?.reason ?? ''

  const skus = [...new Set([...texts(groupBody?.variantSKUs), ...expectedSkus])]
  const items: Record<string, Json> = {}
  for (const batch of chunks(skus, 25)) {
    let failure: string | null = null
    const answers = await reads.items(batch).catch(error => { failure = message(error); return null })
    for (const sku of batch) {
      const answer = answers?.find(a => a.sku === sku)
      if (answer?.statusCode === 200 && answer.inventoryItem) items[sku] = answer.inventoryItem
      else if (!answer || answer.statusCode !== 404) errors.push({ scope: 'sku', sku, reason: failure ? `The eBay item could not be read: ${failure}.` : `The eBay item could not be read (${answer?.statusCode ?? 'eBay gave no answer for this SKU'}).` })
    }
  }

  const got = await reads.getItem().catch(error => ({ xml: null, error: error instanceof Error ? error.message : String(error) }))
  let item: Json | null = null
  try { item = got.xml ? parseEbayItemDocument(got.xml) : null } catch { item = null }
  if (!item) errors.push({ scope: 'field', field: 'price', reason: got.error ?? 'The eBay listing (GetItem) could not be read.' })
  const prices = new Map(ebayXmlList(ebayXmlObject(item?.Variations).Variation).map(ebayXmlObject)
    .map(v => [ebayXmlText(v.SKU), ebayXmlObject(v.StartPrice)] as const))

  const content: Record<string, LiveValue> = groupBody
    ? { title: value(groupBody.title), description: value(groupBody.description), pictures: value(texts(groupBody.imageUrls)),
      ...Object.fromEntries(Object.entries(obj(groupBody.aspects)).map(([name, values]) => [`aspect:${ebayAspectKey(name)}`, value(texts(values))])) }
    : { title: unread(groupReason), description: unread(groupReason), pictures: unread(groupReason) }

  let variations: LiveVariations | null = null
  if (groupBody) {
    const specifications = (obj(groupBody.variesBy).specifications as unknown[] | undefined ?? []).map(obj)
    const axes = specifications.map(s => String(s.name ?? '')).filter(Boolean)
    const live = texts(groupBody.variantSKUs).map(sku => {
      const inventoryItem = items[sku], aspects = obj(obj(inventoryItem?.product).aspects)
      const price = prices.get(sku), amount = ebayXmlText(price)
      const quantity = obj(obj(inventoryItem?.availability).shipToLocationAvailability).quantity
      return { sku,
        values: inventoryItem ? Object.fromEntries(axes.flatMap(axis => texts(aspects[axis]).slice(0, 1).map(v => [axis, v]))) : {},
        price: !item ? unread('The eBay listing (GetItem) could not be read.') : amount ? value({ amount, currency: typeof price?.['@_currencyID'] === 'string' ? price['@_currencyID'] : null }) : { state: 'absent' as const },
        stock: !inventoryItem ? unread('The eBay item could not be read.') : Number.isSafeInteger(quantity) ? value(quantity) : { state: 'absent' as const } }
    })
    variations = { axes, variants: markLiveVariants(expectedSkus, live), order: Object.fromEntries(specifications.map(s => [String(s.name ?? ''), texts(s.values)])) }
  }
  const revision = groupBody ? publicationDigest({ group: groupBody, items: Object.fromEntries(Object.keys(items).sort().map(sku => [sku, contentOf(items[sku])])) }) : null
  return { readAt: now().toISOString(), source: 'ebay-inventory-group', destination: where, revision, content, variations, errors,
    raw: { groupKey: groupBody ? groupKey : null, group: groupBody, items, item } }
}
