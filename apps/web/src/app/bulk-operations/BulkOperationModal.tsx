// @ts-nocheck — U.58 BISECT 9: BulkOperationModal stubbed to `return null`
'use client'

import type { MarketplaceContext } from './components/MarketplaceSelector'

interface ScopeFilters {
  status?: 'DRAFT' | 'ACTIVE' | 'INACTIVE'
  stockMin?: number
  stockMax?: number
}

interface Props {
  open: boolean
  onClose: () => void
  currentFilters?: ScopeFilters
  marketplaceTargets?: MarketplaceContext[]
  visibleProductIds?: string[]
  selectedProductIds?: string[]
}

// U.58 (BISECT 9) — body replaced with `return null`. Same import,
// same export, same prop shape. If clicks die, the bug isn't in this
// file's body. If clicks navigate, the original body is the culprit
// and we bisect line-by-line.
export default function BulkOperationModal(_props: Props) {
  return null
}
