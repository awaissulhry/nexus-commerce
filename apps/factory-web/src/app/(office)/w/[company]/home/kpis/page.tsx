import type { Metadata } from 'next'
import { Suspense } from 'react'
import { KpisPage } from '../../../../../../areas/home/kpis/KpisPage'

export const metadata: Metadata = { title: 'KPI library · Nexus Factory' }

/**
 * Home › Insights › KPI library (SCR-249; areas/home/nav.ts, permission home.kpis.view): every KPI with its plain
 * definition and its value now. The company layout above loaded the session and draws the Office shell; the page is the
 * client container.
 */
export default function HomeKpisPage() {
  return (
    <Suspense>
      <KpisPage />
    </Suspense>
  )
}
