import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MachineRecord } from '../../../../../../../areas/plant/machines/record/MachineRecord'

export const metadata: Metadata = { title: 'Machine · Nexus Factory' }

/** Plant › a machine (SCR-150 record; `?tab=overview|docs|history|status`, B-TH-265: an old `tag` opens Overview & tag). The company layout above loaded the session and shell. */
export default async function PlantMachinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <MachineRecord machineId={id} />
    </Suspense>
  )
}
