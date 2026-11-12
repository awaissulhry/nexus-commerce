import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PurchasingSettingsPage } from '../../../../../../areas/purchasing/settings/PurchasingSettingsPage'

export const metadata: Metadata = { title: 'Purchasing settings · Nexus Factory' }

/**
 * Purchasing › Settings › Purchasing settings (SCR-256, B-W2b-354; areas/purchasing/nav.ts, purchasing.view). The company
 * layout above loaded the session and draws the Office shell; the page is the client container. `?scope=all` every
 * company's settings (else the address's company), `?status=ARCHIVED|ALL` the exceptions listed, `?tolerance=<id>|new` a
 * delivery tolerance in its dialog.
 */
export default function PurchasingSettingsRoute() {
  return (
    <Suspense>
      <PurchasingSettingsPage />
    </Suspense>
  )
}
