import type { Metadata } from 'next'
import { Suspense } from 'react'
import { JobsPage } from '../../../../../../areas/plant/jobs/JobsPage'

export const metadata: Metadata = { title: 'Maintenance jobs · Nexus Factory' }

/**
 * Plant › Maintenance › Maintenance jobs (SCR-149; areas/plant/nav.ts, permission plant.view): corrective, preventive,
 * inspection, improvement and safety work as a list or a board. The client container reads `?view=`, `?site=`,
 * `?machine=`, `?mode=board` and `?new=1`.
 */
export default function PlantJobsPage() {
  return (
    <Suspense>
      <JobsPage />
    </Suspense>
  )
}
