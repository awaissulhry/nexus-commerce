import type { AddFixedPriceItemInput, TradingVariation } from './ebay-trading-api.service.js'
import { toTradingConditionId } from './ebay-condition.js'
import { aspectCanonicalName, ASPECT_SYNONYM_GROUPS, AXIS_SYNONYM_GROUPS } from './ebay-theme-axes.js'

/** Incident #21 — "blank qty on a shared listing = whatever the pool allows".
 *  Callers' capQty implementations recognize this sentinel and return the pool
 *  availability WITHOUT logging an oversell warning. */
export const POOL_DEFAULT_QTY_SENTINEL = Number.MAX_SAFE_INTEGER

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
  // Incident #19 — SYNONYM-COLLAPSED: legacy rows carry English twins
  // (aspect_size beside aspect_taglia); both used to become declared axes
  // (live listing showed Size+Color+Colore+Taglia). Names collapse through
  // aspectCanonicalName — the localized name wins, its value preferred.
  const canonicalByLower = new Map<string, string>()   // canonical lower → display name
  const valueSets = new Map<string, Set<string>>()      // display name → value set
  for (const row of variantRows) {
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('aspect_') && typeof v === 'string' && v) {
        const rawName = k.slice('aspect_'.length).replace(/_/g, ' ')
        if (!rawName) continue
        const canonicalLower = aspectCanonicalName(rawName)
        const isCanonicalSpelling = rawName.toLowerCase().trim() === canonicalLower
        const displayFor = (base: string) => base.replace(/^\w/, (c) => c.toUpperCase())
        if (!canonicalByLower.has(canonicalLower)) {
          // display name: the canonical (localized) spelling, first letter up
          canonicalByLower.set(canonicalLower, displayFor(isCanonicalSpelling ? rawName : canonicalLower))
          valueSets.set(canonicalByLower.get(canonicalLower)!, new Set())
        } else if (isCanonicalSpelling) {
          // prefer the localized spelling as display once seen
          const prev = canonicalByLower.get(canonicalLower)!
          const next = displayFor(rawName)
          if (prev !== next) {
            const set = valueSets.get(prev)!
            valueSets.delete(prev)
            canonicalByLower.set(canonicalLower, next)
            valueSets.set(next, set)
          }
        }
        const canonical = canonicalByLower.get(canonicalLower)!
        valueSets.get(canonical)!.add(v)
      }
    }
  }
  // Incident #25 (code 219451: 'Colore specifico is not allowed as a
  // variation specific') — axes are NEVER guessed from arbitrary aspects:
  // (1) the operator's declared variation_theme rules when present;
  // (2) the heuristic fallback is RESTRICTED to the known axis dimensions
  //     (AXIS_SYNONYM_GROUPS) — per-variant aspects outside them (Colore
  //     specifico, shade names…) stay listing-level item specifics.
  const displayCase = (n: string) => n.replace(/^\w/, (c) => c.toUpperCase())
  const declaredTheme = str(parentRow?.variation_theme) || str(variantRows[0]?.variation_theme)
  let variationSpecificNames: string[]
  if (declaredTheme) {
    variationSpecificNames = [...new Set(
      declaredTheme.split(/[,/|]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => {
          const cl = aspectCanonicalName(t)
          return displayCase(t.toLowerCase() === cl ? t : cl)
        }),
    )]
  } else {
    const isKnownAxis = (name: string) => {
      const cl = aspectCanonicalName(name)
      return AXIS_SYNONYM_GROUPS.some((g) => (g as string[])[0] === cl)
    }
    variationSpecificNames = [...valueSets.entries()]
      .filter(([n, s]) => s.size > 1 && isKnownAxis(n))
      .map(([n]) => n)
  }

  const variations: TradingVariation[] = variantRows.map((row) => {
    const sku = str(row.sku)
    const ean = str(row.ean)
    // Incident #21 — quantities on a SHARED listing follow the POOL. A blank
    // qty cell (planned/imported rows never carry one) used to become 0 and
    // the whole creation died on the all-out-of-stock guard. Blank now means
    // "whatever the pool allows" (capQty caps MAX_SAFE_INTEGER down to the
    // pool's available). An EXPLICIT 0 stays 0 — operator suppression.
    const rawQtyField = row[`${prefix}_qty`] ?? row.quantity
    const qtyBlank = rawQtyField == null || String(rawQtyField).trim() === ''
    const rawQty = qtyBlank ? POOL_DEFAULT_QTY_SENTINEL : num(rawQtyField)
    const quantity = capQty
      ? capQty(row._productId as string | undefined, sku, rawQty, mkt)
      : (qtyBlank ? 0 : num(rawQtyField))
    const specifics: Record<string, string> = {}
    // Build a lowercase→value map from the row's aspect_* keys for case-insensitive lookup.
    const rowKeyLower = new Map<string, string>()
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('aspect_') && typeof v === 'string') {
        rowKeyLower.set(k.toLowerCase(), v)
      }
    }
    for (const name of variationSpecificNames) {
      // Canonical name may have spaces; convert to underscored lowercase for key
      // lookup. Incident #19 — fall back through the synonym spellings so a
      // legacy row carrying ONLY aspect_size still fills the Taglia axis.
      const canonicalLower = aspectCanonicalName(name)
      const spellings = [name.toLowerCase(), canonicalLower,
        ...(ASPECT_SYNONYM_GROUPS.find((g) => (g as string[]).includes(canonicalLower)) ?? [])]
      let val = ''
      for (const sp of spellings) {
        val = rowKeyLower.get(`aspect_${sp.replace(/ /g, '_')}`) ?? ''
        if (val) break
      }
      if (val) specifics[name] = val
    }
    // I4 — only treat a price as present when the selected field actually carries a
    // non-blank value. num() coerces missing/blank → 0, which (a) defeats the "fall back
    // to the child price" path in synthesis and (b) would silently persist a €0 listing.
    const rawPrice = row[`${prefix}_price`] ?? row.price
    const priceStr = rawPrice == null ? '' : String(rawPrice).trim()
    const price = priceStr === '' ? null : num(priceStr)
    return { sku, price, quantity, specifics, ean }
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

  // Listing-level ItemSpecifics (Marca, Stagione…): every aspect_* value that
  // is NOT a variation axis, from the parent row first (child fallback). The
  // category's required aspects live here — eBay code 71 without them.
  // Incident #19 — SYNONYM-COLLAPSED (Brand+Marca were both transmitted) and
  // condition-excluded (eBay renders condition structurally; a Condizione
  // specific doubled it on the page). Localized names win; when both language
  // twins carry values, the localized column's value is preferred.
  const axisCanonicals = new Set(variationSpecificNames.map((n) => aspectCanonicalName(n)))
  const bestByCanonical = new Map<string, { display: string; value: string; localized: boolean }>()
  for (const source of [parentRow, ...variantRows]) {
    for (const [k, v] of Object.entries(source ?? {})) {
      if (!k.startsWith('aspect_') || typeof v !== 'string' || !v.trim()) continue
      const name = k.slice('aspect_'.length).replace(/_/g, ' ').trim()
      if (!name) continue
      const canonicalLower = aspectCanonicalName(name)
      if (canonicalLower === 'condizione') continue
      if (axisCanonicals.has(canonicalLower)) continue
      const isLocalized = name.toLowerCase() === canonicalLower
      const display = (isLocalized ? name : canonicalLower).replace(/^\w/, (c) => c.toUpperCase())
      const prev = bestByCanonical.get(canonicalLower)
      if (!prev || (isLocalized && !prev.localized)) {
        bestByCanonical.set(canonicalLower, { display, value: v.trim(), localized: isLocalized })
      }
    }
  }
  // Incident #26 (code 21919308) — eBay caps each specific VALUE at 65 chars;
  // list-like values (Caratteristiche: 'Ventilato, Impermeabile, …') are
  // MULTI-VALUE aspects and must ship as several <Value> entries.
  const itemSpecifics: Record<string, string | string[]> = {}
  for (const { display, value } of bestByCanonical.values()) {
    if (value.length > 65 && /[,;]/.test(value)) {
      const parts = [...new Set(value.split(/[,;]/).map((x) => x.trim()).filter(Boolean))]
      itemSpecifics[display] = parts
    } else {
      itemSpecifics[display] = value
    }
  }

  return {
    title: str(src.title),
    description: str(src.description),
    categoryId: str(src.category_id),
    // Incident #16 — the operator writes NEW/USED_EXCELLENT… (Inventory-style
    // words); Trading wants numeric ConditionID. Translate; unknown words
    // resolve to '' and the pre-flight below names them (never eBay code 37).
    conditionId: str(src.condition) ? toTradingConditionId(str(src.condition)) : '1000',
    country: str(src.item_location_country) || 'IT',
    // Shipping origin: row columns win; otherwise the account's single origin
    // (mirrors every live listing on this account — probed 2026-07-18).
    location: str(src.item_location) || process.env.EBAY_ITEM_LOCATION || 'Santarcangelo di Romagna',
    postalCode: str(src.item_postal_code) || process.env.EBAY_ITEM_POSTAL_CODE || '47822',
    itemSpecifics,
    currency: CURRENCY_BY_MARKET[mkt] ?? 'EUR',
    variationSpecificNames,
    variations,
    pictureUrls: pictureUrls.length ? pictureUrls : undefined,
    policies,
  }
}

