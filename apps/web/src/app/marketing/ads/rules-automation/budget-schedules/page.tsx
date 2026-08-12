/** BSP.0 — Budget Pacing & Schedules, promoted from a tab to its own route. */
import { Suspense } from 'react'
import { BudgetSchedulesClient } from './BudgetSchedulesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  // `useSearchParams` needs a Suspense boundary above it — this page's entire state is the URL, so
  // without one the whole route opts into client rendering at build time.
  return (
    <Suspense fallback={null}>
      <BudgetSchedulesClient />
    </Suspense>
  )
}
