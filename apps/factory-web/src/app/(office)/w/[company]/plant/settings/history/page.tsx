import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SettingsHistory } from '../../../../../../../areas/plant/settings/history/SettingsHistory'

export const metadata: Metadata = { title: 'Plant settings history · Nexus Factory' }

/** Plant › Plant settings › Audit log (a new tab from ⋯ History, audit.read): every change of these settings, newest first. */
export default function PlantSettingsHistoryRoute() {
  return (
    <Suspense>
      <SettingsHistory />
    </Suspense>
  )
}
