import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CuttingPage } from '../../../../../../areas/production/cutting/CuttingPage'

export const metadata: Metadata = { title: 'Cutting · Nexus Factory' }

/**
 * Production › Cutting room › Cutting (SCR-238; areas/production/nav.ts, permission production.cutting.view): the cuts
 * across work orders (`?view=`, `?q=`), New cut order (`?new=1`) and Allocate hides (`?alloc=<work order>`). The company
 * layout above loaded the session and draws the Office shell.
 */
export default function ProductionCuttingPage() {
  return (
    <Suspense>
      <CuttingPage />
    </Suspense>
  )
}
