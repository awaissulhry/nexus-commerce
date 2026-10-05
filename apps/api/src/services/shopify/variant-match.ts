/**
 * S10 (per-channel SKU) — which Shopify variant one Nexus variant is, and which variants a synchronisation renames in
 * place. One rule for the publisher (`mapRemoteVariants`, content-publisher.ts) and the review (`previewContentSync`).
 * Pure: no Shopify call, no database.
 */
import type { ContentVariant } from '@nexus/shared/shopify-content'
import type { ShopifyRemoteProduct } from './content-publisher.js'

const variantGid = (value: string) => value.startsWith('gid://') ? value : `gid://shopify/ProductVariant/${value}`

/**
 * S10 (per-channel SKU) — the Shopify variants one Nexus variant may be: its stored Shopify variant id; else the SKU
 * Shopify HOLDS for it (`liveSkus`, its listing's live SKU — a rename waiting to be sent); only when that finds none, the
 * SKU being sent (as before). `matchedBy` names the SKU that matched, for the refusal sentence.
 */
export function remoteVariantMatches(v: Pick<ContentVariant, 'id' | 'sku' | 'shopifyVariantId'>, remote: ShopifyRemoteProduct | null,
  liveSkus: Readonly<Record<string, string>> = {}): { matches: ShopifyRemoteProduct['variants']['nodes']; matchedBy: string } {
  const nodes = remote?.variants?.nodes ?? []
  if (v.shopifyVariantId) return { matches: nodes.filter(r => r.id === variantGid(v.shopifyVariantId!)), matchedBy: v.sku }
  const live = liveSkus[v.id]
  if (live && live !== v.sku) {
    const held = nodes.filter(r => r.sku === live)
    if (held.length) return { matches: held, matchedBy: live }
  }
  return { matches: nodes.filter(r => r.sku === v.sku), matchedBy: v.sku }
}

/** One variant Shopify holds under another SKU than the one Nexus sends now (`previewContentSync`'s `skuRenames`). */
export interface ShopifySkuRename { productId: string; from: string; to: string; sentence: string }

/**
 * S10 — the variants a synchronisation renames in place: matched as `mapRemoteVariants` matches them (exactly one Shopify
 * variant), whose Shopify SKU differs from the SKU sent. Never throws (the send refuses ambiguity by itself).
 */
export function shopifySkuRenames(variants: ContentVariant[], remote: ShopifyRemoteProduct | null, liveSkus: Readonly<Record<string, string>> = {}): ShopifySkuRename[] {
  if (!remote) return []
  return variants.flatMap(v => {
    const { matches } = remoteVariantMatches(v, remote, liveSkus)
    if (matches.length !== 1) return []
    const from = String(matches[0].sku ?? '').trim(), to = String(v.sku ?? '').trim()
    if (from === to) return []
    return [{ productId: v.id, from, to, sentence: from ? `Shopify renames ${from} to ${to}.` : `Shopify sets the SKU ${to} (it holds none now).` }]
  })
}
