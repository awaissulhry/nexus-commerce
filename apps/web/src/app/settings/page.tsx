import { redirect } from 'next/navigation'

// TECH_DEBT #3 — /settings (root) was a 404. The sidebar's "Settings"
// link points to /settings/account, so we send root visits there.
// Anyone with a bookmarked /settings lands on the canonical landing
// page rather than seeing the Next.js 404.
export default function SettingsRedirect() {
  redirect('/settings/account')
}
