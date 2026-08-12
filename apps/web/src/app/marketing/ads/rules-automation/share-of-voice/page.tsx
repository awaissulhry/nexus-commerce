/**
 * SOV.0 — Share of Voice, promoted from a tab to its own route.
 *
 * Same shape as ../keyword-tracker, ../automations and ../dayparting: force-dynamic, and a Suspense
 * boundary because the client reads `useSearchParams` — every view on this page is linkable, so the
 * URL is the state.
 */
import { Suspense } from 'react'
import { ShareOfVoiceClient } from './ShareOfVoiceClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ShareOfVoiceClient />
    </Suspense>
  )
}
