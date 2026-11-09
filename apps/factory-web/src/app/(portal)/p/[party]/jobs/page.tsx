'use client'

import { usePortalFrame } from '../../../../../portal/shell/frame'
import { SupplierJobsPage } from '../../../../../portal/supplier/jobs/JobsPage'
import { NotInAccessHere } from '../../../../../portal/supplier/orders/parts'

/**
 * `/p/<party code>/jobs?chip=&q=` — a workshop's Jobs (B-W2b-181, SCR-192; design portal.supplier.jobs): the jobs by what
 * they need now, one big button each. Another kind of partner reads that it is not part of its access.
 */
export default function PortalJobsPage() {
  const { kinds } = usePortalFrame()
  if (kinds.includes('SUBCONTRACTOR')) return <SupplierJobsPage />
  return <NotInAccessHere />
}
