'use client'

import { useT } from '../../../../lib/i18n/provider'

/**
 * B-W2b-238: the words of the materials-in-depth parts — a refused write or a failed read (`problem.*`) in the library's
 * catalogue (W1's words for every library page), everything else in `products-materials-depth`.
 */
export function useDepthWords(): (key: string, params?: Record<string, string | number>) => string {
  const t = useT('products-materials-depth')
  const library = useT('library')
  return (key, params) => (key.startsWith('problem.') ? library(key, params) : t(key, params))
}
