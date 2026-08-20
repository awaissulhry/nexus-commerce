/** AIAD.3 — AI Advertising dashboard (console-native). Suspense: the client reads searchParams. */
import { Suspense } from 'react'
import { AiAdvertisingDashboard } from './AiAdvertisingDashboard'

export const dynamic = 'force-dynamic'
export default function AiAdvertisingPage() {
  return (
    <Suspense>
      <AiAdvertisingDashboard />
    </Suspense>
  )
}
