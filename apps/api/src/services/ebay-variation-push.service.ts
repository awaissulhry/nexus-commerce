/**
 * eBay variation-group push — shared Inventory-API publisher.
 *
 * Extracted verbatim from ebay-flat-file.routes.ts (behaviour-preserving) so both
 * the eBay flat-file page and the per-product Images tab publish through ONE proven
 * code path. No logic changes vs the original at extraction time.
 */
import prisma from '../db.js'
import { ebayAccountService } from './ebay-account.service.js'
import { syncActivatedListings } from './listing-activation-sync.service.js'
import { Prisma } from '@nexus/database'

// FF-EN.2 — eBay numeric conditionId → Inventory API ConditionEnum string.
// get_item_condition_policies returns numeric ids; the flat-file/Inventory
// push uses the enum string, so we translate before exposing as options.
export const CONDITION_ID_TO_ENUM: Record<string, string> = {
  '1000': 'NEW',
  '1500': 'NEW_OTHER',
  '1750': 'NEW_WITH_DEFECTS',
  '2000': 'CERTIFIED_REFURBISHED',
  '2010': 'EXCELLENT_REFURBISHED',
  '2020': 'VERY_GOOD_REFURBISHED',
  '2030': 'GOOD_REFURBISHED',
  '2500': 'SELLER_REFURBISHED',
  '2750': 'LIKE_NEW',
  '3000': 'USED_EXCELLENT',
  '4000': 'USED_VERY_GOOD',
  '5000': 'USED_GOOD',
  '6000': 'USED_ACCEPTABLE',
  '7000': 'FOR_PARTS_OR_NOT_WORKING',
};

// ── Variation group push helper ────────────────────────────────────────

// FF-EN.4 — build the Inventory API packageWeightAndSize from the flat
// row's package fields. Returns undefined when nothing usable is set, so
// the publish body is unchanged for rows without shipping dimensions.
export function buildPackageWeightAndSize(
  row: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const w = Number(row.package_weight ?? 0);
  const l = Number(row.package_length ?? 0);
  const wd = Number(row.package_width ?? 0);
  const h = Number(row.package_height ?? 0);
  const pkgType = (row.package_type as string) || '';
  const out: Record<string, unknown> = {};
  if (w > 0) out.weight = { value: w, unit: (row.weight_unit as string) || 'KILOGRAM' };
  if (l > 0 && wd > 0 && h > 0) {
    out.dimensions = {
      length: l,
      width: wd,
      height: h,
      unit: (row.dimension_unit as string) || 'CENTIMETER',
    };
  }
  if (pkgType) out.packageType = pkgType;
  return Object.keys(out).length ? out : undefined;
}

// Maps eBay marketplace short-code to the BCP-47 language tag that eBay's
// Inventory API requires for Content-Language / Accept-Language headers.
// eBay stores aspect names in the locale used at write time — sending en-US
// for an EBAY_IT listing causes eBay to expect English names ("Color", "Size")
// which then don't match the Italian category aspects ("Colore", "Taglia"),
// triggering publish error 25013.
export function toListingLanguage(mp: string): string {
  const MAP: Record<string, string> = {
    IT: 'it-IT', DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', UK: 'en-GB', GB: 'en-GB',
  }
  return MAP[mp.toUpperCase()] ?? 'en-US'
}

// Transient eBay Inventory errors — 25001 ("internal warehouse service error")
// and 25604 ("product not found") — fire when a PUT/POST races eBay's eventual
// consistency (e.g. a group PUT referencing inventory_items written <2s earlier,
// common for large families). Retry with exponential backoff. The body is peeked
// via res.clone() so callers still read res.ok / res.text() on the result unchanged.
async function ebayFetchRetry(
  url: string,
  init: RequestInit,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const { retries = 3, baseDelayMs = 2000 } = opts
  let res = await fetch(url, init)
  for (let attempt = 0; attempt < retries; attempt++) {
    if (res.ok || res.status === 204) return res
    let body = ''
    try { body = await res.clone().text() } catch { /* unreadable — treat as non-transient */ }
    const transient =
      res.status === 500 || res.status === 503 ||
      body.includes('"errorId":25001') || body.includes('"errorId":25604')
    if (!transient) return res
    await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt)) // 2s → 4s → 8s
    res = await fetch(url, init)
  }
  return res
}

