'use client'

// S.5 — Path B Amazon deep view.
//
// Wraps ListingsWorkspace with Amazon-specific overlay: marketplace
// tabs (IT/DE/FR/UK/ES/NL/PL/SE/US), KPI strip with FBA economics +
// suppression count + parent ASIN count, and a SuppressionResolver
// panel for active suppressions.
//
// The composition pattern keeps every workspace investment (grid,
// matrix, drafts, drawer with tabs, bulk bar) intact — Amazon depth
// renders ABOVE it. The drawer's Detail tab also picks up an Amazon
// section when channel='AMAZON' (see AmazonContextSection in
// ListingsWorkspace).

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import ListingsWorkspace from '../ListingsWorkspace'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tabs } from '@/components/ui/Tabs'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

// Amazon's seeded marketplaces, ordered so EU (Awa's primary) renders
// left-to-right. US/CA/MX/BR/AU/JP get appended on the right when
// usage data confirms them; for now we surface Amazon EU + US.
const AMAZON_MARKETS = ['IT', 'DE', 'FR', 'UK', 'ES', 'NL', 'PL', 'SE', 'US']

interface AmazonOverview {
  marketplace: string | null
  counts: { total: number; live: number; draft: number; error: number; suppressed: number }
  fbaEconomics: { avgFbaFee: number | null; avgReferralPct: number | null; coverage: number }
  parentAsinCount: number
  pricingIntelligence: { listingsWithCompetitor: number; losingOnPrice: number }
  marketplaceBreakdown: Array<{ marketplace: string; count: number }>
  activeSuppressions: Array<{
    id: string
    listingId: string
    suppressedAt: string
    reasonCode: string | null
    reasonText: string
    severity: string
    source: string
    listing: {
      id: string
      marketplace: string
      externalListingId: string | null
      listingStatus: string
      product: { id: string; sku: string; name: string }
    }
  }>
}

interface Props {
  /** When set, locks to a specific Amazon marketplace (per-market route). */
  lockMarketplace?: string
  breadcrumbs?: Array<{ label: string; href?: string }>
}

