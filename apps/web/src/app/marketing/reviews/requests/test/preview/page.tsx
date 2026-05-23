/**
 * RV.9.6 — Email-preview iframe endpoint.
 *
 * Renders the localized sentiment-check email HTML by proxying to the
 * API's preview action. The dashboard TestModeClient embeds this in
 * an iframe so the operator can flip locales and see the output.
 */

import { getBackendUrl } from '@/lib/backend-url'

type Locale = 'it' | 'de' | 'fr' | 'es' | 'en'

interface PageProps {
  searchParams: Promise<{ locale?: string; productName?: string }>
}

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

export default async function PreviewPage({ searchParams }: PageProps) {
  const { locale, productName } = await searchParams
  const l: Locale = (['it', 'de', 'fr', 'es', 'en'] as Locale[]).includes((locale ?? 'it') as Locale)
    ? ((locale ?? 'it') as Locale)
    : 'it'
  const html = await fetchHtml(l, productName ?? 'Casco Xavia Carbon')

  return <div dangerouslySetInnerHTML={{ __html: html }} />
}
