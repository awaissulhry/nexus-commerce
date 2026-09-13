import { cachedSchemasOnly } from '../pim/cached-schema-context.js'
import { loadAmazonSpec } from '../pim/channel-specs/index.js'
import { resolveChannelConnectionId } from '../connection-resolver.service.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { TtlCache } from '../../utils/ttl-cache.js'
import prisma from '../../db.js'
import { cachedBrowseNodeLabels } from './browse-node-labels.service.js'

type Labels = Record<string, Record<string, string>>
const shippingCache = new TtlCache<Promise<Record<string, string>>>({ ttlMs: 5 * 60_000, maxEntries: 100 })

/** Saved taxonomy paths remain usable when the external taxonomy service is unavailable. */
export async function cachedCategoryLabels(channel: string, marketplace: string, productType: string): Promise<Labels> {
  const mappings = await prisma.categoryChannelMapping.findMany({
    where: { channel, marketplace: { in: channel === 'EBAY' ? [marketplace] : [marketplace, '*'] }, channelCategoryId: productType, channelCategoryPath: { not: null } },
    select: { marketplace: true, channelCategoryPath: true },
  })
  const exact = mappings.filter(mapping => mapping.marketplace === marketplace)
  const names = [...new Set((channel === 'EBAY' || exact.length ? exact : mappings).map(mapping => mapping.channelCategoryPath?.trim()).filter((name): name is string => !!name))]
  // Conflicting saved labels are not a license to pick an arbitrary category name.
  return names.length === 1 ? { [channel === 'EBAY' ? 'categoryId' : 'productType']: { [productType]: names[0] } } : {}
}

/**
 * 🔴 LX.6 / R-LX-4 — a page load makes NO provider call.
 *
 * MEASURED 2026-09-13 (`docs/audits/2026-09-13-lx6/gateway-leak-before.json`): a cold
 * `/categories/reference-labels?…&shipping=1` — which the studio fired on EVERY master and channel
 * page load (`useReferenceNames.ts:86`) — reached `amazonSellerSpec` and attempted
 * `https://api.amazon.com/auth/o2/token` through `getAmazonSpClient`. 1 attempt per cold request, on
 * a request nobody asked for, and it returned **0** shipping-template names anyway.
 *
 * The rule is AM.1's, already written in `pim/channel-specs/index.ts`: cache only, whatever the age
 * of the row; the age is REPORTED; refreshing is a gesture's job, never a page load's. The mechanism
 * is the ONE that exists — `cachedSchemasOnly()` (`pim/cached-schema-context.ts`) — so there is no
 * second flag to keep in step. A request wrapped in `withCachedSchemas` may consume a completed
 * cache entry and must never START provider work.
 *
 * The live path is unchanged for the two gestures that need it: the reference editor opening its
 * option list (`?live=1`) and the write-time name→ID resolution (`pim/reference-values.service.ts`,
 * which is not inside a cached-schema scope).
 */
/**
 * 🔴 LX.FIN (R-LX-24, on LX.R's R-LX-12) — the DURABLE half of the cache.
 *
 * LX.6 closed the leak (a cold page load no longer reaches `auth/o2/token`) and left an honest cost: the
 * only cache was the 5-minute in-process `TtlCache` above, which an API restart or a deploy empties, so a
 * cold page showed the raw template ID (`t-4f2a…`) where a name belongs. R-LX-12 asked for the second
 * half; R-LX-24 rules how it lands. `SellerReferenceLabel` stores what a LIVE arm learned, keyed by the
 * CONNECTION, so the cache-only arm can answer with names and with the age of what it served.
 *
 * Three properties, on purpose:
 *  1. **Reading it starts no provider work.** It is a row read inside the same request, and the
 *     `cachedSchemasOnly()` arm returns before `amazonSellerSpec` is even imported.
 *  2. **It never widens an option list.** The allowed VALUES still come from the live definition or the
 *     cached `CategorySchema`; this answers only "what does this id read as". A stale label on a
 *     withdrawn template is a wrong NAME, never a writable value — and `fetchedAt` says how old it is.
 *  3. **A write failure is swallowed.** A label cache that could fail a page load would be worse than the
 *     raw id it exists to replace.
 */
