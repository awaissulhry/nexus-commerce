import { Suspense } from 'react'
import type { Metadata } from 'next'
import { MaterialRecord } from '../../../../../../../areas/products/materials/record/MaterialRecord'

export const metadata: Metadata = { title: 'Material · Nexus Factory' }

/** Products › Materials & trims › a material (SCR-048; `?tab=overview|colours|properties|suppliers|compliance|stock`). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <MaterialRecord materialId={decodeURIComponent(id)} />
    </Suspense>
  )
}
