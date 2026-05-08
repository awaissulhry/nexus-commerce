/**
 * S.22 — Shopify Locations multi-location binding service.
 *
 * Mirrors the FBA pattern: each Shopify location becomes a Nexus
 * StockLocation row of type 'SHOPIFY_LOCATION'. Stock the operator
 * keeps in Shopify's inventory model lives at that row; Shopify is
 * canonical for SHOPIFY_LOCATION StockLevels (webhook updates flow
 * in; Nexus operator changes go through IT-MAIN and only push to
 * Shopify via the existing sync queue).
 *
 * Discovery: ShopifyEnhancedService.makeRequest('/locations.json')
 * returns the channel-side list. We upsert each on (externalChannel='SHOPIFY',
 * externalLocationId=...) — the unique partial index from S.22's
 * migration prevents duplicates if the cron runs twice in parallel.
 *
 * S.23 ships the operator-facing Settings UI; this commit ships the
 * service + 3 endpoints so S.23 can wire to them without backend churn.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export interface ShopifyLocationRaw {
  id: string | number
  name: string
  address1?: string | null
  address2?: string | null
  city?: string | null
  province?: string | null
  country?: string | null
  zip?: string | null
  active?: boolean
}

export interface DiscoverySummary {
  total: number
  created: number
  updated: number
  unchanged: number
  errors: Array<{ externalLocationId: string; error: string }>
}

/**
 * Generate a Nexus StockLocation.code from a Shopify location name.
 * Uppercase, dash-separated, prefixed with SHOPIFY-. Falls back to the
 * external ID when the name is empty or pure punctuation.
 */
function makeShopifyCode(name: string, externalId: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
  if (slug.length > 0) return `SHOPIFY-${slug}`.slice(0, 64)
  return `SHOPIFY-${String(externalId).slice(-12)}`
}

/**
 * Upsert a single Shopify location into the StockLocation table.
 * Returns whether the row was created, updated, or unchanged so the
 * discovery summary can report progress accurately.
 */
export async function upsertShopifyLocation(raw: ShopifyLocationRaw): Promise<{
  status: 'created' | 'updated' | 'unchanged'
  locationId: string
}> {
  const externalLocationId = String(raw.id)
  const name = raw.name?.trim() || `Shopify location ${externalLocationId}`
  const code = makeShopifyCode(name, externalLocationId)
  const isActive = raw.active !== false

  // Look up by (externalChannel, externalLocationId) first; fall back
  // to code so a manually-created row with the operator's own naming
  // doesn't get duplicated.
  const existing = await prisma.stockLocation.findFirst({
    where: {
      OR: [
        { externalChannel: 'SHOPIFY', externalLocationId },
        { code },
      ],
    },
    select: { id: true, name: true, isActive: true, externalLocationId: true, externalChannel: true, code: true },
  })

  const address = {
    address1: raw.address1 ?? null,
    address2: raw.address2 ?? null,
    city: raw.city ?? null,
    province: raw.province ?? null,
    country: raw.country ?? null,
    zip: raw.zip ?? null,
  } as object

  if (!existing) {
    const created = await prisma.stockLocation.create({
      data: {
        type: 'SHOPIFY_LOCATION',
        code,
        name,
        address,
        isActive,
        externalLocationId,
        externalChannel: 'SHOPIFY',
      },
      select: { id: true },
    })
    return { status: 'created', locationId: created.id }
  }

  const needsUpdate =
    existing.name !== name ||
    existing.isActive !== isActive ||
    existing.externalLocationId !== externalLocationId ||
    existing.externalChannel !== 'SHOPIFY'
  if (!needsUpdate) {
    return { status: 'unchanged', locationId: existing.id }
  }
  await prisma.stockLocation.update({
    where: { id: existing.id },
    data: {
      name,
      address,
      isActive,
      externalLocationId,
      externalChannel: 'SHOPIFY',
      // Don't touch code — operator may have renamed; keep their
      // nomenclature stable.
    },
  })
  return { status: 'updated', locationId: existing.id }
}

/**
 * Pull every location from the Shopify Admin API and upsert each as
 * a Nexus StockLocation. The shopifyService argument is parameter-
 * injected so the cron path and tests can pass a mock without import-
 * order drama.
 */
export async function discoverShopifyLocations(
  shopifyService: { makeRequest: (method: 'GET', path: string) => Promise<unknown> } | null,
): Promise<DiscoverySummary> {
  const summary: DiscoverySummary = { total: 0, created: 0, updated: 0, unchanged: 0, errors: [] }
  if (!shopifyService) {
    logger.info('shopify-locations: shopifyService null — skipping discovery')
    return summary
  }

  let response: { locations?: ShopifyLocationRaw[] }
  try {
    response = (await shopifyService.makeRequest('GET', '/locations.json')) as {
      locations?: ShopifyLocationRaw[]
    }
  } catch (err) {
    logger.error('shopify-locations: discover request failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    summary.errors.push({ externalLocationId: '*', error: err instanceof Error ? err.message : String(err) })
    return summary
  }
  const locations = response.locations ?? []
  summary.total = locations.length

  for (const raw of locations) {
    try {
      const r = await upsertShopifyLocation(raw)
      if (r.status === 'created') summary.created++
      else if (r.status === 'updated') summary.updated++
      else summary.unchanged++
    } catch (err) {
      summary.errors.push({
        externalLocationId: String(raw.id),
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('shopify-locations: discovery complete', summary)
  return summary
}

/**
 * Resolve a Nexus StockLocation by its Shopify externalLocationId.
 * Used by the inventory_levels webhook + the outbound push path so
 * channel-side IDs map deterministically to Nexus rows.
 */
export async function resolveByShopifyId(externalLocationId: string): Promise<{
  id: string
  code: string
} | null> {
  const row = await prisma.stockLocation.findFirst({
    where: { externalChannel: 'SHOPIFY', externalLocationId: String(externalLocationId) },
    select: { id: true, code: true },
  })
  return row
}

/**
 * List every Shopify-mapped Nexus location with a per-location stock
 * roll-up. Used by the upcoming Settings UI (S.23) to render the
 * mapping table.
 */
export async function listShopifyLocationsWithStock(): Promise<Array<{
  id: string
  code: string
  name: string
  externalLocationId: string | null
  isActive: boolean
  skuCount: number
  totalQuantity: number
}>> {
  const rows = await prisma.stockLocation.findMany({
    where: { externalChannel: 'SHOPIFY' },
    orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
    include: {
      _count: { select: { stockLevels: true } },
    },
  })
  const summaries = await Promise.all(
    rows.map(async (loc) => {
      const agg = await prisma.stockLevel.aggregate({
        where: { locationId: loc.id },
        _sum: { quantity: true },
      })
      return {
        id: loc.id,
        code: loc.code,
        name: loc.name,
        externalLocationId: loc.externalLocationId,
        isActive: loc.isActive,
        skuCount: loc._count.stockLevels,
        totalQuantity: agg._sum.quantity ?? 0,
      }
    }),
  )
  return summaries
}

/**
 * Toggle a Shopify location's active flag. Used by the operator
 * settings UI so they can disable a Shopify location without
 * unmapping it (cron will skip inactive rows on the next sync).
 */
export async function setShopifyLocationActive(args: {
  id: string
  isActive: boolean
}): Promise<{ id: string; isActive: boolean }> {
  const updated = await prisma.stockLocation.update({
    where: { id: args.id },
    data: { isActive: args.isActive },
    select: { id: true, isActive: true },
  })
  return updated
}