const SHIPPING_FIELD_KEY = 'merchant_shipping_group'

async function storedShippingLabels(marketplace: string, productType: string, connectionId: string): Promise<{ labels: Record<string, string>; fetchedAt: Date } | null> {
  try {
    const row = await prisma.sellerReferenceLabel.findFirst({
      where: { channel: 'AMAZON', connectionId, marketplace, productType, fieldKey: SHIPPING_FIELD_KEY },
      select: { labels: true, fetchedAt: true },
    })
    if (!row || !row.labels || typeof row.labels !== 'object' || Array.isArray(row.labels)) return null
    const labels = Object.fromEntries(Object.entries(row.labels as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    return Object.keys(labels).length ? { labels, fetchedAt: row.fetchedAt } : null
  } catch { return null }
}

async function rememberShippingLabels(marketplace: string, productType: string, connectionId: string, labels: Record<string, string>): Promise<void> {
  /* An EMPTY answer is not written: it would overwrite real names with nothing the next time a seller
     definition came back empty, which is the "measured empty vs could not measure" failure, persisted. */
  if (!Object.keys(labels).length) return
  try {
    await prisma.sellerReferenceLabel.upsert({
      where: { channel_connectionId_marketplace_productType_fieldKey: { workspaceId: workspaceIdForQuery(), channel: 'AMAZON', connectionId, marketplace, productType, fieldKey: SHIPPING_FIELD_KEY } },
      create: { channel: 'AMAZON', connectionId, marketplace, productType, fieldKey: SHIPPING_FIELD_KEY, labels, fetchedAt: new Date() },
      update: { labels, fetchedAt: new Date() },
    })
  } catch { /* a label cache never fails the request it rode in on */ }
}

/** The stamp's own reading of WHERE the names came from, set by the one function that knows. */
let lastShippingSource: 'live' | 'memory' | 'database' | 'none' = 'none'
let lastShippingFetchedAt: Date | null = null

async function shippingTemplateLabels(marketplace: string, productType: string, connectionId: string, refresh = false): Promise<Record<string, string>> {
  const key = JSON.stringify([workspaceIdForQuery(), connectionId, marketplace, productType])
  const hit = shippingCache.get(key)
  if (hit && !refresh) { lastShippingSource = 'memory'; return hit }
  // Cache-first: a cold entry inside a cached-schema scope may NOT start provider work. It is no longer
  // an empty answer, though — the durable row is read instead, and the stamp reports its database date.
  if (cachedSchemasOnly()) {
    const stored = await storedShippingLabels(marketplace, productType, connectionId)
    lastShippingSource = stored ? 'database' : 'none'
    lastShippingFetchedAt = stored?.fetchedAt ?? null
    /* 🔴 The durable answer is NOT written into the in-process provider cache, on purpose. Doing that
       measurably changes a different path: `live=1` (the reference editor opening its option list) skips
       `withCachedSchemas` but still takes a memory HIT, so a cold page load that seeded memory from the
       database would make the operator's next "show me the live list" gesture serve a stored answer for
       up to 5 minutes — a newly created shipping template would be invisible in the one place it matters.
       The memory cache stays a PROVIDER cache; this is one indexed row read per cold request. */
    return stored?.labels ?? {}
  }
  const pending = (async () => {
    const { amazonSellerSpec } = await import('./seller-schema.service.js')
    const spec = await amazonSellerSpec(connectionId, marketplace, productType, refresh)
    const field = spec.fields.find(field => field.key === SHIPPING_FIELD_KEY)
    const labels = Object.fromEntries(Object.entries(field?.optionLabels ?? {}).filter(([id]) => field?.options?.includes(id) && !field.deprecatedOptions?.includes(id))) as Record<string, string>
    await rememberShippingLabels(marketplace, productType, connectionId, labels)
    return labels
  })().catch(error => { shippingCache.delete(key); throw error })
  shippingCache.set(key, pending)
  lastShippingSource = 'live'
  lastShippingFetchedAt = new Date()
  return pending
}

/** Shared by display lookup and writes, scoped to the verified seller account. */
export async function sellerShippingTemplateLabels(input: { marketplace: string; productType: string; accountId?: string; refresh?: boolean }): Promise<Record<string, string>> {
  const connectionId = await resolveChannelConnectionId('AMAZON', input.accountId)
  if (!connectionId) throw new Error('Shipping templates are unavailable for this seller')
  return shippingTemplateLabels(input.marketplace, input.productType, connectionId, input.refresh)
}

/** Label metadata only: no product/listing writes, schema refreshes, or changes to allowed values. */
export async function amazonReferenceLabels(input: { marketplace: string; productType: string; accountId?: string; shipping: boolean; browseNodeIds?: string[] }) {
  /* Reset before the read, so a stamp can never report the PREVIOUS request's source
     (`reference_stale_measurement_looks_like_a_missing_one`: both predict "nothing moved"). */
  lastShippingSource = 'none'
  lastShippingFetchedAt = null
  const spec = await loadAmazonSpec(input.marketplace, input.productType, input.accountId)
  const labels: Labels = Object.fromEntries(spec.fields.filter(field => field.optionLabels && field.key !== 'merchant_shipping_group').map(field => [field.key, field.optionLabels!]))
  const unavailable: string[] = []
  const missingNodes = (input.browseNodeIds ?? []).filter(id => !labels.recommended_browse_nodes?.[id] || labels.recommended_browse_nodes[id] === id)
  if (missingNodes.length) {
    try {
      const names = await cachedBrowseNodeLabels(input.marketplace, missingNodes)
      labels.recommended_browse_nodes = { ...labels.recommended_browse_nodes, ...names }
      labels.browseNodeId = { ...labels.browseNodeId, ...names }
      if (missingNodes.some(id => !names[id])) unavailable.push('browseNodes')
    } catch { unavailable.push('browseNodes') }
  }
  if (labels.recommended_browse_nodes) labels.browseNodeId = { ...labels.recommended_browse_nodes, ...labels.browseNodeId }
  if (input.shipping) {
    // Seller-owned choices come from this exact account’s product-type definition.
    try {
      const names = await sellerShippingTemplateLabels(input)
      labels.merchant_shipping_group = names
      labels.shippingTemplate = names
      if (!Object.keys(names).length) unavailable.push('shippingTemplate')
    } catch { unavailable.push('shippingTemplate') }
  }
  /**
   * The age of what was served, as a DATABASE date — never the request time (the step-7 rule for
   * `meta.schemaAge`, `pim/studio-columns.ts`). `sellerTemplates` says which arm answered, so a
   * cache-only page load is distinguishable on the wire from a live refresh that came back empty:
   * "could not measure" and "measured empty" are different answers (`reference_could_not_measure_vs_measured_empty`).
   */
  const stamp = {
    marketplace: input.marketplace,
    productType: input.productType,
    schemaFetchedAt: spec.fetchedAt ? new Date(spec.fetchedAt).toISOString() : null,
    schemaVersion: spec.schemaVersion ?? null,
    cachedOnly: cachedSchemasOnly(),
    sellerTemplates: !input.shipping
      ? ('not-requested' as const)
      : unavailable.includes('shippingTemplate')
        ? (cachedSchemasOnly() ? ('cache-miss' as const) : ('unavailable' as const))
        : (cachedSchemasOnly() ? ('cache-hit' as const) : ('live' as const)),
    /**
     * LX.FIN (R-LX-24) — WHICH cache answered, and the DATABASE date of what it served.
     *
     * `sellerTemplates` above says whether names were served; these say where from. `'database'` with a
     * `sellerTemplatesFetchedAt` is the reading that distinguishes "a cold page load showed NAMES from a
     * stored answer of 2026-09-12" from "a warm process happened to still hold them" and from "it could
     * not measure" — three states that used to be one word. Never the request time.
     */
    sellerTemplateSource: input.shipping ? lastShippingSource : ('not-requested' as const),
    sellerTemplatesFetchedAt: input.shipping && lastShippingFetchedAt ? lastShippingFetchedAt.toISOString() : null,
  }
  return { labels, unavailable, stamp }
}
