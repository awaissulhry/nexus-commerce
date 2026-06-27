import type { AddFixedPriceItemInput, TradingVariation } from './ebay-trading-api.service.js'

export type SharedRow = Record<string, unknown>
export type CapQtyFn = (productId: string | undefined, sku: string, requested: number, market?: string) => number

const CURRENCY_BY_MARKET: Record<string, string> = { IT: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', UK: 'GBP' }

function str(v: unknown): string { return v == null ? '' : String(v) }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0 }

export function buildSharedListingInput(
  parentRow: SharedRow,
  variantRows: SharedRow[],
  market: string,
  capQty?: CapQtyFn,
): AddFixedPriceItemInput {
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
    return { sku, price: num(row[`${prefix}_price`] ?? row.price), quantity, specifics }
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

import prisma from '../db.js'
import { addFixedPriceItem } from './ebay-trading-api.service.js'

export interface SharedListingCtx {
  oauthToken: string
  market: string
  capQty?: CapQtyFn
  addFixedPriceItemFn?: (input: AddFixedPriceItemInput, ctx: { oauthToken: string; market: string }) => Promise<{ itemId: string }>
  db?: { sharedListingMembership: { findFirst: Function; create: Function } }
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

    const input = buildSharedListingInput(parentRow, variantRows, market, ctx.capQty)
    const { itemId } = await addFn(input, { oauthToken: ctx.oauthToken, market })

    // Build a SKU→productId map so writeback is correct even if the mapper filters/reorders variations.
    const productIdBySku = new Map<string, string | undefined>()
    for (const row of variantRows) {
      const sku = str(row.sku)
      if (sku) productIdBySku.set(sku, row._productId as string | undefined)
    }

    let count = 0
    for (const v of input.variations) {
      await db.sharedListingMembership.create({
        data: {
          marketplace: market,
          sku: v.sku,
          itemId,
          parentSku,
          productId: productIdBySku.get(v.sku) ?? null,
          variationSpecifics: v.specifics,
          lastQtyPushed: v.quantity,
          lastPushedAt: new Date(),
          status: 'ACTIVE',
        },
      })
      count++
    }
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
