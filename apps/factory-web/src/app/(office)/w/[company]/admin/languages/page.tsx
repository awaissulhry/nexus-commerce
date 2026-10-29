import { Suspense } from 'react'
import type { Metadata } from 'next'
import { LanguagesPage } from '../../../../../../areas/admin/languages/LanguagesPage'

export const metadata: Metadata = { title: 'Languages & formats · Nexus Factory' }

/** Admin › Languages & formats (SCR-016; areas/admin/nav.ts, companies.view). */
export default function Page() {
  return (
    <Suspense>
      <LanguagesPage />
    </Suspense>
  )
}
