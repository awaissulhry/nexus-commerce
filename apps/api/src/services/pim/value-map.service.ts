import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * FM.4 — value-map + size-scale store/service.
 *
 * Catalog-level lookups behind the `valueMap` / `sizeScale` transform ops
 * (FM.3): canonical/master value → channel-or-market value, and cross-
 * system size conversion. Provides:
 *   - CRUD over FieldValueMap + SizeScaleMap
 *   - cached SYNC lookups (loadValueMapLookup / loadSizeScaleLookup) so
 *     resolveChannelField/applyTransforms stay pure + synchronous
 *   - an on-demand, budget-capped AI seeder that repurposes the Amazon
 *     cross-market enum mapper (value-translate.service) → FieldValueMap
 *     rows flagged reviewedAt=null for operator review.
 */

import prisma from '../../db.js'
import { TtlCache } from '../../utils/ttl-cache.js'
import type { ValueTranslateResult } from '../amazon/value-translate.service.js'

const ALL_MARKETS = '*'

export type ValueMapConfidence = 'MANUAL' | 'AI_HIGH' | 'AI_MEDIUM' | 'AI_LOW'

// ── caches (5 min, mirrors the manifest cache) ──────────────────────
// Value-map cache: `${channel}:${marketplace}` → merged ('*' + market)
// lookup map. Size-scale cache: single 'all' entry.
const valueMapCache = new TtlCache<Map<string, string>>({ ttlMs: 5 * 60_000, maxEntries: 200 })
const sizeScaleCache = new TtlCache<Map<string, string>>({ ttlMs: 5 * 60_000, maxEntries: 1 })

const vmKey = (attribute: string, fromValue: string) => `${attribute}\0${fromValue}`
const ssKey = (scale: string, from: string, to: string, value: string) =>
  `${scale.toUpperCase()}\0${from.toUpperCase()}\0${to.toUpperCase()}\0${value}`

const normMarket = (mp?: string | null): string =>
  !mp || mp === ALL_MARKETS ? ALL_MARKETS : mp.toUpperCase()

/** Drop both caches — called after any mutation, and exported for tests.
 *  A '*' write affects every market's merged map, so we clear wholesale
 *  rather than reason about prefixes (caches are tiny + 5-min TTL). */
export function clearValueMapCaches(): void {
  valueMapCache.clear()
  sizeScaleCache.clear()
}

// ── cached sync lookups ─────────────────────────────────────────────

/** Build a sync lookup for (channel, marketplace): the '*' (all-markets)
 *  maps overlaid with the specific market's maps (specific wins). */
export async function loadValueMapLookup(
  channel: string,
  marketplace?: string | null,
  options?: { fresh?: boolean },
): Promise<(attribute: string, fromValue: string) => string | null> {
  const ch = channel.toUpperCase()
  const mk = normMarket(marketplace)
  const cacheKey = `${ch}:${mk}`
  let map = options?.fresh ? undefined : valueMapCache.get(cacheKey)
  if (!map) {
    const markets = mk === ALL_MARKETS ? [ALL_MARKETS] : [ALL_MARKETS, mk]
    const rows = await prisma.fieldValueMap.findMany({
      where: { channel: ch, marketplace: { in: markets } },
      select: { marketplace: true, attribute: true, fromValue: true, toValue: true },
    })
    map = new Map<string, string>()
    // '*' first, specific market second so specific overrides.
    for (const r of rows) if (r.marketplace === ALL_MARKETS) map.set(vmKey(r.attribute, r.fromValue), r.toValue)
    for (const r of rows) if (r.marketplace !== ALL_MARKETS) map.set(vmKey(r.attribute, r.fromValue), r.toValue)
    valueMapCache.set(cacheKey, map)
  }
  const built = map
  return (attribute, fromValue) => built.get(vmKey(attribute, fromValue)) ?? null
}

export async function loadSizeScaleLookup(options?: { fresh?: boolean }): Promise<
  (scale: string, from: string, to: string, value: string) => string | null
> {
  let map = options?.fresh ? undefined : sizeScaleCache.get('all')
  if (!map) {
    const rows = await prisma.sizeScaleMap.findMany({
      select: { scale: true, fromSystem: true, toSystem: true, fromValue: true, toValue: true },
    })
    map = new Map<string, string>()
    for (const r of rows) map.set(ssKey(r.scale, r.fromSystem, r.toSystem, r.fromValue), r.toValue)
    sizeScaleCache.set('all', map)
  }
  const built = map
  return (scale, from, to, value) => built.get(ssKey(scale, from, to, value)) ?? null
}

// ── CRUD ────────────────────────────────────────────────────────────

export async function listValueMaps(filter: {
  channel: string
  marketplace?: string | null
  attribute?: string
}) {
  return prisma.fieldValueMap.findMany({
    where: {
      channel: filter.channel.toUpperCase(),
      ...(filter.marketplace ? { marketplace: normMarket(filter.marketplace) } : {}),
      ...(filter.attribute ? { attribute: filter.attribute } : {}),
    },
    orderBy: [{ attribute: 'asc' }, { fromValue: 'asc' }],
  })
}

