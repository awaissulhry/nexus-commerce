import type { Metadata } from 'next'
import { ActivityClient } from './ActivityClient'
import { getBackendUrl } from '@/lib/backend-url'

export const metadata: Metadata = { title: 'Activity | Ads Console' }
export const dynamic = 'force-dynamic'

async function getExecutions() {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rule-executions?limit=100`, { cache: 'no-store' })
    if (!r.ok) return []
    return (await r.json()).items ?? []
  } catch { return [] }
}

export default async function ActivityPage() {
  const items = await getExecutions()
  return <ActivityClient initial={items} />
}
