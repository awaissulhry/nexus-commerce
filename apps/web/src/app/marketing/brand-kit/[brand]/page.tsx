'use client'

// MC.10.1 — Brand Kit edit page (per brand).
//
// Fetches the kit (or null if it doesn't exist yet) and hands off to the
// client editor. Operator can edit colors / fonts / logos / voice / notes;
// PUT auto-creates the kit on first save.
//
// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the old server-side fetch 401'd and
// every EXISTING kit rendered as a blank "new" kit in prod (worst case: a
// save would overwrite the real kit). Data MUST load client-side where the
// patched window.fetch adds credentials.

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { ArrowLeft, Palette } from 'lucide-react'
import Link from 'next/link'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import BrandKitEditClient from './BrandKitEditClient'
import type { BrandKitRow } from '../_lib/types'

async function fetchKit(brand: string): Promise<BrandKitRow | null> {
  const backend = getBackendUrl()
  try {
    const res = await fetch(
      `${backend}/api/brand-kits/${encodeURIComponent(brand)}`,
      { cache: 'no-store' },
    )
    if (res.status === 404) return null
    if (!res.ok) return null
    const data = (await res.json()) as { kit: BrandKitRow }
    return data.kit
  } catch {
    return null
  }
}

export default function BrandKitEditPage() {
  const params = useParams<{ brand: string }>()
  const brand = decodeURIComponent(params?.brand ?? '')
  const { t } = useTranslations()

  // `loaded` is separate from the kit value because null is a legitimate
  // result (kit doesn't exist yet → editor opens in "new kit" mode).
  const [state, setState] = useState<{ kit: BrandKitRow | null } | null>(null)

  useEffect(() => {
    if (!brand) return
    let alive = true
    setState(null)
    fetchKit(brand).then((kit) => {
      if (alive) setState({ kit })
    })
    return () => {
      alive = false
    }
  }, [brand])

  if (!state) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div>
          <Link
            href="/marketing/brand-kit"
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            {t('brandKit.backToList')}
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-slate-900 dark:text-slate-100">
            <Palette className="w-5 h-5 text-blue-500" />
            {brand}
          </h1>
        </div>
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-28 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse"
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <BrandKitEditClient
      brand={brand}
      initial={state.kit}
      apiBase={getBackendUrl()}
    />
  )
}
