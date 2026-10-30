'use client'

import type { ReactNode } from 'react'
import type { PartyRecordModel } from '../../../../parties/_shared/model'
import { PartyRecordView, type PartyRecordActions } from '../../../../parties/_shared/view/PartyRecordView'

/**
 * SCR-057 Supplier record (design purchasing.suppliers "records: Supplier"): Overview (the supplier's form with ⌘S, its
 * tax identity with VIES, its addresses, and Now beside it), Contacts (who receives POs), Items & prices (B-W2a-69: the
 * approved sources, drawn by Purchasing in the `items` slot), Orders and Activity. Documents & qualification, Quality &
 * rating, Bank details and Portal access (W2b) are not drawn.
 */
export function SupplierRecordView({ model, actions, panels, items }: { model: PartyRecordModel; actions?: PartyRecordActions; panels?: ReactNode; items?: ReactNode }) {
  return <PartyRecordView model={{ ...model, side: 'suppliers' }} actions={actions} panels={panels} items={items} />
}
