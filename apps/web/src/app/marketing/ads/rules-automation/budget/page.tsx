/**
 * BUD.1 — Budget Rules, promoted from a tab to its own route.
 *
 * Same shape as ../bid and ../negative-targeting: force-dynamic, and a Suspense boundary because
 * the client reads `useSearchParams` — every view on this page must be linkable, since "which rule
 * took this campaign to €1" is a question answered by pasting a URL into a message, not by
 * describing where to click.
 */
import { Suspense } from 'react'
import { BudgetClient } from './BudgetClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <BudgetClient />
    </Suspense>
  )
}
