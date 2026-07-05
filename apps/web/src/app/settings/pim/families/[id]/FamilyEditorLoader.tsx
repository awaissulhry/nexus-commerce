'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so data MUST load client-side where the
// fetch patch adds credentials. Server-side these fetches 401'd, which made
// the page notFound() (404) for everyone in prod.

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import FamilyEditorClient, {
  type FamilyDetail,
  type AttributeRow,
  type EffectiveAttribute,
} from './FamilyEditorClient'

interface LoadedData {
  family: FamilyDetail | null
  attributes: AttributeRow[]
  effective: EffectiveAttribute[]
  errors: string[]
  missing: boolean
}

async function fetchInitialData(id: string): Promise<LoadedData> {
  const backend = getBackendUrl()

  const errors: string[] = []
  let family: FamilyDetail | null = null
  let attributes: AttributeRow[] = []
  let effective: EffectiveAttribute[] = []
  let missing = false

  // PERF — these three reads are independent; fetch them in one parallel
  // round instead of three sequential round trips (~3x the latency).
  const [familyRes, attributesRes, effectiveRes] = await Promise.allSettled([
    fetch(`${backend}/api/families/${id}`, { cache: 'no-store' }),
    fetch(`${backend}/api/attributes`, { cache: 'no-store' }),
    fetch(`${backend}/api/families/${id}/effective`, { cache: 'no-store' }),
  ])

  // family (required — 404s the route if missing)
  if (familyRes.status === 'fulfilled') {
    const res = familyRes.value
    if (res.status === 404) missing = true
    else if (!res.ok) errors.push(`Failed to load family (HTTP ${res.status})`)
    else {
      const data = (await res.json()) as { family?: FamilyDetail }
      family = data.family ?? null
    }
  } else {
    errors.push(familyRes.reason?.message ?? String(familyRes.reason))
  }

  // attribute pool
  if (attributesRes.status === 'fulfilled') {
    const res = attributesRes.value
    if (!res.ok) errors.push(`Failed to load attribute pool (HTTP ${res.status})`)
    else {
      const data = (await res.json()) as { attributes?: AttributeRow[] }
      attributes = data.attributes ?? []
    }
  } else {
    errors.push(attributesRes.reason?.message ?? String(attributesRes.reason))
  }

  // effective inheritance preview (best-effort, non-critical)
  if (effectiveRes.status === 'fulfilled' && effectiveRes.value.ok) {
    const data = (await effectiveRes.value.json()) as { attributes?: EffectiveAttribute[] }
    effective = data.attributes ?? []
  }

  return { family, attributes, effective, errors, missing }
}

export default function FamilyEditorLoader({ familyId }: { familyId: string }) {
  const [data, setData] = useState<LoadedData | null>(null)

  useEffect(() => {
    let alive = true
    setData(null)
    fetchInitialData(familyId).then((d) => {
      if (alive) setData(d)
    })
    return () => { alive = false }
  }, [familyId])

  if (!data) {
    return (
      <div className="space-y-5" aria-busy="true">
        <div>
          <div className="h-6 w-56 rounded-md bg-slate-100 dark:bg-slate-800 animate-pulse" />
          <div className="h-4 w-96 max-w-full mt-2 rounded-md bg-slate-100 dark:bg-slate-800 animate-pulse" />
        </div>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-40 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
        ))}
      </div>
    )
  }

  // Explicit API 404 → route-level not-found (mirrors the old server render).
  if (data.missing || !data.family) notFound()

  const { family, attributes, effective, errors } = data

  // The shell header above shows "Product families" (parent nav).
  // Per-row identity (the family's own label + description) goes
  // here so a parent + child page still feels distinct.
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {family.label}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
          {family.description ??
            `Akeneo-style family. Attach attributes here; ${family.parentFamily ? 'inherits ' + (effective.length - family.familyAttributes.length) + ' more from ancestors. ' : ''}Children of this family inherit ALL of these (additive, parent-wins on conflict).`}
        </p>
      </div>
      <FamilyEditorClient
        family={family}
        attributePool={attributes}
        initialEffective={effective}
        initialError={errors.length > 0 ? errors.join(' · ') : null}
      />
    </div>
  )
}
