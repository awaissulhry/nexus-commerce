/**
 * P2.5 — pull an Etsy shop's receipts (Etsy's word for orders).
 *
 * Etsy orders have never entered Nexus. There is an `EstySyncService.syncOrders`, and
 * `jobs/etsy-sync.job.ts` wraps it as `syncEstyOrders` — but **nothing calls either**:
 * a grep for `syncEstyOrders` across `apps/api/src` finds only its own definition, with
 * `startTrackingPushbackCron` (3 hits: definition, import, call) as the control. And it
 * would have returned immediately anyway: it reads `ConfigManager.getConfig("ETSY")`,
 * which needs five `ETSY_*` environment variables, and production has none of them.
 *
 * So this is written against the account-scoped reader instead — the same path
 * `information-content.ts` already uses, which resolves the connection's own token and
 * goes through the channel gateway. No environment variables, one shop per account.
 *
 * Pull, not push, on purpose: a webhook tells us an order CHANGED, and this is what
 * then reads the authoritative version. It is also the whole ingest path whenever the
 * webhook is not configured, which is the state every installation starts in.
 */
import { logger } from '../../utils/logger.js'
import { etsyReader } from './read-client.js'

export interface EtsyReceipt {
  receipt_id: number
  status?: string
  created_timestamp?: number
  updated_timestamp?: number
  is_paid?: boolean
  is_shipped?: boolean
  buyer_email?: string
  name?: string
  grandtotal?: { amount: number; divisor: number; currency_code: string }
  transactions?: Array<{ transaction_id: number; listing_id?: number; product_id?: number; sku?: string; quantity?: number; title?: string }>
}

export interface ReceiptPullResult {
  shopId: string
  fetched: number
  receipts: EtsyReceipt[]
  truncated: boolean
}

const PAGE = 100
/** Etsy's limit/offset paging is bounded here so one sweep cannot run away. */
const MAX_PAGES = 10

/**
 * Receipts updated at or after `since`, newest first.
 *
 * `min_last_modified` is Etsy's own filter, so the window is applied by Etsy rather
 * than by reading everything and discarding most of it — which matters because Etsy's
 * rate limit is per app, shared by every connected shop.
 */
export async function pullEtsyReceipts(accountId: string, since: Date): Promise<ReceiptPullResult> {
  const { get, shopId } = await etsyReader(accountId)
  const minModified = Math.floor(since.getTime() / 1000)
  const receipts: EtsyReceipt[] = []
  let offset = 0
  let truncated = false

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await get<{ count: number; results: EtsyReceipt[] }>(
      `/shops/${shopId}/receipts?limit=${PAGE}&offset=${offset}&min_last_modified=${minModified}&sort_on=updated&sort_order=down`,
    )
    const batch = body?.results ?? []
    receipts.push(...batch)
    if (batch.length < PAGE) break
    offset += PAGE
    if (page === MAX_PAGES - 1) {
      // Said out loud rather than returning a quietly short list. A caller that cannot
      // tell "that is all of them" from "that is as many as I was willing to read"
      // will treat the second as the first.
      truncated = true
      logger.warn('[etsy-receipts] stopped at the page limit — more receipts remain in this window', {
        accountId, shopId, fetched: receipts.length, since: since.toISOString(),
      })
    }
  }
  return { shopId, fetched: receipts.length, receipts, truncated }
}

/** One receipt by id, which is what a webhook names. */
export async function pullEtsyReceipt(accountId: string, receiptId: string | number): Promise<EtsyReceipt | null> {
  const id = String(receiptId)
  if (!/^[1-9]\d*$/.test(id)) throw new Error('An Etsy receipt id must be a positive whole number.')
  const { get, shopId } = await etsyReader(accountId)
  try {
    return await get<EtsyReceipt>(`/shops/${shopId}/receipts/${id}`)
  } catch (error) {
    // A receipt id from an unverified source may simply not belong to this shop. That
    // is a routing answer, not a failure of the pull.
    logger.warn('[etsy-receipts] could not read one receipt', {
      accountId, shopId, receiptId: id, error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
