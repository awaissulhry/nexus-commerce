/**
 * MCP full control I7 — what an Amazon, Shopify or Etsy account holds, for the per-account sweep
 * (channel-held.service.ts; eBay's reader lives there). Every read goes through the channel gateway by the existing
 * read clients, and each is incomplete — never "everything" — when a page failed, a cap stopped it, or the channel
 * answered with nothing where this account has live listings:
 *
 *   Amazon   the merchant listings report (GET_MERCHANT_LISTINGS_ALL_DATA) per market the account sells in, for THIS
 *            account (AmazonService.fetchActiveCatalog now takes the account; it used the primary one only — G3).
 *            One id per ASIN and seller SKU.
 *   Shopify  products and their variants, paged, through the read-only admin client: the product id (the id a
 *            listing carries) with each variant's SKU.
 *   Etsy     the shop's active listings, paged: the listing id with each SKU.
 *
 * The transports are injectable so tests stand the channel in; KMS-sealed logins make real reads deployed-only.
 */
import prisma from '../../db.js'
import { shortShopifyId } from './identity-read.service.js'
import type { HeldConnection, HeldItem, HeldRead, HeldReader } from './channel-held.service.js'

const pageCapOf = (cap?: number) => cap ?? Number(process.env.NEXUS_IDENTITY_SWEEP_PAGE_CAP ?? 50)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ── Amazon ────────────────────────────────────────────────────────────────────────────────────────────

export interface AmazonCatalogRow { sku: string; asin: string; parentAsin: string | null; title: string; status: string }

export function amazonHeldReader(options: {
  fetchCatalog?: (accountId: string, marketplaceId: string) => Promise<AmazonCatalogRow[]>
} = {}): HeldReader {
  const fetchCatalog = options.fetchCatalog ?? (async (accountId: string, marketplaceId: string) => {
    const { AmazonService } = await import('../marketplaces/amazon.service.js')
    return new AmazonService().fetchActiveCatalog(marketplaceId, accountId)
  })
  return {
    channel: 'AMAZON',
    async read(connection: HeldConnection): Promise<HeldRead> {
      const { AMAZON_MARKETPLACE_CODE_TO_ID } = await import('../marketplaces/amazon.service.js')
      // The markets this account sells in: its listings', else the account's own.
      const listed = await prisma.channelListing.groupBy({
        by: ['marketplace'],
        where: { channelConnectionId: connection.id, channel: 'AMAZON' },
        _count: { _all: true },
      })
      const markets = [...new Set([...listed.map((l) => l.marketplace), ...(connection.marketplace ? [connection.marketplace] : [])])].sort()
      const items: HeldItem[] = []
      const problems: string[] = []
      for (const market of markets) {
        const marketplaceId = AMAZON_MARKETPLACE_CODE_TO_ID[market.toUpperCase()]
        if (!marketplaceId) {
          problems.push(`${market}: no Amazon marketplace id`)
          continue
        }
        let rows: AmazonCatalogRow[]
        try {
          rows = await fetchCatalog(connection.id, marketplaceId)
        } catch (error) {
          problems.push(`${market}: the listings report failed (${message(error)})`)
          continue
        }
        const live = await prisma.channelListing.count({ where: { channelConnectionId: connection.id, channel: 'AMAZON', marketplace: market, listingStatus: 'ACTIVE', externalListingId: { not: null } } })
        // An empty report where this account has live listings is not "holds nothing".
        if (rows.length === 0 && live > 0) {
          problems.push(`${market}: the report was empty while ${live} listing(s) are live`)
          continue
        }
        for (const row of rows) {
          if (!row.asin) continue
          items.push({ marketplace: market.toUpperCase(), externalId: row.asin, sellerSku: row.sku ?? '', parentExternalId: row.parentAsin, title: row.title, remoteStatus: row.status })
        }
      }
      if (markets.length === 0) problems.push('the account sells in no known market')
      return problems.length ? { items, complete: false, reason: problems.join('; ') } : { items, complete: true }
    },
  }
}

// ── Shopify ───────────────────────────────────────────────────────────────────────────────────────────

type ShopifyRead = (query: string, variables?: Record<string, unknown>) => Promise<{ data: any; errors: Array<{ message?: string }> }>

const SHOPIFY_PRODUCTS = `query NexusHeldProducts($after: String) {
  products(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id title status variants(first: 250) { pageInfo { hasNextPage } nodes { id sku } } }
  }
}`

