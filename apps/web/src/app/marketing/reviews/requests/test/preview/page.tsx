'use client'

/**
 * RV.9.6 — Email-preview iframe endpoint.
 *
 * Renders the localized sentiment-check email HTML by proxying to the
 * API's preview action. The dashboard TestModeClient embeds this in
 * an iframe so the operator can flip locales and see the output.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so the HTML MUST be fetched client-side
 * where the fetch patch adds credentials. Server-side this page 401'd into
 * "Preview failed: HTTP 401" for everyone.
 */

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'

type Locale = 'it' | 'de' | 'fr' | 'es' | 'en'

async function fetchHtml(locale: Locale, productName: string): Promise<string> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/reviews/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'preview-html', locale, productName }),
      cache: 'no-store',
    })
    if (!res.ok) return `<p style="font-family: monospace; color: #c00; padding: 16px;">Preview failed: HTTP ${res.status}</p>`
    return await res.text()
  } catch (err) {
    return `<p style="font-family: monospace; color: #c00; padding: 16px;">Preview error: ${err instanceof Error ? err.message : 'unknown'}</p>`
  }
}

function PreviewInner() {
  const searchParams = useSearchParams()
  const locale = searchParams?.get('locale') ?? undefined
  const productName = searchParams?.get('productName') ?? undefined
  const l: Locale = (['it', 'de', 'fr', 'es', 'en'] as Locale[]).includes((locale ?? 'it') as Locale)
    ? ((locale ?? 'it') as Locale)
    : 'it'
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchHtml(l, productName ?? 'Casco Xavia Carbon').then((h) => {
      if (alive) setHtml(h)
    })
    return () => { alive = false }
  }, [l, productName])

  if (html === null) {
    return <p style={{ fontFamily: 'monospace', color: '#64748b', padding: 16 }}>Loading preview…</p>
  }
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}

export default function PreviewPage() {
  return (
    <Suspense fallback={<p style={{ fontFamily: 'monospace', color: '#64748b', padding: 16 }}>Loading preview…</p>}>
      <PreviewInner />
    </Suspense>
  )
}
