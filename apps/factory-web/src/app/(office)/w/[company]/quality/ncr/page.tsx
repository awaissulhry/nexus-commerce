import type { Metadata } from 'next'
import { Suspense } from 'react'
import { NcrPage } from '../../../../../../areas/quality/ncr/list/NcrPage'

export const metadata: Metadata = { title: 'Nonconformances · Nexus Factory' }

/**
 * Quality › Problems › Nonconformances (SCR-144; areas/quality/nav.ts, permission quality.ncr.view): every NCR as a list
 * or a board by stage. The client container reads `?view=`, `?q=`, `?site=`, `?mode=board` and New NCR `?new=1`
 * (`&from=<record type>&id=<id>`: raised from a record, "from anywhere").
 */
export default function QualityNcrPage() {
  return (
    <Suspense>
      <NcrPage />
    </Suspense>
  )
}
