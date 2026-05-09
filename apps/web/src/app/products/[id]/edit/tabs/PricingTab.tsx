'use client'

/**
 * W2.1 — Pricing tab on /products/[id]/edit.
 *
 * Master pricing floors (basePrice / cost / minMargin / minPrice /
 * maxPrice) live on the Master Data tab. This surface owns the two
 * pricing concerns that are *additive* on top of the master price:
 *
 *   - Tier prices (Magento-parity volume + customer-group ladders).
 *     Backed by ProductTierPrice + the existing /tier-prices CRUD
 *     in tier-pricing.routes.ts. Drawer's TierPricingSection has
 *     the same logic; this tab is the canonical full-page version.
 *
 *   - Scheduled changes (status flips + price moves at a future
 *     timestamp). Backed by ScheduledProductChange + the cron
 *     worker in scheduled-changes.cron.ts. Existing
 *     ScheduleChangeModal handles the create flow; we list the
 *     PENDING / APPLIED / CANCELLED rows and let the operator
 *     cancel anything still PENDING.
 *
 * Every action persists immediately, so this tab never reports
 * dirty state to the parent. discardSignal still resets local
 * inline-form state so a user clicking Discard mid-edit doesn't see
 * a leftover half-typed tier row after the page refreshes.
 */

import dynamic from 'next/dynamic'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AlertCircle,
  Calendar,
  Check,
  Loader2,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

const ScheduleChangeModal = dynamic(
  () => import('../../../_modals/ScheduleChangeModal'),
  { ssr: false },
)

interface TierPriceRow {
  id: string
  minQty: number
  price: string
  customerGroupId: string | null
  customerGroup: { id: string; code: string; label: string } | null
  notes?: string | null
}

interface CustomerGroupOpt {
  id: string
  code: string
  label: string
  isB2b?: boolean
}

interface ScheduledChange {
  id: string
  kind: 'STATUS' | 'PRICE'
  payload: Record<string, unknown>
  scheduledFor: string
  status: 'PENDING' | 'APPLIED' | 'CANCELLED' | 'FAILED'
  createdAt: string
  appliedAt: string | null
  errorMessage: string | null
}

interface Props {
  product: any
  onDirtyChange: (count: number) => void
  discardSignal: number
}

