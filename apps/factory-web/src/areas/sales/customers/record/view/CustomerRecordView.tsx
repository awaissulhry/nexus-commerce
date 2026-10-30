'use client'

import type { ReactNode } from 'react'
import type { PartyRecordModel } from '../../../../parties/_shared/model'
import { PartyRecordView, type PartyRecordActions } from '../../../../parties/_shared/view/PartyRecordView'

/**
 * SCR-033 Customer record (design sales.customers "records: Customer"): Overview, Addresses & contacts, Tax & terms,
 * Quotes & orders, Documents and Activity of one party, seen from Sales. Requirements and Portal access (W2b) are not
 * drawn. The record is the shared one (areas/parties/_shared); Tax & terms adds the customer's Commercial terms card
 * (B-W2a-49, `terms`: the container mounts it).
 */
export function CustomerRecordView({ model, actions, panels, documents, terms }: { model: PartyRecordModel; actions?: PartyRecordActions; panels?: ReactNode; documents?: ReactNode; terms?: ReactNode }) {
  return <PartyRecordView model={{ ...model, side: 'customers' }} actions={actions} panels={panels} documents={documents} terms={terms} />
}
