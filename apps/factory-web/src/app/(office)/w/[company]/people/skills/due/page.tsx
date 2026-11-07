import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DueListTab } from '../../../../../../../areas/people/skills/training/due/DueListTab'

export const metadata: Metadata = { title: 'Training due list · Nexus Factory' }

/** People › Skills & training › Training due list (PDF for the RSPP; a new tab from the band's ⋯): `?view=&course=&language=`. */
export default function TrainingDueListRoute() {
  return (
    <Suspense>
      <DueListTab />
    </Suspense>
  )
}
