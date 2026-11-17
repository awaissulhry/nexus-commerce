'use client'

import type { ReactNode } from 'react'
import type { PartyRecordModel } from '../../../../parties/_shared/model'
import { PartyRecordView, type PartyRecordActions, type SupplierDepth } from '../../../../parties/_shared/view/PartyRecordView'

/**
 * SCR-057 Supplier record (design purchasing.suppliers "records: Supplier"; B-TH-260: on RecordFrame, the thread docked): Overview &
 * contacts (the supplier's form with ⌘S, its tax identity with VIES, its addresses, Now beside it, then who receives POs), Items &
 * prices (B-W2a-69: the approved sources, drawn by Purchasing in the `items` slot), Documents & questionnaire, Orders. B-W2b-334: the W2b parts in the
 * `depth` slot — kinds, status, origin and closures under the form, the status and the next document under Now, what each
 * contact receives, and the Documents & qualification, Quality & rating and Bank details tabs.
 */
// B-TH-260: `thread` is the supplier's docked thread (a design case's; the page mounts OfficeRecordThread).
export function SupplierRecordView({ model, actions, thread, items, depth }: { model: PartyRecordModel; actions?: PartyRecordActions; thread?: ReactNode; items?: ReactNode; depth?: SupplierDepth }) {
  return <PartyRecordView model={{ ...model, side: 'suppliers' }} actions={actions} thread={thread} items={items} depth={depth} />
}
