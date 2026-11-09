'use client'

import { use } from 'react'
import { usePortalFrame } from '../../../../../../../portal/shell/frame'
import { SupplierJobSheetPage } from '../../../../../../../portal/supplier/jobs/SheetPage'
import { NotInAccessHere } from '../../../../../../../portal/supplier/orders/parts'

/** `/p/<party code>/jobs/<id>/sheet` — the job sheet for the bench, printed by the browser (B-W2b-181; tab:job-sheet). */
export default function PortalJobSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { kinds } = usePortalFrame()
  if (kinds.includes('SUBCONTRACTOR')) return <SupplierJobSheetPage id={id} />
  return <NotInAccessHere />
}
