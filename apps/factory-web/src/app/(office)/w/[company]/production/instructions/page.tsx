import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InstructionsPage } from '../../../../../../areas/production/instructions/InstructionsPage'

export const metadata: Metadata = { title: 'Work instructions · Nexus Factory' }

/**
 * Production › Floor control › Work instructions (SCR-141; areas/production/nav.ts, production.instructions.view). The company
 * layout above loaded the session and draws the Office shell; the page is the client container. `?view=` (a saved view),
 * `?q=`, New instruction `?new=1`, Bring in typed steps `?typed=1`.
 */
export default function WorkInstructionsRoute() {
  return (
    <Suspense>
      <InstructionsPage />
    </Suspense>
  )
}
