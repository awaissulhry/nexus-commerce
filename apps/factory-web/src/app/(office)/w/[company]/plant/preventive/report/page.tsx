import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CheckReport } from '../../../../../../../areas/plant/preventive/report/CheckReport'

export const metadata: Metadata = { title: 'Check report · Nexus Factory' }

/** Plant › Maintenance › Preventive & statutory checks › Check report (a new tab from a result): `?result=&language=`. */
export default function CheckReportRoute() {
  return (
    <Suspense>
      <CheckReport />
    </Suspense>
  )
}
