import { Suspense } from 'react'
import type { Metadata } from 'next'
import { Alerts } from '../../../../../../areas/home/alerts/Alerts'

export const metadata: Metadata = { title: 'Alerts · Nexus Factory' }

/** Home › Insights › Alerts (SCR-234, B-W2a-78; `?tile=`, `?severity=`, `?kind=`, `?q=`, `?open=<alert id>`, `?rule=<id>|new`; `#rules`). */
export default function Page() {
  return (
    <Suspense>
      <Alerts />
    </Suspense>
  )
}
