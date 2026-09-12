'use client'

import type { EbayRow } from './EbayFlatFileClient'
import { OrderEditor } from './Presentation/OrderEditor'

export interface VariationValueOrderModalProps {
  open: boolean; onClose: () => void; rows: EbayRow[]; parentProductId: string | null
  marketplace: string; accountId?: string; aliasKey?: string; onSaved?: () => void
}

/** Legacy entry point composes the same destination/version-aware editor as Product Presentation.
 * Rows remain a compatibility prop; the server resolves the current destination family. */
export function VariationValueOrderModal({ parentProductId, ...props }: VariationValueOrderModalProps) {
  return parentProductId ? <OrderEditor {...props} productId={parentProductId} /> : null
}
