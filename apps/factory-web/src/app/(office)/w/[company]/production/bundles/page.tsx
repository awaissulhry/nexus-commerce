import type { Metadata } from 'next'
import { Suspense } from 'react'
import { BundlesPage } from '../../../../../../areas/production/bundles/BundlesPage'

export const metadata: Metadata = { title: 'Bundles · Nexus Factory' }

/**
 * Production › Cutting room › Bundles (SCR-259; areas/production/nav.ts, permission production.bundles.view): the tiles,
 * the scan-pattern checks and where every bundle is (`?stuck=true`, `?place=LINE`, `?status=VOID`, `?view=all`, `?q=`).
 */
export default function ProductionBundlesPage() {
  return (
    <Suspense>
      <BundlesPage />
    </Suspense>
  )
}
