import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Today } from '../../../../../../areas/home/today/Today'

export const metadata: Metadata = { title: 'Today · Nexus Factory' }

/**
 * Home › Today (SCR-029; areas/home/nav.ts, permission home.view). The company layout above loaded the session and
 * draws the Office shell; the page is the client container, which loads Today through the API.
 */
export default function TodayPage() {
  return (
    <Suspense>
      <Today />
    </Suspense>
  )
}
