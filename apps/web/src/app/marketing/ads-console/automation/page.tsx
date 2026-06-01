/** Ads Console — Automation (rule library + active rules + recommendations + engine). */
import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { AutomationHub } from './AutomationHub'

export const metadata: Metadata = { title: 'Automation | Ads Console' }
export const dynamic = 'force-dynamic'

async function load() {
  const b = getBackendUrl()
  const [rules, state] = await Promise.all([
    fetch(`${b}/api/advertising/automation-rules`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
    fetch(`${b}/api/advertising/automation/state`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
  ])
  return { rules: rules.items ?? [], state }
}

export default async function AdsConsoleAutomationPage() {
  const { rules, state } = await load()
  return <AutomationHub initialRules={rules} initialState={state} />
}
