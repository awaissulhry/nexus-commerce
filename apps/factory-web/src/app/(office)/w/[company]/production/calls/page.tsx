import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CallsPage } from '../../../../../../areas/production/calls/CallsPage'

export const metadata: Metadata = { title: 'Help calls · Nexus Factory' }

/**
 * Production › Floor control › Help calls (SCR-142; areas/production/nav.ts, permission production.calls.view): the tiles,
 * calls by hour, who is called and every call with its response and resolve times (`?view=`, `?tile=`, `?kind=`, `?q=`,
 * `?open=<call>`). The company layout above loaded the session and the shell.
 */
export default function ProductionCallsPage() {
  return (
    <Suspense>
      <CallsPage />
    </Suspense>
  )
}
