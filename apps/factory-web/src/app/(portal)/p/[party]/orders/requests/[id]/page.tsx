'use client'

import { use } from 'react'
import { usePortalFrame } from '../../../../../../../portal/shell/frame'
import { CustomerRequestRoute } from '../../../../../../../portal/customer/orders/RequestOrderPage'
import { NotInAccessHere } from '../../../../../../../portal/supplier/orders/parts'

/**
 * `/p/<party code>/orders/requests/<id>` — a customer's request. owb-po5.2 (settle 2): a Draft or Sent order (a portal order request)
 * draws the order's frame and tabs; an e-mail request (B-TH-222, SCR-185-request) keeps its own page — the route asks the draft read
 * first and falls back. `RECORD_PAGES.Inquiry` opens it from the API's links. Only a customer has requests; another kind's typed
 * address says it is not part of its access.
 */
export default function PortalRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { kinds } = usePortalFrame()
  if (kinds.includes('CUSTOMER')) return <CustomerRequestRoute id={id} />
  return <NotInAccessHere />
}
