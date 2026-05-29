/** AX3.2 — Full-funnel Goal builder page. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { GoalBuilderClient } from './GoalBuilderClient'

export const metadata: Metadata = { title: 'Amazon Ads · New goal' }
export const dynamic = 'force-dynamic'

export default function GoalsPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <GoalBuilderClient />
    </div>
  )
}
