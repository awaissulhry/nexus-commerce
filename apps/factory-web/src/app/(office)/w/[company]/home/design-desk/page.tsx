import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DesignDeskPage } from '../../../../../../areas/home/design-desk/DesignDeskPage'

export const metadata: Metadata = { title: 'Design desk · Nexus Factory' }

/**
 * Home › Design desk (owb-of7 step 1; areas/home/nav.ts, permission orders.view.own). The page replaces the base's stub; its address
 * stays DECLARED until lead 88's nav flip (shell/nav/office-nav.ts DECLARED_PAGES → OFFICE_PAGES). The client container reads the desk.
 */
export default function HomeDesignDeskPage() {
  return (
    <Suspense>
      <DesignDeskPage />
    </Suspense>
  )
}
