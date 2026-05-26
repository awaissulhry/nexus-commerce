// FL.6.1 — Default link-policy derivation (pure).
//
// Gives every field a sensible default scope + translate policy so a
// product arrives pre-configured and the operator only touches
// exceptions (the "extremely automated" baseline). Derived from the
// field key + its manifest parentage:
//
//   identity (gtin/ean/upc/mpn/sku/brand/asin) → locked   (NONE)
//   text (title/description/bullets)            → master   (TRANSLATE)
//   images                                      → linked   (NONE, in-channel)
//   price / quantity / other CHILD numerics     → master   (VERBATIM)
//   everything else                             → master   (VERBATIM)

import type { FieldParentage } from './parentage.js'

export type DefaultScope = 'locked' | 'master' | 'linked'
export type TranslatePolicy = 'TRANSLATE' | 'VERBATIM' | 'NONE'

export interface DefaultPolicy {
  scope: DefaultScope
  translatePolicy: TranslatePolicy
}

const IDENTITY = new Set([
  'gtin', 'ean', 'upc', 'mpn', 'sku', 'brand', 'asin', 'external_id', 'externalid',
])

const TEXT = [
  'title', 'item_name', 'name', 'description', 'product_description',
  'bullet_point', 'bullets', 'bullet_points', 'keywords', 'subtitle',
]

const IMAGE_HINTS = ['image', 'swatch', 'photo', 'picture']
const PRICE_QTY_HINTS = ['price', 'quantity', 'qty', 'stock']

export function defaultLinkPolicy(
  fieldKey: string,
  parentage: FieldParentage = 'PARENT',
): DefaultPolicy {
  const k = fieldKey.toLowerCase()

  if (IDENTITY.has(k)) return { scope: 'locked', translatePolicy: 'NONE' }

  if (TEXT.includes(k) || TEXT.some((t) => k.includes(t))) {
    return { scope: 'master', translatePolicy: 'TRANSLATE' }
  }

  if (IMAGE_HINTS.some((h) => k.includes(h))) {
    return { scope: 'linked', translatePolicy: 'NONE' }
  }

  if (PRICE_QTY_HINTS.some((h) => k.includes(h)) || parentage === 'CHILD') {
    return { scope: 'master', translatePolicy: 'VERBATIM' }
  }

  return { scope: 'master', translatePolicy: 'VERBATIM' }
}