export default function AmazonListingsClient({ lockMarketplace, breadcrumbs }: Props) {
  // The active marketplace tab. When the route is /listings/amazon (no
  // [market]), this is local state. When it's /listings/amazon/[market]
  // (lockMarketplace set), the tab is fixed.
  const [activeMarket, setActiveMarket] = useState<string>(lockMarketplace ?? 'IT')

  const overviewUrl = useMemo(
    () => `/api/listings/amazon/overview?marketplace=${activeMarket}`,
    [activeMarket],
  )
  const { data: overview, loading } = usePolledList<AmazonOverview>({
    url: overviewUrl,
    intervalMs: 30_000,
    invalidationTypes: [
      'listing.updated',
      'listing.created',
      'listing.deleted',
      'bulk-job.completed',
      'wizard.submitted',
    ],
  })

  // Marketplace tab counts come from the marketplaceBreakdown which
  // is unfiltered (intentional — the strip shows all-Amazon counts).
  const marketCount = (mp: string): number =>
    overview?.marketplaceBreakdown.find((b) => b.marketplace === mp)?.count ?? 0

  const tabs = useMemo(
    () =>
      AMAZON_MARKETS.map((mp) => ({
        id: mp,
        label: (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-xs">{mp}</span>
            <span className="text-xs text-slate-400">{COUNTRY_NAMES[mp] ?? mp}</span>
          </span>
        ),
        count: marketCount(mp) || undefined,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overview?.marketplaceBreakdown],
  )

  return (
    <div className="space-y-4">
      {/* Marketplace tab strip — only when route is /listings/amazon
          (not /listings/amazon/[market]); locked routes already encode
          the choice in the URL and we don't want users hopping out. */}
      {!lockMarketplace && (
        <Tabs
          tabs={tabs}
          activeTab={activeMarket}
          onChange={(mp) => setActiveMarket(mp)}
          className="bg-white border-b-0"
        />
      )}

      {/* KPI strip — Amazon-specific overview metrics */}
      <AmazonKpiStrip overview={overview} loading={loading} />

      {/* Suppression resolver — only shown when there are active suppressions */}
      {overview && overview.activeSuppressions.length > 0 && (
        <SuppressionResolver suppressions={overview.activeSuppressions} />
      )}

      {/* The proven workspace renders below — grid / health / matrix /
          drafts lenses, drawer, bulk bar all unchanged. lockChannel +
          lockMarketplace are wired so it filters to the active market. */}
      <ListingsWorkspace
        lockChannel="AMAZON"
        lockMarketplace={activeMarket}
        breadcrumbs={breadcrumbs}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// AmazonKpiStrip — KPI tiles using Amazon-specific aggregates
// ────────────────────────────────────────────────────────────────────

function AmazonKpiStrip({
  overview,
  loading,
}: {
  overview: AmazonOverview | null
  loading: boolean
}) {
  if (loading && !overview) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}><Skeleton variant="text" lines={2} /></Card>
        ))}
      </div>
    )
  }
  if (!overview) return null

  const { counts, fbaEconomics, parentAsinCount, pricingIntelligence } = overview

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <KpiTile
        label="Live"
        value={counts.live}
        sub={`${counts.total} total`}
        tone="success"
      />
      <KpiTile
        label="Suppressed"
        value={counts.suppressed}
        sub={counts.suppressed === 0 ? 'all clear' : 'needs review'}
        tone={counts.suppressed === 0 ? 'default' : 'danger'}
      />
      <KpiTile
        label="Avg FBA fee"
        value={fbaEconomics.avgFbaFee != null ? `€${fbaEconomics.avgFbaFee.toFixed(2)}` : '—'}
        sub={
          fbaEconomics.avgReferralPct != null
            ? `${fbaEconomics.avgReferralPct.toFixed(1)}% referral`
            : 'pending fee fetch'
        }
        tone="default"
      />
      <KpiTile
        label="Parent ASINs"
        value={parentAsinCount}
        sub="distinct"
        tone="default"
      />
      <KpiTile
        label="Buy Box risk"
        value={
          pricingIntelligence.listingsWithCompetitor === 0
            ? '—'
            : `${pricingIntelligence.losingOnPrice}/${pricingIntelligence.listingsWithCompetitor}`
        }
        sub="losing on price"
        tone={pricingIntelligence.losingOnPrice > 0 ? 'warning' : 'default'}
      />
    </div>
  )
}

function KpiTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string | number
  sub?: string
  tone: 'default' | 'success' | 'warning' | 'danger'
}) {
  const toneClass =
    tone === 'success' ? 'text-emerald-700'
    : tone === 'warning' ? 'text-amber-700'
    : tone === 'danger' ? 'text-rose-700'
    : 'text-slate-900'
  return (
    <Card>
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1">{label}</div>
      <div className={`text-[24px] font-semibold tabular-nums leading-none ${toneClass}`}>
        {value}
      </div>
      {sub && <div className="text-sm text-slate-500 mt-1">{sub}</div>}
    </Card>
  )
}

// ────────────────────────────────────────────────────────────────────
// SuppressionResolver — list active suppressions with per-row actions
// ────────────────────────────────────────────────────────────────────

