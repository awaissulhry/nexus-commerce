import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PrivacyPage } from '../../../../../../areas/admin/privacy/PrivacyPage'

export const metadata: Metadata = { title: 'Privacy & notices · Nexus Factory' }

/**
 * Admin › Data › Privacy & notices (SCR-086; areas/admin/nav.ts, privacy.view): the privacy duties with the floor's gate
 * per site, the worker / staff / public notices and who acknowledged them, the DPIA and the record of processing
 * activities. `?company=<id>`, `?view=notices|dpia|register`, `?open=<noticeId>`.
 */
export default function Page() {
  return (
    <Suspense>
      <PrivacyPage />
    </Suspense>
  )
}
