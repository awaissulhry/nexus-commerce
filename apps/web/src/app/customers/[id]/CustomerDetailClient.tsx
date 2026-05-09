'use client'

/**
 * O.21b — /customers/:id detail page.
 *
 * Three-card layout:
 *   1. Header — name, email, LTV, total orders, first/last seen, risk badge, tags editor
 *   2. Orders timeline (last 50, newest first) — each row deep-links to /orders/:id
 *   3. Sidebar (lg+) — addresses + notes (inline editor)
 *
 * Inline editing where the operator wants speed: tags via comma-
 * separated input, notes via textarea + pin toggle. Heavier edits
 * (split a customer, merge duplicates, mass-tag) defer to ops
 * scripts; this page is for day-to-day per-customer operator
 * actions.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  MapPin,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Shield,
  ShoppingCart,
  StickyNote,
  Trash2,
  User,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { IconButton } from '@/components/ui/IconButton'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

type Address = {
  id: string
  type: string
  isPrimary: boolean
  recipient: string | null
  line1: string
  line2: string | null
  city: string
  state: string | null
  postalCode: string
  country: string
  phone: string | null
}

type Note = {
  id: string
  body: string
  pinned: boolean
  authorEmail: string | null
  createdAt: string
  updatedAt: string
}

type RiskScore = {
  score: number
  flag: 'LOW' | 'MEDIUM' | 'HIGH'
  signals: Record<string, number | boolean>
  reasons: string[]
  computedAt: string
}

type Order = {
  id: string
  channel: string
  marketplace: string | null
  channelOrderId: string
  status: string
  totalPrice: number
  currencyCode: string | null
  purchaseDate: string | null
  createdAt: string
  riskScore: RiskScore | null
}

type CustomerDetail = {
  id: string
  email: string
  name: string | null
  totalOrders: number
  totalSpentCents: number
  firstOrderAt: string | null
  lastOrderAt: string | null
  channelOrderCounts: Record<string, number> | null
  tags: string[]
  riskFlag: string | null
  manualReviewState: string | null
  // FU.3 — Italian fiscal identity (operator-editable).
  codiceFiscale: string | null
  partitaIva: string | null
  fiscalKind: 'B2B' | 'B2C' | null
  pecEmail: string | null
  codiceDestinatario: string | null
  addresses: Address[]
  notes: Note[]
  orders: Order[]
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-900',
  EBAY: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900',
  SHOPIFY: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  WOOCOMMERCE: 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900',
  ETSY: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
  MANUAL: 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700',
}

const STATUS_VARIANT: Record<
  string,
  'success' | 'warning' | 'danger' | 'default' | 'info'
> = {
  PENDING: 'warning',
  PROCESSING: 'warning',
  PARTIALLY_SHIPPED: 'info',
  ON_HOLD: 'warning',
  AWAITING_PAYMENT: 'warning',
  SHIPPED: 'info',
  DELIVERED: 'success',
  CANCELLED: 'default',
  REFUNDED: 'danger',
  RETURNED: 'danger',
}

type CustTab = 'orders' | 'notes' | 'risk'

export default function CustomerDetailClient({ customerId }: { customerId: string }) {
  const { t, locale } = useTranslations()
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // Header card (LTV / risk badges / tags editor) + sidebar (addresses
  // + fiscal data) stay always-visible; tabs gate only the main-column
  // workspace below.
  const tabParam = (searchParams.get('tab') as CustTab) || 'orders'
  const setTab = useCallback(
    (t: CustTab) => {
      const next = new URLSearchParams(searchParams.toString())
      if (t === 'orders') next.delete('tab')
      else next.set('tab', t)
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [router, pathname, searchParams],
  )

  const [customer, setCustomer] = useState<CustomerDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [tagInput, setTagInput] = useState('')
  const [noteDraft, setNoteDraft] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/customers/${customerId}`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        if (res.status === 404) {
          toast.error(t('customers.detail.notFound'))
          router.push('/customers')
          return
        }
        throw new Error(`HTTP ${res.status}`)
      }
      const data = (await res.json()) as CustomerDetail
      setCustomer(data)
      setTagInput(data.tags.join(', '))
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [customerId, router, toast, t])

  useEffect(() => {
    refresh()
  }, [refresh])

  const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const fmtDate = (s: string | null) =>
    s
      ? new Date(s).toLocaleDateString(dateLocale, {
          day: 'numeric',
          month: 'short',
          year: '2-digit',
        })
      : '—'
  const fmtMoney = (cents: number) => `€${(cents / 100).toFixed(2)}`
  const fmtOrderTotal = (n: number, code: string | null) =>
    code === 'EUR' || !code ? `€${n.toFixed(2)}` : `€${n.toFixed(2)} ${code}`

  const saveTags = async () => {
    const tags = tagInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/customers/${customerId}/tags`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags }),
        },
      )
      if (!res.ok) throw new Error(await res.text())
      toast.success(t('customers.tags.saved'))
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const addNote = async () => {
    if (!noteDraft.trim()) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/customers/${customerId}/notes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: noteDraft }),
        },
      )
      if (!res.ok) throw new Error(await res.text())
      setNoteDraft('')
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const togglePinned = async (note: Note) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/customers/${customerId}/notes/${note.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: !note.pinned }),
        },
      )
      if (!res.ok) throw new Error(await res.text())
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const deleteNote = async (note: Note) => {
    if (
      !(await askConfirm({
        title: t('customers.notes.deleteConfirm'),
        confirmLabel: t('common.delete'),
        tone: 'danger',
      }))
    )
      return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/customers/${customerId}/notes/${note.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(await res.text())
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const refreshCache = async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/customers/${customerId}/refresh-cache`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error(await res.text())
      toast.success(t('customers.cache.refreshed'))
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const recomputeRisk = async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/customers/${customerId}/recompute-risk`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error(await res.text())
      toast.success(t('customers.risk.recomputed'))
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const setManualReview = async (state: 'PENDING' | 'APPROVED' | 'REJECTED') => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/customers/${customerId}/manual-review`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state }),
        },
      )
      if (!res.ok) throw new Error(await res.text())
      toast.success(t('customers.risk.reviewSaved'))
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  if (loading && !customer) {
    return (
      <div className="p-5 space-y-3">
        <Skeleton variant="card" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2">
            <Skeleton variant="card" />
          </div>
          <div>
            <Skeleton variant="card" />
          </div>
        </div>
      </div>
    )
  }
  if (!customer) return null

  return (
    <div className="space-y-5">
      <PageHeader
        title={customer.name || customer.email}
        description={customer.email}
        breadcrumbs={[
          { label: t('customers.title'), href: '/customers' },
          { label: customer.name || customer.email },
        ]}
        actions={
          <button
            onClick={refreshCache}
            className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
            title={t('customers.cache.refreshTitle')}
          >
            <RefreshCw size={12} /> {t('customers.cache.refresh')}
          </button>
        }
      />

      {/* AU.2 — tab nav. Header card (header + risk + tags) and the
          sidebar (addresses + fiscal data) stay always-visible —
          orientation context shouldn't disappear when an operator
          clicks a tab. Tabs gate only the main-column workspace. */}
      <div role="tablist" aria-label="Customer detail sections" className="inline-flex items-center bg-slate-100 dark:bg-slate-800 rounded-md p-0.5 flex-wrap gap-0.5">
        {([
          { key: 'orders', label: t('customers.detail.tabs.orders'), icon: ShoppingCart },
          { key: 'notes',  label: t('customers.detail.tabs.notes'),  icon: StickyNote },
          { key: 'risk',   label: t('customers.detail.tabs.risk'),   icon: Shield },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={tabParam === tab.key}
            onClick={() => setTab(tab.key)}
            className={`h-7 px-3 text-base font-medium inline-flex items-center gap-1.5 rounded transition-colors ${
              tabParam === tab.key
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <tab.icon size={12} aria-hidden="true" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Header card stays always-visible across tabs — operator
          orientation (LTV / orders count / risk badges / channels)
          shouldn't disappear when they click a tab. */}
      <Card>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('customers.detail.totalOrders')}
            </div>
            <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {customer.totalOrders}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('customers.detail.ltv')}
            </div>
            <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {fmtMoney(customer.totalSpentCents)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('customers.detail.firstOrder')}
            </div>
            <div className="text-md text-slate-700 dark:text-slate-300">
              {fmtDate(customer.firstOrderAt)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('customers.detail.lastOrder')}
            </div>
            <div className="text-md text-slate-700 dark:text-slate-300">
              {fmtDate(customer.lastOrderAt)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('customers.detail.channels')}
            </div>
            <div className="flex items-center gap-1 flex-wrap mt-0.5">
              {Object.entries(customer.channelOrderCounts ?? {}).map(([ch, n]) => (
                <span
                  key={ch}
                  className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${CHANNEL_TONE[ch] ?? 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'}`}
                >
                  {ch} {n}
                </span>
              ))}
            </div>
          </div>
        </div>

        {(customer.riskFlag || customer.manualReviewState) && (
          <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
            {customer.riskFlag && (
              <Badge
                variant={
                  customer.riskFlag === 'HIGH'
                    ? 'danger'
                    : customer.riskFlag === 'MEDIUM'
                      ? 'warning'
                      : 'success'
                }
                size="sm"
              >
                {t('customers.riskFlag.label', { flag: customer.riskFlag })}
              </Badge>
            )}
            {customer.manualReviewState && (
              <Badge variant="warning" size="sm">
                {customer.manualReviewState.replace(/_/g, ' ')}
              </Badge>
            )}
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => setManualReview('APPROVED')}
                className="h-7 px-2 text-sm bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/60"
              >
                {t('customers.risk.markApproved')}
              </button>
              <button
                onClick={() => setManualReview('REJECTED')}
                className="h-7 px-2 text-sm bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 rounded hover:bg-rose-100 dark:hover:bg-rose-900/60"
              >
                {t('customers.risk.markRejected')}
              </button>
              <button
                onClick={recomputeRisk}
                className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                {t('customers.risk.recompute')}
              </button>
            </div>
          </div>
        )}

        <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
          <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1.5">
            {t('customers.tags.label')}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder={t('customers.tags.placeholder')}
              className="flex-1 max-w-md h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded"
            />
            <button
              onClick={saveTags}
              className="h-8 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white rounded hover:bg-slate-800"
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 space-y-3">
          {/* AU.2 — Orders tab (default) */}
          {tabParam === 'orders' && (
          <Card noPadding>
            <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
                <ShoppingCart size={12} /> {t('customers.detail.ordersTitle')}
              </div>
              <span className="text-sm text-slate-500 dark:text-slate-400 tabular-nums">
                {customer.orders.length} / {customer.totalOrders}
              </span>
            </div>
            {customer.orders.length === 0 ? (
              <div className="px-3 py-6 text-center text-md text-slate-500 dark:text-slate-400">
                {t('customers.detail.noOrders')}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-md">
                  <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
                    <tr>
                      <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700 dark:text-slate-300">
                        {t('orders.table.header.channel')}
                      </th>
                      <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700 dark:text-slate-300">
                        {t('orders.table.header.order')}
                      </th>
                      <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700 dark:text-slate-300">
                        Date
                      </th>
                      <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700 dark:text-slate-300">
                        {t('orders.table.header.status')}
                      </th>
                      <th className="px-3 py-2 text-right text-sm font-semibold uppercase text-slate-700 dark:text-slate-300">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {customer.orders.map((o) => (
                      <tr
                        key={o.id}
                        className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${CHANNEL_TONE[o.channel] ?? 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'}`}
                          >
                            {o.channel}
                          </span>
                          {o.marketplace && (
                            <span className="text-xs text-slate-500 dark:text-slate-400 font-mono ml-1">
                              {o.marketplace}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Link
                            href={`/orders/${o.id}`}
                            className="font-mono text-base text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            {o.channelOrderId}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                          {fmtDate(o.purchaseDate ?? o.createdAt)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1 flex-wrap">
                            <Badge
                              variant={STATUS_VARIANT[o.status] ?? 'default'}
                              size="sm"
                            >
                              {o.status}
                            </Badge>
                            {o.riskScore && o.riskScore.flag !== 'LOW' && (
                              <span
                                title={o.riskScore.reasons.join(' · ')}
                                className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${
                                  o.riskScore.flag === 'HIGH'
                                    ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900'
                                    : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900'
                                }`}
                              >
                                {o.riskScore.flag} {o.riskScore.score}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                          {fmtOrderTotal(o.totalPrice, o.currencyCode)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          )}

          {/* AU.2 — Risk tab. Drills into per-order risk-score
              breakdown the operator needs to triage flagged
              customers. The header card already shows the rolled-up
              flag + Approve/Reject buttons; this panel shows the
              evidence behind that flag. */}
          {tabParam === 'risk' && (
          <Card>
            <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-2 inline-flex items-center gap-1.5">
              <Shield size={12} /> Risk breakdown
            </div>
            {(() => {
              const flagged = customer.orders.filter(
                (o: any) => o.riskScore && o.riskScore.flag !== 'LOW',
              )
              if (flagged.length === 0) {
                return (
                  <div className="text-md text-slate-500 dark:text-slate-400 text-center py-3">
                    No flagged orders. {customer.riskFlag === null
                      ? 'Customer is unscored — first order will trigger the engine.'
                      : `Current rollup: ${customer.riskFlag}.`}
                  </div>
                )
              }
              return (
                <ul className="space-y-2">
                  {flagged.map((o: any) => (
                    <li
                      key={o.id}
                      className={`border rounded p-3 ${
                        o.riskScore.flag === 'HIGH'
                          ? 'border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40'
                          : 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          href={`/orders/${o.id}`}
                          className="font-mono text-base text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {o.channelOrderId}
                        </Link>
                        <span
                          className={`text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${
                            o.riskScore.flag === 'HIGH'
                              ? 'bg-rose-100 dark:bg-rose-900/60 text-rose-700 dark:text-rose-300 border-rose-300'
                              : 'bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 border-amber-300'
                          }`}
                        >
                          {o.riskScore.flag} {o.riskScore.score}
                        </span>
                      </div>
                      {o.riskScore.reasons?.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5 text-sm text-slate-700 dark:text-slate-300">
                          {o.riskScore.reasons.map((r: string, i: number) => (
                            <li key={i}>· {r}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )
            })()}
          </Card>
          )}

          {/* AU.2 — Notes tab. Larger editor surface than the
              sidebar; sidebar Notes card stays visible too as
              a synced mini-view. */}
          {tabParam === 'notes' && (
          <Card>
            <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-2 inline-flex items-center gap-1.5">
              <User size={12} /> {t('customers.detail.notesTitle')}
            </div>
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder={t('customers.notes.placeholder')}
                  className="flex-1 h-32 px-2 py-1.5 text-base border border-slate-200 dark:border-slate-700 rounded"
                />
                <button
                  onClick={addNote}
                  disabled={!noteDraft.trim()}
                  className="h-8 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <Plus size={12} /> {t('common.save')}
                </button>
              </div>
              {customer.notes.length === 0 ? (
                <div className="text-md text-slate-500 dark:text-slate-400 text-center py-3">
                  {t('customers.notes.empty')}
                </div>
              ) : (
                <ul className="space-y-2">
                  {customer.notes.map((n) => (
                    <li
                      key={n.id}
                      className={`text-sm border rounded p-2 ${
                        n.pinned
                          ? 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-slate-800 dark:text-slate-200 whitespace-pre-wrap flex-1">
                          {n.body}
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <IconButton aria-label={n.pinned ? 'Unpin note' : 'Pin note'} size="sm" onClick={() => togglePinned(n)}>
                            {n.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                          </IconButton>
                          <IconButton aria-label="Delete note" size="sm" tone="danger" onClick={() => deleteNote(n)}>
                            <Trash2 size={12} />
                          </IconButton>
                        </div>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        {n.authorEmail ?? 'system'} ·{' '}
                        {new Date(n.createdAt).toLocaleString(dateLocale)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
          )}
        </div>

        <div className="space-y-3">
          {/* FU.3 — Italian fiscal data (operator-editable). Renders
              for everyone, not just IT customers, since cross-border
              B2B customers may need codice fiscale entered too. */}
          <FiscalDataCard customer={customer} onSaved={refresh} />

          <Card>
            <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-2 inline-flex items-center gap-1.5">
              <MapPin size={12} /> {t('customers.detail.addressesTitle')}
            </div>
            {customer.addresses.length === 0 ? (
              <div className="text-md text-slate-500 dark:text-slate-400">
                {t('customers.detail.noAddresses')}
              </div>
            ) : (
              <ul className="space-y-2">
                {customer.addresses.map((a) => (
                  <li
                    key={a.id}
                    className="text-sm text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded p-2"
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <Badge variant="default" size="sm">
                        {a.type}
                      </Badge>
                      {a.isPrimary && (
                        <Badge variant="info" size="sm">
                          {t('customers.detail.primary')}
                        </Badge>
                      )}
                    </div>
                    {a.recipient && (
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {a.recipient}
                      </div>
                    )}
                    <div>{a.line1}</div>
                    {a.line2 && <div>{a.line2}</div>}
                    <div>
                      {a.postalCode} {a.city}
                      {a.state ? `, ${a.state}` : ''}
                    </div>
                    <div className="text-slate-500 dark:text-slate-400">{a.country}</div>
                    {a.phone && (
                      <div className="text-slate-500 dark:text-slate-400">{a.phone}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-2 inline-flex items-center gap-1.5">
              <User size={12} /> {t('customers.detail.notesTitle')}
            </div>
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder={t('customers.notes.placeholder')}
                  className="flex-1 h-16 px-2 py-1.5 text-base border border-slate-200 dark:border-slate-700 rounded"
                />
                <button
                  onClick={addNote}
                  disabled={!noteDraft.trim()}
                  className="h-8 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <Plus size={12} /> {t('common.save')}
                </button>
              </div>
              {customer.notes.length === 0 ? (
                <div className="text-md text-slate-500 dark:text-slate-400 text-center py-3">
                  {t('customers.notes.empty')}
                </div>
              ) : (
                <ul className="space-y-2">
                  {customer.notes.map((n) => (
                    <li
                      key={n.id}
                      className={`text-sm border rounded p-2 ${
                        n.pinned
                          ? 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40'
                          : 'border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-slate-800 dark:text-slate-200 whitespace-pre-wrap">
                          {n.body}
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <IconButton
                            aria-label={
                              n.pinned ? 'Unpin note' : 'Pin note'
                            }
                            size="sm"
                            onClick={() => togglePinned(n)}
                          >
                            {n.pinned ? (
                              <PinOff size={12} />
                            ) : (
                              <Pin size={12} />
                            )}
                          </IconButton>
                          <IconButton
                            aria-label="Delete note"
                            size="sm"
                            tone="danger"
                            onClick={() => deleteNote(n)}
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        </div>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        {n.authorEmail ?? 'system'} ·{' '}
                        {new Date(n.createdAt).toLocaleString(dateLocale)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

// ── FU.3: Italian fiscal-data editor ──────────────────────────────────
// Operator captures codice fiscale / partita IVA / fiscalKind / PEC /
// codice destinatario. Channel ingest rarely surfaces this data, so
// this is the primary entry point. Saves via PATCH /api/customers/:id
// /fiscal; FU.3's customer-cache snapshot then propagates to incoming
// orders that haven't already been frozen with sale-time values.
function FiscalDataCard({
  customer,
  onSaved,
}: {
  customer: CustomerDetail
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [editing, setEditing] = useState(false)
  const [codiceFiscale, setCodiceFiscale] = useState(customer.codiceFiscale ?? '')
  const [partitaIva, setPartitaIva] = useState(customer.partitaIva ?? '')
  const [fiscalKind, setFiscalKind] = useState<'' | 'B2B' | 'B2C'>(
    customer.fiscalKind ?? '',
  )
  const [pecEmail, setPecEmail] = useState(customer.pecEmail ?? '')
  const [codiceDestinatario, setCodiceDestinatario] = useState(
    customer.codiceDestinatario ?? '',
  )
  const [busy, setBusy] = useState(false)

  // Reset local state when the customer prop changes (e.g. after a
  // refresh from another panel's save).
  useEffect(() => {
    setCodiceFiscale(customer.codiceFiscale ?? '')
    setPartitaIva(customer.partitaIva ?? '')
    setFiscalKind(customer.fiscalKind ?? '')
    setPecEmail(customer.pecEmail ?? '')
    setCodiceDestinatario(customer.codiceDestinatario ?? '')
  }, [customer])

  const save = async () => {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/customers/${customer.id}/fiscal`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            codiceFiscale: codiceFiscale || null,
            partitaIva: partitaIva || null,
            fiscalKind: fiscalKind || null,
            pecEmail: pecEmail || null,
            codiceDestinatario: codiceDestinatario || null,
          }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Save failed')
      }
      toast.success('Dati fiscali salvati')
      setEditing(false)
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  // Read-only preview (not editing).
  if (!editing) {
    const hasAny =
      customer.codiceFiscale ||
      customer.partitaIva ||
      customer.fiscalKind ||
      customer.pecEmail
    return (
      <Card>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
            Dati fiscali
          </div>
          <button
            onClick={() => setEditing(true)}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            {hasAny ? 'Modifica' : 'Aggiungi'}
          </button>
        </div>
        {!hasAny ? (
          <div className="text-md text-slate-500 dark:text-slate-400">
            Nessun dato fiscale. Aggiungi codice fiscale o partita IVA per
            generare fatture italiane.
          </div>
        ) : (
          <dl className="text-sm space-y-1">
            {customer.fiscalKind && (
              <div className="flex items-center gap-2">
                <dt className="text-slate-500 dark:text-slate-400 w-32">Tipo:</dt>
                <dd>
                  <Badge variant={customer.fiscalKind === 'B2B' ? 'info' : 'default'} size="sm">
                    {customer.fiscalKind}
                  </Badge>
                </dd>
              </div>
            )}
            {customer.codiceFiscale && (
              <div className="flex items-center gap-2">
                <dt className="text-slate-500 dark:text-slate-400 w-32">Codice fiscale:</dt>
                <dd className="font-mono text-slate-800 dark:text-slate-200">{customer.codiceFiscale}</dd>
              </div>
            )}
            {customer.partitaIva && (
              <div className="flex items-center gap-2">
                <dt className="text-slate-500 dark:text-slate-400 w-32">Partita IVA:</dt>
                <dd className="font-mono text-slate-800 dark:text-slate-200">IT{customer.partitaIva}</dd>
              </div>
            )}
            {customer.pecEmail && (
              <div className="flex items-center gap-2">
                <dt className="text-slate-500 dark:text-slate-400 w-32">PEC:</dt>
                <dd className="text-slate-800 dark:text-slate-200 truncate">{customer.pecEmail}</dd>
              </div>
            )}
            {customer.codiceDestinatario && (
              <div className="flex items-center gap-2">
                <dt className="text-slate-500 dark:text-slate-400 w-32">Cod. destinatario:</dt>
                <dd className="font-mono text-slate-800 dark:text-slate-200">{customer.codiceDestinatario}</dd>
              </div>
            )}
          </dl>
        )}
      </Card>
    )
  }

  // Editor.
  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
          Dati fiscali
        </div>
      </div>
      <div className="space-y-2">
        <div>
          <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-0.5">
            Tipo cliente
          </label>
          <select
            value={fiscalKind}
            onChange={(e) => setFiscalKind(e.target.value as '' | 'B2B' | 'B2C')}
            className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded"
          >
            <option value="">— Non specificato</option>
            <option value="B2B">B2B (azienda con P. IVA)</option>
            <option value="B2C">B2C (privato)</option>
          </select>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-0.5">
            Codice fiscale
          </label>
          <input
            value={codiceFiscale}
            onChange={(e) => setCodiceFiscale(e.target.value.toUpperCase())}
            placeholder="16 caratteri alfanumerici"
            maxLength={16}
            className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded font-mono"
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-0.5">
            Partita IVA
          </label>
          <input
            value={partitaIva}
            onChange={(e) => setPartitaIva(e.target.value.replace(/\D/g, '').slice(0, 11))}
            placeholder="11 cifre"
            inputMode="numeric"
            className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded font-mono"
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-0.5">
            PEC
          </label>
          <input
            value={pecEmail}
            onChange={(e) => setPecEmail(e.target.value)}
            placeholder="indirizzo@pec.it (per fallback SDI)"
            type="email"
            className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded"
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-0.5">
            Codice destinatario
          </label>
          <input
            value={codiceDestinatario}
            onChange={(e) => setCodiceDestinatario(e.target.value.toUpperCase().slice(0, 7))}
            placeholder="7 caratteri (vuoto = SDI usa PEC)"
            maxLength={7}
            className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded font-mono"
          />
        </div>
        <div className="flex items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <button
            onClick={save}
            disabled={busy}
            className="h-8 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white rounded hover:bg-slate-800 disabled:opacity-50"
          >
            Salva
          </button>
          <button
            onClick={() => setEditing(false)}
            disabled={busy}
            className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Annulla
          </button>
        </div>
      </div>
    </Card>
  )
}
