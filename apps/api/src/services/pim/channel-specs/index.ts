import { categorySchemaMarket, categorySchemaMarkets } from '../../categories/category-schema-coordinate.js'
import { cachedSchemasOnly } from '../cached-schema-context.js'
import { WorkspaceCache } from '../../../lib/workspace-cache.js'
/**
 * AM.1 — the DB-backed loaders for channel specs, with the caches the page-load path needs.
 *
 * CACHE ONLY, whatever the TTL on the row — the rule `schema-caps.ts` documented: a month-old cap
 * beats no cap, the age is REPORTED (`fetchedAt`), and refreshing is the schema-sync cron's job.
 * Nothing here calls SP-API or eBay; a page load must never wait on a channel.
 *
 * Invalidation is the schema's own freshness stamp (max `fetchedAt` + row count for the
 * coordinate), so a cache refresh changes the key and the walk happens again — a TTL would be stale
 * after a refresh and wasteful when none happened (the F6 rule in `field-registry.service.ts`).
 */
import prisma from '../../../db.js'
import { amazonSpecFromDefinition } from './amazon.js'
import { aspectNames, ebaySpecFromCache, type EbayCachedAspect, type EbayCachedCondition, type EbayChannelSchemaRow } from './ebay.js'
import { normaliseKey, type ChannelSpec } from './types.js'

export * from './types.js'
export { amazonSpecFromDefinition, AMAZON_MASTER_LINKS } from './amazon.js'
export { ebaySpecFromCache, aspectNames } from './ebay.js'

/**
 * Marketplaces whose cached Amazon schema carries ENGLISH titles (D10). Verified: `AMAZON:UK`
 * OUTERWEAR gives `item_name` = "Item Name", `fabric_type` = "Fabric Type", against DE's
 * "Artikelname" / "Gewebeart".
 */
export const ENGLISH_MARKETPLACES = ['UK', 'US', 'IE', 'AU', 'CA']

const specCache = new WorkspaceCache<string, { stamp: string; value: ChannelSpec }>()
const SPEC_CACHE_MAX = 256

function remember(key: string, stamp: string, value: ChannelSpec): ChannelSpec {
  if (specCache.size >= SPEC_CACHE_MAX) {
    const first = specCache.keys().next().value
    if (first !== undefined) specCache.delete(first)
  }
  specCache.set(key, { stamp, value })
  return value
}

/** Exported for tests and for a refresh path that wants to drop it explicitly. */
export function clearChannelSpecCache(): void {
  specCache.clear()
}

