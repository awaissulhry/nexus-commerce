'use client'

import { use } from 'react'
import { CustomerRepairPage } from '../../../../../../../portal/customer/returns/repair/RepairPage'

/** `/p/<party code>/returns/repairs/<id>?tab=status|request` — one repair or alteration (B-W2b-342; SCR-358). */
export default function PortalRepairPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <CustomerRepairPage id={id} />
}
