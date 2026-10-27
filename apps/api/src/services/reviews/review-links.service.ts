/**
 * Reviews — where a buyer leaves the review our e-mail asks for, per business and per order (Owner, 2026-10-27).
 *
 *   - eBay: the leave-feedback page of the buyer's OWN eBay site, from the order's market (www.ebay.de for a German
 *     buyer); an order without a market gets www.ebay.com, which sends the buyer on to their site.
 *   - Shopify: the review page of THIS business's own shop (`/pages/reviews`, where the store's review app lists its
 *     reviews): the business's own connected Shopify store, else the website in its Settings › Company. Never a
 *     deployment-wide setting: business profiles share one deployment.
 *   - No shop for this business: null. The e-mail then has no review button (never a dead `#` link) and Settings ›
 *     Emails says so (`shopReviewHeld`).
 *
 * `reviewLinkFor` is pure; `readShopReviewPage` reads the business's own rows (row-secured to the business the call
 * runs in). Tested in review-links.vitest.test.ts.
 */
import prisma from '../../db.js'
import { channelSiteDomain } from '@nexus/shared/review-reply-rules'
import { isOwnConnection } from '../connection-resolver.service.js'

/** The page path a Shopify store's review app lists its reviews on. */
const SHOP_REVIEW_PATH = '/pages/reviews'

/** What a review e-mail of this business links to for Shopify buyers, and where it came from. */
export interface ShopReviewPage {
  url: string | null
  source: 'shopify_store' | 'website' | null
}

/** eBay's leave-feedback page on the buyer's own eBay site. */
export function ebayFeedbackUrl(marketplace: string | null | undefined): string {
  return `https://${channelSiteDomain('EBAY', marketplace)}/fdbk/leave_feedback`
}

/** "https://shop.example" from a website setting ("shop.example", "https://shop.example/about"), or null. */
export function shopOrigin(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    if (!url.hostname.includes('.')) return null
    return `https://${url.hostname.toLowerCase()}`
  } catch {
    return null
  }
}

/** The review link of one order's e-mail, or null (no button). Pure. */
export function reviewLinkFor(channel: string, marketplace: string | null | undefined, shop: ShopReviewPage): string | null {
  const c = (channel ?? '').toUpperCase()
  if (c === 'EBAY') return ebayFeedbackUrl(marketplace)
  if (c === 'SHOPIFY') return shop.url
  return null
}

/** Why Shopify buyers' review e-mails have no review button, in words (null when they have one). Pure. */
export function shopReviewHeld(shop: ShopReviewPage): string | null {
  return shop.url
    ? null
    : 'Shopify buyers’ review e-mails go out without a review button: this business has no Shopify store connected and no website in Settings › Company.'
}

/**
 * The business's own shop review page: its own active Shopify store (the primary one when it has several; none picked
 * when it has several and no primary), else the website in Settings › Company.
 */
export async function readShopReviewPage(): Promise<ShopReviewPage> {
  const [stores, settings] = await Promise.all([
    prisma.channelConnection.findMany({
      where: { channelType: 'SHOPIFY', isActive: true },
      select: { region: true, isPrimary: true, workspaceId: true },
    }),
    prisma.brandSettings.findFirst({ orderBy: { createdAt: 'asc' }, select: { websiteUrl: true } }),
  ])
  const own = stores.filter(isOwnConnection).filter((s) => shopOrigin(s.region))
  const store = own.length === 1 ? own[0] : own.find((s) => s.isPrimary) ?? null
  const storeOrigin = store ? shopOrigin(store.region) : null
  if (storeOrigin) return { url: `${storeOrigin}${SHOP_REVIEW_PATH}`, source: 'shopify_store' }
  const website = shopOrigin(settings?.websiteUrl)
  if (website) return { url: `${website}${SHOP_REVIEW_PATH}`, source: 'website' }
  return { url: null, source: null }
}
