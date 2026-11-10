import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PackWindow } from '../../../../../../../areas/compliance/techfiles/window/PackWindow'

export const metadata: Metadata = { title: 'Evidence pack (PDF) · Nexus Factory' }

/** Compliance › Technical files › Evidence pack (PDF) (SCR-326, a new tab, design tab:tf-pack-pdf): `?pack=<id>`. */
export default function Page() {
  return (
    <Suspense>
      <PackWindow />
    </Suspense>
  )
}
