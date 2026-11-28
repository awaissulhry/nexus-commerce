'use client'

import type { Translate } from '../../../../lib/i18n/messages'
import { useT } from '../../../../lib/i18n/provider'

/**
 * owb-pd4 (S4 settle 10): the product page's new words live in their own catalogue `products-overview` (the band, Overview, Sizes,
 * the Product sheet); the words it shares with the list stay in `products` (the kinds, the families, the states). `say` takes a key
 * of either (by its first part) or a text already in words.
 */
export const PRODUCT_NS = 'products-overview'

const IN_PRODUCTS = /^(productType|family|status|revisionStatus|ppe|list|common|held)\./

export type Said = { key: string; params?: Record<string, string | number> } | { text: string }

export function useProductWords(): { t: Translate; tp: Translate; say: (words: Said) => string } {
  const tp = useT('products')
  const t = useT(PRODUCT_NS)
  const say = (words: Said) => ('text' in words ? words.text : (IN_PRODUCTS.test(words.key) ? tp : t)(words.key, words.params))
  return { t, tp, say }
}
