'use client'

import type { ReactNode } from 'react'
import type { PartyRecordModel } from '../../../../parties/_shared/model'
import { PartyRecordView, type PartyRecordActions, type SupplierDepth } from '../../../../parties/_shared/view/PartyRecordView'

/**
 * SCR-057 Supplier record (design purchasing.suppliers "records: Supplier"): Overview (the supplier's form with ⌘S, its
 * tax identity with VIES, its addresses, and Now beside it), Contacts (who receives POs), Items & prices (B-W2a-69: the
 * approved sources, drawn by Purchasing in the `items` slot), Orders and Activity. B-W2b-334: the W2b parts in the
 * `depth` slot — kinds, status, origin and closures under the form, the status and the next document under Now, what each
 * contact receives, and the Documents & qualification, Quality & rating and Bank details tabs.
 */
export function SupplierRecordView({ model, actions, panels, items, depth }: { model: PartyRecordModel; actions?: PartyRecordActions; panels?: ReactNode; items?: ReactNode; depth?: SupplierDepth }) {
  return <PartyRecordView model={{ ...model, side: 'suppliers' }} actions={actions} panels={panels} items={items} depth={depth} />
}
