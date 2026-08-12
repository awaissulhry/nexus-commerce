/**
 * DPS.3 — Rank & Dayparting Schedules, promoted from a tab to its own route.
 *
 * RD.P0 — a Suspense boundary, because the client now reads `useSearchParams`: scope, the open row
 * and its panel all live in the URL. Same shape as ../negative-targeting and ../keyword-tracker.
 */
import { Suspense } from 'react'
import { DaypartingSchedulesClient } from './DaypartingSchedulesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <DaypartingSchedulesClient />
    </Suspense>
  )
}