export async function pushVariationGroup(
  groupKey: string,
  rows: Array<Record<string, unknown>>,
  mp: string,
  token: string,
  connectionId: string,
  connectionMeta: Record<string, unknown>,
  apiBase: string,
  marketplaceId: string,
  // FCF.3 — caps each variant's qty at its FBM-available pool.
  capToFbm: (pid: string | undefined, sku: string, requested: number, market?: string) => number,
  // P3 — per-colour curated image override (colourValue.toLowerCase() → ordered
  // URLs). When a colour is present here these URLs WIN over the ProductImage-
  // derived colorRepImages, so the operator's master-gallery selections become
  // the per-variant images. Colours absent from the map keep the default.
  imageOverrideByColor?: Map<string, string[]>,
  // P4 — the variation axis eBay varies images by (aspectsImageVariesBy). Defaults
  // to the auto-detected colour axis when omitted, so the flat-file push is
  // unchanged. imageOverrideByColor is keyed by THIS axis's values.
  pictureAxisOverride?: string,
  // P4 — per-SKU image override; WINS over the per-axis-value override for that
  // exact variant. Keyed by SKU. (eBay only shows per-SKU images when the picture
  // axis is granular enough — e.g. Size — so this is for those configurations.)
  imageOverrideBySku?: Map<string, string[]>,
): Promise<{ sku: string; market: string; status: 'PUSHED' | 'ERROR'; message: string; itemId?: string }[]> {
  const results: { sku: string; market: string; status: 'PUSHED' | 'ERROR'; message: string; itemId?: string }[] = []

  const lang = toListingLanguage(mp)
  // eBay Sell Inventory API requires BOTH Content-Language AND Accept-Language
  // on every call (inventory_item, inventory_item_group, offer, publish).
  // Sending only one triggers error 25709 ("Invalid value for Content-Language
  // header"). Use one headers object for all steps — mirrors ebay-publish.adapter.ts.
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Content-Language': lang,
    'Accept-Language': lang,
    Accept: 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
  }

  // EV.5b — the family load (EV.5) includes the parent *container* row
  // (_isParent). The parent is not a sellable variant: it must not get
  // its own inventory_item nor be a group member. It IS the right source
  // for the group-level title/description/images.
  const parentRow = rows.find((r) => r._isParent) ?? rows[0]
  const variantRowsAll = rows.filter((r) => !r._isParent)
  const variantRows = variantRowsAll.length > 0 ? variantRowsAll : rows

  // EV.6b — name/value renames from parent ChannelListing platformAttributes.
  // Also build brandBySku (sku-keyed, not _productId-keyed) so brand lookup is
  // frontend-round-trip-proof: _productId/_brand are _ -prefixed internal fields
  // that React state may drop; sku is always present in the push body.
  let nameLabels: Record<string, string> = {}
  let valueLabels: Record<string, Record<string, string>> = {}
  const brandBySku = new Map<string, string>()
  try {
    const skus = rows.map((r) => r.sku as string).filter(Boolean)
    const prods = await prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, parentId: true, brand: true },
    })
    for (const p of prods) {
      if (p.brand) brandBySku.set(p.sku, p.brand)
    }
    // Resolve name/value label overrides from the parent listing's platformAttributes
    const parentSku = (rows.find((r) => r._isParent) ?? rows[0])?.sku as string | undefined
    if (parentSku) {
      const pl = await prisma.channelListing.findFirst({
        where: { product: { sku: parentSku }, channel: 'EBAY', marketplace: mp },
        select: { platformAttributes: true },
      })
      const pa = (pl?.platformAttributes ?? {}) as Record<string, unknown>
      nameLabels = (pa._axisNameLabels ?? {}) as Record<string, string>
      valueLabels = (pa._axisValueLabels ?? {}) as Record<string, Record<string, string>>
    }
  } catch (err) {
    console.warn('[ebay-push] brand/label fetch failed — proceeding without renames', err)
  }
  const nmLabel = (a: string) => nameLabels[a] || a
  const vlLabel = (a: string, v: string) => valueLabels[a]?.[v] || v

  // Pre-fetch images per SKU. Priority order:
  //   1. ProductImage rows (PI) — the canonical image store; always populated for
  //      products that went through the image editor. Covers all colours + all sizes.
  //   2. Amazon ChannelListing platformAttributes.imageUrls — SP-API import fallback
  //      (only present when Amazon sync has run and stored per-variant image URLs).
  //   3. row.image_1..image_6 — operator-entered flat-file image columns (fallback
  //      of last resort; used per-variant in the loop below).
  const productImagesBySku = new Map<string, string[]>()
  try {
    const variantSkus = variantRows.map(r => r.sku as string).filter(Boolean)
    const piRows = await prisma.product.findMany({
      where: { sku: { in: variantSkus }, deletedAt: null },
      select: {
        sku: true,
        images: { orderBy: { sortOrder: 'asc' }, select: { url: true } },
      },
    })
    for (const p of piRows) {
      const urls = p.images.map(i => i.url).filter(Boolean)
      if (urls.length) productImagesBySku.set(p.sku, urls)
    }
  } catch (err) {
    console.warn('[ebay-push] ProductImage fetch failed', err)
  }

  const amazonImagesBySku = new Map<string, string[]>()
  try {
    const variantSkus = variantRows.map(r => r.sku as string).filter(Boolean)
    const amazonListings = await prisma.channelListing.findMany({
      where: { product: { sku: { in: variantSkus } }, channel: 'AMAZON' },
      select: { platformAttributes: true, product: { select: { sku: true } } },
    })
    for (const al of amazonListings) {
      const attrs = (al.platformAttributes ?? {}) as Record<string, unknown>
      let urls: string[] = Array.isArray(attrs.imageUrls)
        ? (attrs.imageUrls as string[]).filter(Boolean)
        : []
      if (urls.length === 0 && Array.isArray(attrs.main_product_image_locator)) {
        urls = (attrs.main_product_image_locator as Array<{ media_location?: string }>)
          .map(l => l.media_location ?? '')
          .filter(Boolean)
      }
      if (urls.length === 0 && typeof attrs.mainImage === 'string' && attrs.mainImage) {
        urls = [attrs.mainImage]
      }
      if (urls.length) amazonImagesBySku.set(al.product.sku, urls)
    }
  } catch (err) {
    console.warn('[ebay-push] Amazon image fallback fetch failed', err)
  }

  // Merge: ProductImage rows win over Amazon ChannelListing platformAttributes.
  const imagesBySku = new Map<string, string[]>()
  for (const [sku, urls] of amazonImagesBySku) imagesBySku.set(sku, urls)
  for (const [sku, urls] of productImagesBySku) imagesBySku.set(sku, urls) // PI wins

  // Detect variation axes dynamically: scan all aspect_* keys across variant
  // rows and find those with >1 distinct value. Robust against the Amazon
  // variation theme (e.g. "SIZE_COLOR") not matching the eBay category's
  // locale-specific aspect names ("Colore", "Taglia" on EBAY_IT).
  const allAspectValueSets = new Map<string, Set<string>>()
  for (const row of variantRows) {
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('aspect_') && typeof v === 'string' && v) {
        const name = k.slice('aspect_'.length).replace(/_/g, ' ')
        if (!allAspectValueSets.has(name)) allAspectValueSets.set(name, new Set())
        allAspectValueSets.get(name)!.add(v)
      }
    }
  }
  const effectiveVarAxes = [...allAspectValueSets.entries()]
    .filter(([, vals]) => vals.size > 1)
    .map(([name]) => name)

  const isVarAxis = (name: string) => effectiveVarAxes.includes(name)

  // ── Colour-representative image sets ─────────────────────────────────────
  // eBay with aspectsImageVariesBy=['Color'] aggregates images from EVERY variant
  // that matches the selected colour. If all 9 Black-size variants each carry 6
  // images (even identical URLs), eBay may show up to 9×6=54 photos in the
  // carousel instead of 6.
  //
  // Fix: pre-compute ONE canonical image set per colour value, then assign that
  // exact same set to every same-colour variant. eBay deduplicates by URL so the
  // buyer always sees 6 images regardless of how many sizes the colour has.
  //
  // Falls back to per-SKU images when no colour axis is present (single-colour
  // products, bundles, etc.).
  const COLOR_AXIS_NAMES_PRE = new Set(['colore', 'color', 'farbe', 'couleur', 'colour', 'kleur'])
  const colorAxisRawName = effectiveVarAxes.find(n => COLOR_AXIS_NAMES_PRE.has(n.toLowerCase()))
  // P4 — operator-chosen picture axis (the aspect eBay varies images by). Resolve
  // the requested name against the real variation axes; fall back to the colour
  // axis. With no override this IS colorAxisRawName, so behaviour is unchanged.
  const pictureAxis = (pictureAxisOverride
    && effectiveVarAxes.find(a => a.toLowerCase() === pictureAxisOverride.toLowerCase()))
    || colorAxisRawName
  const colorRepImages = new Map<string, string[]>() // pictureAxisValue.toLowerCase() → [url, ...]
  if (pictureAxis) {
    const axisKey = `aspect_${pictureAxis.replace(/ /g, '_')}`
    for (const row of variantRows) {
      const colorVal = String((row as Record<string, unknown>)[axisKey] ?? '').toLowerCase()
      if (!colorVal || colorRepImages.has(colorVal)) continue
      const sku = row.sku as string
      // Prefer imagesBySku (ProductImage rows + Amazon PA — set in the merge above)
      // over the flat-file image_1..6 columns which may contain old stale URLs.
      let imgs = (imagesBySku.get(sku) ?? []).slice(0, 6)
      if (imgs.length === 0) {
        for (let i = 1; i <= 6; i++) {
          const url = (row as Record<string, unknown>)[`image_${i}`] as string | undefined
          if (url) imgs.push(url)
        }
      }
      colorRepImages.set(colorVal, imgs)
    }
  }

  // Step 1: Create/update each variant's inventory_item.
  for (const row of variantRows) {
    const sku = row.sku as string

    // Deduplicate aspects by nmLabel key: buildFlatRow writes both the
    // case-preserved key (aspect_Colore) and lowercased key (aspect_color),
    // and Amazon import can add English equivalents. Using a Map keyed by
    // nmLabel ensures each logical axis appears exactly once in the item.
    const aspectsMap = new Map<string, string[]>()
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('aspect_') && v) {
        const aspectName = k.slice('aspect_'.length).replace(/_/g, ' ')
        if (isVarAxis(aspectName)) {
          aspectsMap.set(nmLabel(aspectName), [vlLabel(aspectName, String(v))])
        } else {
          aspectsMap.set(aspectName, [String(v)])
        }
      }
    }
    if (row.ean) aspectsMap.set('EAN', [String(row.ean)])
    if (row.mpn) aspectsMap.set('MPN', [String(row.mpn)])

    // eBay requires the market-localised brand aspect ("Marca" for IT/ES,
    // "Marke" for DE, "Marque" for FR, "Brand" for UK). Normalise any
    // existing brand-like key, or inject from Product.brand (_brand on row).
    const BRAND_ASPECT: Record<string, string> = {
      IT: 'Marca', ES: 'Marca', DE: 'Marke', FR: 'Marque', UK: 'Brand', GB: 'Brand',
    }
    const targetBrandAspect = BRAND_ASPECT[mp.toUpperCase()] ?? 'Brand'
    const BRAND_ALIASES = new Set(['marca', 'brand', 'marke', 'marque', 'marka'])
    const existingBrandKey = [...aspectsMap.keys()].find(k => BRAND_ALIASES.has(k.toLowerCase()))
    if (existingBrandKey && existingBrandKey !== targetBrandAspect) {
      // Rename e.g. "Brand" → "Marca" for EBAY_IT
      const v = aspectsMap.get(existingBrandKey)!
      aspectsMap.delete(existingBrandKey)
      aspectsMap.set(targetBrandAspect, v)
    } else if (!existingBrandKey) {
      // Look up brand by SKU — sku is always preserved through the frontend round-trip
      // unlike _productId/_brand which are underscore-prefixed internal fields.
      const brandVal = (brandBySku.get(sku) ?? '').trim()
      if (brandVal) aspectsMap.set(targetBrandAspect, [brandVal])
    }

    // Unconditional safety net: if the brand aspect is still absent after all
    // injection paths (DB lookup, rename, row data), force-set it. A missing
    // brand causes eBay error 25002 at publish_by_group. The brandBySku map
    // should have the value; 'Xavia' is the correct fallback for this system.
    if (!aspectsMap.has(targetBrandAspect)) {
      aspectsMap.set(targetBrandAspect, [brandBySku.get(sku) || 'Xavia'])
    }

    // eBay IT requires EAN as an item specific for clothing (error 25002 "Manca EAN").
    // When no real EAN exists, 'Does not apply' is the eBay-standard placeholder for
    // products that genuinely have no GTIN/barcode. Accepted by all EU marketplaces.
    const EAN_ALIASES = new Set(['ean', 'gtin', 'upc', 'isbn'])
    const existingEanKey = [...aspectsMap.keys()].find(k => EAN_ALIASES.has(k.toLowerCase()))
    if (!existingEanKey && !row.ean) {
      aspectsMap.set('EAN', ['Does not apply'])
    }

    const aspects = Object.fromEntries(aspectsMap)

    // FCF.3 — cap each variant at its FBM-available pool.
    const qty = capToFbm(row._productId as string | undefined, sku, Number(row[`${mp.toLowerCase()}_qty`] ?? row.quantity ?? 0), mp)

    // Use the colour-representative image set (same URLs for every variant of
    // the same colour). eBay deduplicates by URL, so all Black-size variants
    // end up showing the same 6 images in the carousel instead of 9×6=54.
    // Falls back to per-SKU images when no colour axis is detected.
    const imageUrls: string[] = []
    // P4 — a per-SKU override (operator pinned images to this exact variant) wins
    // over everything else.
    if (imageOverrideBySku?.get(sku)?.length) {
      imageUrls.push(...imageOverrideBySku.get(sku)!)
    } else if (pictureAxis) {
      const axisKey = `aspect_${pictureAxis.replace(/ /g, '_')}`
      const axisVal = String((row as Record<string, unknown>)[axisKey] ?? '').toLowerCase()
      // P3 — curated per-axis-value override (operator's master-gallery picks) wins
      // over the ProductImage-derived set; otherwise fall back to the rep-image set.
      if (axisVal && imageOverrideByColor?.get(axisVal)?.length) {
        imageUrls.push(...imageOverrideByColor.get(axisVal)!)
      } else if (axisVal && colorRepImages.has(axisVal)) {
        imageUrls.push(...colorRepImages.get(axisVal)!)
      }
    }
    // Fallback: per-SKU images (no colour axis, or this variant's colour value
    // wasn't found in the pre-pass map).
    if (imageUrls.length === 0) {
      for (let i = 1; i <= 6; i++) {
        const url = row[`image_${i}`] as string | undefined
        if (url) imageUrls.push(url)
      }
      if (imageUrls.length === 0) {
        imageUrls.push(...(imagesBySku.get(sku) ?? []).slice(0, 6))
      }
    }
    // eBay rejects inventory_item PUT with error 25717 when imageUrls is empty.
    if (imageUrls.length === 0) {
      results.push({ sku, market: mp, status: 'ERROR', message: 'No images found for this SKU — upload images via the image editor or populate image_1 in the flat-file before pushing' })
      continue
    }

    // Translate numeric conditionId (e.g. '1000') to eBay ConditionEnum ('NEW').
    // buildFlatRow stores the raw conditionId from platformAttributes; the
    // Inventory API rejects numeric strings.
    const rawCondition = String(row.condition ?? '')
    const condition = CONDITION_ID_TO_ENUM[rawCondition] ?? (rawCondition || 'NEW')

    const pkgSize = buildPackageWeightAndSize(row)
    const itemBody = {
      product: {
        title: row.title ?? sku,
        description: row.description ?? '',
        imageUrls,
        aspects,
        // eBay requires the EAN/GTIN identifier field to be explicitly set.
        // When no real barcode exists, 'Does not apply' is the correct value —
        // equivalent to selecting "Does not apply" in eBay's listing form.
        ean: row.ean ? [String(row.ean)] : ['Does not apply'],
        // MPN is required alongside EAN. Use 'Does not apply' when absent.
        mpn: row.mpn ? String(row.mpn) : 'Does not apply',
      },
      condition,
      availability: {
        shipToLocationAvailability: { quantity: Number(qty) },
      },
      ...(pkgSize ? { packageWeightAndSize: pkgSize } : {}),
    }

    const itemRes = await ebayFetchRetry(`${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: 'PUT', headers, body: JSON.stringify(itemBody),
    })
    if (!itemRes.ok && itemRes.status !== 204) {
      const err = await itemRes.text().catch(() => '')
      results.push({ sku, market: mp, status: 'ERROR', message: `inventory_item PUT ${itemRes.status}: ${err.slice(0, 300)}` })
      continue
    }
    results.push({ sku, market: mp, status: 'PUSHED', message: 'inventory_item updated' })
  }

  // eBay's Inventory Service has eventual consistency: a freshly PUT inventory_item
  // may not be visible to the offer endpoint for ~1s. Without this pause, rapid
  // sequential calls hit a 25604 "product not found" / 25001 internal error on
  // random SKUs (the exact SKU varies each run — it is eBay-side, not data-driven).
  await new Promise(r => setTimeout(r, 1500))

  // Step 2: Build variesBy specifications from the detected variation axes.
  // Deduplicate by nmLabel output: two different aspect_* raw keys (e.g. "color"
  // imported from Amazon + "Colore" set up on eBay) can both have >1 distinct value
  // and therefore both appear in effectiveVarAxes, then nmLabel maps both to the
  // same Italian label → two specs entries with identical name → eBay error 25013
  // ("Duplicate names in variant specifications"). Merge values across raw keys that
  // share a label so the group sees exactly one specification entry per axis.
  // Key by lowercase label so "Colore" and "colore" (buildFlatRow writes both
  // the original-case and a lowercase duplicate of each variation axis) collapse
  // into a single specifications entry. Without this, both pass the vals.size > 1
  // filter and produce two entries with identical display names → eBay 25013.
  const specificationsMap = new Map<string, { name: string; values: Set<string> }>()
  for (const rawName of effectiveVarAxes) {
    const label = nmLabel(rawName)
    const mapKey = label.toLowerCase()
    if (!specificationsMap.has(mapKey)) {
      specificationsMap.set(mapKey, { name: label, values: new Set() })
    }
    const entry = specificationsMap.get(mapKey)!
    for (const v of (allAspectValueSets.get(rawName) ?? [])) {
      entry.values.add(vlLabel(rawName, v))
    }
  }
  // Deduplicate specifications by value-set fingerprint: axes with the same set of
  // values are the same physical attribute (e.g. "Color" from Amazon's variation
  // theme and "Colore" from eBay IT's category schema both carry {BLACK, YELLOW}).
  // buildFlatRow writes variation values under both names so both appear in
  // allAspectValueSets with >1 distinct value → without dedup eBay shows 4 selectors
  // instead of 2. First occurrence wins — itemSpecifics keys (written first in
  // buildFlatRow) are in the correct market locale (Colore, Taglia for EBAY_IT).
  const specFingerprintsSeen = new Set<string>()
  const specificationsRaw = [...specificationsMap.values()]
  const deduplicatedSpecs = specificationsRaw.filter(spec => {
    const fp = [...spec.values].map(v => v.toLowerCase()).sort().join('|')
    if (specFingerprintsSeen.has(fp)) return false
    specFingerprintsSeen.add(fp)
    return true
  })
  const specifications = deduplicatedSpecs.length > 0
    ? deduplicatedSpecs.map(e => ({ name: e.name, values: [...e.values] }))
    : [{ name: 'Custom Bundle', values: variantRows.map(r => r.sku as string) }]
  // imageVariesByAxes names the spec eBay switches photos by — the operator's
  // chosen picture axis (default = the colour axis). Match it to the normalised
  // spec so the value lines up after eBay's locale normalisation.
  const pictureSpec = pictureAxis
    ? deduplicatedSpecs.find(s => s.name.toLowerCase() === pictureAxis.toLowerCase()
        || (COLOR_AXIS_NAMES_PRE.has(s.name.toLowerCase()) && COLOR_AXIS_NAMES_PRE.has(pictureAxis.toLowerCase())))
    : undefined
  const imageVariesByAxes = pictureSpec ? [pictureSpec.name] : deduplicatedSpecs.slice(0, 1).map(e => e.name)

  // Step 3: Create/update the inventory_item_group.
  // variantSKUs is the correct field name (plain string array, not objects).
  let parentTitle = String(parentRow.title ?? '').trim()
  if (!parentTitle) {
    // Flat-file rows built from buildFlatRow already fall back to product.name, but
    // when the eBay ChannelListing has an explicitly empty title (operator cleared it)
    // or the product has never been saved with a title, try the master product name.
    try {
      const masterProduct = await prisma.product.findFirst({
        where: { sku: parentRow.sku as string },
        select: { name: true },
      })
      parentTitle = masterProduct?.name?.trim() ?? ''
    } catch { /* ignore — fall through to the error below */ }
  }
  if (!parentTitle) {
    return results.map(r => ({ ...r, status: 'ERROR' as const, message: 'Missing title on parent row — set a title before pushing' }))
  }
  // eBay group title max is 80 chars — truncate silently to avoid error 25718.
  if (parentTitle.length > 80) parentTitle = parentTitle.slice(0, 80)
  const groupImageUrls: string[] = []
  for (let i = 1; i <= 6; i++) {
    const url = parentRow[`image_${i}`] as string | undefined
    if (url) groupImageUrls.push(url)
  }
  // If parent has no direct images, use the first color variant's images as the
  // group representative. Using ALL variant images (both colors) creates too many
  // images in the eBay listing carousel. The per-variant inventory_items already
  // carry their own color-specific images (shown when buyer selects a color).
  if (groupImageUrls.length === 0) {
    // Try the first variant's full image set (ProductImage rows preferred)
    const firstVariantSku = variantRows[0]?.sku as string | undefined
    const firstVariantImages = firstVariantSku ? (imagesBySku.get(firstVariantSku) ?? []) : []
    groupImageUrls.push(...firstVariantImages.slice(0, 6))
    // Fallback: use the colour-representative image set built in the pre-pass
    if (groupImageUrls.length === 0 && colorRepImages.size > 0) {
      const firstRepImages = colorRepImages.values().next().value as string[] ?? []
      groupImageUrls.push(...firstRepImages.slice(0, 6))
    }
    // Last resort: aggregate unique URLs from all variants
    if (groupImageUrls.length === 0) {
      const seen = new Set<string>()
      for (const urls of imagesBySku.values()) {
        for (const u of urls) {
          if (u && !seen.has(u) && groupImageUrls.length < 6) {
            seen.add(u); groupImageUrls.push(u)
          }
        }
      }
    }
  }
  // eBay requires imageUrls on the group — hard-fail if still empty so the
  // operator gets a clear message rather than a cryptic eBay error 25717.
  if (groupImageUrls.length === 0) {
    return results.map(r => r.status === 'ERROR' ? r : { ...r, status: 'ERROR' as const, message: 'No images found for this group — upload images via the image editor or populate image_1 on the parent row before pushing' })
  }

  // eBay validates Brand/Marca at the GROUP level at publish_by_inventory_item_group.
  // Setting it only on the individual inventory_items is not enough.
  const GROUP_BRAND_ASPECT: Record<string, string> = {
    IT: 'Marca', ES: 'Marca', DE: 'Marke', FR: 'Marque', UK: 'Brand', GB: 'Brand',
  }
  const groupBrandKey = GROUP_BRAND_ASPECT[mp.toUpperCase()] ?? 'Brand'
  const groupBrandVal =
    brandBySku.get(parentRow.sku as string) ||
    [...brandBySku.values()][0] ||
    'Xavia'

  const groupBody = {
    inventoryItemGroupKey: groupKey,
    title: parentTitle,
    description: parentRow.description ?? '',
    imageUrls: groupImageUrls,
    variantSKUs: variantRows.map(r => r.sku as string),
    variesBy: {
      aspectsImageVariesBy: imageVariesByAxes,
      specifications,
    },
    aspects: {
      [groupBrandKey]: [groupBrandVal],
    },
  }

  // eBay error 25703: one or more SKUs are already members of a DIFFERENT group —
  // typically the old UUID-based group from before we switched to parent-SKU keys.
  // eBay won't let us DELETE an active group (it has published offers pointing to it).
  // Strategy: update the EXISTING group IN PLACE using its old key so all content
  // fixes (specs dedup, image cap, correct title) land immediately on the live listing.
  // The groupKey stays as the old UUID for now — the operator can migrate to the parent
  // SKU key by ending the listing in eBay Seller Hub, then re-pushing.
  let effectiveGroupKey = groupKey

  let groupRes = await ebayFetchRetry(`${apiBase}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(effectiveGroupKey)}`, {
    method: 'PUT', headers, body: JSON.stringify({ ...groupBody, inventoryItemGroupKey: effectiveGroupKey }),
  })

  if (!groupRes.ok && groupRes.status === 400) {
    const errText = await groupRes.text().catch(() => '')
    let errJson: { errors?: Array<{ errorId?: number; message?: string }> } = {}
    try { errJson = JSON.parse(errText) } catch { /* raw text fallback */ }
    const firstErr = errJson.errors?.[0]
    const is25703 = firstErr?.errorId === 25703 || errText.includes('"errorId":25703')
    if (is25703) {
      // Extract the existing groupId from the error message text ("...groupId: abc123")
      const groupIdMatch = (firstErr?.message ?? errText).match(/groupId[:\s]+([a-zA-Z0-9]+)/)
      const oldGroupId = groupIdMatch?.[1]
      if (oldGroupId && oldGroupId !== effectiveGroupKey) {
        // Update the existing group in place (preserving its old key on eBay)
        effectiveGroupKey = oldGroupId
        console.log(`[ebay-push] 25703 — updating existing group ${effectiveGroupKey} in place`)
        groupRes = await ebayFetchRetry(`${apiBase}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(effectiveGroupKey)}`, {
          method: 'PUT', headers, body: JSON.stringify({ ...groupBody, inventoryItemGroupKey: effectiveGroupKey }),
        })
      }
    }
    // If still not ok after 25703 fallback (or other error), fall through to error return below
  }

  if (!groupRes.ok && groupRes.status !== 204) {
    const err = await groupRes.text().catch(() => '')
    return results.map(r => ({ ...r, status: 'ERROR' as const, message: `inventory_item_group PUT ${groupRes.status}: ${err.slice(0, 300)}` }))
  }

  // Step 3.5: Create/update one offer per variant.
  // Rules for variation member offers (eBay Inventory API):
  //   • listingDescription MUST be omitted — it comes from the group description;
  //     including it overwrites the group description on the live listing.
  //   • inventoryItemGroupKey is NOT a valid offer field — group linkage is
  //     established exclusively via variantSKUs in the group PUT above.
  //   • availableQuantity is required before publishOfferByInventoryItemGroup.
  //   • merchantLocationKey (top-level on offer) is required so eBay can resolve
  //     Item.Country; absence causes error 25002 at publish.
  //
  // Policy waterfall (mirrors ebay-publish.adapter.ts):
  //   1. Per-row flat-file columns (operator override)
  //   2. ChannelConnection.connectionMetadata.ebayPolicies (account default)
  //   3. ebayAccountService.getSnapshot() — live eBay Account + Inventory API
  //   Hard-fail if any required field is still missing after all three tiers.
  const configured = ((connectionMeta.ebayPolicies ?? {}) as {
    fulfillmentPolicyId?: string
    paymentPolicyId?: string
    returnPolicyId?: string
    merchantLocationKey?: string
  })
  let fulfillmentPolicyId = (parentRow.fulfillment_policy_id as string | undefined) || configured.fulfillmentPolicyId || ''
  let paymentPolicyId     = (parentRow.payment_policy_id     as string | undefined) || configured.paymentPolicyId     || ''
  let returnPolicyId      = (parentRow.return_policy_id      as string | undefined) || configured.returnPolicyId      || ''
  let merchantLocationKey = (parentRow.merchant_location_key as string | undefined) || configured.merchantLocationKey || ''

  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId || !merchantLocationKey) {
    try {
      const snapshot = await ebayAccountService.getSnapshot(connectionId, marketplaceId)
      if (!fulfillmentPolicyId) fulfillmentPolicyId = snapshot.fulfillmentPolicies[0]?.id ?? ''
      if (!paymentPolicyId)     paymentPolicyId     = snapshot.paymentPolicies[0]?.id     ?? ''
      if (!returnPolicyId)      returnPolicyId      = snapshot.returnPolicies[0]?.id      ?? ''
      if (!merchantLocationKey) merchantLocationKey = snapshot.locations[0]?.key           ?? ''
    } catch (err) {
      const msg = `Could not fetch seller policies: ${err instanceof Error ? err.message : String(err)}`
      return rows.map(r => ({ sku: (r.sku ?? '') as string, market: mp, status: 'ERROR' as const, message: msg }))
    }
  }

  const missing: string[] = []
  if (!merchantLocationKey) missing.push('merchantLocation (configure in eBay Seller Hub > Inventory > Locations)')
  if (!fulfillmentPolicyId) missing.push('fulfillmentPolicy')
  if (!returnPolicyId)      missing.push('returnPolicy')
  if (missing.length > 0) {
    const msg = `Missing required seller settings: ${missing.join(', ')}`
    return rows.map(r => ({ sku: (r.sku ?? '') as string, market: mp, status: 'ERROR' as const, message: msg }))
  }

  const currency = mp === 'UK' ? 'GBP' : 'EUR'
  const catId    = (parentRow.category_id as string | undefined) ?? ''

  // Seed from Step-1 errors: if any inventory_item PUT already failed, skip
  // publish_by_group — eBay would reject it because the group's variantSKUs
  // includes SKUs without valid inventory_items.
  let anyOfferFailed = results.some(r => r.status === 'ERROR')
  for (const row of variantRows) {
    const sku   = row.sku as string
    const price = Number(row[`${mp.toLowerCase()}_price`] ?? row.price ?? 0)
    const qty   = capToFbm(row._productId as string | undefined, sku, Number(row[`${mp.toLowerCase()}_qty`] ?? row.quantity ?? 0), mp)

    if (!price || price <= 0) {
      const msg = `No ${mp} price set for ${sku} — enter a price before pushing`
      const idx = results.findIndex(r => r.sku === sku)
      if (idx >= 0) results[idx] = { ...results[idx], status: 'ERROR', message: msg }
      else results.push({ sku, market: mp, status: 'ERROR', message: msg })
      anyOfferFailed = true
      continue
    }

    const offerBody: Record<string, unknown> = {
      sku,
      marketplaceId,
      format: 'FIXED_PRICE',
      // listingDescription intentionally omitted — comes from group description
      ...(catId ? { categoryId: catId } : {}),
      availableQuantity: qty,
      pricingSummary: { price: { value: price.toFixed(2), currency } },
      listingPolicies: {
        ...(fulfillmentPolicyId ? { fulfillmentPolicyId } : {}),
        ...(paymentPolicyId     ? { paymentPolicyId }     : {}),
        ...(returnPolicyId      ? { returnPolicyId }      : {}),
      },
      // merchantLocationKey (top-level, not inside listingPolicies) tells eBay
      // the seller's location so it can resolve Item.Country for the listing.
      ...(merchantLocationKey ? { merchantLocationKey } : {}),
      quantityLimitPerBuyer: 10,
    }

    const getOfferRes = await fetch(
      `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`,
      { headers: headers },
    )
    let offerId: string | null = null
    if (getOfferRes.ok) {
      const od = await getOfferRes.json() as { offers?: Array<{ offerId: string }> }
      offerId = od.offers?.[0]?.offerId ?? null
    }

    if (offerId) {
      const upd = await fetch(`${apiBase}/sell/inventory/v1/offer/${offerId}`, {
        method: 'PUT', headers: headers, body: JSON.stringify(offerBody),
      })
      if (!upd.ok) {
        const err = await upd.text().catch(() => '')
        const msg = `offer update ${upd.status}: ${err.slice(0, 300)}`
        const idx = results.findIndex(r => r.sku === sku)
        if (idx >= 0) results[idx] = { ...results[idx], status: 'ERROR', message: msg }
        else results.push({ sku, market: mp, status: 'ERROR', message: msg })
        anyOfferFailed = true
        continue
      }
    } else {
      const cre = await fetch(`${apiBase}/sell/inventory/v1/offer`, {
        method: 'POST', headers: headers, body: JSON.stringify(offerBody),
      })
      if (!cre.ok) {
        const err = await cre.text().catch(() => '')
        const msg = `offer create ${cre.status}: ${err.slice(0, 300)}`
        const idx = results.findIndex(r => r.sku === sku)
        if (idx >= 0) results[idx] = { ...results[idx], status: 'ERROR', message: msg }
        else results.push({ sku, market: mp, status: 'ERROR', message: msg })
        anyOfferFailed = true
        continue
      }
    }
  }

  // If any offer failed, skip publish and return per-variant results so the
  // operator can see exactly which SKUs need attention.
  if (anyOfferFailed) return results

  // Step 4: Publish the variation listing.
  // Use effectiveGroupKey (may be old UUID if 25703 triggered in-place update).
  const publishRes = await ebayFetchRetry(`${apiBase}/sell/inventory/v1/offer/publish_by_inventory_item_group`, {
    method: 'POST', headers,
    body: JSON.stringify({ inventoryItemGroupKey: effectiveGroupKey, marketplaceId }),
  })

  if (!publishRes.ok) {
    const err = await publishRes.text().catch(() => '')
    const pubMsg = `publish_by_group ${publishRes.status}: ${err.slice(0, 300)}`
    // Preserve per-SKU step-1 errors — only stamp publish failure on rows that
    // made it through to the offer stage (status 'PUSHED'). Overwriting step-1
    // errors with "Manca Marca" masks the real root cause (e.g. imageUrls empty).
    return results.map(r => r.status === 'ERROR' ? r : { ...r, status: 'ERROR' as const, message: pubMsg })
  }

  const pubData = await publishRes.json().catch(() => ({})) as { listingId?: string }
  let listingId = pubData.listingId

  // Re-publishing an already-active listing returns no listingId in the publish body.
  // Fall back to GET offer for the first variant — the offer's listing.listingId is
  // always populated once the group has been published at least once.
  if (!listingId && variantRows.length > 0) {
    try {
      const firstSku = variantRows[0].sku as string
      const offerLookup = await fetch(
        `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(firstSku)}&marketplace_id=${marketplaceId}`,
        { headers },
      )
      if (offerLookup.ok) {
        const offerData = await offerLookup.json().catch(() => ({})) as { offers?: Array<{ listing?: { listingId?: string } }> }
        listingId = offerData.offers?.[0]?.listing?.listingId
      }
    } catch { /* non-fatal — listingId stays undefined */ }
  }

  // Write the shared listingId back to all variant ChannelListings.
  // _productId may be stripped in the frontend round-trip; fall back to SKU lookup.
  let productIds = variantRows.map(r => r._productId as string).filter(Boolean)
  if (productIds.length === 0) {
    const skus = variantRows.map(r => r.sku as string).filter(Boolean)
    if (skus.length > 0) {
      const prods = await prisma.product.findMany({ where: { sku: { in: skus }, deletedAt: null }, select: { id: true } }).catch(() => [])
      productIds = prods.map(p => p.id)
    }
  }
  const region = mp === 'UK' ? 'GB' : mp
  if (productIds.length > 0) {
    try {
      await prisma.channelListing.updateMany({
        where: { productId: { in: productIds }, channel: 'EBAY', region },
        // Only set externalListingId when we have a fresh value from the publish response.
        // Re-publishing an existing listing returns no new listingId — don't overwrite with null.
        data: { ...(listingId ? { externalListingId: listingId } : {}), listingStatus: 'ACTIVE', offerActive: true },
      })
      const activated = await prisma.channelListing.findMany({
        where: { productId: { in: productIds }, channel: 'EBAY', region },
        select: { id: true },
      })
      void syncActivatedListings(activated.map(l => l.id))
    } catch {
      /* DB write-back failure is non-fatal — listing is already live on eBay */
    }
  }

  // Preserve step-1 errors even on successful publish — a SKU that failed
  // inventory_item PUT was not actually pushed, even though the group published.
  return results.map(r => r.status === 'ERROR' ? r : { ...r, status: 'PUSHED' as const, message: 'pushed as variation group', itemId: listingId })
}

// ── Market constants ───────────────────────────────────────────────────
export const MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const;
export type Market = (typeof MARKETS)[number];

// ── Helpers ────────────────────────────────────────────────────────────

export function toMarketplaceId(marketplace: string): string {
  const MAP: Record<string, string> = {
    IT: 'EBAY_IT',
    DE: 'EBAY_DE',
    FR: 'EBAY_FR',
    ES: 'EBAY_ES',
    UK: 'EBAY_GB',
    GB: 'EBAY_GB',
  };
  return MAP[marketplace.toUpperCase()] ?? `EBAY_${marketplace.toUpperCase()}`;
}

export function toChannelMarket(mp: Market): string {
  if (mp === 'UK') return 'EBAY_GB';
  return `EBAY_${mp}`;
}

/**
 * Build a flat multi-market row from a Product + its eBay ChannelListings.
 */
export function buildFlatRow(
  product: {
    id: string;
    sku: string;
    name: string;
    ean: string | null;
    // EV.5b — family linkage + variation data (present at runtime; /rows
    // selects all Product scalars).
    parentId?: string | null;
    variationTheme?: string | null;
    categoryAttributes?: unknown;
    brand?: string | null;
    images?: Array<{ url: string; sortOrder: number; type: string }>;
    channelListings: Array<{
      id: string;
      region: string;
      externalListingId: string | null;
      title: string | null;
      description: string | null;
      price: { toNumber(): number } | null;
      quantity: number | null;
      platformAttributes: unknown;
      listingStatus: string;
      offerActive: boolean;
      syncStatus: string;
      updatedAt: Date;
      // IN.1 — Inheritance state fields (present at runtime, optional in type)
      followMasterTitle?: boolean | null;
      followMasterDescription?: boolean | null;
      followMasterPrice?: boolean | null;
      followMasterQuantity?: boolean | null;
      followMasterBulletPoints?: boolean | null;
      masterTitle?: string | null;
      masterDescription?: string | null;
      masterPrice?: { toNumber(): number } | null;
      masterQuantity?: number | null;
    }>;
  },
): Record<string, unknown> {
  // Shared fields come from the first listing that has data, or from the product
  const listings = product.channelListings;
  const first = listings[0];
  const firstAttrs = first ? ((first.platformAttributes ?? {}) as Record<string, unknown>) : {};
  const firstImageUrls = (firstAttrs.imageUrls as string[] | undefined) ?? [];

  // Prefer Cloudinary images (ProductImage rows) over Amazon CDN platformAttributes URLs.
  // Sort MAIN type first, then by sortOrder. Fall back to non-Amazon platformAttributes URLs.
  // Prefer Cloudinary (ProductImage rows) over platformAttributes URLs.
  // Do NOT filter out Amazon CDN fallback URLs — m.media-amazon.com images are
  // publicly accessible; eBay fetches and re-hosts them in eBay Picture Services.
  // Filtering them was leaving imageUrls empty → eBay error 25717.
  const cloudinaryUrls = (product.images ?? [])
    .slice()
    .sort((a, b) => (a.type === 'MAIN' ? -1 : b.type === 'MAIN' ? 1 : 0) || a.sortOrder - b.sortOrder)
    .map((img) => img.url)
    .filter((url) => !!url);
  const effectiveImageUrls = cloudinaryUrls.length > 0 ? cloudinaryUrls : firstImageUrls.filter(Boolean);

  // EV.5b — variation linkage. Axis names normalised to comma-separated
  // (what the variation publish's split(',') expects); axis values from
  // the canonical categoryAttributes.variations.
  const variationAxisNames = (product.variationTheme ?? '')
    .split(/[/,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const variationValues =
    ((product.categoryAttributes as { variations?: Record<string, string> } | null)?.variations) ?? {};

  const row: Record<string, unknown> = {
    _rowId: product.id,
    _productId: product.id,
    _dirty: false,
    _status: 'idle',
    sku: product.sku,
    ean: product.ean ?? '',
    mpn: '',
    // shared listing fields from first listing
    title: first?.title || product.name || '',
    condition: (firstAttrs.conditionId as string | undefined) ?? 'NEW',
    category_id: (firstAttrs.categoryId as string | undefined) ?? '',
    subtitle: (firstAttrs.subtitle as string | undefined) ?? '',
    description: first?.description ?? '',
    price: first?.price?.toNumber() ?? 0,
    best_offer_enabled: (firstAttrs.bestOffer as boolean | undefined) ?? false,
    best_offer_floor: (firstAttrs.bestOfferFloor as number | undefined) ?? 0,
    best_offer_ceiling: (firstAttrs.bestOfferCeiling as number | undefined) ?? 0,
    quantity: first?.quantity ?? 0,
    handling_time: (firstAttrs.handlingTime as number | undefined) ?? 1,
    // FF-EN.4 — full-parity fields (round-trip via platformAttributes)
    vat_rate: (firstAttrs.vatRate as string | undefined) ?? '',
    listing_format: (firstAttrs.listingFormat as string | undefined) ?? 'FIXED_PRICE',
    listing_duration: (firstAttrs.listingDuration as string | undefined) ?? 'GTC',
    item_location_country: (firstAttrs.itemLocationCountry as string | undefined) ?? '',
    package_type: (firstAttrs.packageType as string | undefined) ?? '',
    package_weight: (firstAttrs.packageWeight as number | undefined) ?? 0,
    weight_unit: (firstAttrs.weightUnit as string | undefined) ?? 'KILOGRAM',
    package_length: (firstAttrs.packageLength as number | undefined) ?? 0,
    package_width: (firstAttrs.packageWidth as number | undefined) ?? 0,
    package_height: (firstAttrs.packageHeight as number | undefined) ?? 0,
    dimension_unit: (firstAttrs.dimensionUnit as string | undefined) ?? 'CENTIMETER',
    image_1: effectiveImageUrls[0] ?? '',
    image_2: effectiveImageUrls[1] ?? '',
    image_3: effectiveImageUrls[2] ?? '',
    image_4: effectiveImageUrls[3] ?? '',
    image_5: effectiveImageUrls[4] ?? '',
    image_6: effectiveImageUrls[5] ?? '',
    fulfillment_policy_id: (firstAttrs.fulfillmentPolicyId as string | undefined) ?? '',
    payment_policy_id: (firstAttrs.paymentPolicyId as string | undefined) ?? '',
    return_policy_id: (firstAttrs.returnPolicyId as string | undefined) ?? '',
    _brand: product.brand ?? '',
    // legacy single-market fields (backward compat)
    listing_status: first?.listingStatus ?? 'DRAFT',
    last_pushed_at: first?.updatedAt.toISOString() ?? '',
    sync_status: first?.syncStatus ?? 'pending',
    ebay_item_id: first?.externalListingId ?? '',
    // EV.5b — family group key: children share the parent's id, the parent
    // uses its own. So a family groups (push + UI) instead of every row
    // being its own one-row "family".
    platformProductId: product.parentId ?? product.id,
    variation_theme: variationAxisNames.join(','),
    // metadata flag (underscore-prefixed, not a display column).
    _isParent: !product.parentId,
  };

  // Dynamic item specifics from first listing
  const itemSpecifics = (firstAttrs.itemSpecifics as Record<string, string> | undefined) ?? {};
  for (const [key, val] of Object.entries(itemSpecifics)) {
    const colId = `aspect_${key.replace(/\s+/g, '_')}`;
    row[colId] = val;
  }

  // EV.5b — variation axis values from categoryAttributes.variations,
  // under both the case-preserved key (the dynamic UI columns) and the
  // lowercased key the variation publish's variesBy build reads.
  for (const [axis, val] of Object.entries(variationValues)) {
    if (!val) continue;
    row[`aspect_${axis.replace(/\s+/g, '_')}`] = val;
    row[`aspect_${axis.toLowerCase().replace(/\s+/g, '_')}`] = val;
  }

  // Per-market flat fields
  for (const mp of MARKETS) {
    const listing = listings.find((l) => l.region === mp || l.region === (mp === 'UK' ? 'GB' : mp));
    const attrs = listing ? ((listing.platformAttributes ?? {}) as Record<string, unknown>) : {};
    const prefix = mp.toLowerCase() as Lowercase<Market>;
    row[`${prefix}_price`] = listing?.price?.toNumber() ?? null;
    row[`${prefix}_qty`] = listing?.quantity ?? null;
    row[`${prefix}_item_id`] = listing?.externalListingId ?? null;
    row[`${prefix}_status`] = listing?.listingStatus ?? null;
    row[`${prefix}_listing_id`] = (attrs.offerId as string | undefined) ?? null;
  }

  // IN.1 — Inheritance state from the first (primary) listing.
  // _marketFieldStates provides per-market breakdown for the eBay popover.
  if (first) {
    row._listingId = first.id
    row._fieldStates = {
      price:        (first.followMasterPrice        ?? true) ? 'INHERITED' : 'OVERRIDE',
      title:        (first.followMasterTitle        ?? true) ? 'INHERITED' : 'OVERRIDE',
      description:  (first.followMasterDescription  ?? true) ? 'INHERITED' : 'OVERRIDE',
      quantity:     (first.followMasterQuantity     ?? true) ? 'INHERITED' : 'OVERRIDE',
      bulletPoints: (first.followMasterBulletPoints ?? true) ? 'INHERITED' : 'OVERRIDE',
    }
    row._masterValues = {
      price:       first.masterPrice != null ? first.masterPrice.toNumber() : null,
      title:       first.masterTitle       ?? null,
      description: first.masterDescription ?? null,
      quantity:    first.masterQuantity    ?? null,
    }
    // Per-market override state (price + qty are the key ones for eBay)
    const marketFieldStates: Record<string, Record<string, 'INHERITED' | 'OVERRIDE'>> = {}
    for (const mp of MARKETS) {
      const l = listings.find((x) => x.region === mp || x.region === (mp === 'UK' ? 'GB' : mp))
      if (l) {
        marketFieldStates[mp] = {
          price:    (l.followMasterPrice    ?? true) ? 'INHERITED' : 'OVERRIDE',
          quantity: (l.followMasterQuantity ?? true) ? 'INHERITED' : 'OVERRIDE',
          title:    (l.followMasterTitle    ?? true) ? 'INHERITED' : 'OVERRIDE',
        }
      }
    }
    row._marketFieldStates = marketFieldStates
    // Build list of per-market listing IDs for the reset-per-market action
    const marketListingIds: Record<string, string> = {}
    for (const mp of MARKETS) {
      const l = listings.find((x) => x.region === mp || x.region === (mp === 'UK' ? 'GB' : mp))
      if (l) marketListingIds[mp] = l.id
    }
    row._marketListingIds = marketListingIds
  }

  return row;
}

/**
 * Pack shared listing fields back into ChannelListing DB fields.
 */
export function packSharedFields(row: Record<string, unknown>): {
  title: string;
  description: string;
  externalListingId: string | null;
  listingStatus: string;
  offerActive: boolean;
  platformAttributes: Prisma.InputJsonValue;
} {
  const imageUrls: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const url = row[`image_${i}`] as string | undefined;
    if (url) imageUrls.push(url);
  }

  // Collect item specifics from aspect_* keys — deduplicate by lowercase name
  // so both aspect_Colore and aspect_colore (buildFlatRow writes both for variation
  // axes) don't end up as two separate keys in platformAttributes.itemSpecifics.
  const itemSpecifics: Record<string, string> = {};
  const seenAspectLower = new Set<string>();
  for (const [key, val] of Object.entries(row)) {
    if (key.startsWith('aspect_') && typeof val === 'string' && val) {
      const aspectName = key.slice('aspect_'.length).replace(/_/g, ' ');
      const lk = aspectName.toLowerCase();
      if (!seenAspectLower.has(lk)) {
        seenAspectLower.add(lk);
        itemSpecifics[aspectName] = val;
      }
    }
  }

  return {
    title: (row.title as string) ?? '',
    description: (row.description as string) ?? '',
    externalListingId: (row.ebay_item_id as string) || null,
    listingStatus: (row.listing_status as string) ?? 'DRAFT',
    offerActive: row.listing_status === 'ACTIVE',
    platformAttributes: {
      conditionId: (row.condition as string) ?? 'NEW',
      categoryId: (row.category_id as string) ?? '',
      subtitle: (row.subtitle as string) ?? '',
      imageUrls,
      itemSpecifics,
      handlingTime: Number(row.handling_time ?? 1),
      bestOffer: Boolean(row.best_offer_enabled),
      bestOfferFloor: Number(row.best_offer_floor ?? 0),
      bestOfferCeiling: Number(row.best_offer_ceiling ?? 0),
      fulfillmentPolicyId: (row.fulfillment_policy_id as string) ?? '',
      paymentPolicyId: (row.payment_policy_id as string) ?? '',
      returnPolicyId: (row.return_policy_id as string) ?? '',
      // FF-EN.4 — full-parity fields
      vatRate: (row.vat_rate as string) ?? '',
      listingFormat: (row.listing_format as string) ?? 'FIXED_PRICE',
      listingDuration: (row.listing_duration as string) ?? 'GTC',
      itemLocationCountry: (row.item_location_country as string) ?? '',
      packageType: (row.package_type as string) ?? '',
      packageWeight: Number(row.package_weight ?? 0),
      weightUnit: (row.weight_unit as string) ?? 'KILOGRAM',
      packageLength: Number(row.package_length ?? 0),
      packageWidth: Number(row.package_width ?? 0),
      packageHeight: Number(row.package_height ?? 0),
      dimensionUnit: (row.dimension_unit as string) ?? 'CENTIMETER',
    } as Prisma.InputJsonValue,
  };
}

/**
 * Load the full eBay flat-row payload for ONE product family (parent + variant
 * children) — identical to GET /api/ebay/flat-file/rows?familyId=. Lets the
 * per-product Images tab publish build the SAME listing body the flat-file page
 * builds, so there is one source of truth for the eBay listing payload.
 */
export async function buildEbayFamilyRows(
  familyParentId: string,
): Promise<Array<Record<string, unknown>>> {
  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      OR: [{ id: familyParentId }, { parentId: familyParentId }],
    },
    include: {
      channelListings: { where: { channel: 'EBAY' } },
      images: { select: { url: true, sortOrder: true, type: true }, orderBy: { sortOrder: 'asc' } },
    },
    orderBy: { sku: 'asc' },
  })
  return products.map((p) => buildFlatRow(p as Parameters<typeof buildFlatRow>[0]))
}
