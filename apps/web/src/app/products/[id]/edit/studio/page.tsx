/**
 * PES.1 — `/products/[id]/edit/studio`.
 *
 * The production product editor. Historical `/products/[id]/edit` URLs redirect here,
 * preserving their product identity, market, and supported destination/tab state.
 */

import { Suspense } from 'react'
import { StudioLoader } from '../_studio/StudioLoader'

import Loading from './loading'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function ProductStudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  return (
    // The API session belongs to the browser. An unauthenticated server pass used to wait for
    // three requests before repeating them in the browser, delaying every editor navigation.
    <Suspense fallback={<Loading />}>
      <StudioLoader key={id} id={id} />
    </Suspense>
  )
}