export default function PricingTab({
  product,
  onDirtyChange,
  discardSignal,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const confirm = useConfirm()

  const basePrice =
    typeof product.basePrice === 'number'
      ? product.basePrice
      : product.basePrice != null
        ? Number(product.basePrice)
        : null

  const [tiers, setTiers] = useState<TierPriceRow[] | null>(null)
  const [groups, setGroups] = useState<CustomerGroupOpt[]>([])
  const [tiersError, setTiersError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [scheduled, setScheduled] = useState<ScheduledChange[] | null>(null)
  const [scheduledError, setScheduledError] = useState<string | null>(null)
  const [showScheduleModal, setShowScheduleModal] = useState(false)

  // This tab is non-draft. Make sure the parent's "Unsaved" badge
  // never lights up because of it. Single emit on mount is enough.
  const reportedRef = useRef(false)
  useEffect(() => {
    if (reportedRef.current) return
    reportedRef.current = true
    onDirtyChange(0)
  }, [onDirtyChange])

  const refreshTiers = useCallback(async () => {
    try {
      const [t, g] = await Promise.all([
        fetch(`${getBackendUrl()}/api/products/${product.id}/tier-prices`, {
          cache: 'no-store',
        }),
        fetch(`${getBackendUrl()}/api/customer-groups`, { cache: 'no-store' }),
      ])
      if (!t.ok) throw new Error(`tiers HTTP ${t.status}`)
      if (!g.ok) throw new Error(`groups HTTP ${g.status}`)
      const tdata = (await t.json()) as { tierPrices?: TierPriceRow[] }
      const gdata = (await g.json()) as { groups?: CustomerGroupOpt[] }
      setTiers(tdata.tierPrices ?? [])
      setGroups(gdata.groups ?? [])
      setTiersError(null)
    } catch (e: any) {
      setTiersError(e?.message ?? String(e))
    }
  }, [product.id])

  const refreshScheduled = useCallback(async () => {
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/scheduled-changes`,
        { cache: 'no-store' },
      )
      if (!r.ok) throw new Error(`scheduled HTTP ${r.status}`)
      const j = (await r.json()) as { changes?: ScheduledChange[] }
      setScheduled(j.changes ?? [])
      setScheduledError(null)
    } catch (e: any) {
      setScheduledError(e?.message ?? String(e))
    }
  }, [product.id])

  useEffect(() => {
    void refreshTiers()
    void refreshScheduled()
  }, [refreshTiers, refreshScheduled])

  // Discard: collapse the inline-add form back to closed so the
  // user starts from a clean slate after the page refreshes.
  const discardSeen = useRef(discardSignal)
  useEffect(() => {
    if (discardSignal === discardSeen.current) return
    discardSeen.current = discardSignal
    setAdding(false)
  }, [discardSignal])

  const onDeleteTier = async (tier: TierPriceRow) => {
    const ok = await confirm({
      title: t('products.edit.pricing.deleteTierTitle', {
        qty: tier.minQty,
        groupSuffix: tier.customerGroup
          ? ` (${tier.customerGroup.label})`
          : '',
      }),
      confirmLabel: t('products.edit.pricing.deleteTierConfirm'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/tier-prices/${tier.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(t('products.edit.pricing.tierDeleted'))
      void refreshTiers()
    } catch (e: any) {
      toast.error(
        t('products.edit.pricing.tierDeleteFailed', {
          error: e?.message ?? String(e),
        }),
      )
    }
  }

  const onCancelScheduled = async (change: ScheduledChange) => {
    const when = formatDateTime(change.scheduledFor)
    const ok = await confirm({
      title: t('products.edit.pricing.cancelScheduledTitle', {
        kind: change.kind,
        when,
      }),
      confirmLabel: t('products.edit.pricing.cancelScheduledConfirm'),
      tone: 'warning',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/scheduled-changes/${change.id}/cancel`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('products.edit.pricing.scheduledCancelled'))
      void refreshScheduled()
    } catch (e: any) {
      toast.error(
        t('products.edit.pricing.scheduledCancelFailed', {
          error: e?.message ?? String(e),
        }),
      )
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Master snapshot bar ─────────────────────────────── */}
      <Card noPadding>
        <div className="px-4 py-3 flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {t('products.edit.pricing.basePriceLabel')}
            </div>
            <div className="text-2xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums mt-0.5">
              {basePrice != null ? `€${basePrice.toFixed(2)}` : '—'}
            </div>
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400 max-w-md">
            {t('products.edit.pricing.basePriceHint')}
          </div>
        </div>
      </Card>

      {/* ── Tier prices ──────────────────────────────────────── */}
      <Card
        title={t('products.edit.pricing.tierTitle')}
        description={t('products.edit.pricing.tierDesc')}
        action={
          !adding ? (
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => setAdding(true)}
            >
              {t('products.edit.pricing.addTier')}
            </Button>
          ) : null
        }
      >
        {tiersError && (
          <div className="text-sm text-rose-700 dark:text-rose-300 mb-3 inline-flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            {tiersError}
          </div>
        )}

        {adding && (
          <AddTierForm
            productId={product.id}
            groups={groups}
            existingTiers={tiers ?? []}
            onCancel={() => setAdding(false)}
            onCreated={() => {
              setAdding(false)
              void refreshTiers()
            }}
          />
        )}

        {tiers === null ? (
          <div className="text-sm italic text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t('products.edit.pricing.tiersLoading')}
          </div>
        ) : tiers.length === 0 && !adding ? (
          <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-4 text-center">
            {t('products.edit.pricing.tiersEmpty', {
              base: basePrice?.toFixed(2) ?? '—',
            })}
          </div>
        ) : tiers.length > 0 ? (
          <table className="w-full text-sm border border-slate-200 dark:border-slate-800 rounded overflow-hidden mt-3">
            <thead className="bg-slate-50 dark:bg-slate-900">
              <tr className="text-left">
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.pricing.colMinQty')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.pricing.colGroup')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">
                  {t('products.edit.pricing.colPrice')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">
                  {t('products.edit.pricing.colVsBase')}
                </th>
                <th className="px-1 w-8" />
              </tr>
            </thead>
            <tbody>
              {tiers
                .slice()
                .sort((a, b) => a.minQty - b.minQty)
                .map((tier) => {
                  const priceNum = Number(tier.price)
                  const delta =
                    basePrice != null && basePrice > 0
                      ? Math.round(((priceNum - basePrice) / basePrice) * 100)
                      : null
                  return (
                    <tr
                      key={tier.id}
                      className="border-t border-slate-200 dark:border-slate-800"
                    >
                      <td className="px-3 py-2 tabular-nums">
                        {tier.minQty}+
                      </td>
                      <td className="px-3 py-2">
                        {tier.customerGroup ? (
                          <Badge mono variant="info">
                            {tier.customerGroup.label}
                          </Badge>
                        ) : (
                          <span className="text-slate-500 dark:text-slate-400 italic text-xs">
                            {t('products.edit.pricing.allCustomers')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">
                        €{priceNum.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {delta != null ? (
                          <span
                            className={cn(
                              'text-xs px-1.5 py-0.5 rounded',
                              delta < 0
                                ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40'
                                : delta > 0
                                  ? 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40'
                                  : 'text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800',
                            )}
                          >
                            {delta > 0 ? '+' : ''}
                            {delta}%
                          </span>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-600">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-1 py-1 text-right">
                        <button
                          onClick={() => void onDeleteTier(tier)}
                          aria-label={t('products.edit.pricing.deleteTierAria', {
                            qty: tier.minQty,
                          })}
                          className="p-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        ) : null}
      </Card>

      {/* ── Scheduled changes ────────────────────────────────── */}
      <Card
        title={t('products.edit.pricing.scheduledTitle')}
        description={t('products.edit.pricing.scheduledDesc')}
        action={
          <Button
            variant="primary"
            size="sm"
            icon={<Calendar className="w-3.5 h-3.5" />}
            onClick={() => setShowScheduleModal(true)}
          >
            {t('products.edit.pricing.scheduleChange')}
          </Button>
        }
      >
        {scheduledError && (
          <div className="text-sm text-rose-700 dark:text-rose-300 mb-3 inline-flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            {scheduledError}
          </div>
        )}
        {scheduled === null ? (
          <div className="text-sm italic text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t('products.edit.pricing.scheduledLoading')}
          </div>
        ) : scheduled.length === 0 ? (
          <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-4 text-center">
            {t('products.edit.pricing.scheduledEmpty')}
          </div>
        ) : (
          <table className="w-full text-sm border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
            <thead className="bg-slate-50 dark:bg-slate-900">
              <tr className="text-left">
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.pricing.colKind')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.pricing.colChange')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.pricing.colWhen')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.pricing.colStatus')}
                </th>
                <th className="px-1 w-8" />
              </tr>
            </thead>
            <tbody>
              {scheduled.map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-slate-200 dark:border-slate-800"
                >
                  <td className="px-3 py-2">
                    <Badge mono variant={c.kind === 'PRICE' ? 'info' : 'default'}>
                      {c.kind}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {describePayload(c.kind, c.payload)}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-700 dark:text-slate-300">
                    {formatDateTime(c.scheduledFor)}
                  </td>
                  <td className="px-3 py-2">
                    <ScheduledStatus status={c.status} t={t} />
                    {c.errorMessage && (
                      <div
                        className="text-xs text-rose-700 dark:text-rose-300 mt-0.5 max-w-xs truncate"
                        title={c.errorMessage}
                      >
                        {c.errorMessage}
                      </div>
                    )}
                  </td>
                  <td className="px-1 py-1 text-right">
                    {c.status === 'PENDING' ? (
                      <button
                        onClick={() => void onCancelScheduled(c)}
                        aria-label={t('products.edit.pricing.cancelScheduledAria')}
                        className="p-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {showScheduleModal && (
        <ScheduleChangeModal
          productIds={[product.id]}
          onClose={() => setShowScheduleModal(false)}
          onComplete={() => {
            setShowScheduleModal(false)
            void refreshScheduled()
          }}
        />
      )}
    </div>
  )
}

// ── Inline add-tier form ──────────────────────────────────────
function AddTierForm({
  productId,
  groups,
  existingTiers,
  onCancel,
  onCreated,
}: {
  productId: string
  groups: CustomerGroupOpt[]
  existingTiers: TierPriceRow[]
  onCancel: () => void
  onCreated: () => void
}) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [minQty, setMinQty] = useState('')
  const [price, setPrice] = useState('')
  const [groupId, setGroupId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const conflict = useMemo(() => {
    const q = Number(minQty)
    if (!q || q <= 0) return null
    const norm = groupId === '' ? null : groupId
    return existingTiers.find(
      (tx) => tx.minQty === q && (tx.customerGroupId ?? null) === norm,
    )
  }, [minQty, groupId, existingTiers])

  const submit = async () => {
    setError(null)
    const q = Math.floor(Number(minQty))
    const p = Number(price)
    if (!Number.isFinite(q) || q <= 0) {
      setError(t('products.edit.pricing.errMinQty'))
      return
    }
    if (!Number.isFinite(p) || p <= 0) {
      setError(t('products.edit.pricing.errPrice'))
      return
    }
    if (conflict) {
      setError(t('products.edit.pricing.errDuplicate'))
      return
    }
    setBusy(true)
    try {
      const body: Record<string, unknown> = { minQty: q, price: p }
      if (groupId !== '') body.customerGroupId = groupId
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/tier-prices`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('products.edit.pricing.tierCreated'))
      onCreated()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 mb-3 bg-slate-50/50 dark:bg-slate-900/40 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Input
          label={t('products.edit.pricing.colMinQty')}
          type="number"
          value={minQty}
          onChange={(e) => setMinQty(e.target.value)}
        />
        <Input
          label={t('products.edit.pricing.colPrice')}
          type="number"
          prefix="€"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
        <div className="space-y-1">
          <label className="text-base font-medium text-slate-700 dark:text-slate-300">
            {t('products.edit.pricing.colGroup')}
          </label>
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="w-full h-8 rounded-md border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 px-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
          >
            <option value="">
              {t('products.edit.pricing.allCustomers')}
            </option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && (
        <div className="text-sm text-rose-700 dark:text-rose-300 inline-flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}
      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t('products.edit.pricing.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          icon={<Check className="w-3.5 h-3.5" />}
          onClick={() => void submit()}
        >
          {t('products.edit.pricing.saveTier')}
        </Button>
      </div>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────
function describePayload(
  kind: ScheduledChange['kind'],
  payload: Record<string, unknown>,
): string {
  if (kind === 'PRICE' && typeof payload?.basePrice === 'number') {
    return `€${(payload.basePrice as number).toFixed(2)}`
  }
  if (kind === 'PRICE' && typeof payload?.basePrice === 'string') {
    const n = Number(payload.basePrice)
    if (Number.isFinite(n)) return `€${n.toFixed(2)}`
  }
  if (kind === 'STATUS' && typeof payload?.status === 'string') {
    return payload.status as string
  }
  return JSON.stringify(payload ?? {})
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, '0')
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`
    )
  } catch {
    return iso
  }
}

function ScheduledStatus({
  status,
  t,
}: {
  status: ScheduledChange['status']
  t: (key: string) => string
}) {
  if (status === 'PENDING') {
    return (
      <Badge variant="warning">
        {t('products.edit.pricing.statusPending')}
      </Badge>
    )
  }
  if (status === 'APPLIED') {
    return (
      <Badge variant="success">
        {t('products.edit.pricing.statusApplied')}
      </Badge>
    )
  }
  if (status === 'CANCELLED') {
    return (
      <Badge variant="default">
        {t('products.edit.pricing.statusCancelled')}
      </Badge>
    )
  }
  return (
    <Badge variant="danger">
      {t('products.edit.pricing.statusFailed')}
    </Badge>
  )
}
