import type { AddFixedPriceItemInput, TradingVariation } from './ebay-trading-api.service.js'

export type SharedRow = Record<string, unknown>
export type CapQtyFn = (productId: string | undefined, sku: string, requested: number, market?: string) => number

// I4 — a shared variation carries a NULLABLE price so a genuinely-absent per-listing
// price yields `null` (→ membership.price NULL → synthesis falls back to the child base
// price) instead of a coerced 0. createSharedListing rejects any null/≤0 price before it
// ever reaches the eBay push, so a persisted membership always has a real positive price.
export type SharedVariation = Omit<TradingVariation, 'price'> & { price: number | null }
export type SharedListingInput = Omit<AddFixedPriceItemInput, 'variations'> & { variations: SharedVariation[] }

const CURRENCY_BY_MARKET: Record<string, string> = { IT: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', UK: 'GBP' }

function str(v: unknown): string { return v == null ? '' : String(v) }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0 }

export function buildSharedListingInput(
  parentRow: SharedRow,
  variantRows: SharedRow[],
  market: string,
  capQty?: CapQtyFn,
): SharedListingInput {
  const mkt = market.toUpperCase()
  const prefix = mkt.toLowerCase()

  // Axis detection: aspect_* keys with >1 distinct value across variants.
  // Case-insensitive dedup: first-seen casing wins for the canonical name.
  const canonicalByLower = new Map<string, string>()   // lower → first-seen canonical
  const valueSets = new Map<string, Set<string>>()      // canonical → value set
  for (const row of variantRows) {
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('aspect_') && typeof v === 'string' && v) {
        const rawName = k.slice('aspect_'.length).replace(/_/g, ' ')
        if (!rawName) continue
        const lower = rawName.toLowerCase()
        // first-cased-wins: record canonical on first encounter
        if (!canonicalByLower.has(lower)) {
          canonicalByLower.set(lower, rawName)
          valueSets.set(rawName, new Set())
        }
        const canonical = canonicalByLower.get(lower)!
        valueSets.get(canonical)!.add(v)
      }
    }
  }
  const variationSpecificNames = [...valueSets.entries()].filter(([, s]) => s.size > 1).map(([n]) => n)

  const variations: TradingVariation[] = variantRows.map((row) => {
    const sku = str(row.sku)
    const rawQty = num(row[`${prefix}_qty`] ?? row.quantity)
    const quantity = capQty ? capQty(row._productId as string | undefined, sku, rawQty, mkt) : rawQty
    const specifics: Record<string, string> = {}
    // Build a lowercase→value map from the row's aspect_* keys for case-insensitive lookup.
    const rowKeyLower = new Map<string, string>()
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('aspect_') && typeof v === 'string') {
        rowKeyLower.set(k.toLowerCase(), v)
      }
    }
    for (const name of variationSpecificNames) {
      // Canonical name may have spaces; convert to underscored lowercase for key lookup.
      const lowerKey = `aspect_${name.replace(/ /g, '_').toLowerCase()}`
      const val = rowKeyLower.get(lowerKey) ?? ''
      if (val) specifics[name] = val
    }
    // I4 — only treat a price as present when the selected field actually carries a
    // non-blank value. num() coerces missing/blank → 0, which (a) defeats the "fall back
    // to the child price" path in synthesis and (b) would silently persist a €0 listing.
    const rawPrice = row[`${prefix}_price`] ?? row.price
    const priceStr = rawPrice == null ? '' : String(rawPrice).trim()
    const price = priceStr === '' ? null : num(priceStr)
    return { sku, price, quantity, specifics }
  })

  const src = parentRow ?? variantRows[0] ?? {}
  const pictureUrls = ['image_1', 'image_2', 'image_3', 'image_4', 'image_5', 'image_6']
    .map((k) => str(src[k]))
    .filter(Boolean)

  const policyVals = {
    fulfillmentPolicyId: str(src.fulfillment_policy_id) || undefined,
    paymentPolicyId: str(src.payment_policy_id) || undefined,
    returnPolicyId: str(src.return_policy_id) || undefined,
  }
  const policies = (policyVals.fulfillmentPolicyId || policyVals.paymentPolicyId || policyVals.returnPolicyId)
    ? policyVals
    : undefined

  return {
    title: str(src.title),
    description: str(src.description),
    categoryId: str(src.category_id),
    conditionId: str(src.condition) || '1000',
    country: str(src.item_location_country) || 'IT',
    currency: CURRENCY_BY_MARKET[mkt] ?? 'EUR',
    variationSpecificNames,
    variations,
    pictureUrls: pictureUrls.length ? pictureUrls : undefined,
    policies,
  }
}

import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { addFixedPriceItem } from './ebay-trading-api.service.js'
import { renderListingDescriptionSafe } from './ebay-description-theme.service.js'

export interface SharedListingCtx {
  oauthToken: string
  market: string
  capQty?: CapQtyFn
  addFixedPriceItemFn?: (input: AddFixedPriceItemInput, ctx: { oauthToken: string; market: string }) => Promise<{ itemId: string }>
  db?: {
    sharedListingMembership: { findFirst: Function; create: Function }
    product: { findMany: Function }
    $transaction: (args: Promise<unknown>[]) => Promise<unknown[]>
  }
}
export interface SharedListingResult {
  status: 'CREATED' | 'SKIPPED_EXISTS' | 'ERROR'
  itemId?: string
  parentSku: string
  market: string
  memberships: number
  message: string
}

