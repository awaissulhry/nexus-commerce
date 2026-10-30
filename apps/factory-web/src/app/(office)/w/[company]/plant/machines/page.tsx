import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MachinesPage } from '../../../../../../areas/plant/machines/MachinesPage'

export const metadata: Metadata = { title: 'Machines & tools · Nexus Factory' }

/**
 * Plant › Maintenance › Machines & tools (SCR-150; areas/plant/nav.ts, permission plant.view): the register of machines
 * and equipment. The client container reads `?view=`, `?q=`, `?site=`, `?class=` and `?new=1`.
 */
export default function PlantMachinesPage() {
  return (
    <Suspense>
      <MachinesPage />
    </Suspense>
  )
}
