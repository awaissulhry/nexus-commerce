import { Suspense } from 'react'
import type { Metadata } from 'next'
import { MaterialsPage } from '../../../../../../areas/products/materials/MaterialsPage'

export const metadata: Metadata = { title: 'Materials & trims · Nexus Factory' }

/**
 * Products › Materials & trims (SCR-047; areas/products/nav.ts, product.materials.view): leather, textiles, trims,
 * protectors and labels. The filters are in the address (`?view=&kind=&q=`); `?new=1` opens New material.
 */
export default function Page() {
  return (
    <Suspense>
      <MaterialsPage />
    </Suspense>
  )
}
