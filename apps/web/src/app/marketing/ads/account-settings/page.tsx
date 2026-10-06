import { redirect } from 'next/navigation'

/**
 * AM-29 — the advertising settings live at /settings/advertising (connections and their read/write state). This
 * route was a "This page is not built yet." stub the ads rail opened; it now redirects there, as the old console's
 * Settings already did, so a bookmark still lands on the real page.
 */
export const dynamic = 'force-dynamic'
export default function Page() {
  redirect('/settings/advertising')
}