function SuppressionResolver({
  suppressions,
}: {
  suppressions: AmazonOverview['activeSuppressions']
}) {
  const { toast } = useToast()
  const [resolving, setResolving] = useState<Set<string>>(new Set())

  const resolve = async (suppressionId: string) => {
    setResolving((p) => new Set(p).add(suppressionId))
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listings/amazon/suppressions/${suppressionId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolved: true, restoreStatus: 'ACTIVE' }),
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success('Suppression marked resolved')
      emitInvalidation({ type: 'listing.updated' })
    } catch (e: any) {
      toast.error(`Resolve failed: ${e?.message ?? String(e)}`)
    } finally {
      setResolving((p) => {
        const next = new Set(p)
        next.delete(suppressionId)
        return next
      })
    }
  }

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <AlertTriangle size={14} className="text-rose-600" />
          Active suppressions ({suppressions.length})
        </span>
      }
      description="Listings hidden from buyers until the underlying issue is resolved."
    >
      <div className="space-y-2">
        {suppressions.map((s) => (
          <div
            key={s.id}
            className="border border-rose-200 bg-rose-50/40 rounded-md p-3 flex items-start justify-between gap-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-semibold bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
                  {s.listing.marketplace}
                </span>
                <span className="text-md font-medium text-slate-900 truncate">
                  {s.listing.product.name}
                </span>
                <span className="text-sm text-slate-500 font-mono">{s.listing.product.sku}</span>
                {s.listing.externalListingId && (
                  <span className="text-xs text-slate-400 font-mono">
                    ASIN {s.listing.externalListingId}
                  </span>
                )}
              </div>
              <div className="mt-1.5 text-base text-rose-700">
                {s.reasonCode && <span className="font-mono mr-1">[{s.reasonCode}]</span>}
                {s.reasonText}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Suppressed {new Date(s.suppressedAt).toLocaleString()} · source: {s.source}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 flex-shrink-0">
              <Link
                href={`/products/${s.listing.product.id}/edit?channel=AMAZON&marketplace=${s.listing.marketplace}`}
                className="h-7 px-2.5 text-sm bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                Open in editor
              </Link>
              <button
                onClick={() => resolve(s.id)}
                disabled={resolving.has(s.id)}
                className="h-7 px-2.5 text-sm bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <CheckCircle2 size={11} /> Mark resolved
              </button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ────────────────────────────────────────────────────────────────────
// SuppressionLogModal — operator-facing modal to log a manual
// suppression record before SP-API auto-detection (S.5b) lands.
// Exported so the drawer Amazon section can trigger it.
// ────────────────────────────────────────────────────────────────────

export function SuppressionLogModal({
  open,
  onClose,
  listingId,
  listingLabel,
  onLogged,
}: {
  open: boolean
  onClose: () => void
  listingId: string
  listingLabel: string
  onLogged?: () => void
}) {
  const { toast } = useToast()
  const [reasonText, setReasonText] = useState('')
  const [reasonCode, setReasonCode] = useState('')
  const [severity, setSeverity] = useState<'ERROR' | 'WARNING' | 'INFO'>('ERROR')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (!reasonText.trim()) {
      toast.error('Reason text is required')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/amazon/suppressions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listingId,
          reasonText: reasonText.trim(),
          reasonCode: reasonCode.trim() || undefined,
          severity,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error ?? `HTTP ${res.status}`)
      }
      toast.success('Suppression logged')
      onLogged?.()
      onClose()
    } catch (e: any) {
      toast.error(`Log failed: ${e?.message ?? String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Log suppression"
      description={listingLabel}
      size="md"
    >
      <ModalBody>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Reason text <span className="text-rose-600">*</span>
            </label>
            <Input
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder="e.g. Missing required CE safety warning"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                Reason code <span className="text-slate-400 font-normal">(SP-API)</span>
              </label>
              <Input
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
                placeholder="MISSING_SAFETY_WARNING"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">Severity</label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as any)}
                className="h-9 w-full px-2 text-base border border-slate-200 rounded text-slate-700"
              >
                <option value="ERROR">ERROR</option>
                <option value="WARNING">WARNING</option>
                <option value="INFO">INFO</option>
              </select>
            </div>
          </div>
          <div className="text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-md p-2.5">
            Logging a suppression sets the listing's status to <code>SUPPRESSED</code> and
            opens an audit episode. SP-API auto-detection comes in S.5b — until then, this
            is the manual entry point.
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          onClick={onClose}
          disabled={submitting}
          className="h-8 px-3 text-base text-slate-700 border border-slate-200 rounded hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={submitting || !reasonText.trim()}
          className="h-8 px-3 text-base bg-rose-600 text-white rounded hover:bg-rose-700 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <AlertTriangle size={12} /> {submitting ? 'Logging…' : 'Log suppression'}
        </button>
      </ModalFooter>
    </Modal>
  )
}
