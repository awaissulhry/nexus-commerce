import { Suspense } from 'react'
import type { Metadata } from 'next'
import { Approvals } from '../../../../../../areas/home/approvals/Approvals'

export const metadata: Metadata = { title: 'Approvals · Nexus Factory' }

/** Home › Approvals (SCR-030; W1: quote approvals; `?view=waiting|mine|decided`, `?open=<request id>`). */
export default function Page() {
  return (
    <Suspense>
      <Approvals />
    </Suspense>
  )
}
