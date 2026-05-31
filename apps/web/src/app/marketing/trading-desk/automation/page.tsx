/** Trading Desk — Automation command center (rules engine). */
import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { AutomationClient } from './AutomationClient'

export const metadata: Metadata = { title: 'Automation · Trading Desk' }
export const dynamic = 'force-dynamic'

async function j(path: string) {
  try {
    const r = await fetch(`${getBackendUrl()}${path}`, { cache: 'no-store' })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export default async function TradingDeskAutomationPage() {
  const [rules, health] = await Promise.all([
    j('/api/advertising/automation-rules'),
    j('/api/advertising/automation-health'),
  ])
  return <AutomationClient initialRules={rules?.items ?? []} initialHealth={health} />
}
