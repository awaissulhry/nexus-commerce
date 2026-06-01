import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { OverviewClient } from './OverviewClient'

export const metadata: Metadata = { title: 'Overview | Ads Console' }
export const dynamic = 'force-dynamic'

async function getData() {
  const base = getBackendUrl()
  const [connsRes, campsRes, rulesRes, recsRes, stateRes] = await Promise.allSettled([
    fetch(`${base}/api/advertising/connections`, { cache: 'no-store' }),
    fetch(`${base}/api/advertising/campaigns?limit=500`, { cache: 'no-store' }),
    fetch(`${base}/api/advertising/automation-rules?limit=200`, { cache: 'no-store' }),
    fetch(`${base}/api/advertising/recommendations?limit=10`, { cache: 'no-store' }),
    fetch(`${base}/api/advertising/automation/state`, { cache: 'no-store' }),
  ])
  const j = async (r: PromiseSettledResult<Response>) => r.status === 'fulfilled' && r.value.ok ? r.value.json().catch(() => null) : null
  const [conns, camps, rules, recs, state] = await Promise.all([j(connsRes), j(campsRes), j(rulesRes), j(recsRes), j(stateRes)])
  return { conns: conns?.items ?? [], camps: camps?.items ?? [], rules: rules?.rules ?? [], recs, state }
}

export default async function OverviewPage() {
  const data = await getData()
  return <OverviewClient {...data} />
}
