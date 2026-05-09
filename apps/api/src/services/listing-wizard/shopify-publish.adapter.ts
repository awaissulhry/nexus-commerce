/**
 * S.2 — Shopify publish adapter (Admin REST API 2024-01).
 *
 * Single call:
 *   POST https://{shop}.myshopify.com/admin/api/{ver}/products.json
 *
 * Mirrors the EbayPublishAdapter pattern: fetch-based, retry/backoff
 * on transient errors, never throws (returns {ok:false} so the
 * channel-publish dispatcher can complete every channel without one
 * bad adapter sinking the others).
 *
 * v1 publishes the master product as a single-variant draft. The
 * operator activates it on the Shopify side after reviewing — keeps
 * the wizard from surprise-shipping a live listing the operator
 * hasn't sanity-checked. Variation expansion (multi-variant Shopify
 * products) lands in a follow-up: this adapter ships the parent and
 * returns the productId; the wizard route can then iterate
 * payload.children and POST /admin/api/{ver}/products/{id}/variants.json
 * for each.
 *
 * NOT END-TO-END TESTED — wiring is real but exercising it requires
 * SHOPIFY_SHOP_NAME + SHOPIFY_ACCESS_TOKEN env (Admin API access
 * token from a custom app, not a Storefront token). Until creds are
 * configured the adapter returns ok=false with a clear "config" step
 * so the wizard's submissions log surfaces the actionable error.
 */

import { logger } from '../../utils/logger.js'

interface ShopifyVariantInput {
  sku: string
  price: string
  compare_at_price?: string
  inventory_quantity?: number
  inventory_management?: string
  inventory_policy?: string
}

interface ShopifyImageInput {
  src: string
}

interface ShopifyProductInput {
  title: string
  body_html: string
  vendor: string
  product_type: string
  tags: string[] | string
  status: 'draft' | 'active' | 'archived'
  variants: ShopifyVariantInput[]
  images?: ShopifyImageInput[]
}

interface ShopifyPayload {
  /** Reserved for the Shopify Markets multi-store case. Currently
   *  ignored — adapter uses SHOPIFY_SHOP_NAME from env. When
   *  multi-store lands the env can become a per-marketplace lookup. */
  shop?: string
  product: ShopifyProductInput
}

export interface ShopifyPublishResult {
  ok: boolean
  /** Numeric Shopify product id, returned by the create endpoint.
   *  Persisted to ChannelListing.externalListingId for poll-based
   *  follow-ups. */
  productId?: string
  /** Storefront URL once the product is set to active. Draft
   *  products don't have a public URL; we surface the admin URL
   *  instead so the operator can jump to the listing. */
  listingUrl?: string
  /** First created variant id — useful when the publish path needs
   *  to follow up with variant updates. */
  firstVariantId?: string
  /** Number of variants created. v1 always 1. */
  variantCount?: number
  /** Human-readable error when ok=false. */
  error?: string
  /** Which step failed (config | productCreate | parse). */
  failedStep?: string
}

const ADMIN_API_VERSION = '2024-01'

// C.1-style symmetric retry/backoff. Same policy as Amazon SP-API +
// eBay Inventory adapters: 3 retries (1s/2s/4s) on 429 + 5xx +
// network errors; non-retryable on other 4xx so caller errors fail
// fast.
const SHOPIFY_RETRY_DELAYS_MS = [1000, 2000, 4000] as const
const SHOPIFY_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

async function shopifyFetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  let lastErr: unknown = null
  const maxAttempts = SHOPIFY_RETRY_DELAYS_MS.length + 1
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url, init)
      if (!SHOPIFY_RETRY_DELAYS_MS[attempt]) return response
      if (!SHOPIFY_RETRYABLE_STATUSES.has(response.status)) return response
      try {
        await response.text()
      } catch {
        // ignore body-read failures on a discarded response
      }
      const delay = SHOPIFY_RETRY_DELAYS_MS[attempt]!
      logger.warn('Shopify retryable status — backing off', {
        label,
        attempt: attempt + 1,
        status: response.status,
        delayMs: delay,
      })
      await new Promise((r) => setTimeout(r, delay))
    } catch (err) {
      lastErr = err
      if (!SHOPIFY_RETRY_DELAYS_MS[attempt]) throw err
      const delay = SHOPIFY_RETRY_DELAYS_MS[attempt]!
      logger.warn('Shopify network error — backing off', {
        label,
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
        delayMs: delay,
      })
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('Shopify fetchWithRetry exhausted')
}

