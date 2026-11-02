import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LabourPage } from '../../../../../../areas/production/labour/LabourPage'

export const metadata: Metadata = { title: 'Labour & corrections · Nexus Factory' }

/**
 * Production › Floor control › Labour & corrections (SCR-139, SCR-143; areas/production/nav.ts, permission
 * production.labour.view): the legal basis first, the tiles, one queue of corrections, disputes, off-standard blocks and
 * line days to close (`?kind=`, `?line=`, `?q=`, `?open=<KIND>:<id>`), Line days (`?state=`, `?from=`, `?to=`) and the changes
 * to labour records (`?editKind=`, `?editFrom=`, `?editTo=`). The company layout above loaded the session and the shell.
 */
export default function ProductionLabourPage() {
  return (
    <Suspense>
      <LabourPage />
    </Suspense>
  )
}
