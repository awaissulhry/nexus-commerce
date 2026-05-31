/** Trading Desk — Settings (native): connections + write-mode status. */
import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { SettingsClient } from './SettingsClient'

export const metadata: Metadata = { title: 'Settings · Trading Desk' }
export const dynamic = 'force-dynamic'

async function getConns() {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/connections`, { cache: 'no-store' })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export default async function TradingDeskSettingsPage() {
  const initial = await getConns()
  return <SettingsClient initial={initial} />
}
