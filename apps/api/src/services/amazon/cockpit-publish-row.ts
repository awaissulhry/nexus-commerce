// Bullets are the only multi-instance columns buildRow emits — map bullet_point_N
// → bullet_point so buildJsonFeedBody reassembles them into the bullet_point array
// instead of emitting stray "bullet_point_1" attributes (HIGH-3).
export const COCKPIT_EXPANDED_FIELDS: Record<string, string> = {
  bullet_point_1: 'bullet_point',
  bullet_point_2: 'bullet_point',
  bullet_point_3: 'bullet_point',
  bullet_point_4: 'bullet_point',
}

/** Build a flat-file row from a ChannelListing + product. Pulls the
 *  same shape the flat-file editor would produce so the SP-API call
 *  receives identical attribute envelopes. */
export function buildRow(args: {
  listing: any
  product: any
  marketplace: string
  parentSku?: string | null
}): Record<string, unknown> {
  const { listing, product, marketplace, parentSku } = args
  const platform = (listing.platformAttributes ?? {}) as Record<string, any>
  const attrs = (platform.attributes ?? {}) as Record<string, any>

  // Extract a "first value" from the SP-API-shaped attribute array.
  const pickFirst = (key: string): string | null => {
    const v = attrs[key]
    if (Array.isArray(v) && v.length > 0) {
      const first = v[0]
      if (first && typeof first === 'object' && 'value' in first) {
        return String(first.value ?? '')
      }
    }
    return null
  }

  const productType = String(
    platform.productType ?? product.productType ?? '',
  ).toUpperCase()

  // Bullets — explicit override array wins; otherwise fall back to
  // the attribute envelope.
  const bullets: string[] = Array.isArray(listing.bulletPointsOverride)
    ? (listing.bulletPointsOverride as unknown[]).filter(
        (b): b is string => typeof b === 'string',
      )
    : Array.isArray(attrs.bullet_point)
      ? (attrs.bullet_point as any[])
          .map((b) => (b && typeof b === 'object' ? String(b.value ?? '') : ''))
          .filter(Boolean)
      : []

  const row: Record<string, unknown> = {
    item_sku: product.sku,
    product_type: productType,
    record_action: 'full_update',
    item_name: listing.title ?? product.name ?? pickFirst('item_name') ?? '',
    brand: product.brand ?? pickFirst('brand') ?? '',
    product_description:
      listing.description ??
      product.description ??
      pickFirst('product_description') ??
      '',
    // The flat-file service reads bullet_point as a single value
    // per row; arrays land via expanded sub-columns. For a one-row
    // submit we pass the first bullet here and the rest as
    // _1.._4 keys so buildJsonFeedBody's expansion path picks them
    // up via the EXPLICIT_KEYS branch.
    bullet_point: bullets[0] ?? '',
  }
  // Mirror remaining bullets into bullet_point_1..bullet_point_4
  // so the flat-file service's expanded-column reassembly catches
  // them. (Index 0 is already at bullet_point above.)
  for (let i = 1; i < bullets.length && i < 5; i += 1) {
    row[`bullet_point_${i}`] = bullets[i]
  }

  // Price + currency.
  const priceRaw = listing.priceOverride ?? listing.price ?? product.basePrice
  if (priceRaw != null && priceRaw !== '') {
    const priceNum =
      typeof priceRaw === 'string' ? parseFloat(priceRaw) : Number(priceRaw)
    if (Number.isFinite(priceNum)) {
      row.purchasable_offer__our_price = priceNum.toFixed(2)
      row.purchasable_offer__currency =
        (platform.currency as string | undefined) ?? 'EUR'
      row.purchasable_offer__condition_type =
        (attrs.condition_type as string | undefined) ?? 'new_new'
    }
  }

  // Sale price (optional).
  if (listing.salePrice != null) {
    const sp =
      typeof listing.salePrice === 'string'
        ? parseFloat(listing.salePrice)
        : Number(listing.salePrice)
    if (Number.isFinite(sp)) {
      row.purchasable_offer__sale_price = sp.toFixed(2)
    }
  }

  // Fulfillment + qty.
  const qtyRaw = listing.quantityOverride ?? listing.quantity
  if (qtyRaw != null) {
    const qty = Number(qtyRaw)
    if (Number.isFinite(qty)) {
      row.fulfillment_availability__quantity = qty
    }
  }
  const fch =
    pickFirst('fulfillment_channel_code') ??
    (platform.fulfillment_channel as string | undefined) ??
    null
  if (fch) row.fulfillment_availability__fulfillment_channel_code = fch

  // Main image.
  const mainImg =
    pickFirst('main_product_image_locator') ??
    (Array.isArray(product.images)
      ? product.images.find((i: any) => i?.isPrimary)?.url ??
        product.images[0]?.url ??
        null
      : null)
  if (mainImg) row.main_product_image_locator = mainImg

  // Variation theme + parent/child relationship.
  const variationTheme =
    (platform.variation_theme as string | undefined) ??
    (platform.variationTheme as string | undefined)
  if (variationTheme) row.variation_theme = variationTheme
  if (product.parentId) {
    row.parentage_level = 'child'
    // HIGH-4 — Amazon needs the parent's seller SKU, not our internal UUID.
    if (parentSku) row.parent_sku = parentSku
  } else if (product.isParent) {
    row.parentage_level = 'parent'
  }

  void marketplace
  return row
}

