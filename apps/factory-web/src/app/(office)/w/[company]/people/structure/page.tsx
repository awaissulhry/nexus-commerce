import type { Metadata } from 'next'
import { Suspense } from 'react'
import { StructurePage } from '../../../../../../areas/people/structure/StructurePage'

export const metadata: Metadata = { title: 'Factory structure · Nexus Factory' }

/**
 * People › Factory structure (owb-ss8 8.1 + 8.2; design plan § 5zb; areas/people/nav.ts, permission people.view): the chart and the list of
 * units and people, a unit's and a person's profile (`?unit=` / `?person=`, no route of their own) and their windows. The company layout
 * above loaded the session and draws the Office shell; the page is the client container, which reads GET /people/structure through the
 * API. Its address joins OFFICE_PAGES at the S3 land (shell/nav/office-nav.ts: DECLARED_PAGES → OFFICE_PAGES, lead 88's flip).
 */
export default function PeopleStructurePage() {
  return (
    <Suspense>
      <StructurePage />
    </Suspense>
  )
}
