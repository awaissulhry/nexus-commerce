import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PlantSettingsPage } from '../../../../../../areas/plant/settings/PlantSettingsPage'

export const metadata: Metadata = { title: 'Plant settings · Nexus Factory' }

/**
 * Plant › Settings › Plant settings (SCR-241; areas/plant/nav.ts, permission plant.view): its W2a section, the symptoms
 * operators pick on the floor per machine class. The client container reads `?class=`.
 */
export default function PlantSettingsRoute() {
  return (
    <Suspense>
      <PlantSettingsPage />
    </Suspense>
  )
}
