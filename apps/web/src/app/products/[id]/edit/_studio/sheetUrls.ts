/**
 * The studio's read URLs, in one small module.
 *
 * The hooks that read (`useChannelSheet`, `useMasterSheet`, `useWorkspaceDestination`) and the page-load prefetch
 * (`studioPrefetch.ts`) build their URLs here, so a prefetched read is adopted only when it is byte-for-byte the read the
 * hook would have made. Kept free of the hooks' imports so the frame can use it without loading the sheet's code.
 */
import { getBackendUrl } from '@/lib/backend-url'

export interface ChannelSheetUrlOptions {
  productId: string
  channel: string
  marketplace: string
  accountId?: string
  locale?: string
  locales?: string[] | null
  view?: string
}

/**
 * PES.5 §3.2.
 *
 * 🔴 The market parameter is `market`, NOT `marketplace`. §3.2's prose writes `&marketplace=`, but
 * the shipped route reads `q.market` and answers `400 {"error":"market is required"}` — verified
 * against the running service, not the doc. The RESPONSE still calls it `scope.marketplace`, so the
 * two names genuinely coexist and only the request side takes `market`.
 */
export function channelScopeUrl(o: ChannelSheetUrlOptions): string {
  const params = new URLSearchParams({
    scope: 'channel',
    channel: o.channel,
    market: o.marketplace,
  })
  if (o.accountId) params.set('accountId', o.accountId)
  if (o.locale) params.set('locale', o.locale)
  if (o.locales) params.set('locales', o.locales.join(','))
  if (o.view) params.set('view', o.view)
  return `${getBackendUrl()}/api/products/${o.productId}/studio/sheet?${params}`
}

/**
 * The master sheet's read. `?market=`, not `?marketplace=` (see above); the scope is derived server-side from the absence
 * of `channel`, so master sends neither `scope` nor `channel`.
 */
export function masterSheetUrl(productId: string, market: string, locale: string, locales?: string[] | null): string {
  const localesQuery = locales ? `&locales=${encodeURIComponent(locales.join(','))}` : ''
  return `${getBackendUrl()}/api/products/${productId}/studio/sheet?market=${encodeURIComponent(market)}&locale=${encodeURIComponent(locale)}${localesQuery}`
}

/**
 * P2 — the sheet read asks for the compact wire form (each column's shared cell once, each cell as its difference); the
 * sheet hooks decode it to today's shape. Here, beside the other builders, so the page-load prefetch asks for the SAME
 * bytes as the hook and is adopted — a prefetch of the plain form was never adopted and cost a second full read.
 * `patches=pooled` (2026-10-01): each repeated patch once more. An API that does not know it answers the compact form,
 * and `decodeSheetCells` reads plain, compact and pooled answers alike.
 */
export const compactSheetUrl = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}cells=compact&patches=pooled`

/** The destination check a channel scope makes before its tab mounts. */
export function destinationUrl(productId: string, channel: string, market: string, accountId?: string, listingId?: string): string {
  const query = new URLSearchParams({ channel, market })
  if (accountId !== undefined) query.set('accountId', accountId)
  if (listingId !== undefined) query.set('listingId', listingId)
  return `${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/studio/destination?${query}`
}