export function shopifyHeldReader(options: { read?: (accountId: string) => Promise<ShopifyRead>; pageCap?: number } = {}): HeldReader {
  const reader = options.read ?? (async (accountId: string) => {
    const { shopifyAdminReader } = await import('../shopify/admin-client.js')
    return (await shopifyAdminReader(accountId)).read as unknown as ShopifyRead
  })
  return {
    channel: 'SHOPIFY',
    async read(connection: HeldConnection): Promise<HeldRead> {
      const read = await reader(connection.id)
      const items: HeldItem[] = []
      let after: string | null = null
      const cap = pageCapOf(options.pageCap)
      for (let page = 1; page <= cap; page++) {
        let answer: Awaited<ReturnType<ShopifyRead>>
        try {
          answer = await read(SHOPIFY_PRODUCTS, { after })
        } catch (error) {
          return { items, complete: false, reason: `page ${page} could not be read: ${message(error)}` }
        }
        if (answer.errors?.length || !answer.data?.products) {
          return { items, complete: false, reason: `page ${page}: ${answer.errors?.[0]?.message ?? 'Shopify answered nothing'}` }
        }
        for (const product of answer.data.products.nodes ?? []) {
          const productId = shortShopifyId(product.id)
          if (!productId) continue
          if (product.variants?.pageInfo?.hasNextPage) return { items, complete: false, reason: `product ${productId} has more than 250 variants` }
          const skus: string[] = (product.variants?.nodes ?? []).map((v: { sku?: string | null }) => (v.sku ?? '').trim())
          for (const sku of skus.length ? skus : ['']) {
            items.push({ marketplace: 'GLOBAL', externalId: productId, sellerSku: sku, title: product.title, remoteStatus: product.status })
          }
        }
        if (!answer.data.products.pageInfo?.hasNextPage) return { items, complete: true }
        after = answer.data.products.pageInfo.endCursor
        if (page === cap) return { items, complete: false, reason: `stopped at the ${cap}-page cap (NEXUS_IDENTITY_SWEEP_PAGE_CAP)` }
      }
      return { items, complete: false, reason: 'no page was read' }
    },
  }
}

// ── Etsy ──────────────────────────────────────────────────────────────────────────────────────────────

type EtsyGet = <T>(path: string) => Promise<T>
interface EtsyListingsPage { count: number; results: Array<{ listing_id: number | string; title?: string; state?: string; skus?: string[] }> }

export function etsyHeldReader(options: { reader?: (accountId: string) => Promise<{ get: EtsyGet; shopId: string | number }>; pageCap?: number } = {}): HeldReader {
  const open = options.reader ?? (async (accountId: string) => {
    const { etsyReader } = await import('../etsy/read-client.js')
    return etsyReader(accountId) as unknown as Promise<{ get: EtsyGet; shopId: string | number }>
  })
  return {
    channel: 'ETSY',
    async read(connection: HeldConnection): Promise<HeldRead> {
      const { get, shopId } = await open(connection.id)
      const items: HeldItem[] = []
      const limit = 100
      const cap = pageCapOf(options.pageCap)
      for (let page = 0; page < cap; page++) {
        let answer: EtsyListingsPage
        try {
          answer = await get<EtsyListingsPage>(`/shops/${shopId}/listings?state=active&limit=${limit}&offset=${page * limit}`)
        } catch (error) {
          return { items, complete: false, reason: `page ${page + 1} could not be read: ${message(error)}` }
        }
        for (const listing of answer.results ?? []) {
          const skus = (listing.skus ?? []).map((s) => s.trim()).filter(Boolean)
          for (const sku of skus.length ? skus : ['']) {
            items.push({ marketplace: 'GLOBAL', externalId: String(listing.listing_id), sellerSku: sku, title: listing.title ?? null, remoteStatus: listing.state ?? 'active' })
          }
        }
        if ((page + 1) * limit >= (answer.count ?? 0)) return { items, complete: true }
        if (page + 1 === cap) return { items, complete: false, reason: `stopped at the ${cap}-page cap (NEXUS_IDENTITY_SWEEP_PAGE_CAP)` }
      }
      return { items, complete: false, reason: 'no page was read' }
    },
  }
}

export function channelHeldReaders(): Record<string, HeldReader> {
  return { AMAZON: amazonHeldReader(), SHOPIFY: shopifyHeldReader(), ETSY: etsyHeldReader() }
}
