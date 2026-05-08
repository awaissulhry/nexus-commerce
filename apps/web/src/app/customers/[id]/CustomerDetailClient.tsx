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
import { useRouter } from 'next/navigation'
import {
  MapPin,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  ShoppingCart,
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
  addresses: Address[]
  notes: Note[]
  orders: Order[]
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 text-orange-700 border-orange-200',
  EBAY: 'bg-blue-50 text-blue-700 border-blue-200',
  SHOPIFY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  WOOCOMMERCE: 'bg-violet-50 text-violet-700 border-violet-200',
  ETSY: 'bg-rose-50 text-rose-700 border-rose-200',
  MANUAL: 'bg-slate-50 text-slate-700 border-slate-200',
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

export default function CustomerDetailClient({ customerId }: { customerId: string }) {
  const { t, locale } = useTranslations()
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const router = useRouter()

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
            className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
            title={t('customers.cache.refreshTitle')}
          >
            <RefreshCw size={12} /> {t('customers.cache.refresh')}
          </button>
        }
      />

      <Card>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
              {t('customers.detail.totalOrders')}
            </div>
            <div className="text-[24px] font-semibold tabular-nums text-slate-900">
              {customer.totalOrders}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
              {t('customers.detail.ltv')}
            </div>
            <div className="text-[24px] font-semibold tabular-nums text-slate-900">
              {fmtMoney(customer.totalSpentCents)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
              {t('customers.detail.firstOrder')}
            </div>
            <div className="text-md text-slate-700">
              {fmtDate(customer.firstOrderAt)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
              {t('customers.detail.lastOrder')}
            </div>
            <div className="text-md text-slate-700">
              {fmtDate(customer.lastOrderAt)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
              {t('customers.detail.channels')}
            </div>
            <div className="flex items-center gap-1 flex-wrap mt-0.5">
              {Object.entries(customer.channelOrderCounts ?? {}).map(([ch, n]) => (
                <span
                  key={ch}
                  className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${CHANNEL_TONE[ch] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}
                >
                  {ch} {n}
                </span>
              ))}
            </div>
          </div>
        </div>

        {(customer.riskFlag || customer.manualReviewState) && (
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2">
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
          </div>
        )}

        <div className="mt-3 pt-3 border-t border-slate-100">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
            {t('customers.tags.label')}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder={t('customers.tags.placeholder')}
              className="flex-1 max-w-md h-8 px-2 text-base border border-slate-200 rounded"
            />
            <button
              onClick={saveTags}
              className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800"
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 space-y-3">
          <Card noPadding>
            <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between">
              <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 inline-flex items-center gap-1.5">
                <ShoppingCart size={12} /> {t('customers.detail.ordersTitle')}
              </div>
              <span className="text-sm text-slate-500 tabular-nums">
                {customer.orders.length} / {customer.totalOrders}
              </span>
            </div>
            {customer.orders.length === 0 ? (
              <div className="px-3 py-6 text-center text-md text-slate-500">
                {t('customers.detail.noOrders')}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-md">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                        {t('orders.table.header.channel')}
                      </th>
                      <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                        {t('orders.table.header.order')}
                      </th>
                      <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                        Date
                      </th>
                      <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">
                        {t('orders.table.header.status')}
                      </th>
                      <th className="px-3 py-2 text-right text-sm font-semibold uppercase text-slate-700">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {customer.orders.map((o) => (
                      <tr
                        key={o.id}
                        className="border-b border-slate-100 hover:bg-slate-50"
                      >
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${CHANNEL_TONE[o.channel] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}
                          >
                            {o.channel}
                          </span>
                          {o.marketplace && (
                            <span className="text-xs text-slate-500 font-mono ml-1">
                              {o.marketplace}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Link
                            href={`/orders/${o.id}`}
                            className="font-mono text-base text-blue-600 hover:underline"
                          >
                            {o.channelOrderId}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-sm text-slate-500">
                          {fmtDate(o.purchaseDate ?? o.createdAt)}
                        </td>
                        <td className="px-3 py-2">
                          <Badge
                            variant={STATUS_VARIANT[o.status] ?? 'default'}
                            size="sm"
                          >
                            {o.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                          {fmtOrderTotal(o.totalPrice, o.currencyCode)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-3">
          <Card>
            <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 mb-2 inline-flex items-center gap-1.5">
              <MapPin size={12} /> {t('customers.detail.addressesTitle')}
            </div>
            {customer.addresses.length === 0 ? (
              <div className="text-md text-slate-500">
                {t('customers.detail.noAddresses')}
              </div>
            ) : (
              <ul className="space-y-2">
                {customer.addresses.map((a) => (
                  <li
                    key={a.id}
                    className="text-sm text-slate-700 border border-slate-200 rounded p-2"
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
                      <div className="font-medium text-slate-900">
                        {a.recipient}
                      </div>
                    )}
                    <div>{a.line1}</div>
                    {a.line2 && <div>{a.line2}</div>}
                    <div>
                      {a.postalCode} {a.city}
                      {a.state ? `, ${a.state}` : ''}
                    </div>
                    <div className="text-slate-500">{a.country}</div>
                    {a.phone && (
                      <div className="text-slate-500">{a.phone}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 mb-2 inline-flex items-center gap-1.5">
              <User size={12} /> {t('customers.detail.notesTitle')}
            </div>
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder={t('customers.notes.placeholder')}
                  className="flex-1 h-16 px-2 py-1.5 text-base border border-slate-200 rounded"
                />
                <button
                  onClick={addNote}
                  disabled={!noteDraft.trim()}
                  className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <Plus size={12} /> {t('common.save')}
                </button>
              </div>
              {customer.notes.length === 0 ? (
                <div className="text-md text-slate-500 text-center py-3">
                  {t('customers.notes.empty')}
                </div>
              ) : (
                <ul className="space-y-2">
                  {customer.notes.map((n) => (
                    <li
                      key={n.id}
                      className={`text-sm border rounded p-2 ${
                        n.pinned
                          ? 'border-amber-200 bg-amber-50'
                          : 'border-slate-200'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-slate-800 whitespace-pre-wrap">
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
                      <div className="text-xs text-slate-500 mt-1">
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
