// /marketing/reviews/settings — Reviews › Settings (build spec §3.6, PR D): where reviews come from, our review e-mails
// and the unsubscribe list, reply templates and the brand voice, alerts, review automations and the jobs behind them.
// The page is SettingsClient: it reads `?section=` on the client (it scrolls to that section) and renders its own
// PageHeader inside the Reviews shell.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SettingsClient } from './_settings/SettingsClient'
import ReviewsSettingsLoading from './loading'

export const metadata: Metadata = { title: 'Reviews · Settings' }

export default function ReviewsSettingsPage() {
  return (
    <Suspense fallback={<ReviewsSettingsLoading />}>
      <SettingsClient />
    </Suspense>
  )
}
