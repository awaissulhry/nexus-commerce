/**
 * PE P3.3 — send one change-only inventory_item_group PUT, and the live reads it rests on.
 *
 * Order: re-read → the revision must equal the review's → journal the exact request → PUT → read back. A 4xx answer means
 * eBay did not apply it (not sent); a failure without an answer is UNKNOWN, never retried here. Accepted only when the read
 * back shows every sent field. It never touches offers (no price, stock, publish or delete call) — whether eBay also needs
 * publish_by_inventory_item_group after a group change is proven on one listing first (P3.8), then decided.
 */
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { ebayAuthService } from '../ebay-auth.service.js'
import { callTradingApi, escapeXml, siteIdForMarket } from '../ebay-trading-api.service.js'
import { ebaySend } from '../gateway/ebay.js'
import { ebayListingLanguage } from '../gateway/channels.js'
import { readEbayInventoryListing, type EbayInventoryDestination, type EbayInventoryRaw, type EbayInventoryReads } from '../live-read/ebay-inventory.js'
import type { ServerLiveRead } from '../live-read/types.js'

type Json = Record<string, unknown>
export interface EbayInventorySendRequest { operation: 'PUT inventory_item_group'; groupKey: string; body: Json }
export interface EbayInventoryReceipt { reference: string; verified: boolean; warnings: string[]; readBack: ServerLiveRead<EbayInventoryRaw> | null }
const notSent = (error: unknown): never => { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { notSent: true }) }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const GROUP_FIELD: Record<string, string> = { title: 'title', description: 'description', pictures: 'imageUrls' }

/** The live eBay reads for one Inventory listing (production: KMS-sealed logins, so only the deployed API can make them). */
export function ebayInventoryReads(accountId: string, marketplace: string, itemId: string): EbayInventoryReads & { put(key: string, body: Json): Promise<{ status: number; text: string }> } {
  const api = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'
  const headers = async () => {
    const lang = await ebayListingLanguage(marketplace), token = await ebayAuthService.getValidToken(accountId)
    return { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Language': lang, 'Accept-Language': lang }
  }
  return {
    async group(key) {
      const res = await ebaySend(accountId, `${api}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(key)}`, { headers: await headers() })
      return { status: res.status, body: res.ok ? await res.json() as Json : null }
    },
    async items(skus) {
      const res = await ebaySend(accountId, `${api}/sell/inventory/v1/bulk_get_inventory_item`, { method: 'POST', headers: await headers(), body: JSON.stringify({ requests: skus.map(sku => ({ sku })) }) })
      if (!res.ok) throw new Error(`bulk_get_inventory_item ${res.status}`)
      const answer = await res.json() as { responses?: Array<{ sku?: string; statusCode?: number; inventoryItem?: Json }> }
      return (answer.responses ?? []).map(r => ({ sku: String(r.sku ?? ''), statusCode: Number(r.statusCode ?? 0), inventoryItem: r.inventoryItem ?? null }))
    },
    async getItem() {
      const oauthToken = await ebayAuthService.getValidToken(accountId)
      const got = await callTradingApi('GetItem', `<?xml version="1.0" encoding="UTF-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`,
        { oauthToken, siteId: siteIdForMarket(marketplace), connectionId: accountId, market: marketplace })
      return !got.raw || !['Success', 'Warning'].includes(got.ack) ? { xml: null, error: 'GetItem was not acknowledged.' } : { xml: got.raw }
    },
    async put(key, body) {
      const res = await ebaySend(accountId, `${api}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(key)}`, { method: 'PUT', headers: await headers(), body: JSON.stringify(body) })
      return { status: res.status, text: res.ok ? '' : (await res.text().catch(() => '')).slice(0, 500) }
    },
  }
}

export async function sendEbayInventoryGroup(input: {
  destination: EbayInventoryDestination; groupKey: string; group: Json; expectedRevision: string; fields: string[]
  reads: EbayInventoryReads & { put(key: string, body: Json): Promise<{ status: number; text: string }> }
  beforeSend?: (request: EbayInventorySendRequest) => Promise<void>
}): Promise<EbayInventoryReceipt> {
  if (getEbayPublishMode() !== 'live' || process.env.NEXUS_EBAY_REAL_API !== 'true' || process.env.EBAY_SANDBOX === 'true') notSent(new Error('Live eBay publication is disabled for this connection.'))
  const fresh = await readEbayInventoryListing(input.destination, input.reads).catch(notSent)
  if (!fresh.revision || fresh.revision !== input.expectedRevision || fresh.raw.groupKey !== input.groupKey) notSent(new Error('eBay changed after the review. Refresh the publication review.'))
  const request: EbayInventorySendRequest = { operation: 'PUT inventory_item_group', groupKey: input.groupKey, body: input.group }
  try { await input.beforeSend?.(request) } catch (error) { notSent(error) }
  const answer = await input.reads.put(input.groupKey, input.group)
  if (answer.status >= 400 && answer.status < 500) notSent(new Error(`eBay refused the group update (${answer.status}): ${answer.text || 'no detail'}`))
  if (answer.status < 200 || answer.status >= 300) throw new Error(`eBay did not confirm the group update (${answer.status}). Check the listing before retrying.`)
  const readBack = await readEbayInventoryListing(input.destination, input.reads).catch(() => null)
  const live = readBack?.raw.group ?? null
  const missing = input.fields.filter(field => {
    if (!live) return true
    if (field.startsWith('aspect:')) return !same((live.aspects as Json | undefined) ?? {}, (input.group.aspects as Json | undefined) ?? {})
    return !same(live[GROUP_FIELD[field] ?? field], input.group[GROUP_FIELD[field] ?? field])
  })
  return { reference: input.groupKey, readBack, verified: !missing.length,
    warnings: !live ? ['eBay accepted the update; the read-back failed. Check the listing.'] : missing.length ? [`eBay accepted the update, but the read-back differs for: ${missing.join(', ')}.`] : [] }
}
