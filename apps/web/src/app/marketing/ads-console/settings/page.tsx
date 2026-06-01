import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = { title: 'Settings | Ads Console' }

// Advertising settings live at /settings/advertising — redirect there.
export default function AdsConsoleSettingsPage() {
  redirect('/settings/advertising')
}
