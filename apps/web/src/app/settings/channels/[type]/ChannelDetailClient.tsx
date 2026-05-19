'use client'

/**
 * Settings rebuild — Phase F.5
 *
 * /settings/channels/[type] — per-channel deep view. Four cards:
 *
 *   1. Token & connection health — token-expiry countdown (relative
 *      under 24h, absolute past), last sync status, scopes granted
 *      (when the OAuth callback captured them).
 *   2. Per-marketplace toggle grid — IT / DE / FR / ES / UK for the
 *      EU channels; "Marketplaces don't apply" for single-store
 *      connectors (Shopify).
 *   3. Recent webhook events — last 50 inbound deliveries with
 *      success / pending / failed pills and the error message.
 *   4. Reconnect / advanced — link back to the listing-channel
 *      OAuth start URL, raw connectionMetadata for diagnostics.
 *
 * Reads from the Phase F.2 detail endpoint; writes through the
 * Phase F.3 marketplace-scope endpoint. Reuses the SaveBar from
 * Phase A for the marketplace toggle (the scope can stay dirty
 * across other interactions).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Globe,
  Inbox,
  KeyRound,
  Plug,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { useSettingsForm } from '../../_shell/SettingsSaveBar'

export interface ChannelConnection {
  id: string
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'
  isActive: boolean
  isManagedBy: 'oauth' | 'env' | 'pending'
  sellerName: string | null
  storeName: string | null
  storeFrontUrl: string | null
  tokenExpiresAt: string | null
  lastSyncAt: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
  createdAt: string
  updatedAt: string
}

export interface RecentEvent {
  id: string
  eventType: string
  externalId: string
  isProcessed: boolean
  processedAt: string | null
  error: string | null
  createdAt: string
}

export interface ChannelDetail {
  connection: ChannelConnection
  scopes: string[]
  activeMarketplaces: string[]
  meta: Record<string, unknown> | null
  recentEvents: RecentEvent[]
  eventStats: {
    total: number
    success: number
    failed: number
    pending: number
  }
}

const CHANNEL_LABEL: Record<string, string> = {
  amazon: 'Amazon',
  ebay: 'eBay',
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  etsy: 'Etsy',
}

// Mirrors the API's ALLOWED_MARKETPLACES — duplicated here so the
// UI can render the toggle grid without a round-trip. Drift would
// be caught the moment a non-allowed value is sent; the server
// returns 400 with the allowed list.
const ALLOWED_MARKETPLACES_BY_CHANNEL: Record<string, string[]> = {
  amazon: ['IT', 'DE', 'FR', 'ES', 'UK'],
  ebay: ['IT', 'DE', 'FR', 'ES', 'UK'],
  shopify: [],
  woocommerce: [],
  etsy: [],
}

const COUNTRY_NAMES: Record<string, string> = {
  IT: 'Italy',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  UK: 'United Kingdom',
}

interface Props {
  channelType: string
  initial: ChannelDetail | null
  initialError: string | null
}

export default function ChannelDetailClient({
  channelType,
  initial,
  initialError,
}: Props) {
  const router = useRouter()
  const [detail, setDetail] = useState<ChannelDetail | null>(initial)
  const [error, setError] = useState<string | null>(initialError)
  const [draftMarkets, setDraftMarkets] = useState<string[]>(
    initial?.activeMarketplaces ?? [],
  )
  useEffect(() => {
    setDraftMarkets(detail?.activeMarketplaces ?? [])
  }, [detail?.activeMarketplaces])

  const allowed = ALLOWED_MARKETPLACES_BY_CHANNEL[channelType] ?? []

  const isDirty = useMemo(() => {
    const saved = detail?.activeMarketplaces ?? []
    if (saved.length !== draftMarkets.length) return true
    const set = new Set(saved)
    return !draftMarkets.every((m) => set.has(m))
  }, [detail?.activeMarketplaces, draftMarkets])

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/channels/${channelType}/detail`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setDetail((await res.json()) as ChannelDetail)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [channelType])

  const onSave = useCallback(async () => {
    const res = await fetch(
      `${getBackendUrl()}/api/settings/channels/${channelType}/marketplaces`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplaces: draftMarkets }),
      },
    )
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error ?? `HTTP ${res.status}`)
    }
    await refetch()
    router.refresh()
  }, [draftMarkets, channelType, refetch, router])

  const onDiscard = useCallback(() => {
    setDraftMarkets(detail?.activeMarketplaces ?? [])
  }, [detail?.activeMarketplaces])

  useSettingsForm({
    id: `settings/channels/${channelType}`,
    isDirty,
    onSave,
    onDiscard,
  })

  if (!detail) {
    return (
      <div className="max-w-3xl space-y-4">
        <BackLink />
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5" />
          {error ?? 'Unable to load channel detail.'}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-6">
      <BackLink />
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <ConnectionHeader detail={detail} channelType={channelType} />
      <TokenHealthCard detail={detail} />
      <ScopesCard scopes={detail.scopes} />
      <MarketplacesCard
        channelType={channelType}
        allowed={allowed}
        draftMarkets={draftMarkets}
        setDraftMarkets={setDraftMarkets}
      />
      <RecentEventsCard
        events={detail.recentEvents}
        stats={detail.eventStats}
      />
      <AdvancedCard meta={detail.meta} />
    </div>
  )
}

function BackLink() {
  return (
    <Link
      href="/settings/channels"
      className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
    >
      <ArrowLeft size={13} /> All channels
    </Link>
  )
}

// ─── Cards ────────────────────────────────────────────────────────

function ConnectionHeader({
  detail,
  channelType,
}: {
  detail: ChannelDetail
  channelType: string
}) {
  const { connection } = detail
  const label = CHANNEL_LABEL[channelType] ?? channelType
  const tone = connection.isActive
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-10 h-10 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
          <Plug size={18} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {label}
          </h2>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {connection.sellerName ??
              connection.storeName ??
              (connection.isManagedBy === 'env' ? 'Env-managed' : '—')}
          </div>
        </div>
      </div>
      <span
        className={cn(
          'inline-flex items-center gap-1 h-6 px-2 rounded-full text-xs font-semibold uppercase tracking-wide',
          tone,
        )}
      >
        {connection.isActive ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
        {connection.isActive ? 'Active' : 'Inactive'}
      </span>
    </div>
  )
}

function relativeTime(iso: string): { text: string; tone: 'ok' | 'warn' | 'danger' } {
  const target = new Date(iso).getTime()
  const now = Date.now()
  const deltaMs = target - now
  const absMs = Math.abs(deltaMs)
  const absMin = Math.floor(absMs / 60_000)
  const absHr = Math.floor(absMs / 3_600_000)
  const absDay = Math.floor(absMs / 86_400_000)
  if (absDay >= 1) {
    const formatted = new Date(iso).toLocaleString()
    return { text: formatted, tone: deltaMs >= 0 ? 'ok' : 'danger' }
  }
  let text: string
  if (deltaMs >= 0) {
    if (absMin < 1) text = 'in < 1m'
    else if (absHr < 1) text = `in ${absMin}m`
    else text = `in ${absHr}h ${absMin % 60}m`
  } else {
    if (absMin < 1) text = 'just now'
    else if (absHr < 1) text = `${absMin}m ago`
    else text = `${absHr}h ${absMin % 60}m ago`
  }
  let tone: 'ok' | 'warn' | 'danger' = 'ok'
  if (deltaMs < 0) tone = 'danger'
  else if (absMin < 5) tone = 'danger'
  else if (absMin < 60) tone = 'warn'
  return { text, tone }
}

const TONE_PILL: Record<'ok' | 'warn' | 'danger', string> = {
  ok: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  warn: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  danger: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
}

function TokenHealthCard({ detail }: { detail: ChannelDetail }) {
  const { connection } = detail
  const expiry = connection.tokenExpiresAt
    ? relativeTime(connection.tokenExpiresAt)
    : null
  const lastSync = connection.lastSyncAt
    ? relativeTime(connection.lastSyncAt)
    : null
  const syncTone =
    connection.lastSyncStatus === 'SUCCESS'
      ? 'ok'
      : connection.lastSyncStatus === 'PARTIAL'
        ? 'warn'
        : connection.lastSyncStatus === 'FAILED'
          ? 'danger'
          : 'warn'
  return (
    <Card title="Token & sync health" icon={<ShieldCheck size={14} />}>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <Stat label="Token expires">
          {expiry ? (
            <span className={cn('font-mono text-xs px-2 py-0.5 rounded', TONE_PILL[expiry.tone])}>
              {expiry.text}
            </span>
          ) : connection.isManagedBy === 'env' ? (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Env-managed (no token rotation)
            </span>
          ) : (
            <span className="text-xs text-slate-500 dark:text-slate-400">—</span>
          )}
        </Stat>
        <Stat label="Last sync">
          {lastSync ? (
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide',
                  TONE_PILL[syncTone],
                )}
              >
                {connection.lastSyncStatus ?? '—'}
              </span>
              <span className="text-xs text-slate-600 dark:text-slate-400">
                {lastSync.text}
              </span>
            </div>
          ) : (
            <span className="text-xs text-slate-500 dark:text-slate-400">never</span>
          )}
        </Stat>
        <Stat label="Connected since">
          <span className="text-xs text-slate-700 dark:text-slate-300">
            {new Date(connection.createdAt).toLocaleDateString()}
          </span>
        </Stat>
        <Stat label="Managed by">
          <span className="text-xs font-mono text-slate-700 dark:text-slate-300 uppercase">
            {connection.isManagedBy}
          </span>
        </Stat>
      </dl>
      {connection.lastSyncError && (
        <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300 inline-flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span className="font-mono">{connection.lastSyncError}</span>
        </div>
      )}
    </Card>
  )
}

function ScopesCard({ scopes }: { scopes: string[] }) {
  return (
    <Card
      title="OAuth scopes"
      icon={<KeyRound size={14} />}
      description={
        scopes.length > 0
          ? undefined
          : 'No scopes captured. The OAuth callback writes them to connectionMetadata.scopes when granted — Amazon SP-API v2 and eBay sign-in both expose this; older grants may need a reconnect to populate.'
      }
    >
      {scopes.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5">
          {scopes.map((s) => (
            <li
              key={s}
              className="inline-flex items-center h-6 px-2 rounded-full text-xs font-mono bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function MarketplacesCard({
  channelType,
  allowed,
  draftMarkets,
  setDraftMarkets,
}: {
  channelType: string
  allowed: string[]
  draftMarkets: string[]
  setDraftMarkets: (next: string[]) => void
}) {
  if (allowed.length === 0) {
    return (
      <Card title="Marketplaces" icon={<Globe size={14} />}>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {CHANNEL_LABEL[channelType] ?? channelType} is a single-store
          channel — there are no marketplaces to scope.
        </p>
      </Card>
    )
  }
  const toggle = (m: string) =>
    draftMarkets.includes(m)
      ? setDraftMarkets(draftMarkets.filter((x) => x !== m))
      : setDraftMarkets([...draftMarkets, m].sort())
  const noneOn = draftMarkets.length === 0
  return (
    <Card
      title="Marketplaces"
      icon={<Globe size={14} />}
      description={
        noneOn
          ? 'No marketplaces selected — defaults to ALL when empty. Pick specific markets to scope syncs + listings.'
          : `Syncs + listings scoped to ${draftMarkets.length} marketplace${draftMarkets.length === 1 ? '' : 's'}.`
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {allowed.map((m) => {
          const on = draftMarkets.includes(m)
          return (
            <button
              key={m}
              type="button"
              onClick={() => toggle(m)}
              className={cn(
                'flex flex-col items-center gap-1 py-2 rounded-md border text-sm transition-colors',
                on
                  ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-300'
                  : 'bg-white border-slate-200 text-slate-600 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-400 hover:border-slate-300',
              )}
              aria-pressed={on}
            >
              <span className="font-mono text-base font-semibold">{m}</span>
              <span className="text-xs">{COUNTRY_NAMES[m]}</span>
            </button>
          )
        })}
      </div>
    </Card>
  )
}

function RecentEventsCard({
  events,
  stats,
}: {
  events: RecentEvent[]
  stats: { total: number; success: number; failed: number; pending: number }
}) {
  return (
    <Card
      title="Recent webhook events"
      icon={<Inbox size={14} />}
      description="Last 50 inbound deliveries from the channel."
    >
      <div className="flex items-center gap-2 mb-3 text-xs">
        <Pill tone="ok">{stats.success} ok</Pill>
        {stats.failed > 0 && <Pill tone="danger">{stats.failed} failed</Pill>}
        {stats.pending > 0 && <Pill tone="warn">{stats.pending} pending</Pill>}
        <span className="text-slate-400 dark:text-slate-500">
          · {stats.total} total
        </span>
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">
          No inbound webhook events yet.
        </p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <tr>
                <th className="text-left px-2 py-1 font-medium">Type</th>
                <th className="text-left px-2 py-1 font-medium">External ID</th>
                <th className="text-left px-2 py-1 font-medium">Status</th>
                <th className="text-left px-2 py-1 font-medium">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {events.map((e) => {
                const tone: 'ok' | 'warn' | 'danger' = e.error
                  ? 'danger'
                  : e.isProcessed
                    ? 'ok'
                    : 'warn'
                return (
                  <tr key={e.id}>
                    <td className="px-2 py-1.5 font-mono text-xs text-slate-700 dark:text-slate-300">
                      {e.eventType}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-xs text-slate-500 dark:text-slate-400 truncate max-w-[160px]" title={e.externalId}>
                      {e.externalId}
                    </td>
                    <td className="px-2 py-1.5">
                      <span
                        className={cn(
                          'inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide',
                          TONE_PILL[tone],
                        )}
                      >
                        {e.error ? 'failed' : e.isProcessed ? 'ok' : 'pending'}
                      </span>
                      {e.error && (
                        <div
                          className="text-xs text-rose-600 dark:text-rose-400 mt-0.5 truncate max-w-xs"
                          title={e.error}
                        >
                          {e.error}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function AdvancedCard({ meta }: { meta: Record<string, unknown> | null }) {
  if (!meta || Object.keys(meta).length === 0) return null
  return (
    <details className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <summary className="px-5 py-3 cursor-pointer flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 [&::-webkit-details-marker]:hidden">
        <Activity size={14} className="text-slate-400 dark:text-slate-500" />
        Advanced — raw connection metadata
        <ChevronDown size={14} className="ml-auto text-slate-400 dark:text-slate-500" />
      </summary>
      <pre className="px-5 pb-4 text-xs font-mono text-slate-700 dark:text-slate-300 overflow-x-auto">
        {JSON.stringify(meta, null, 2)}
      </pre>
    </details>
  )
}

// ─── shared ───────────────────────────────────────────────────────

function Card({
  title,
  description,
  icon,
  children,
}: {
  title: string
  description?: string
  icon?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
      <div className="flex items-start gap-3 mb-4 pb-3 border-b border-slate-100 dark:border-slate-800">
        {icon && (
          <div className="shrink-0 w-8 h-8 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
            {icon}
          </div>
        )}
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h3>
          {description && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {description}
            </p>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}

function Stat({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium mb-1">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  )
}

function Pill({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'danger'
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide',
        TONE_PILL[tone],
      )}
    >
      {children}
    </span>
  )
}

// ChevronRight kept around for a follow-up "edit scopes" affordance.
void ChevronRight
