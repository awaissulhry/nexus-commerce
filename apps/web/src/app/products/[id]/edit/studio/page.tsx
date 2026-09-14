/**
 * PES.1 — `/products/[id]/edit/studio`.
 *
 * The production product editor. Historical `/products/[id]/edit` URLs redirect here,
 * preserving their product identity, market, and supported destination/tab state.
 */

import { Suspense } from 'react'
import { notFound } from 'next/navigation'

import { StudioClient } from '../_studio/StudioClient'
import { StudioLoader } from '../_studio/StudioLoader'
import { loadStudioData } from '../_studio/studio-data'

import Loading from './loading'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function ProductStudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // Fast path: the server renders the frame fully formed. Under RBAC enforce this comes back 401
  // (the Next server cannot read the API-origin session cookie), and the client loader re-runs the
  // same calls where the credentialed fetch wrapper authenticates them.
  const result = await loadStudioData(id)

  if (result.kind === 'notfound') notFound()

  return (
    // The studio's state lives in the query string, and `useSearchParams` needs a Suspense boundary
    // above it.
    <Suspense fallback={<Loading />}>
      {result.kind === 'ok' ? (
        <StudioClient
          product={result.data.product}
          family={result.data.family}
          marketplaces={result.data.marketplaces}
      primaryLanguage={result.data.primaryLanguage}
          marketplacesFailed={result.data.marketplacesFailed}
        />
      ) : (
        <StudioLoader id={id} />
      )}
    </Suspense>
  )
}
