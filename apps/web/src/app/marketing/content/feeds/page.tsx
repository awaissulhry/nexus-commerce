'use client'

/**
 * ACR.6 (R11) — Cross-RMN feeds, moved out of the ads tree.
 *
 * Google Merchant Center and Meta Product Catalog exports. This lived at
 * `/marketing/advertising/feeds` purely by accident of where it was first written: it has nothing
 * to do with Amazon advertising, reads no ads data, and calls `/api/feed-export/*`. Stage 6 retires
 * that tree, and the operator placed it here — Content already owns what the catalogue says about
 * each product, and a channel feed is that content leaving the building.
 *
 * A tab on Content, not a sidebar entry.
 *
 * CHANGED IN THE MOVE: the preview now loads client-side. The legacy page server-fetched it, and
 * the API session cookie lives on the API origin — the Next server cannot present it, so the fetch
 * would 401 and the page silently rendered "no summary yet" rather than the counts. The same trap
 * is documented on every other page in this directory; it is fixed here rather than carried over.
 */
import { useCallback, useEffect, useState } from 'react'
import { Rss, Download, Loader2, RefreshCw, AlertTriangle } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { getBackendUrl } from '@/lib/backend-url'

interface FeedSummary { total: number; inStock: number; outOfStock: number; generatedAt: string }
interface Preview { gmc: { summary: FeedSummary }; meta: { summary: FeedSummary } }

export default function FeedsPage() {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [regenerated, setRegenerated] = useState<{ gmc: FeedSummary; meta: FeedSummary } | null>(null)

  const load = useCallback(() => {
    setError(null)
    fetch(`${getBackendUrl()}/api/feed-export/preview`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((j) => setPreview(j as Preview))
      .catch((e) => setError((e as Error).message))
  }, [])
  useEffect(() => { load() }, [load])

  const regenerate = async () => {
    setBusy(true); setRegenerated(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/feed-export/trigger`, { method: 'POST' })
      const j = await r.json().catch(() => null)
      if (r.ok && j) { setRegenerated(j as { gmc: FeedSummary; meta: FeedSummary }); load() }
      else setError('Regeneration failed.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const backend = getBackendUrl()

  return (
    <div className="space-y-4">
      <PageHeader
        title="Cross-RMN Feeds"
        description="Google Merchant Center and Meta Product Catalog exports. Channel transform rules are applied at export time, and out-of-stock products are shipped as unavailable rather than dropped — so Google and Meta pause their own bids instead of losing the listing history."
      />

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>Could not load the feed summary ({error}). The download links below still work — they generate on request.</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FeedCard
          title="Google Merchant Center"
          subtitle="RSS/XML feed for Google Shopping"
          format="GMC XML"
          href={`${backend}/api/feed-export/gmc.xml`}
          downloadLabel="Download GMC XML"
          summary={preview?.gmc.summary ?? null}
        />
        <FeedCard
          title="Meta Product Catalog"
          subtitle="JSON feed for Facebook & Instagram Shopping"
          format="Meta JSON"
          href={`${backend}/api/feed-export/meta.json`}
          downloadLabel="Download Meta JSON"
          summary={preview?.meta.summary ?? null}
        />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => void regenerate()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-violet-300 dark:ring-violet-700 bg-white dark:bg-slate-900 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/40 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          Regenerate feeds
        </button>
        {regenerated && (
          <span className="text-xs text-slate-600 dark:text-slate-400">
            GMC {regenerated.gmc.total} products ({regenerated.gmc.inStock} in stock, {regenerated.gmc.outOfStock} unavailable) ·
            Meta {regenerated.meta.total} products ({regenerated.meta.inStock} in stock, {regenerated.meta.outOfStock} unavailable)
          </span>
        )}
      </div>

      <section>
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">How feeds are generated</h2>
        <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md px-4 py-3 text-sm text-slate-600 dark:text-slate-400 space-y-2">
          <Step n={1} label="Transform">
            Channel transform rules run per product, so the title, description and custom labels are the
            channel-optimised versions rather than the Amazon ones.
          </Step>
          <Step n={2} label="Suppress">
            Products with <Code>totalStock ≤ 0</Code> are still included, marked{' '}
            <Code>availability=out_of_stock</Code>. Removing them instead would reset the listing&rsquo;s history
            on each channel every time stock ran out.
          </Step>
          <Step n={3} label="Export">
            The feed is built fresh on each request; a daily cron logs the summary. Point Merchant Center and
            Meta Catalog at the <Code>/api/feed-export/</Code> endpoints and they fetch on their own schedule.
          </Step>
        </div>
      </section>

      <section>
        <div className="bg-slate-50 dark:bg-slate-950/40 border border-default dark:border-slate-800 rounded-md px-4 py-3 text-xs text-slate-600 dark:text-slate-400">
          <div className="flex items-start gap-2 flex-wrap">
            <Code>NEXUS_FEED_EXPORT_SCHEDULE=0 6 * * *</Code>
            <span>Overrides the daily generation cron schedule.</span>
          </div>
        </div>
      </section>
    </div>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">{children}</code>
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="font-mono text-violet-600 dark:text-violet-400 text-xs mt-0.5">{n}</span>
      <span><strong className="text-slate-900 dark:text-slate-100">{label}</strong> — {children}</span>
    </div>
  )
}

function FeedCard({
  title, subtitle, format, href, downloadLabel, summary,
}: {
  title: string; subtitle: string; format: string; href: string; downloadLabel: string
  summary: FeedSummary | null
}) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md p-4">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
            <Rss className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden="true" />
            {title}
          </h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{subtitle}</p>
        </div>
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700 font-medium">
          {format}
        </span>
      </div>

      {summary ? (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <Stat label="Total" value={summary.total} />
          <Stat label="In stock" value={summary.inStock} tone="emerald" />
          <Stat label="Unavailable" value={summary.outOfStock} tone="amber" />
        </div>
      ) : (
        <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">Counting products…</div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {downloadLabel}
        </a>
        {summary?.generatedAt && (
          <span className="text-[10px] text-slate-500 dark:text-slate-400">
            {new Date(summary.generatedAt).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'emerald' | 'amber' }) {
  const cls = tone === 'emerald'
    ? 'text-emerald-700 dark:text-emerald-400'
    : tone === 'amber'
      ? 'text-amber-700 dark:text-amber-400'
      : 'text-slate-900 dark:text-slate-100'
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-600 dark:text-slate-400">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${cls}`}>{value.toLocaleString('en-IE')}</div>
    </div>
  )
}