interface ShopifyVariantResponse {
  id: number
  product_id: number
  sku: string
  price: string
}

interface ShopifyProductResponse {
  id: number
  title: string
  handle: string
  status: string
  variants: ShopifyVariantResponse[]
}

export class ShopifyPublishAdapter {
  /**
   * Publish a single Shopify product. v1 ships master-only as draft.
   * Returns the productId on success; the wizard route persists it
   * to ChannelListing.externalListingId for the poll path.
   */
  async publish(payload: ShopifyPayload): Promise<ShopifyPublishResult> {
    const shopName = process.env.SHOPIFY_SHOP_NAME ?? ''
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN ?? ''

    if (!shopName || !accessToken) {
      return {
        ok: false,
        error:
          'SHOPIFY_SHOP_NAME / SHOPIFY_ACCESS_TOKEN not configured. Set both before publishing.',
        failedStep: 'config',
      }
    }
    if (!payload?.product?.title) {
      return {
        ok: false,
        error: 'Composed payload is missing product.title — wizard content not finished.',
        failedStep: 'config',
      }
    }
    if (
      !Array.isArray(payload.product.variants) ||
      payload.product.variants.length === 0
    ) {
      return {
        ok: false,
        error: 'Composed payload has no variants — at least one is required.',
        failedStep: 'config',
      }
    }

    const url = `https://${shopName}.myshopify.com/admin/api/${ADMIN_API_VERSION}/products.json`
    // Shopify expects tags as a comma-separated string at the REST
    // surface; the composer hands us either form, normalize here.
    const tagsValue = Array.isArray(payload.product.tags)
      ? payload.product.tags.join(', ')
      : payload.product.tags ?? ''
    const body = {
      product: {
        ...payload.product,
        tags: tagsValue,
      },
    }

    let response: Response
    try {
      response = await shopifyFetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        'productCreate',
      )
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? `Shopify network error: ${err.message}`
            : 'Shopify network error (unknown).',
        failedStep: 'productCreate',
      }
    }

    let parsed: { product?: ShopifyProductResponse; errors?: unknown } | null = null
    try {
      parsed = (await response.json()) as {
        product?: ShopifyProductResponse
        errors?: unknown
      }
    } catch {
      // Body wasn't JSON — fall through to the !response.ok path
      // with a generic message.
    }

    if (!response.ok) {
      const errMsg =
        parsed?.errors !== undefined
          ? typeof parsed.errors === 'string'
            ? parsed.errors
            : JSON.stringify(parsed.errors)
          : `Shopify productCreate failed (HTTP ${response.status}).`
      return {
        ok: false,
        error: errMsg.slice(0, 500),
        failedStep: 'productCreate',
      }
    }

    if (!parsed?.product?.id) {
      return {
        ok: false,
        error: 'Shopify productCreate returned 2xx but no product id.',
        failedStep: 'parse',
      }
    }

    const product = parsed.product
    const productId = String(product.id)
    const adminUrl = `https://${shopName}.myshopify.com/admin/products/${productId}`

    return {
      ok: true,
      productId,
      // Use the admin URL — draft listings have no storefront URL.
      // Operators can flip to "active" via the admin and the public
      // URL becomes /products/{handle}; we leave that swap to a poll
      // step that reads back the status field.
      listingUrl: adminUrl,
      firstVariantId:
        Array.isArray(product.variants) && product.variants.length > 0
          ? String(product.variants[0]!.id)
          : undefined,
      variantCount: Array.isArray(product.variants)
        ? product.variants.length
        : 0,
    }
  }
}
