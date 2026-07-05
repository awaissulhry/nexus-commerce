'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so data MUST load client-side where the
// fetch patch adds credentials. Server-side these fetches 401'd into empty
// groups/attributes lists for everyone.

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import AttributesClient, {
  type AttributeGroupRow,
  type AttributeRow,
} from './AttributesClient'

interface InitialData {
  groups: AttributeGroupRow[]
  attributes: AttributeRow[]
  errors: string[]
}

async function fetchInitialData(): Promise<InitialData> {
  const backend = getBackendUrl()
  const errors: string[] = []

  let groups: AttributeGroupRow[] = []
  let attributes: AttributeRow[] = []

  try {
    const res = await fetch(`${backend}/api/attribute-groups`, {
      cache: 'no-store',
    })
    if (!res.ok) errors.push(`Failed to load groups (HTTP ${res.status})`)
    else {
      const data = (await res.json()) as { groups?: AttributeGroupRow[] }
      groups = data.groups ?? []
    }
  } catch (err: any) {
    errors.push(err?.message ?? String(err))
  }

  try {
    const res = await fetch(`${backend}/api/attributes`, { cache: 'no-store' })
    if (!res.ok) errors.push(`Failed to load attributes (HTTP ${res.status})`)
    else {
      const data = (await res.json()) as { attributes?: AttributeRow[] }
      attributes = data.attributes ?? []
    }
  } catch (err: any) {
    errors.push(err?.message ?? String(err))
  }

  return { groups, attributes, errors }
}

export default function AttributesSettingsPage() {
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
      <div className="max-w-5xl space-y-4" aria-busy="true">
        <div className="h-10 w-64 rounded-md bg-slate-100 dark:bg-slate-800 animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-32 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <AttributesClient
      initialGroups={data.groups}
      initialAttributes={data.attributes}
      initialError={data.errors.length > 0 ? data.errors.join(' · ') : null}
    />
  )
}
