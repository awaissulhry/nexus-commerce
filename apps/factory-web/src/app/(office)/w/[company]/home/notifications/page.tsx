import { Suspense } from 'react'
import type { Metadata } from 'next'
import { Notifications } from '../../../../../../areas/home/notifications/Notifications'

export const metadata: Metadata = { title: 'Notifications · Nexus Factory' }

/** Home › Notifications (SCR-005, B-W2a-40; `?tab=MENTION|ASSIGNMENT|APPROVAL|SYSTEM`, `?state=SNOOZED|DONE`). */
export default function Page() {
  return (
    <Suspense>
      <Notifications />
    </Suspense>
  )
}
