import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SettingsHistory } from '../../../../../../../areas/people/settings/history/SettingsHistory'

export const metadata: Metadata = { title: 'People settings history · Nexus Factory' }

/** People › People settings › Audit log (a new tab, audit.read): every change of these settings, newest first. */
export default function PeopleSettingsHistoryRoute() {
  return (
    <Suspense>
      <SettingsHistory />
    </Suspense>
  )
}
