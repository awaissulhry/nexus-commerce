/** ACR.1 — the Control Room: every automation that can change this account, in one place. */
import { Suspense } from 'react'
import { ControlRoomClient } from './ControlRoomClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  // The tab is read from ?tab= via useSearchParams, which App Router requires be wrapped —
  // without this the whole route opts into client rendering and the build warns.
  return (
    <Suspense fallback={null}>
      <ControlRoomClient />
    </Suspense>
  )
}
