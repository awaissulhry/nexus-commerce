import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PickingPrint } from '../../../../../../../areas/warehouse/picking/print/PickingPrint'

export const metadata: Metadata = { title: 'Pick lists · Nexus Factory' }

/** Warehouse › Picking & kits (print, `?ids=`), opened in a new tab from Picking & kits; the print stylesheet hides the frame. */
export default function WarehousePickingPrintPage() {
  return (
    <Suspense>
      <PickingPrint />
    </Suspense>
  )
}
