/**
 * W12.1 — Amazon JSON_LISTINGS_FEED batch submission.
 *
 * Packs N listing updates into ONE feed call (vs N per-SKU
 * postPrice/postStock calls). At Xavia's ~280-SKU catalog scope
 * this is the difference between 280 SP-API calls and one. The
 * SP-API throttle for Listings calls is per-second; Feeds is
 * per-request, so a single feed costs one quota tick regardless
 * of message count.
 *
 * Pipeline (mirrors the amazon-pushback service for shape parity):
 *   1. createFeedDocument        → returns feedDocumentId + presigned URL
 *   2. PUT to presigned URL      → upload the JSONL body
 *   3. createFeed                → returns feedId
 *
 * Polling for terminal status is a follow-up — the bulk-operations
 * job stays IN_PROGRESS until the operator pulls the feed
 * processing report (separate endpoint). v0 returns feedId
 * immediately so the per-item BulkActionItem rows can carry the
 * Amazon side ID for downstream reconciliation.
 */

import { logger } from '../../utils/logger.js'

export type AmazonBatchOperation =
  | { type: 'price'; sku: string; currency: string; value: number }
  | { type: 'stock'; sku: string; quantity: number }
  | { type: 'status'; sku: string; status: 'ACTIVE' | 'INACTIVE' }

export interface AmazonBatchSubmission {
  marketplaceIds: string[]
  sellerId: string
  operations: AmazonBatchOperation[]
}

export interface AmazonBatchResult {
  feedId: string
  feedDocumentId: string
  messageCount: number
  dryRun: boolean
}

/**
 * Build the JSONL body Amazon expects. One newline-delimited JSON
 * object per message; the header is a regular JSON line at the top.
 *
 * The JSON_LISTINGS_FEED v2.0 spec accepts `messages: []` either as
 * a JSONL stream (one message per line) or as a single JSON envelope
 * — we use the envelope form since Amazon's docs show that's the
 * preferred path for createFeed-style flows.
 */
export function buildJsonListingsFeedBody(
  input: AmazonBatchSubmission,
): string {
  const messages = input.operations.map((op, i) => {
    const messageId = i + 1
    if (op.type === 'price') {
      return {
        messageId,
        operationType: 'Update',
        productType: 'PRODUCT',
        attributes: {
          sku: op.sku,
          price: { currency: op.currency, value: op.value },
        },
      }
    }
    if (op.type === 'stock') {
      return {
        messageId,
        operationType: 'Update',
        productType: 'PRODUCT',
        attributes: {
          sku: op.sku,
          fulfillmentAvailability: [
            { fulfillmentChannelCode: 'DEFAULT', quantity: op.quantity },
          ],
        },
      }
    }
    // status
    return {
      messageId,
      operationType: 'Update',
      productType: 'PRODUCT',
      attributes: {
        sku: op.sku,
        // SP-API encodes status as merchant_suggested_asin -> none, but
        // the canonical Listings approach is to set the SKU's status
        // via the catalog-items API. For W12.1 we use the simplified
        // attribute path; a follow-up moves status to the dedicated
        // patchListingsItem call when we add that.
        status: { value: op.status },
      },
    }
  })
  return JSON.stringify({
    header: {
      sellerId: input.sellerId,
      version: '2.0',
      issueLocale: 'en_US',
    },
    messages,
  })
}

function isDryRunEnv(): boolean {
  return process.env.NEXUS_AMAZON_BATCH_DRYRUN === '1'
}

export async function submitAmazonListingsBatch(
  input: AmazonBatchSubmission,
): Promise<AmazonBatchResult> {
  if (input.operations.length === 0) {
    throw new Error('AmazonBatch: operations must be non-empty')
  }
  if (input.operations.length > 10_000) {
    // Amazon's documented cap on a single feed.
    throw new Error('AmazonBatch: max 10,000 messages per feed')
  }
  if (!input.sellerId) throw new Error('AmazonBatch: sellerId required')
  if (!input.marketplaceIds || input.marketplaceIds.length === 0) {
    throw new Error('AmazonBatch: marketplaceIds required')
  }

  const body = buildJsonListingsFeedBody(input)

  if (isDryRunEnv()) {
    logger.info('[amazon-batch] dryRun — feed not submitted', {
      messageCount: input.operations.length,
      bytes: body.length,
    })
    return {
      feedId: `dryrun-${Date.now()}`,
      feedDocumentId: `dryrun-doc-${Date.now()}`,
      messageCount: input.operations.length,
      dryRun: true,
    }
  }

  // Lazy-load the SP-API client so dry-run paths never pay the
  // import cost (the client pulls in AWS auth chain + a 1MB+ tree).
  const { SellingPartner } = await import('amazon-sp-api')
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  const lwaClientId = process.env.AMAZON_LWA_CLIENT_ID
  const lwaClientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  if (!refreshToken || !lwaClientId || !lwaClientSecret) {
    throw new Error(
      'AmazonBatch: AMAZON_REFRESH_TOKEN / AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET required',
    )
  }
  const sp: any = new SellingPartner({
    region: (process.env.AMAZON_REGION ?? 'eu') as any,
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: lwaClientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: lwaClientSecret,
    },
    options: { auto_request_tokens: true, auto_request_throttled: true },
  })

  // Step 1: create feed document slot.
  const docRes: any = await sp.callAPI({
    operation: 'createFeedDocument',
    endpoint: 'feeds',
    body: { contentType: 'application/json; charset=UTF-8' },
  })
  const feedDocumentId: string = docRes.feedDocumentId
  const uploadUrl: string = docRes.url

  // Step 2: upload the body to the presigned URL.
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body,
  })
  if (!uploadRes.ok) {
    throw new Error(
      `AmazonBatch: upload failed HTTP ${uploadRes.status} ${uploadRes.statusText}`,
    )
  }

  // Step 3: create the feed.
  const feedRes: any = await sp.callAPI({
    operation: 'createFeed',
    endpoint: 'feeds',
    body: {
      feedType: 'JSON_LISTINGS_FEED',
      marketplaceIds: input.marketplaceIds,
      inputFeedDocumentId: feedDocumentId,
    },
  })

  return {
    feedId: feedRes.feedId,
    feedDocumentId,
    messageCount: input.operations.length,
    dryRun: false,
  }
}

/**
 * Poll the feed's terminal status. Used by the bulk-operations job
 * once the operator wants to reconcile per-message results. v0
 * returns the raw shape; a v1 helper could parse the
 * processingReport document and map per-SKU outcomes to
 * BulkActionItem rows.
 */
export async function pollAmazonFeedStatus(feedId: string): Promise<{
  feedId: string
  processingStatus: string
  resultFeedDocumentId: string | null
}> {
  if (isDryRunEnv()) {
    return {
      feedId,
      processingStatus: 'DONE',
      resultFeedDocumentId: null,
    }
  }
  const { SellingPartner } = await import('amazon-sp-api')
  const sp: any = new SellingPartner({
    region: (process.env.AMAZON_REGION ?? 'eu') as any,
    refresh_token: process.env.AMAZON_REFRESH_TOKEN!,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID!,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET!,
    },
    options: { auto_request_tokens: true, auto_request_throttled: true },
  })
  const res: any = await sp.callAPI({
    operation: 'getFeed',
    endpoint: 'feeds',
    path: { feedId },
  })
  return {
    feedId,
    processingStatus: res.processingStatus,
    resultFeedDocumentId: res.resultFeedDocumentId ?? null,
  }
}
