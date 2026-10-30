import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MachineTags } from '../../../../../../../areas/plant/machines/tags/MachineTags'

export const metadata: Metadata = { title: 'Machine tags · Nexus Factory' }

/** Plant › Machines & tools › Tag sheet (a new tab, `?ids=` the machines: one QR tag each, printed from the browser). */
export default function PlantMachineTagsPage() {
  return (
    <Suspense>
      <MachineTags />
    </Suspense>
  )
}
