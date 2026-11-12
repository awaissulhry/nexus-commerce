'use client'

import type { ReactNode } from 'react'
import type { ColDef } from '@nexus/ui/grid'
import type { PartyRow } from '../../../parties/_shared/api'
import type { PartiesListModel } from '../../../parties/_shared/model'
import { PartiesListView, type ListDepth, type PartiesListActions } from '../../../parties/_shared/view/PartiesListView'

/**
 * SCR-056 Suppliers (design purchasing.suppliers): the parties list seen from Purchasing — the roles we buy from or
 * send work and goods with (Supplier, Subcontractor, Carrier), the VAT number with its VIES mark. The list is the shared
 * one (areas/parties/_shared): Customers draws the same parts from the selling side. B-W2b-334: the band's Import, the
 * Documents column, the "Documents expiring in 30 days" tile and its view, Request documents N (`depth`).
 */
export function SuppliersView({ model, actions, headActions, columns, depth }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode; columns?: readonly ColDef<PartyRow>[]; depth?: ListDepth }) {
  return <PartiesListView model={{ ...model, side: 'suppliers' }} actions={actions} headActions={headActions} columns={columns} depth={depth} />
}