import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { addFixedPriceItem, callTradingApi, siteIdForMarket } from './ebay-trading-api.service.js'
import { renderListingDescriptionSafe } from './ebay-description-theme.service.js'

export interface SharedListingCtx {
  oauthToken: string
  market: string
  capQty?: CapQtyFn
  addFixedPriceItemFn?: (input: AddFixedPriceItemInput, ctx: { oauthToken: string; market: string }) => Promise<{ itemId: string }>
  db?: {
    sharedListingMembership: { findFirst: Function; create: Function; deleteMany?: Function }
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
    // Incident #23 — the adopt belt must never bow to a CORPSE. A membership
    // (or row ItemID) can reference a listing that has since been ended
    // (deleted pre-sweep-fix, ended in Seller Hub…). Verify liveness with
    // GetItem; a dead listing's memberships are swept and creation proceeds.
    const isListingAlive = async (iid: string): Promise<boolean | null> => {
      try {
        if (!iid) return null
        const got = await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?>\n<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${iid}</ItemID></GetItemRequest>`,
          { oauthToken: ctx.oauthToken, siteId: siteIdForMarket(market) })
        if (!got.raw) return null // dry-run/neutralized harness — indeterminate
        const status = /<ListingStatus>([^<]+)<\/ListingStatus>/.exec(got.raw)?.[1] ?? ''
        return status === 'Active'
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/invalid item id|item id was not found|17\)/i.test(msg)) return false
        return null // indeterminate (network/etc) — do NOT sweep on doubt
      }
    }

    const existing = await db.sharedListingMembership.findFirst({ where: { marketplace: market, parentSku } })
    if (existing) {
      const alive = await isListingAlive(String((existing as { itemId?: unknown }).itemId ?? ''))
      if (alive === false && typeof (db.sharedListingMembership as { deleteMany?: Function }).deleteMany === 'function') {
        await (db.sharedListingMembership as { deleteMany: Function }).deleteMany({ where: { marketplace: market, parentSku } })
        // fall through to creation — the old listing is gone; self-healed.
      } else {
        return { status: 'SKIPPED_EXISTS', parentSku, market, memberships: 0, message: 'memberships already exist for this parent+market' }
      }
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
      const alive = await isListingAlive(liveItemId)
      if (alive !== false) {
        return {
          status: 'SKIPPED_EXISTS',
          itemId: liveItemId,
          parentSku,
          market,
          memberships: 0,
          message: `already live on eBay (ItemID ${liveItemId}) — Save the sheet to adopt it; quantities then sync via the shared fan-out`,
        }
      }
      // dead row-carried ItemID — ignore it and create fresh (self-heal).
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
      const bad = input.variations.filter((v) => v.price == null || v.price <= 0).map((v) => v.sku)
      return { status: 'ERROR', parentSku, market, memberships: 0, message: `missing/invalid price on: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ''} — set the ${market} price on those rows` }
    }
    // Incident #15 pre-flight — name EVERY missing requirement client-side so
    // eBay never answers a new-listing attempt with a bare "Input data is
    // invalid". Checks mirror AddFixedPriceItem's hard requirements.
    {
      const missing: string[] = []
      if (!str(input.title)) missing.push('title')
      if (!str((input as { categoryId?: unknown }).categoryId)) missing.push('category ID')
      if (!str((input as { conditionId?: unknown }).conditionId)) {
        const rawCond = str(parentRow.condition)
        missing.push(rawCond
          ? `condition ('${rawCond}' is not a recognized value — use NEW, NEW_OTHER, USED_EXCELLENT, … or a numeric eBay ConditionID)`
          : 'condition')
      }
      if (!input.variations.length) missing.push('variant rows')
      const pics = (input as { pictureUrls?: unknown[] }).pictureUrls
      if (Array.isArray(pics) && pics.length === 0) missing.push('images')
      if (missing.length > 0) {
        return { status: 'ERROR', parentSku, market, memberships: 0, message: `cannot create the listing — missing: ${missing.join(', ')} (fill these on the parent row, Save, then push again)` }
      }
      // 65-char cap per specific value (eBay 21919308) — name the offender
      // instead of letting eBay reject with a truncated message.
      const specificsForCheck = (input as { itemSpecifics?: Record<string, string | string[]> }).itemSpecifics ?? {}
      for (const [n, v] of Object.entries(specificsForCheck)) {
        const vals = Array.isArray(v) ? v : [v]
        const tooLong = vals.find((x) => x.length > 65)
        if (tooLong) {
          return { status: 'ERROR', parentSku, market, memberships: 0, message: `item specific "${n}" has a value over eBay's 65-character limit: "${tooLong.slice(0, 70)}…" — shorten it (or separate list items with commas)` }
        }
      }
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

    // Incident #24 — round-trip integrity from birth: the membership stores
    // the PUSHED row verbatim (flatFileSnapshot), so the grid's synthesized
    // rows after creation are exactly the file the operator pushed — never a
    // regeneration from base product data ("reverts to a previous version").
    const rowBySku = new Map<string, Record<string, unknown>>()
    for (const r of variantRows) {
      const rsku = str(r.sku)
      if (rsku) rowBySku.set(rsku, r as Record<string, unknown>)
    }
    const snapshotFor = (vsku: string): Prisma.InputJsonObject | undefined => {
      const r = rowBySku.get(vsku)
      if (!r) return undefined
      return Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_'))) as Prisma.InputJsonObject
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
          ...(snapshotFor(v.sku) ? { flatFileSnapshot: snapshotFor(v.sku) } : {}),
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