export async function createSharedListing(
  parentRow: SharedRow,
  variantRows: SharedRow[],
  ctx: SharedListingCtx,
): Promise<SharedListingResult> {
  const market = ctx.market.toUpperCase()
  const parentSku = str(parentRow.sku)
  const db = ctx.db ?? (prisma as unknown as NonNullable<SharedListingCtx['db']>)
  const addFn = ctx.addFixedPriceItemFn ?? addFixedPriceItem

  try {
    const existing = await db.sharedListingMembership.findFirst({ where: { marketplace: market, parentSku } })
    if (existing) {
      return { status: 'SKIPPED_EXISTS', parentSku, market, memberships: 0, message: 'memberships already exist for this parent+market' }
    }

    // Adopt-don't-duplicate belt: a row carrying a live ItemID describes a
    // listing that ALREADY exists on eBay (an imported multi-listing file, or a
    // live family flipped to shared after a normal publish). AddFixedPriceItem
    // here would put the same items on eBay twice. Memberships adopt live
    // listings on SAVE (upsertSharedMembershipsFromRows) — never by re-listing.
    const mpPrefix = market.toLowerCase()
    const liveItemId = [parentRow, ...variantRows]
      .map((r) => str(r[`${mpPrefix}_item_id`]) || str(r.ebay_item_id))
      .find(Boolean)
    if (liveItemId) {
      return {
        status: 'SKIPPED_EXISTS',
        itemId: liveItemId,
        parentSku,
        market,
        memberships: 0,
        message: `already live on eBay (ItemID ${liveItemId}) — Save the sheet to adopt it; quantities then sync via the shared fan-out`,
      }
    }

    const input = buildSharedListingInput(parentRow, variantRows, market, ctx.capQty)

    // ED.2 — dynamic description: wrap the body in this listing's assigned theme
    // (shared-SKU listings are per-parent, so each gets its own render). Inert
    // without a theme; render errors fall back to the raw body.
    const themeProductId = str(parentRow._productId) || str(variantRows[0]?._productId)
    if (themeProductId) {
      const themed = await renderListingDescriptionSafe(prisma, {
        productId: themeProductId,
        marketplace: market,
        mode: 'group',
        body: input.description,
        title: input.title,
      })
      input.description = themed.html
    }

    // I4 — reject BEFORE the eBay push (mirrors the single-SKU path's price>0 guard) so a
    // 0/undefined-price listing is never created and no Decimal(0) membership is persisted.
    if (input.variations.some((v) => v.price == null || v.price <= 0)) {
      return { status: 'ERROR', parentSku, market, memberships: 0, message: 'missing/invalid price for one or more shared variants' }
    }

    // All variant prices validated as positive numbers above — safe to widen for addFn.
    const { itemId } = await addFn(input as AddFixedPriceItemInput, { oauthToken: ctx.oauthToken, market })

    // Build a SKU→productId map so writeback is correct even if the mapper filters/reorders variations.
    const productIdBySku = new Map<string, string | undefined>()
    for (const row of variantRows) {
      const sku = str(row.sku)
      if (sku) productIdBySku.set(sku, row._productId as string | undefined)
    }

    // Backfill productId via DB SKU lookup for variants that had no _productId.
    const missing = [...productIdBySku.entries()].filter(([, id]) => !id).map(([sku]) => sku)
    if (missing.length) {
      const found = await db.product.findMany({
        where: { sku: { in: missing }, deletedAt: null },
        select: { id: true, sku: true },
      })
      for (const f of found) productIdBySku.set(f.sku as string, f.id as string)
    }

    await db.$transaction(input.variations.map((v) =>
      db.sharedListingMembership.create({
        data: {
          marketplace: market,
          sku: v.sku,
          itemId,
          parentSku,
          productId: productIdBySku.get(v.sku) ?? null,
          variationSpecifics: v.specifics,
          price: v.price != null ? new Prisma.Decimal(v.price) : null,
          lastQtyPushed: v.quantity,
          lastPushedAt: new Date(),
          status: 'ACTIVE',
        },
      })
    ))
    const count = input.variations.length
    return { status: 'CREATED', itemId, parentSku, market, memberships: count, message: `created ${count} memberships` }
  } catch (err) {
    return { status: 'ERROR', parentSku, market, memberships: 0, message: err instanceof Error ? err.message : String(err) }
  }
}

export async function pushSharedListings(rows: SharedRow[], ctx: SharedListingCtx): Promise<SharedListingResult[]> {
  const families = new Map<string, SharedRow[]>()
  for (const row of rows) {
    const key = (row.platformProductId as string | undefined) ?? str(row.sku)
    if (!families.has(key)) families.set(key, [])
    families.get(key)!.push(row)
  }

  const isParent = (r: SharedRow) =>
    r._isParent === true ||
    (r._productId != null && r.platformProductId != null && String(r._productId) === String(r.platformProductId))

  const results: SharedListingResult[] = []
  for (const familyRows of families.values()) {
    const parent = familyRows.find(isParent) ?? familyRows[0]
    const variantsAll = familyRows.filter((r) => !isParent(r))
    const variants = variantsAll.length > 0 ? variantsAll : familyRows
    results.push(await createSharedListing(parent, variants, ctx))
  }
  return results
}
