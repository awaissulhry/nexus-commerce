'use client'

// MC.11.1 — Marketing-content automation rule list.
//
// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so rules MUST load client-side where
// the fetch patch adds credentials. Server-side this page 401'd into an
// empty rule list + error banner for everyone. Later refreshes are handled
// by AutomationListClient's own client-side refresh().

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
import { useTranslations } from '@/lib/i18n/use-translations'
import AutomationListClient from './AutomationListClient'
import { normaliseRule, type RuleRow, type SharedRuleRow } from './_lib/types'

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

export default function AutomationPage() {
  const { t } = useTranslations()
  const [result, setResult] = useState<{
    rules: RuleRow[]
    error: string | null
  } | null>(null)

  useEffect(() => {
    let alive = true
    fetchRules().then((r) => {
      if (alive) setResult(r)
    })
    return () => {
      alive = false
    }
  }, [])

  const apiBase = getBackendUrl()

  if (!result) {
    return (
      <div className="space-y-4" aria-busy="true">
        <PageHeader
          title={t('automation.title')}
          description={t('automation.description')}
        />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800"
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <AutomationListClient
      rules={result.rules}
      error={result.error}
      apiBase={apiBase}
    />
  )
}
