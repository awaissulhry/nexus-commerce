/** Trading Desk — Automation (native rules surface). */
import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { AutomationClient } from './AutomationClient'

export const metadata: Metadata = { title: 'Automation · Trading Desk' }
export const dynamic = 'force-dynamic'

async function getRules() {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' })
    if (!r.ok) return []
    const d = await r.json()
    return d.items ?? []
  } catch {
    return []
  }
}

export default async function TradingDeskAutomationPage() {
  const items = await getRules()
  return <AutomationClient initial={items} />
}
