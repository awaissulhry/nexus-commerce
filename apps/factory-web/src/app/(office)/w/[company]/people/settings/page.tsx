import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PeopleSettingsPage } from '../../../../../../areas/people/settings/PeopleSettingsPage'

export const metadata: Metadata = { title: 'People settings · Nexus Factory' }

/**
 * People › People settings (SCR-265; areas/people/nav.ts, permission people.privacy.view): rounding and grace, absence codes,
 * working-time limits, the privacy of people data. The site is the top bar's.
 */
export default function PeopleSettingsRoute() {
  return (
    <Suspense>
      <PeopleSettingsPage />
    </Suspense>
  )
}
