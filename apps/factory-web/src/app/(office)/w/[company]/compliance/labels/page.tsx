import { Suspense } from 'react'
import type { Metadata } from 'next'
import { LabelsPage } from '../../../../../../areas/compliance/labels/LabelsPage'

export const metadata: Metadata = { title: 'Labels & marking · Nexus Factory' }

/**
 * Compliance › Labels & marking (SCR-053; compliance.certificates.view): the PPE garment labels. `?view=` names a
 * saved filter; `?new=1` opens New label.
 */
export default function Page() {
  return (
    <Suspense>
      <LabelsPage />
    </Suspense>
  )
}
