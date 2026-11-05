import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PreventivePage } from '../../../../../../areas/plant/preventive/PreventivePage'

export const metadata: Metadata = { title: 'Preventive & statutory checks · Nexus Factory' }

/**
 * Plant › Maintenance › Preventive & statutory checks (SCR-266; areas/plant/nav.ts, permission plant.view): the statutory
 * checks of the machines on a calendar, their plans and the check register. The client container reads `?view=`,
 * `?month=`, `?day=`, `?due=`, `?ended=`, `?missing=`, `?outcome=`, `?plan=`, `?result=`, `?new=`, `?record=`,
 * `?corrects=`, `?move=`, `?date=`.
 */
export default function PreventiveRoute() {
  return (
    <Suspense>
      <PreventivePage />
    </Suspense>
  )
}
