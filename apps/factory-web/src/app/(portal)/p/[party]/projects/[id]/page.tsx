'use client'

import { use } from 'react'
import { usePortalFrame } from '../../../../../../portal/shell/frame'
import { ProjectRecordPage } from '../../../../../../portal/customer/projects/ProjectPage'
import { NotInAccessHere } from '../../../../../../portal/supplier/orders/parts'

/**
 * `/p/<party code>/projects/<id>` — a project the person was added to (threads plan TH-5, B-TH-253, SCR-702; design PROJ.portal):
 * its summary and its conversation. `RECORD_PAGES.Project` opens it from the API's links for a customer, a supplier and a
 * workshop alike (one outside company per project: a supplier's never names a customer). A guest (an accountant, an auditor) has
 * no projects: its typed address says it is not part of its access. A person who is not a member reads "not found" on the page.
 */
export default function PortalProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { kinds } = usePortalFrame()
  if (kinds.some((kind) => kind === 'CUSTOMER' || kind === 'SUPPLIER' || kind === 'SUBCONTRACTOR')) return <ProjectRecordPage id={id} />
  return <NotInAccessHere />
}
