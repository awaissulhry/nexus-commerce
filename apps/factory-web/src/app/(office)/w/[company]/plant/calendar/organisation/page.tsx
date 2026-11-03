import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OrganisationPrint } from '../../../../../../../areas/plant/calendar/organisation/OrganisationPrint'

export const metadata: Metadata = { title: 'Safety organisation chart · Nexus Factory' }

/** Plant › Health & safety › Safety calendar › Organisation chart (a new tab, for the notice board): names and contacts. */
export default function SafetyOrganisationPrintRoute() {
  return (
    <Suspense>
      <OrganisationPrint />
    </Suspense>
  )
}
