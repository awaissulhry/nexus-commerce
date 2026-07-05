'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so data MUST load client-side where the
// fetch patch adds credentials. Server-side this fetch 401'd into an empty
// families list for everyone.

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import FamiliesClient, { type FamilyRow } from './FamiliesClient'

interface InitialData {
  initial: FamilyRow[]
  loadError: string | null
}

async function fetchInitialData(): Promise<InitialData> {
  const backend = getBackendUrl()
  let initial: FamilyRow[] = []
  let loadError: string | null = null
  try {
    const res = await fetch(`${backend}/api/families`, { cache: 'no-store' })
    if (!res.ok) {
      loadError = `Failed to load product families (HTTP ${res.status})`
    } else {
      const data = (await res.json()) as { families?: FamilyRow[] }
      initial = data.families ?? []
    }
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }
  return { initial, loadError }
}

export default function FamiliesSettingsPage() {
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
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
        ))}
      </div>
    )
  }

  return <FamiliesClient initial={data.initial} initialError={data.loadError} />
}
