/**
 * Read live — one eBay Trading listing as buyers see it now (GetItem), in the shared LiveRead shape. Read only.
 * The revision is the same digest the publish review re-checks before a send (`ebayLiveContentRevision`).
 * Stock is what eBay has AVAILABLE: GetItem's Quantity is the lifetime total, so available = Quantity − QuantitySold.
 */
import { markLiveVariants, type LiveReadDestination, type LiveReadError, type LiveValue, type LiveVariations } from '@nexus/shared/live-read'
import { ebayAspectKey, ebayContentFromItem, ebayXmlList, ebayXmlObject, ebayXmlText, parseEbayItemDocument, parseEbayPublicationItem } from '../channel-drift/ebay-content-compare.js'
import { publicationDigest } from '../pim/studio-publication-plan.js'
import type { ServerLiveRead } from './types.js'

export interface EbayTradingRaw { xml: string | null }
export type EbayTradingDestination = LiveReadDestination & { itemId: string }
export interface EbayTradingReads { getItem(): Promise<{ xml: string | null; error?: string }> }

const value = (v: unknown): LiveValue => v == null || v === '' || (Array.isArray(v) && !v.length) ? { state: 'absent' } : { state: 'value', value: v }
const unread = (reason: string): LiveValue => ({ state: 'unread', reason })
const count = (v: unknown) => { const n = Number(ebayXmlText(v)); return ebayXmlText(v) !== null && Number.isSafeInteger(n) ? n : null }

export async function readEbayTradingListing(destination: EbayTradingDestination, reads: EbayTradingReads, now = () => new Date()): Promise<ServerLiveRead<EbayTradingRaw>> {
  const { expectedSkus, itemId, ...where } = destination
  const errors: LiveReadError[] = []
  const got = await reads.getItem().catch(error => ({ xml: null, error: error instanceof Error ? error.message : String(error) }))
  let item: Record<string, unknown> | null = null
  try { item = got.xml ? parseEbayItemDocument(got.xml) : null } catch { item = null }
  if (item && ebayXmlText(item.ItemID) !== itemId) item = null
  if (!item) {
    const reason = got.error ?? (got.xml ? 'eBay returned another or an unreadable listing.' : 'The eBay listing (GetItem) could not be read.')
    errors.push({ scope: 'item', reason })
    return { readAt: now().toISOString(), source: 'ebay-trading-item', destination: where, revision: null, variations: null, errors,
      content: { title: unread(reason), description: unread(reason), pictures: unread(reason) }, raw: { xml: got.xml } }
  }
  const aspects = ebayContentFromItem(item).itemSpecifics, merged: Record<string, string[]> = {}
  for (const [name, values] of Object.entries(aspects)) (merged[`aspect:${ebayAspectKey(name)}`] ??= []).push(...values)
  const content: Record<string, LiveValue> = { title: value(ebayXmlText(item.Title)), description: value(ebayXmlText(item.Description)),
    pictures: value(ebayXmlList(ebayXmlObject(item.PictureDetails).PictureURL).map(ebayXmlText).filter((u): u is string => u !== null)),
    ...Object.fromEntries(Object.entries(merged).map(([field, values]) => [field, value(values)])) }

  let variations: LiveVariations | null = null
  const variationRoot = ebayXmlObject(item.Variations)
  if (item.Variations !== undefined) {
    const set = ebayXmlList(ebayXmlObject(variationRoot.VariationSpecificsSet).NameValueList).map(ebayXmlObject)
    const axes = set.map(nv => ebayXmlText(nv.Name)).filter((n): n is string => !!n)
    const live = ebayXmlList(variationRoot.Variation).map(ebayXmlObject).map(v => {
      const sku = ebayXmlText(v.SKU) ?? ''
      const values = Object.fromEntries(ebayXmlList(ebayXmlObject(v.VariationSpecifics).NameValueList).map(ebayXmlObject)
        .map(nv => [ebayXmlText(nv.Name), ebayXmlText(ebayXmlList(nv.Value)[0])] as const).filter((e): e is [string, string] => !!e[0] && e[1] !== null))
      const price = ebayXmlObject(v.StartPrice), amount = ebayXmlText(price)
      const total = count(v.Quantity), sold = count(ebayXmlObject(v.SellingStatus).QuantitySold) ?? 0
      return { sku, values,
        price: amount ? value({ amount, currency: typeof price['@_currencyID'] === 'string' ? price['@_currencyID'] : null }) : { state: 'absent' as const },
        stock: total === null ? unread('eBay did not report this variation\'s quantity.') : value(Math.max(0, total - sold)) }
    })
    variations = { axes, variants: markLiveVariants(expectedSkus, live),
      order: Object.fromEntries(set.map(nv => [ebayXmlText(nv.Name) ?? '', ebayXmlList(nv.Value).map(ebayXmlText).filter((x): x is string => x !== null)])) }
  }
  return { readAt: now().toISOString(), source: 'ebay-trading-item', destination: where, revision: publicationDigest(parseEbayPublicationItem(got.xml!)),
    content, variations, errors, raw: { xml: got.xml } }
}
