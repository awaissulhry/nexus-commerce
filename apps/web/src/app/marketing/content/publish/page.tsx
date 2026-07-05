'use client'

// MC.12.5 — Per-channel publish dashboard.
//
// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the mode map MUST load client-side
// where the fetch patch adds credentials. Server-side this page 401'd into
// the all-sandbox fallback for everyone.

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import PageHeader from '@/components/layout/PageHeader'
import { useTranslations } from '@/lib/i18n/use-translations'
import PublishDashboardClient from './PublishDashboardClient'

interface ModeMap {
  AMAZON: 'sandbox' | 'live'
  EBAY: 'sandbox' | 'live'
  SHOPIFY: 'sandbox' | 'live'
  WOOCOMMERCE: 'sandbox' | 'live'
}

async function fetchModes(): Promise<ModeMap> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(`${backend}/api/channel-publish/_meta/mode`, {
      cache: 'no-store',
    })
    if (!res.ok)
      return {
        AMAZON: 'sandbox',
        EBAY: 'sandbox',
        SHOPIFY: 'sandbox',
        WOOCOMMERCE: 'sandbox',
      }
    const data = (await res.json()) as { modes: ModeMap }
    return data.modes
  } catch {
    return {
      AMAZON: 'sandbox',
      EBAY: 'sandbox',
      SHOPIFY: 'sandbox',
      WOOCOMMERCE: 'sandbox',
    }
  }
}

export default function PublishDashboardPage() {
  const { t } = useTranslations()
  const [modes, setModes] = useState<ModeMap | null>(null)

  useEffect(() => {
    let alive = true
    fetchModes().then((m) => {
      if (alive) setModes(m)
    })
    return () => {
      alive = false
    }
  }, [])

  const apiBase = getBackendUrl()

  if (!modes) {
    return (
      <div className="space-y-4" aria-busy="true">
        <PageHeader
          title={t('publishDashboard.title')}
          description={t('publishDashboard.description')}
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-lg border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800"
            />
          ))}
        </div>
      </div>
    )
  }

  return <PublishDashboardClient modes={modes} apiBase={apiBase} />
}
