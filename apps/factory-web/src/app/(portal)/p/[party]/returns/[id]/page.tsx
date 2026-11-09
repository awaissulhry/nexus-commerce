'use client'

import { use } from 'react'
import { CustomerCasePage } from '../../../../../../portal/customer/returns/CasePage'

/** `/p/<party code>/returns/<id>?tab=request|status|messages` — one return (B-W2b-197; design rec "Return"). */
export default function PortalReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <CustomerCasePage type="RETURN" id={id} />
}