export async function upsertValueMap(input: {
  channel: string
  marketplace?: string | null
  attribute: string
  fromValue: string
  toValue: string
  confidence?: ValueMapConfidence
  /** false → AI-seeded (reviewedAt=null); default/true → operator-reviewed (now). */
  reviewed?: boolean
}) {
  const channel = input.channel.toUpperCase()
  const marketplace = normMarket(input.marketplace)
  const confidence = input.confidence ?? 'MANUAL'
  const reviewedAt = input.reviewed === false ? null : new Date()
  const row = await prisma.fieldValueMap.upsert({
    where: {
      channel_marketplace_attribute_fromValue: workspaceKey({
        channel,
        marketplace,
        attribute: input.attribute,
        fromValue: input.fromValue,
      }),
    },
    create: {
      channel,
      marketplace,
      attribute: input.attribute,
      fromValue: input.fromValue,
      toValue: input.toValue,
      confidence,
      reviewedAt,
    },
    update: { toValue: input.toValue, confidence, reviewedAt },
  })
  clearValueMapCaches()
  return row
}

export async function removeValueMap(id: string): Promise<void> {
  await prisma.fieldValueMap.delete({ where: { id } }).catch(() => {
    /* idempotent — already gone */
  })
  clearValueMapCaches()
}

export async function listSizeScales(filter?: { scale?: string }) {
  return prisma.sizeScaleMap.findMany({
    where: filter?.scale ? { scale: filter.scale.toUpperCase() } : {},
    orderBy: [{ scale: 'asc' }, { fromSystem: 'asc' }, { fromValue: 'asc' }],
  })
}

export async function upsertSizeScale(input: {
  scale: string
  fromSystem: string
  toSystem: string
  fromValue: string
  toValue: string
}) {
  const scale = input.scale.toUpperCase()
  const fromSystem = input.fromSystem.toUpperCase()
  const toSystem = input.toSystem.toUpperCase()
  const row = await prisma.sizeScaleMap.upsert({
    where: {
      scale_fromSystem_toSystem_fromValue: workspaceKey({ scale, fromSystem, toSystem, fromValue: input.fromValue }),
    },
    create: { scale, fromSystem, toSystem, fromValue: input.fromValue, toValue: input.toValue },
    update: { toValue: input.toValue },
  })
  clearValueMapCaches()
  return row
}

/**
 * MCP full control P8 — remove one size conversion: the undo of a conversion Claude added through
 * `save-channel-mapping` (the Settings page has no delete for size scales). Business-scoped by the row policy;
 * removing one that is already gone is a no-op.
 */
export async function removeSizeScale(input: { scale: string; fromSystem: string; toSystem: string; fromValue: string }): Promise<void> {
  await prisma.sizeScaleMap.deleteMany({
    where: { scale: input.scale.toUpperCase(), fromSystem: input.fromSystem.toUpperCase(), toSystem: input.toSystem.toUpperCase(), fromValue: input.fromValue },
  })
  clearValueMapCaches()
}

// ── AI seeder ───────────────────────────────────────────────────────

/**
 * Seed FieldValueMap rows for an Amazon attribute by mapping the source-
 * market's canonical values into each target market's schema options via
 * the constrained LLM mapper (value-translate.service). Only valid
 * matches are written, flagged reviewedAt=null + an AI_* confidence so
 * operators can verify. Channel is AMAZON (the only channel with the
 * cross-market enum schema today); manual upsert covers eBay/Shopify.
 */
export async function seedValueMapsFromAI(input: {
  /** SOURCE market where the canonical values are authored. Default IT. */
  marketplace?: string
  attribute: string
  productType: string
  values: string[]
  targetMarkets: string[]
  colLabelEn?: string
}): Promise<{ written: number; result: ValueTranslateResult }> {
  const sourceMarket = (input.marketplace ?? 'IT').toUpperCase()
  const { translateEnumValues } = await import('../amazon/value-translate.service.js')
  const result = await translateEnumValues(prisma, {
    sourceMarket,
    productType: input.productType,
    colId: input.attribute,
    colLabelEn: input.colLabelEn,
    values: input.values,
    targetMarkets: input.targetMarkets,
  })

  const confMap: Record<string, ValueMapConfidence> = {
    high: 'AI_HIGH',
    medium: 'AI_MEDIUM',
    low: 'AI_LOW',
    none: 'AI_LOW',
  }

  let written = 0
  for (const [market, perValue] of Object.entries(result.mappings)) {
    for (const [fromValue, mapping] of Object.entries(perValue)) {
      if (!mapping.valid || mapping.match == null) continue
      await upsertValueMap({
        channel: 'AMAZON',
        marketplace: market,
        attribute: input.attribute,
        fromValue,
        toValue: mapping.match,
        confidence: confMap[mapping.confidence] ?? 'AI_LOW',
        reviewed: false,
      })
      written++
    }
  }
  return { written, result }
}
