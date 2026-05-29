/** AX3.10 — Budget Manager page. */
import type { Metadata } from 'next'
import { BudgetManagerClient } from './BudgetManagerClient'

export const metadata: Metadata = { title: 'Amazon Ads · Budget Manager' }
export const dynamic = 'force-dynamic'

export default function BudgetManagerPage() {
  return (
    <div className="px-4 py-4">
      <BudgetManagerClient />
    </div>
  )
}
