'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so data MUST load client-side where the
// fetch patch adds credentials. Server-side these fetches 401'd into empty
// exports/retention/consent for everyone.

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import PrivacyClient, {
  type ExportRow,
  type RetentionState,
  type ConsentLatest,
} from './PrivacyClient'

interface InitialData {
  exports: ExportRow[]
  retention: RetentionState | null
  consent: ConsentLatest
  loadError: string | null
}

async function fetchInitialData(): Promise<InitialData> {
  const backend = getBackendUrl()
  let exports: ExportRow[] = []
  let retention: RetentionState | null = null
  let consent: ConsentLatest = {}
  let loadError: string | null = null

  try {
    const [exportsRes, retentionRes, consentRes] = await Promise.all([
      fetch(`${backend}/api/settings/privacy/exports`, { cache: 'no-store' }),
      fetch(`${backend}/api/settings/privacy/retention`, { cache: 'no-store' }),
      fetch(`${backend}/api/settings/privacy/consent`, { cache: 'no-store' }),
    ])
    if (exportsRes.ok) exports = (await exportsRes.json()).exports ?? []
    if (retentionRes.ok) retention = await retentionRes.json()
    if (consentRes.ok) consent = (await consentRes.json()).latest ?? {}
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }

  return { exports, retention, consent, loadError }
}

export default function PrivacyPage() {
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
      <div className="max-w-3xl space-y-6" aria-busy="true">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-40 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <PrivacyClient
      initialExports={data.exports}
      initialRetention={data.retention}
      initialConsent={data.consent}
      initialError={data.loadError}
    />
  )
}
