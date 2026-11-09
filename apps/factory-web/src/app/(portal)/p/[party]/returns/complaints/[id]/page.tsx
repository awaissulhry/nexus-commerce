'use client'

import { use } from 'react'
import { CustomerCasePage } from '../../../../../../../portal/customer/returns/CasePage'

/** `/p/<party code>/returns/complaints/<id>?tab=request|status|messages` — one complaint, the same tabs (B-W2b-197). */
export default function PortalComplaintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <CustomerCasePage type="COMPLAINT" id={id} />
}
