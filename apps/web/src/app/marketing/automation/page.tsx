// MC.11.1 — Marketing-content automation rule list.

import { getBackendUrl } from '@/lib/backend-url'
import AutomationListClient from './AutomationListClient'
import { normaliseRule, type RuleRow, type SharedRuleRow } from './_lib/types'

export const dynamic = 'force-dynamic'

async function fetchRules(): Promise<{
  rules: RuleRow[]
  error: string | null
}> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(
      `${backend}/api/marketing-automation/rules`,
      { cache: 'no-store' },
    )
    if (!res.ok)
      return {
        rules: [],
        error: `Automation API returned ${res.status}`,
      }
    const data = (await res.json()) as { rules: SharedRuleRow[] }
    return { rules: data.rules.map(normaliseRule), error: null }
  } catch (err) {
    return {
      rules: [],
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}

export default async function AutomationPage() {
  const { rules, error } = await fetchRules()
  const apiBase = getBackendUrl()
  return <AutomationListClient rules={rules} error={error} apiBase={apiBase} />
}
