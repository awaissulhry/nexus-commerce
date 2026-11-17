'use client'

import { usePortalFrame } from '../../../../../portal/shell/frame'
import { NotInAccessHere } from '../../../../../portal/supplier/orders/parts'
import { CustomerWaitingPage } from '../../../../../portal/customer/waiting/WaitingPage'

/**
 * `/p/<party code>/waiting` — Home › Waiting for you (F-PR-14; production plan §5, 06-tree B.3): the ONE place the customer answers
 * what we ask (production approvals, order, quality, made-to-measure, payment). A customer's page only: a supplier, a workshop or
 * a guest is told it is not part of their access; a customer role without portal.approvals.view reads the same.
 */
export default function PortalWaitingPage() {
  const { kinds } = usePortalFrame()
  if (kinds.includes('CUSTOMER')) return <CustomerWaitingPage />
  return <NotInAccessHere />
}
