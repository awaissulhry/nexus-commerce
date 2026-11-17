'use client'

import { use } from 'react'
import { usePortalFrame } from '../../../../../../../portal/shell/frame'
import { CustomerRequestRecordPage } from '../../../../../../../portal/customer/requests/RequestPage'
import { NotInAccessHere } from '../../../../../../../portal/supplier/orders/parts'

/**
 * `/p/<party code>/orders/requests/<id>` — a customer's request (B-TH-222, SCR-185-request): its true state and its thread.
 * `RECORD_PAGES.Inquiry` opens it from the API's links. Only a customer has requests; another kind's typed address says it is
 * not part of its access.
 */
export default function PortalRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { kinds } = usePortalFrame()
  if (kinds.includes('CUSTOMER')) return <CustomerRequestRecordPage id={id} />
  return <NotInAccessHere />
}
