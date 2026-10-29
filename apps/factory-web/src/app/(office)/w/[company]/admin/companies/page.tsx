import { Suspense } from 'react'
import type { Metadata } from 'next'
import { CompaniesPage } from '../../../../../../areas/admin/companies/CompaniesPage'

export const metadata: Metadata = { title: 'Companies & sites · Nexus Factory' }

/** Admin › Companies & sites (SCR-008; areas/admin/nav.ts, companies.view). The company layout draws the Office shell. */
export default function Page() {
  return (
    <Suspense>
      <CompaniesPage />
    </Suspense>
  )
}
