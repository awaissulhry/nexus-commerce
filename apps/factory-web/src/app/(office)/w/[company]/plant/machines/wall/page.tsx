import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MachineWall } from '../../../../../../../areas/plant/machines/wall/MachineWall'

export const metadata: Metadata = { title: 'Status wall · Nexus Factory' }

/** Plant › Machines & tools › Status wall (B-W2b-136; a new tab left open on an office screen: `?site=&show=`; live, read-only). */
export default function PlantMachineWallPage() {
  return (
    <Suspense>
      <MachineWall />
    </Suspense>
  )
}
