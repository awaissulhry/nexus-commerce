import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ScrapPage } from '../../../../../../areas/production/scrap/ScrapPage'

export const metadata: Metadata = { title: 'Scrap & rework · Nexus Factory' }

/**
 * Production › Floor control › Scrap & rework (SCR-140; areas/production/nav.ts, permission production.scrap.view): the
 * tiles, the pareto by reason, operation or style, and every scrap and rework row (`?view=`, `?period=`, `?kind=`,
 * `?by=`, `?group=`, `?q=`, `?open=<row>`, `?replace=<row>`). The company layout above loaded the session and the shell.
 */
export default function ProductionScrapPage() {
  return (
    <Suspense>
      <ScrapPage />
    </Suspense>
  )
}
