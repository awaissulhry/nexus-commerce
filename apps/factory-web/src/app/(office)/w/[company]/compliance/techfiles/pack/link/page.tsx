import { Suspense } from 'react'
import type { Metadata } from 'next'
import { AuthorityPreview } from '../../../../../../../../areas/compliance/techfiles/link/AuthorityPreview'

export const metadata: Metadata = { title: 'Authority link preview · Nexus Factory' }

/** Compliance › Technical files › Authority link preview (SCR-327, a new tab, design tab:tf-authority): `?pack=<id>`. */
export default function Page() {
  return (
    <Suspense>
      <AuthorityPreview />
    </Suspense>
  )
}
