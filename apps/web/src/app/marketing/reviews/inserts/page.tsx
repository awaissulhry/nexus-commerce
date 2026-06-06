/**
 * Review inserts — compliant in-box review cards.
 *
 * Generates a printable A6 card per product: brand + product name + an HONEST-
 * review request + a QR that opens the Amazon "write a review" page for that
 * ASIN. Pick a marketplace (sets the QR's Amazon site + the card language) and
 * download one PDF with a card per product, ready to print, cut, and drop in the
 * box when you pack.
 */
'use client'

import { useEffect, useState } from 'react'
import { Download, FileText, Loader2, ShieldCheck, QrCode } from 'lucide-react'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { getBackendUrl } from '../../../../lib/backend-url'

export const dynamic = 'force-dynamic'

const MARKETS: { code: string; label: string; site: string }[] = [
  { code: 'IT', label: 'Italy', site: 'amazon.it' },
  { code: 'DE', label: 'Germany', site: 'amazon.de' },
  { code: 'FR', label: 'France', site: 'amazon.fr' },
  { code: 'ES', label: 'Spain', site: 'amazon.es' },
  { code: 'NL', label: 'Netherlands', site: 'amazon.nl' },
  { code: 'UK', label: 'United Kingdom', site: 'amazon.co.uk' },
]

export default function ReviewInsertsPage() {
  const [marketplace, setMarketplace] = useState('IT')
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/review-inserts/count`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => alive && setCount(typeof d?.count === 'number' ? d.count : null))
      .catch(() => alive && setCount(null))
    return () => {
      alive = false
    }
  }, [])

  async function downloadAll() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/review-inserts/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplace }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `review-inserts-${marketplace}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setError(e?.message ?? 'Download failed')
    } finally {
      setBusy(false)
    }
  }

  const site = MARKETS.find((m) => m.code === marketplace)?.site ?? 'amazon.it'

  return (
    <div className="px-4 py-4">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">Reviews</h1>
      <ReviewsNav />

      <div className="max-w-2xl">
        <div className="flex items-center gap-2 mb-1.5">
          <QrCode className="h-5 w-5 text-blue-600" aria-hidden="true" />
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Review inserts</h2>
        </div>
        <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
          A printable card per product with a QR that opens the Amazon review page for that item. Drop one
          in the box when you pack an order — it catches buyers who ignore the email request.
        </p>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          {/* marketplace */}
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">
            Marketplace
          </label>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
            Sets the QR’s Amazon site and the card’s language.
          </p>
          <div className="flex flex-wrap gap-2 mb-4">
            {MARKETS.map((m) => (
              <button
                key={m.code}
                type="button"
                onClick={() => setMarketplace(m.code)}
                aria-pressed={marketplace === m.code}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  marketplace === m.code
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-blue-300'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* count + action */}
          <div className="flex items-center justify-between gap-3 rounded-md bg-slate-50 dark:bg-slate-800/50 px-3 py-2.5 mb-3">
            <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <FileText className="h-4 w-4 text-slate-400" aria-hidden="true" />
              {count === null ? (
                'Counting products…'
              ) : (
                <span>
                  <strong className="text-slate-900 dark:text-slate-100">{count}</strong> product
                  {count === 1 ? '' : 's'} with an ASIN → <strong>{count}</strong> card
                  {count === 1 ? '' : 's'}, QRs pointing at <strong>{site}</strong>
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={downloadAll}
              disabled={busy || count === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Download PDF
            </button>
          </div>

          {error && <p className="text-sm text-red-600 dark:text-red-400 mb-2">{error}</p>}

          {/* compliance */}
          <div className="flex gap-2 rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2.5">
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" aria-hidden="true" />
            <div className="text-xs text-emerald-800 dark:text-emerald-300">
              <p className="font-medium mb-0.5">Amazon-compliant by design</p>
              The card asks only for an <strong>honest</strong> review — no incentive, no “positive reviews
              only”, and no “contact us instead of leaving a bad review” (review gating is prohibited). A QR
              to Amazon’s own review page is allowed.
            </div>
          </div>
        </div>

        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
          Tip: inserts are easiest with FBM orders you pack yourself. For FBA, include them when you send
          inventory in. Typical lift is +0.5–1.5 percentage points on top of your email/solicitation asks.
        </p>
      </div>
    </div>
  )
}
