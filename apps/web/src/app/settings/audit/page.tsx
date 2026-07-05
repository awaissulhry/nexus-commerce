'use client'

/**
 * Settings rebuild — Phase B.5
 *
 * /settings/audit — settings change history. Reads from
 * /api/settings/audit. Initial page loads CLIENT-side (the API session
 * cookie lives on the API origin, so server fetches can never
 * authenticate — they 401'd into an empty log); the client component
 * handles filter changes + revert with refetch.
 */

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import AuditClient, { type AuditRow, type KeyCountMap } from './AuditClient'

interface InitialData {
  items: AuditRow[]
  total: number
  keyCounts: KeyCountMap
  loadError: string | null
}

async function fetchInitialData(): Promise<InitialData> {
  const backend = getBackendUrl()
  let items: AuditRow[] = []
  let total = 0
  let keyCounts: KeyCountMap = {}
  let loadError: string | null = null

  try {
    const [listRes, keysRes] = await Promise.all([
      fetch(`${backend}/api/settings/audit?limit=50`, { cache: 'no-store' }),
      fetch(`${backend}/api/settings/audit/keys`, { cache: 'no-store' }),
    ])
    if (listRes.ok) {
      const data = (await listRes.json()) as { items: AuditRow[]; total: number }
      items = data.items
      total = data.total
    } else {
      loadError = `Failed to load audit log (HTTP ${listRes.status})`
    }
    if (keysRes.ok) {
      const data = (await keysRes.json()) as { byKey: KeyCountMap }
      keyCounts = data.byKey ?? {}
    }
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }

  return { items, total, keyCounts, loadError }
}

export default function SettingsAuditPage() {
  const [data, setData] = useState<InitialData | null>(null)

  useEffect(() => {
    let alive = true
    fetchInitialData().then((d) => {
      if (alive) setData(d)
    })
    return () => { alive = false }
  }, [])

  if (!data) {
    return (
      <div className="max-w-4xl space-y-4" aria-busy="true">
        <div className="h-10 w-64 rounded-md bg-slate-100 dark:bg-slate-800 animate-pulse" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-14 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <AuditClient
      initial={data.items}
      initialTotal={data.total}
      initialKeyCounts={data.keyCounts}
      initialError={data.loadError}
    />
  )
}
