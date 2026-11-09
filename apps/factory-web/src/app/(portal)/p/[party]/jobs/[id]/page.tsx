'use client'

import { use } from 'react'
import { usePortalFrame } from '../../../../../../portal/shell/frame'
import { SupplierJobPage } from '../../../../../../portal/supplier/jobs/JobPage'
import { NotInAccessHere } from '../../../../../../portal/supplier/orders/parts'

/** `/p/<party code>/jobs/<id>?tab=kit|progress|sendback|documents|messages` — one job of a workshop (B-W2b-181, SCR-193). */
export default function PortalJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { kinds } = usePortalFrame()
  if (kinds.includes('SUBCONTRACTOR')) return <SupplierJobPage id={id} />
  return <NotInAccessHere />
}