async function amazonStamp(marketplace: string, productType: string): Promise<string> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT COALESCE(max("fetchedAt")::text, '') AS stamp, count(*)::int AS n
     FROM "CategorySchema" WHERE channel='AMAZON' AND marketplace=$1 AND "productType"=$2 AND "isActive"=true`,
    marketplace,
    productType,
  )) as { stamp: string; n: number }[]
  return `${rows[0]?.stamp ?? ''}:${rows[0]?.n ?? 0}`
}

/** The Amazon spec for one (marketplace × product type). `absent: true` when nothing is cached. */
export async function loadAmazonSpec(marketplace: string, productType: string, accountId?: string | null): Promise<ChannelSpec> {
  const mk = String(marketplace).toUpperCase()
  const pt = String(productType).toUpperCase()
  const key = `AMAZON|${mk}|${pt}`
  const stamp = await amazonStamp(mk, pt)
  const hit = specCache.get(key)
  if (hit && hit.stamp === stamp) return hit.value

  const row = await prisma.categorySchema.findFirst({
    where: { channel: 'AMAZON', marketplace: mk, productType: pt, isActive: true },
    orderBy: { fetchedAt: 'desc' },
    select: { schemaDefinition: true, fetchedAt: true, schemaVersion: true },
  })
  if (!row) {
    // An account-specific provider read is a cache-miss fallback, never a page-load bypass.
    if (accountId && !cachedSchemasOnly()) return (await import('../../categories/seller-schema.service.js')).amazonSellerSpec(accountId, mk, pt)
    return remember(key, stamp, {
      channel: 'AMAZON', marketplace: mk, category: pt, fields: [], groups: [],
      fetchedAt: null, schemaVersion: null, coverage: {}, unrecognised: [], absent: true,
    })
  }
  const spec = amazonSpecFromDefinition({
    marketplace: mk, productType: pt, schemaDefinition: row.schemaDefinition,
    fetchedAt: row.fetchedAt, schemaVersion: row.schemaVersion,
  })
  return remember(key, stamp, spec)
}

/**
 * English labels for an Amazon product type, keyed by NORMALISED spec key, read from a cached
 * ENGLISH-marketplace schema through the same walker — so a compound leaf or a slot base gets
 * Amazon's own English wording, not a humanised key. Empty when no English schema is cached
 * (6 of 19 product types had one, measured 2026-09-02); the caller falls back to `humanizeKey`.
 */
export async function loadAmazonEnglishLabels(productType: string): Promise<Map<string, string>> {
  const pt = String(productType).toUpperCase()
  const out = new Map<string, string>()
  const rows = await prisma.categorySchema.findMany({
    where: { channel: 'AMAZON', marketplace: { in: ENGLISH_MARKETPLACES }, productType: pt, isActive: true },
    orderBy: { fetchedAt: 'desc' },
    select: { marketplace: true, schemaDefinition: true },
    take: 1,
  })
  for (const r of rows) {
    const spec = amazonSpecFromDefinition({ marketplace: r.marketplace, productType: pt, schemaDefinition: r.schemaDefinition })
    for (const f of spec.fields) {
      const k = normaliseKey(f.key)
      if (!out.has(k)) out.set(k, f.label)
    }
    for (const g of spec.groups) {
      const k = `group:${g.key}`
      if (!out.has(k) && g.channelLabel) out.set(k, g.channelLabel)
    }
  }
  return out
}

/** A separate contract per leaf. Missing metadata never borrows another category's aspects. */
export async function loadEbaySpec(marketplace: string, categoryIds: string[]): Promise<ChannelSpec> {
  // LX.F2 R-LX-20 — ONE authority for this coordinate (`categories/category-schema-coordinate.ts`).
  const mk = categorySchemaMarket('EBAY', marketplace) ?? 'IT'
  const cats = [...new Set(categoryIds.map(String).map(c => c.trim()).filter(Boolean))]
  if (cats.length > 1) throw new Error('Load eBay categories separately to preserve each leaf contract')
  const category = cats[0] ?? '*'
  const [cachedRows, schemaRows] = await Promise.all([
    cats.length ? prisma.categorySchema.findMany({
      where: { channel: 'EBAY', marketplace: { in: categorySchemaMarkets('EBAY', mk) }, productType: category, isActive: true },
      orderBy: [{ fetchedAt: 'desc' }, { id: 'asc' }],
      select: { schemaDefinition: true, fetchedAt: true, schemaVersion: true },
    }) : Promise.resolve([]),
    prisma.channelSchema.findMany({
      where: { channel: 'EBAY', OR: [{ marketplace: mk }, { marketplace: null }] },
      orderBy: { marketplace: { sort: 'desc', nulls: 'last' } },
      select: { fieldKey: true, label: true, maxLength: true, required: true, allowedValues: true, notes: true },
    }),
  ])
  const cached = cachedRows[0] ?? null
  const definition = cached?.schemaDefinition as { aspects?: EbayCachedAspect[]; conditions?: EbayCachedCondition[] } | null
  const rows = [...new Map(schemaRows.slice().reverse().map(r => [r.fieldKey, r])).values()] as EbayChannelSchemaRow[]
  const spec = ebaySpecFromCache({
    marketplace: mk, categoryId: category,
    aspects: Array.isArray(definition?.aspects) ? withRichShape(definition.aspects, cachedRows.slice(1)) : [],
    conditions: Array.isArray(definition?.conditions) ? definition.conditions : [],
    channelSchemaRows: rows, fetchedAt: cached?.fetchedAt ?? null,
  })
  spec.schemaVersion = cached?.schemaVersion ?? null
  spec.absent = !cached || !Array.isArray(definition?.aspects)
  return spec
}

/**
 * P1 (report 3 I-3.5) — single or multiple values come from the FULL schema row. The newest row wins for the aspect list
 * and its options, but the old flat-file GET writes a thin row (no `cardinality`, `maxLength`, `dataType`) that is
 * often the newest: on 177101 "Chiusura" was then offered as a list while eBay says SINGLE. Each aspect the newest row
 * leaves without them takes them from the newest older row of the SAME category that has them.
 */
function withRichShape(aspects: EbayCachedAspect[], older: Array<{ schemaDefinition: unknown }>): EbayCachedAspect[] {
  const richer = older.flatMap(row => {
    const list = (row.schemaDefinition as { aspects?: unknown } | null)?.aspects
    return Array.isArray(list) ? list as EbayCachedAspect[] : []
  }).filter(a => a && typeof a === 'object' && a.cardinality)
  if (!richer.length) return aspects
  // A thin row may carry only the localised label; a rich one both names. Either name identifies the aspect.
  const identity = (a: EbayCachedAspect) => { const names = aspectNames(a); return names ? [normaliseKey(names.english), normaliseKey(names.localized)] : [] }
  return aspects.map(aspect => {
    if (!aspect || typeof aspect !== 'object' || aspect.cardinality) return aspect
    const keys = identity(aspect)
    const rich = keys.length ? richer.find(other => identity(other).some(key => keys.includes(key))) : undefined
    return rich ? { ...aspect, cardinality: rich.cardinality, maxLength: aspect.maxLength ?? rich.maxLength, dataType: aspect.dataType ?? rich.dataType,
      // W3-5 — the thin row never carries eBay's "required from" date; the full row's must not be hidden by it.
      expectedRequiredByDate: aspect.expectedRequiredByDate ?? rich.expectedRequiredByDate } : aspect
  })
}
