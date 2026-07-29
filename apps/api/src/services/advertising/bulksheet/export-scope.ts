/**
 * AX-IE.10 — what an export was narrowed to, parsed once.
 *
 * This exists so the ESTIMATE and the DOWNLOAD cannot disagree.
 *
 * The estimate endpoint tells an operator "3,625 rows across 76 campaigns"
 * before they commit to a download. The moment it computes that from its own
 * copy of the filter logic, the two drift, and a number shown next to a Download
 * button that does not match the file behind it is worse than showing nothing —
 * this whole series has been about removing exactly that shape of lie
 * (`applySupported` vs the apply dispatch, preview vs apply, the response vs the
 * staging table). One parser, two callers, no second copy.
 *
 * Validation is part of the contract, not a nicety. Every value is checked
 * against what we actually store and an unrecognised one is a 400 naming the
 * allowed set — because "0 campaigns" because you typed `adProduct=SP` is
 * precisely the plausible-wrong answer this series exists to remove.
 */

import type { PrismaClient } from '@prisma/client'
import { parseVocabulary, VOCABULARIES } from '@nexus/shared/ads-bulksheet'

/** The raw query a caller supplies. Every field optional; all combinable. */
export interface ExportScopeQuery {
  campaignIds?: string
  portfolioId?: string
  adProduct?: string
  marketplace?: string
  state?: string
  entities?: string
  asin?: string
  sku?: string
}

export interface ExportScope {
  /** Prisma `where` for Campaign. Empty object = whole account. */
  where: Record<string, unknown>
  /** Human-readable filters, for the README banner, `_meta` and the headers. */
  labels: string[]
  /** Canonical entity names to emit, or null for all of them. */
  entityWanted: Set<string> | null
  /** True when anything at all narrowed the selection. */
  scoped: boolean
}

export type ScopeResult =
  | { ok: true; scope: ExportScope }
  | { ok: false; status: number; body: Record<string, unknown> }

const AD_PRODUCTS = ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY']
const STATES = ['ENABLED', 'PAUSED', 'ARCHIVED']

const csv = (s?: string): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)

export async function parseExportScope(prisma: PrismaClient, q: ExportScopeQuery): Promise<ScopeResult> {
  const labels: string[] = []
  const where: Record<string, unknown> = {}
  const bad = (field: string, received: unknown, extra: Record<string, unknown> = {}) =>
    ({ ok: false as const, status: 400, body: { error: 'bad_scope', field, received, ...extra } })

  const campaignIds = csv(q.campaignIds)
  if (campaignIds.length) {
    // Either id form. Callers hold different ones — the bulksheet's own rows
    // carry Amazon's external id, while the campaigns grid works in local ids
    // because that is what its PATCH endpoints take. Matching only one of them
    // would make "export what I'm looking at" silently select nothing, which is
    // the same trap `_row_key` resolution fell into: a lookup keyed on the one
    // id the caller happened not to have.
    where.OR = [{ externalCampaignId: { in: campaignIds } }, { id: { in: campaignIds } }]
    labels.push(`${campaignIds.length} specific campaign${campaignIds.length === 1 ? '' : 's'}`)
  }
  if (q.portfolioId) { where.portfolioId = q.portfolioId; labels.push(`portfolio ${q.portfolioId}`) }

  if (q.adProduct) {
    const v = q.adProduct.trim().toUpperCase().replace(/[\s-]+/g, '_')
    if (!AD_PRODUCTS.includes(v)) return bad('adProduct', q.adProduct, { allowed: AD_PRODUCTS })
    where.adProduct = v
    labels.push(`ad product ${v.toLowerCase().replace(/_/g, ' ')}`)
  }
  if (q.state) {
    const v = q.state.trim().toUpperCase()
    if (!STATES.includes(v)) return bad('state', q.state, { allowed: STATES })
    where.status = v
    labels.push(`state ${v.toLowerCase()}`)
  }
  if (q.marketplace) {
    const v = q.marketplace.trim().toUpperCase()
    const known = await prisma.campaign.findFirst({ where: { marketplace: v }, select: { id: true } })
    if (!known) {
      const have = (await prisma.campaign.groupBy({ by: ['marketplace'] })).map((m) => m.marketplace).filter(Boolean)
      return bad('marketplace', q.marketplace, { allowed: have })
    }
    where.marketplace = v
    labels.push(`marketplace ${v}`)
  }

  // ── Scope by the PRODUCT being advertised ──────────────────────────
  //
  // Selects CAMPAIGNS, like every other filter — a campaign that advertises the
  // ASIN comes out whole, with its keywords, negatives and other product ads.
  // That is the thing you tune when you want to change how a product is
  // advertised; a lone Product ad row would be a file you cannot act on.
  //
  // Measured before building: all 4,015 product ads carry an ASIN and NONE
  // carries a SKU, so a SKU filter alone would have matched nothing. `sku` is
  // resolved through Product.productId; `asin` matches directly; both converge.
  const asins = csv(q.asin).map((a) => a.toUpperCase())
  const skus = csv(q.sku)
  if (asins.length || skus.length) {
    const asinSet = new Set(asins)
    if (skus.length) {
      const products = await prisma.product.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true } })
      const foundSkus = new Set(products.map((p) => p.sku))
      const missing = skus.filter((s) => !foundSkus.has(s))
      if (missing.length) {
        return bad('sku', missing, { hint: 'No product in the catalogue has that SKU. Check it, or scope by ASIN instead.' })
      }
      const ads = await prisma.adProductAd.findMany({
        where: { productId: { in: products.map((p) => p.id) }, asin: { not: null } },
        select: { asin: true },
      })
      for (const a of ads) if (a.asin) asinSet.add(a.asin)
      labels.push(`sku ${skus.join(', ')}`)
    }
    if (asins.length) labels.push(`asin ${asins.join(', ')}`)

    if (asinSet.size === 0) {
      return {
        ok: false, status: 404,
        body: {
          error: 'scope_matched_nothing', scope: labels,
          hint: 'Those SKUs exist in the catalogue but nothing advertising them is linked to a product ad, so there are no campaigns to export.',
        },
      }
    }
    where.adGroups = { some: { productAds: { some: { asin: { in: [...asinSet] } } } } }
  }

  // Entity filter, validated against the shared grammar rather than a
  // hand-written list, so it cannot drift from what the exporter can emit.
  const wantedEntities = csv(q.entities)
  let entityWanted: Set<string> | null = null
  if (wantedEntities.length) {
    const canonical = wantedEntities.map((e) => parseVocabulary('entity', e))
    const unknown = wantedEntities.filter((_, i) => !canonical[i])
    if (unknown.length) return bad('entities', unknown, { allowed: VOCABULARIES.entity.values })
    labels.push(`entities: ${canonical.join(', ')}`)
    entityWanted = new Set(canonical as string[])
  }

  return { ok: true, scope: { where, labels, entityWanted, scoped: Object.keys(where).length > 0 } }
}
