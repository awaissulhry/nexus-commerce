'use client'

/**
 * MC.8.2 — Client-side data loader for the A+ Content list.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so the list MUST load client-side
 * where the fetch patch adds credentials. Server-side this fetch 401'd
 * into an empty list + error banner for everyone.
 *
 * `refreshToken` comes from the server page render (Date.now() under
 * force-dynamic): AplusListClient's Refresh control calls
 * router.refresh(), which re-renders the server page, mints a new token,
 * and re-triggers this fetch — preserving the original refresh semantics.
 */

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
import { useTranslations } from '@/lib/i18n/use-translations'
import AplusListClient from './AplusListClient'
import type { AplusContentRow } from './_lib/types'

async function fetchList(): Promise<{
  items: AplusContentRow[]
  error: string | null
}> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(`${backend}/api/aplus-content?limit=200`, {
      cache: 'no-store',
    })
    if (!res.ok) {
      return {
        items: [],
        error: `A+ Content API returned ${res.status}`,
      }
    }
    const data = (await res.json()) as { items: AplusContentRow[] }
    return { items: data.items ?? [], error: null }
  } catch (err) {
    return {
      items: [],
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}

export default function AplusListLoader({ refreshToken }: { refreshToken: number }) {
  const { t } = useTranslations()
  const [result, setResult] = useState<{
    items: AplusContentRow[]
    error: string | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchList().then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const apiBase = getBackendUrl()

  if (!result) {
    return (
      <div className="space-y-4" aria-busy="true">
        <PageHeader
          title={t('aplus.title')}
          description={t('aplus.description')}
        />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800"
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <AplusListClient items={result.items} error={result.error} apiBase={apiBase} />
  )
}
