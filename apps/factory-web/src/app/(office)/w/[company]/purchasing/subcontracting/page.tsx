import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SubcontractingPage } from '../../../../../../areas/purchasing/subcontracting/list/SubcontractingPage'

export const metadata: Metadata = { title: 'Subcontract orders · Nexus Factory' }

/**
 * Purchasing › Outside work › Subcontract orders (SCR-128; its view Stock at subcontractors, SCR-129, `?show=stock`;
 * areas/purchasing/nav.ts, permission purchasing.view). The company layout above loaded the session and draws the Office
 * shell; the page is the client container (`?view=`, `?q=`, `?show=`, `?new=1`).
 */
export default function PurchasingSubcontractingPage() {
  return (
    <Suspense>
      <SubcontractingPage />
    </Suspense>
  )
}
