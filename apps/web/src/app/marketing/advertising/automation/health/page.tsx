/** AX3.13 — Automation Health page. */
import type { Metadata } from 'next'
import { HealthClient } from './HealthClient'

export const metadata: Metadata = { title: 'Amazon Ads · Automation health' }
export const dynamic = 'force-dynamic'

export default function AutomationHealthPage() {
  return (
    <div className="px-4 py-4">
      <HealthClient />
    </div>
  )
}
