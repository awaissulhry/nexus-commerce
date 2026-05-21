'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  Mail, MapPin, Package, Truck, Undo2, Star, RefreshCw,
  ExternalLink, Clock, CheckCircle2, XCircle, DollarSign,
  ShoppingCart, FileText, Activity, Receipt, Pin, PinOff, Trash2,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { deepLinkForOrder } from '../_lib/deep-links'
import { formatOrderTotal } from '../_lib/money'

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-900',
  EBAY: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900',
  SHOPIFY: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  WOOCOMMERCE: 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900',
  ETSY: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
  MANUAL: 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700',
}
const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'default' | 'info'> = {
  PENDING: 'warning', SHIPPED: 'info', DELIVERED: 'success', CANCELLED: 'default',
}
const TIMELINE_ICON: Record<string, any> = {
  placed: ShoppingCart, paid: DollarSign, shipped: Truck, delivered: CheckCircle2,
  cancelled: XCircle, 'shipment-shipped': Truck, 'shipment-delivered': CheckCircle2,
  'return-received': Undo2, 'return-refunded': DollarSign, 'return-restocked': Package,
  'review-sent': Star, 'review-scheduled': Clock,
}

type Tab = 'summary' | 'fulfillment' | 'activity' | 'fiscal'

export default function OrderDetailClient({ id }: { id: string }) {
  const { toast } = useToast()
  const router = useRouter()
  const [deleteBusy, setDeleteBusy] = useState(false)
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const tabParam = (searchParams.get('tab') as Tab) || 'summary'
  const [order, setOrder] = useState<any>(null)
  const [timeline, setTimeline] = useState<any[]>([])
  const [financials, setFinancials] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [reviewBusy, setReviewBusy] = useState(false)
  // OX.12 — cross-channel buyer profile drawer
  const [buyerDrawerOpen, setBuyerDrawerOpen] = useState(false)

  const setTab = useCallback(
    (t: Tab) => {
      const next = new URLSearchParams(searchParams.toString())
      if (t === 'summary') next.delete('tab')
      else next.set('tab', t)
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [router, pathname, searchParams],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [oRes, tRes, fRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/orders/${id}`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/orders/${id}/timeline`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/orders/${id}/financials`, { cache: 'no-store' }),
      ])
      if (oRes.ok) setOrder(await oRes.json())
      if (tRes.ok) setTimeline((await tRes.json()).events ?? [])
      if (fRes.ok) setFinancials(await fRes.json())
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { refresh() }, [refresh])

  const requestReviewNow = async () => {
    setReviewBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/orders/${id}/request-review`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      const tone = data.status === 'SENT' || data.status === 'OK' ? 'success' : 'info'
      const msg = `Review request: ${data.status}${data.errorMessage ? ` — ${data.errorMessage}` : ''}`
      toast[tone === 'success' ? 'success' : 'info'](msg)
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally { setReviewBusy(false) }
  }

  // RB.1 — per-row delete + restore. Calls the bulk endpoints with a
  // 1-element array so there's a single backend code path.
  const moveToBin = async () => {
    if (!window.confirm('Move this order to the recycle bin?')) return
    setDeleteBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/orders/bulk-soft-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Moved to recycle bin')
      router.push('/orders')
    } catch (e: any) {
      toast.error(e.message)
    } finally { setDeleteBusy(false) }
  }

  const restoreFromBin = async () => {
    setDeleteBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/orders/bulk-restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Restored')
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally { setDeleteBusy(false) }
  }

  if (loading && !order) {
    return (
      <div className="p-5 space-y-3">
        <Skeleton variant="card" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 space-y-3">
            <Skeleton variant="card" />
            <Skeleton variant="card" />
          </div>
          <div className="space-y-3">
            <Skeleton variant="card" />
            <Skeleton variant="card" />
          </div>
        </div>
      </div>
    )
  }
  if (!order) return <div className="p-5"><Card><div className="text-md text-rose-600 dark:text-rose-400 py-8 text-center">Order not found.</div></Card></div>

  const addr = order.shippingAddress ?? {}
  const lastReview = order.reviewRequests?.[0]

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Order ${order.channelOrderId}`}
        description={`${order.customerName} · ${order.customerEmail}`}
        breadcrumbs={[{ label: 'Orders', href: '/orders' }, { label: order.channelOrderId }]}
        actions={
          <div className="flex items-center gap-2">
            {(() => {
              const link = deepLinkForOrder({
                channel: order.channel,
                marketplace: order.marketplace,
                channelOrderId: order.channelOrderId,
              })
              if (!link) return null
              return (
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={link.label}
                  className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
                >
                  <ExternalLink size={12} /> {link.label}
                </a>
              )
            })()}
            <button
              onClick={requestReviewNow}
              disabled={reviewBusy || !order.deliveredAt}
              title={!order.deliveredAt ? 'Order must be delivered first' : 'Send Amazon review request now (4-30d window)'}
              className="h-8 px-3 text-base bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900 rounded hover:bg-amber-100 dark:hover:bg-amber-900/60 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Star size={12} className={reviewBusy ? 'animate-pulse' : ''} /> Request review
            </button>
            {/* L.25.0 — drill-through into /sync-logs/api-calls
                scoped to this order. Operators triaging a failed
                cancellation / fulfillment / refund land on the
                per-order API-call timeline. */}
            <a
              href={`/sync-logs/api-calls?orderId=${encodeURIComponent(order.id)}`}
              title="View every channel API call recorded for this order"
              className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
            >
              <ExternalLink size={12} /> Sync activity
            </a>
            {/* FU.1 — Italian fiscal artifacts (IT marketplace only).
                B2B unlocks the FatturaPA + SDI dispatch options;
                everyone else gets a Pro Forma + packing slip. */}
            {order.marketplace === 'IT' && (
              <FiscalActions order={order} />
            )}
            <button onClick={refresh} className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5">
              <RefreshCw size={12} /> Refresh
            </button>
            {order.deletedAt ? (
              <button
                onClick={restoreFromBin}
                disabled={deleteBusy}
                className="h-8 px-3 text-base bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Undo2 size={12} /> Restore
              </button>
            ) : (
              <button
                onClick={moveToBin}
                disabled={deleteBusy}
                className="h-8 px-3 text-base bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800 rounded hover:bg-rose-100 dark:hover:bg-rose-900/40 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Trash2 size={12} /> Delete
              </button>
            )}
          </div>
        }
      />

      {order.deletedAt && (
        <div className="rounded-md border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-800 dark:text-rose-200 inline-flex items-center gap-2">
          <Trash2 size={14} aria-hidden="true" />
          <span>
            In recycle bin since {new Date(order.deletedAt).toLocaleString()}.
            {order.channelOrderId && (
              <> The source order on {order.channel} is unaffected.</>
            )}
          </span>
        </div>
      )}

      {/* OX.6 — sticky Amazon-style primary action bar. Stays visible
          on scroll so operators can act on the order from any tab
          without scrolling back up. */}
      <div className="sticky top-0 z-20 -mx-5 px-5 py-2 bg-white/95 dark:bg-slate-950/95 backdrop-blur border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={`${getBackendUrl()}/api/orders/${order.id}/invoice.html`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open invoice in a new tab — use Cmd/Ctrl+P to save as PDF"
            className="h-8 px-3 text-sm font-medium border border-slate-300 dark:border-slate-600 rounded-full bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 inline-flex items-center gap-1.5"
          >
            <Receipt size={12} /> Manage invoice
          </a>
          <a
            href={`${getBackendUrl()}/api/orders/${order.id}/packing-slip.html`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open packing slip in a new tab — use Cmd/Ctrl+P to save as PDF"
            className="h-8 px-3 text-sm font-medium border border-slate-300 dark:border-slate-600 rounded-full bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 inline-flex items-center gap-1.5"
          >
            <Package size={12} /> Print packing slip
          </a>
          <Link
            href={`/orders/${order.id}?tab=fulfillment#refund`}
            className="h-8 px-3 text-sm font-medium border border-slate-300 dark:border-slate-600 rounded-full bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 inline-flex items-center gap-1.5"
          >
            <Undo2 size={12} /> Refund order
          </Link>
          <button
            onClick={requestReviewNow}
            disabled={reviewBusy || !order.deliveredAt}
            title={!order.deliveredAt ? 'Order must be delivered first' : 'Send Amazon review request (4–30 days post-delivery)'}
            className="h-8 px-3 text-sm font-medium border border-slate-300 dark:border-slate-600 rounded-full bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            <Star size={12} className={reviewBusy ? 'animate-pulse' : ''} /> Request a review
          </button>
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400 hidden md:inline">
            Order ID: <span className="font-mono text-slate-700 dark:text-slate-300">{order.channelOrderId}</span>
          </span>
        </div>
      </div>

      {/* AU.1 — tab nav. Summary is default; others gate their
          content blocks. URL-backed via ?tab= so deep-links work
          (e.g. /orders/123?tab=fulfillment from a notification). */}
      <div role="tablist" aria-label="Order detail sections" className="inline-flex items-center bg-slate-100 dark:bg-slate-800 rounded-md p-0.5 flex-wrap gap-0.5">
        {([
          { key: 'summary', label: 'Summary', icon: FileText },
          { key: 'fulfillment', label: 'Fulfillment', icon: Truck },
          { key: 'activity', label: 'Activity', icon: Activity },
          ...(order.marketplace === 'IT'
            ? ([{ key: 'fiscal', label: 'Fiscal', icon: Receipt }] as const)
            : ([] as const)),
        ] as Array<{ key: Tab; label: string; icon: any }>).map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tabParam === t.key}
            onClick={() => setTab(t.key)}
            className={`h-7 px-3 text-base font-medium inline-flex items-center gap-1.5 rounded transition-colors ${
              tabParam === t.key
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <t.icon size={12} aria-hidden="true" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-4">
          {/* Header card — channel + status + total at a glance */}
          <Card>
            <div className="flex items-start gap-3 flex-wrap">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[order.channel]}`}>{order.channel}</span>
                  {order.marketplace && <span className="text-xs font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-700 dark:text-slate-300">{order.marketplace}</span>}
                  <Badge variant={STATUS_VARIANT[order.status] ?? 'default'} size="sm">{order.status}</Badge>
                  {order.fulfillmentMethod && <Badge variant={order.fulfillmentMethod === 'FBA' ? 'warning' : 'info'} size="sm">{order.fulfillmentMethod}</Badge>}
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  Placed {order.purchaseDate ? new Date(order.purchaseDate).toLocaleString() : new Date(order.createdAt).toLocaleString()}
                </div>
              </div>
              <div className="ml-auto text-right">
                <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Total</div>
                {(() => {
                  const d = formatOrderTotal({
                    totalPrice: order.totalPrice,
                    currencyCode: order.currencyCode,
                    status: order.status,
                  })
                  if (d.kind === 'pending') {
                    return (
                      <div
                        className="inline-flex flex-col items-end"
                        title="Amazon withholds the order total until payment is verified. The price will appear here once the order leaves Pending status."
                      >
                        <span className="text-base font-semibold text-amber-700 dark:text-amber-300">Awaiting payment</span>
                        <span className="text-xs text-slate-500 dark:text-slate-400">verification</span>
                      </div>
                    )
                  }
                  return (
                    <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                      {d.symbol}{d.amount}{d.trailingCode ? ` ${d.trailingCode}` : ''}
                    </div>
                  )
                })()}
              </div>
            </div>
          </Card>

          {/* OX.7 — three-card summary block matching Amazon Seller
              Central's detail page layout. Stacks 1-up on narrow
              viewports, 3-up on wider ones so Ship to + delivery
              promise sit beside the order summary. */}
          {tabParam === 'summary' && (
            <OrderSummaryTriptych order={order} />
          )}

          {/* OX.8 — Order contents table (Italian fiscal: dual VAT cols) */}
          {tabParam === 'summary' && (
            <OrderContentsTable order={order} onItemChanged={refresh} />
          )}

          {/* AU.1 — Timeline lives on Activity tab */}
          {tabParam === 'activity' && (
          <Card title="Timeline" description="Lifecycle events for this order">
            {timeline.length === 0 ? (
              <div className="text-base text-slate-400 dark:text-slate-500 text-center py-4">No events yet</div>
            ) : (
              <ol className="relative border-l border-slate-200 dark:border-slate-700 ml-2 space-y-3">
                {timeline.map((ev, i) => {
                  const Icon = TIMELINE_ICON[ev.kind] ?? Clock
                  return (
                    <li key={i} className="ml-4">
                      <div className="absolute -left-[8px] mt-0.5 w-4 h-4 rounded-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 inline-flex items-center justify-center">
                        <Icon size={9} className="text-slate-500 dark:text-slate-400" />
                      </div>
                      <div className="text-base font-medium text-slate-900 dark:text-slate-100">{ev.label}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">{new Date(ev.at).toLocaleString()}</div>
                    </li>
                  )
                })}
              </ol>
            )}
          </Card>
          )}

          {/* AU.1 — Channel-specific cards on Activity tab */}
          {tabParam === 'activity' && order.channel === 'SHOPIFY' && order.shopifyMetadata && (
            <ShopifyDiscountsCard meta={order.shopifyMetadata} />
          )}
          {tabParam === 'activity' && order.channel === 'EBAY' && order.ebayMetadata && (
            <EbayMessagingCard meta={order.ebayMetadata} channelOrderId={order.channelOrderId} />
          )}

          {/* AU.1 — Amazon FBM ship-by impact lives on Fulfillment */}
          {tabParam === 'fulfillment' && order.channel === 'AMAZON' && order.fulfillmentMethod === 'FBM' && (
            <AmazonShipByImpactCard order={order} />
          )}

          {/* AU.4 — Buy Shipping rate quote (FBM Amazon only) */}
          {tabParam === 'fulfillment' && order.channel === 'AMAZON' && order.fulfillmentMethod === 'FBM' && (
            <BuyShippingCard orderId={order.id} />
          )}

          {/* OX.9 — per-package sections on the Fulfillment tab.
              Replaces the compact shipments list with one full Amazon-
              style "Package N" panel per shipment. */}
          {tabParam === 'fulfillment' && order.shipments && order.shipments.length > 0 && (
            <div className="space-y-3">
              {order.shipments.map((s: any, idx: number) => (
                <PackageSection key={s.id} idx={idx} shipment={s} order={order} />
              ))}
            </div>
          )}

          {/* AU.1 — Returns on Fulfillment tab */}
          {tabParam === 'fulfillment' && order.returns && order.returns.length > 0 && (
            <Card title="Returns" description={`${order.returns.length} return${order.returns.length === 1 ? '' : 's'}`}>
              <div className="space-y-2">
                {order.returns.map((r: any) => (
                  <Link key={r.id} href={`/fulfillment/returns?id=${r.id}`} className="block border border-slate-200 dark:border-slate-700 rounded p-3 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-base font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-1.5">
                          <Undo2 size={12} /> {r.rmaNumber ?? '—'}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{r.reason ?? 'No reason given'}</div>
                      </div>
                      <Badge variant="warning" size="sm">{r.status.replace(/_/g, ' ')}</Badge>
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
          )}

          {/* AU.1 — Financials on Fiscal tab (IT) or Summary (non-IT)
              When marketplace is IT, fiscal-related views live on
              the dedicated tab; otherwise financials sit at the
              bottom of Summary so non-IT operators don't have to
              click into a one-card tab. */}
          {(order.marketplace === 'IT' ? tabParam === 'fiscal' : tabParam === 'summary')
            && financials && financials.transactions.length > 0 && (
            <Card title="Financials" description="Gross / fees / net">
              <div className="grid grid-cols-3 gap-3 mb-3">
                <FinTile label="Gross" value={financials.rollup.gross} tone="default" />
                <FinTile label="Fees" value={financials.rollup.fees} tone="danger" />
                <FinTile label="Net" value={financials.rollup.net} tone="success" />
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold mb-1.5">Transactions</div>
              <div className="space-y-1">
                {financials.transactions.map((tx: any) => (
                  <div key={tx.id} className="flex items-center justify-between text-sm border-b border-slate-100 dark:border-slate-800 py-1">
                    <div>
                      <span className="font-mono text-slate-700 dark:text-slate-300">{tx.transactionType}</span>
                      <span className="text-slate-500 dark:text-slate-400 ml-2">{new Date(tx.transactionDate).toLocaleDateString('en-GB')}</span>
                    </div>
                    <div className="tabular-nums font-mono text-slate-900 dark:text-slate-100">€{Number(tx.amount).toFixed(2)}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* OX.10 — sales proceeds card. Mirrors Amazon Seller Central:
              Payment method · Items total (excl + incl VAT) · Grand
              total (excl + incl VAT) · drill-down for fee breakdown. */}
          <SalesProceedsCard order={order} financials={financials} />

          <Card title="Customer">
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setBuyerDrawerOpen(true)}
                className="text-md font-semibold text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 hover:underline text-left"
              >
                {order.customerName}
              </button>
              <div className="text-sm text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5"><Mail size={11} /> {order.customerEmail}</div>
              {addr && (
                <div className="text-sm text-slate-600 dark:text-slate-400 mt-1.5 inline-flex items-start gap-1.5">
                  <MapPin size={11} className="mt-0.5 flex-shrink-0" />
                  <span>{[addr.street, addr.city, addr.postalCode, addr.state, addr.country].filter(Boolean).join(', ')}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => setBuyerDrawerOpen(true)}
                className="block mt-2 text-sm text-blue-600 dark:text-blue-400 hover:underline text-left"
              >
                Buyer profile · cross-channel orders →
              </button>
            </div>
          </Card>

          {/* OX.12 — the legacy customerHistory inline card was replaced
              by the cross-channel BuyerDrawer (opened by clicking the
              Customer card buyer name). The drawer surfaces lifetime
              value + return rate + channel mix + the 50 most-recent
              orders — strictly more information than the old 8-row
              widget could fit in the sidebar. */}

          <Card title="Review request" description="Amazon Solicitations">
            {!lastReview ? (
              <div className="text-base text-slate-500 dark:text-slate-400">No request yet.</div>
            ) : (
              <div className="space-y-1">
                <Badge variant="info" size="sm">{lastReview.status}</Badge>
                {lastReview.sentAt && <div className="text-xs text-slate-500 dark:text-slate-400">Sent {new Date(lastReview.sentAt).toLocaleString()}</div>}
                {lastReview.errorMessage && <div className="text-xs text-rose-600 dark:text-rose-400">{lastReview.errorMessage}</div>}
                {lastReview.suppressedReason && <div className="text-xs text-slate-500 dark:text-slate-400">{lastReview.suppressedReason}</div>}
              </div>
            )}
            <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              {!order.deliveredAt
                ? 'Wait until order is delivered before requesting.'
                : 'Amazon allows one request per order, between 4–30 days post-delivery, with no custom message.'}
            </div>
          </Card>

          {order.tags && order.tags.length > 0 && (
            <Card title="Tags">
              <div className="flex items-center gap-1.5 flex-wrap">
                {order.tags.map((t: any) => (
                  <span key={t.id} className="inline-flex items-center px-1.5 py-0.5 text-xs rounded" style={{ background: t.color ? `${t.color}20` : '#f1f5f9', color: t.color ?? '#64748b' }}>
                    {t.name}
                  </span>
                ))}
              </div>
            </Card>
          )}

          {/* OX.11 — Manage Feedback card. Surfaces buyer-side seller
              feedback when present, or an empty-state with a deep-
              link to Seller Central's Feedback Manager. */}
          <ManageFeedbackCard order={order} />

          {/* AU.5 — Order-level notes (always-visible sidebar) */}
          <OrderNotesCard orderId={order.id} />
        </div>
      </div>

      {/* OX.12 — cross-channel buyer profile drawer (mounted at page
          root so it can overlay the tab content) */}
      {buyerDrawerOpen && (
        <BuyerProfileDrawer
          email={order.customerEmail}
          excludeOrderId={order.id}
          onClose={() => setBuyerDrawerOpen(false)}
        />
      )}
    </div>
  )
}

// ── AU.5: Order-level notes panel ─────────────────────────────────────
// Mirrors the customer-notes pattern. Lives in the always-visible
// sidebar (every tab) so operators never lose context — pack
// instructions, fraud-hold flags, buyer-messaged-about-gift-wrap
// memos. Distinct from the customer-side notes (which persist
// across all the customer's orders); these are about THIS order.
type OrderNoteRow = {
  id: string
  body: string
  pinned: boolean
  authorEmail: string | null
  createdAt: string
  updatedAt: string
}
function OrderNotesCard({ orderId }: { orderId: string }) {
  const { toast } = useToast()
  const [notes, setNotes] = useState<OrderNoteRow[]>([])
  const [draft, setDraft] = useState('')
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/orders/${orderId}/notes`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      const data = await res.json()
      setNotes(data.notes ?? [])
    } catch {
      /* ignore — notes are best-effort */
    }
  }, [orderId])
  useEffect(() => {
    refresh()
  }, [refresh])

  const add = async () => {
    if (!draft.trim()) return
    try {
      const res = await fetch(`${getBackendUrl()}/api/orders/${orderId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: draft }),
      })
      if (!res.ok) throw new Error(await res.text())
      setDraft('')
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    }
  }
  const togglePinned = async (n: OrderNoteRow) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/orders/${orderId}/notes/${n.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: !n.pinned }),
        },
      )
      if (!res.ok) throw new Error(await res.text())
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    }
  }
  const remove = async (n: OrderNoteRow) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/orders/${orderId}/notes/${n.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(await res.text())
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  return (
    <Card title="Seller Notes" description="For your records only — will not be displayed to the buyer">
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note for this order (pack hints, fraud holds, buyer messages)…"
            className="flex-1 h-16 px-2 py-1.5 text-base border border-slate-200 dark:border-slate-700 rounded"
          />
          <button
            onClick={add}
            disabled={!draft.trim()}
            className="h-8 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white rounded hover:bg-slate-800 disabled:opacity-50"
          >
            Save
          </button>
        </div>
        {notes.length === 0 ? (
          <div className="text-md text-slate-500 dark:text-slate-400 text-center py-2">
            No notes yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => (
              <li
                key={n.id}
                className={`text-sm border rounded p-2 ${
                  n.pinned ? 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40' : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-slate-800 dark:text-slate-200 whitespace-pre-wrap flex-1">
                    {n.body}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <IconButton
                      aria-label={n.pinned ? 'Unpin note' : 'Pin note'}
                      title={n.pinned ? 'Unpin' : 'Pin'}
                      size="sm"
                      tone={n.pinned ? 'warning' : 'neutral'}
                      onClick={() => togglePinned(n)}
                    >
                      {n.pinned ? (
                        <PinOff className="w-3 h-3" />
                      ) : (
                        <Pin className="w-3 h-3" />
                      )}
                    </IconButton>
                    <IconButton
                      aria-label="Delete note"
                      title="Delete"
                      size="sm"
                      tone="danger"
                      onClick={() => remove(n)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </IconButton>
                  </div>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  {n.authorEmail ?? 'system'} ·{' '}
                  {new Date(n.createdAt).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

function FinTile({ label, value, tone }: { label: string; value: number; tone: 'default' | 'success' | 'danger' }) {
  const cls = { default: 'text-slate-900 dark:text-slate-100', success: 'text-emerald-600 dark:text-emerald-400', danger: 'text-rose-600 dark:text-rose-400' }[tone]
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${cls}`}>€{value.toFixed(2)}</div>
    </div>
  )
}

// ── AU.4: Amazon Buy Shipping rate quote + label purchase ─────────────
// Wires the O.16b backend (currently env-gated dryRun returning 3
// mock rates by default) to an operator-facing modal. On real-path
// flip (NEXUS_ENABLE_AMAZON_BUY_SHIPPING=true + the SP-API client
// wire from the follow-up commit) the same UI shows real SP-API
// quotes without any frontend change.
//
// State machine:
//   idle    — "Get rates" button
//   quoting — fetching, button shows spinner
//   rates   — modal open with quote list
//   buying  — selected rate, label-purchase in flight
//   bought  — confirmation w/ tracking + label URL
type BuyRate = {
  serviceId: string
  carrierName: string
  serviceName: string
  totalCharge: { currencyCode: string; amount: number }
  estimatedTransitDays: number
  guaranteedDelivery: boolean
}
function BuyShippingCard({ orderId }: { orderId: string }) {
  const { toast } = useToast()
  const [phase, setPhase] = useState<'idle' | 'quoting' | 'rates' | 'buying' | 'bought'>('idle')
  const [rates, setRates] = useState<BuyRate[]>([])
  const [source, setSource] = useState<'real' | 'dryRun' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [purchase, setPurchase] = useState<{
    trackingNumber: string
    labelUrl: string
    totalCharge: { currencyCode: string; amount: number }
  } | null>(null)

  const getQuotes = async () => {
    setPhase('quoting')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/amazon/orders/${orderId}/buy-shipping/quote`,
        { method: 'POST' },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Quote failed')
      setRates(data.rates ?? [])
      setSource(data.source ?? null)
      setMessage(data.message ?? null)
      setPhase('rates')
    } catch (e: any) {
      toast.error(e.message)
      setPhase('idle')
    }
  }

  const buyRate = async (serviceId: string) => {
    setPhase('buying')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/amazon/orders/${orderId}/buy-shipping/purchase`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceId }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Purchase failed')
      setPurchase({
        trackingNumber: data.trackingNumber,
        labelUrl: data.labelUrl,
        totalCharge: data.totalCharge,
      })
      setSource(data.source ?? null)
      setMessage(data.message ?? null)
      setPhase('bought')
      toast.success(
        data.source === 'dryRun'
          ? 'dryRun: mock label generated'
          : `Label purchased: ${data.trackingNumber}`,
      )
    } catch (e: any) {
      toast.error(e.message)
      setPhase('rates')
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
          <Truck size={12} /> Amazon Buy Shipping
        </div>
        {source === 'dryRun' && (
          <span className="text-xs font-semibold uppercase px-1.5 py-0.5 border rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900">
            dryRun
          </span>
        )}
      </div>

      {phase === 'idle' && (
        <div className="space-y-2">
          <p className="text-base text-slate-600 dark:text-slate-400">
            Quote SP-API Merchant Fulfillment rates for this order.
            Buy Shipping rates are usually 5–15% cheaper than retail
            and auto-credit VTR.
          </p>
          <button
            onClick={getQuotes}
            className="h-8 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white rounded hover:bg-slate-800 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} /> Get rates
          </button>
        </div>
      )}

      {phase === 'quoting' && (
        <div className="text-md text-slate-500 dark:text-slate-400 py-3 text-center">
          Fetching rates…
        </div>
      )}

      {phase === 'rates' && (
        <div className="space-y-2">
          {message && (
            <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded p-2">
              {message}
            </div>
          )}
          {rates.length === 0 ? (
            <div className="text-md text-slate-500 dark:text-slate-400 py-2">
              No eligible rates returned for this order.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {rates.map((r) => (
                <li
                  key={r.serviceId}
                  className="flex items-center justify-between gap-2 border border-slate-200 dark:border-slate-700 rounded p-2"
                >
                  <div className="min-w-0">
                    <div className="text-md text-slate-900 dark:text-slate-100">
                      {r.carrierName} — {r.serviceName}
                      {r.guaranteedDelivery && (
                        <span className="ml-1.5 text-xs font-semibold uppercase px-1.5 py-0.5 border rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900">
                          guaranteed
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-slate-500 dark:text-slate-400">
                      {r.estimatedTransitDays}d transit · {r.totalCharge.currencyCode}{' '}
                      {r.totalCharge.amount.toFixed(2)}
                    </div>
                  </div>
                  <button
                    onClick={() => buyRate(r.serviceId)}
                    className="h-7 px-3 text-sm bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/60"
                  >
                    Buy
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            onClick={() => setPhase('idle')}
            className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
          >
            ← Back
          </button>
        </div>
      )}

      {phase === 'buying' && (
        <div className="text-md text-slate-500 dark:text-slate-400 py-3 text-center">
          Purchasing label…
        </div>
      )}

      {phase === 'bought' && purchase && (
        <div className="space-y-2">
          {message && (
            <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded p-2">
              {message}
            </div>
          )}
          <div className="border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 rounded p-3 space-y-1">
            <div className="text-md font-semibold text-emerald-900 dark:text-emerald-100">
              Label ready
            </div>
            <div className="text-sm text-slate-700 dark:text-slate-300">
              Tracking:{' '}
              <span className="font-mono">{purchase.trackingNumber}</span>
            </div>
            <div className="text-sm text-slate-700 dark:text-slate-300">
              Charged: {purchase.totalCharge.currencyCode}{' '}
              {purchase.totalCharge.amount.toFixed(2)}
            </div>
            {purchase.labelUrl && (
              <a
                href={purchase.labelUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
              >
                Download label PDF <ExternalLink size={11} />
              </a>
            )}
          </div>
          <button
            onClick={() => {
              setPhase('idle')
              setPurchase(null)
            }}
            className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
          >
            ← Back
          </button>
        </div>
      )}
    </Card>
  )
}

// ── FU.1: Italian fiscal action group ─────────────────────────────────
// Renders only on IT-marketplace orders. Three actions:
//   • Print fattura — opens /api/orders/:id/invoice.html for browser
//     print (Italian PRO FORMA on non-B2B; full fattura on B2B with
//     lazy-assigned F.2 invoice number)
//   • Download FatturaPA XML — only on B2B; SDI-format .xml for
//     manual upload to operator's commercial provider
//   • Dispatch SDI — only on B2B; env-gated (NEXUS_ENABLE_SDI_
//     DISPATCH=true). Default: marks the FiscalInvoice
//     sdiStatus='PENDING' so the operator surface shows queued
//     state.
//
// Operators can find these where they think to look (order detail
// header) without us duplicating the existing /fulfillment/outbound
// pack-slip URL — that surface owns per-shipment pack-time printing.
function FiscalActions({ order }: { order: any }) {
  const isB2B = order.fiscalKind === 'B2B'

  const dispatchSdi = async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/orders/${order.id}/fattura-pa/dispatch`,
        { method: 'POST' },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'dispatch failed')
      // useToast is in the parent scope; bubble via custom event
      // since this is a pure-function component without prop drill.
      window.dispatchEvent(
        new CustomEvent('nexus:toast', {
          detail: { kind: data.status === 'PENDING' ? 'success' : 'info', text: data.message },
        }),
      )
    } catch (e: any) {
      window.dispatchEvent(
        new CustomEvent('nexus:toast', {
          detail: { kind: 'error', text: e.message },
        }),
      )
    }
  }

  return (
    <>
      <a
        href={`${getBackendUrl()}/api/orders/${order.id}/invoice.html`}
        target="_blank"
        rel="noopener noreferrer"
        title="Stampa fattura (apre in nuova scheda — usa Cmd+P per salvare in PDF)"
        className="h-8 px-3 text-base bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900 rounded hover:bg-blue-100 dark:hover:bg-blue-900/60 inline-flex items-center gap-1.5"
      >
        <DollarSign size={12} /> Fattura
      </a>
      {isB2B && (
        <>
          <a
            href={`${getBackendUrl()}/api/orders/${order.id}/fattura-pa.xml`}
            title="Download FatturaPA XML for manual SDI upload"
            className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
            download
          >
            <ExternalLink size={12} /> XML SDI
          </a>
          <button
            onClick={dispatchSdi}
            title="Dispatch invoice to SDI (env-gated — set NEXUS_ENABLE_SDI_DISPATCH=true to flip from dryRun)"
            className="h-8 px-3 text-base bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/60 inline-flex items-center gap-1.5"
          >
            <CheckCircle2 size={12} /> Invia SDI
          </button>
        </>
      )}
    </>
  )
}

// ── O.16a: Amazon FBM ship-by impact (LSR/VTR per-order) ──────────────
// Per-order at-a-glance for the two metrics Amazon's Seller
// Performance dashboard tracks for FBM:
//   LSR (Late Shipment Rate)  — late = shippedAt > shipByDate
//   VTR (Valid Tracking Rate) — needs trackingNumber on a shipment
//
// Tier mapping mirrors the perOrderShipByTier server helper:
//   on-time  green   — shipped before shipByDate w/ tracking
//   at-risk  amber   — not shipped, < 24h to shipByDate
//   overdue  red     — past shipByDate, not shipped (LSR risk)
//   late     red     — shipped after shipByDate (counts toward LSR)
//   no-track red     — shipped on time but no tracking (VTR hit)
//
// Computed entirely client-side from the order data we already
// have — same logic as amazon-account-health.service.ts on the
// backend, kept inline here so the card renders without a fetch.
function AmazonShipByImpactCard({ order }: { order: any }) {
  const shipBy = order.shipByDate ? new Date(order.shipByDate) : null
  const shippedAt = order.shippedAt ? new Date(order.shippedAt) : null
  const hasTracking = (order.shipments ?? []).some(
    (s: any) => s.trackingNumber && String(s.trackingNumber).trim() !== '',
  )
  let tier: 'on-time' | 'at-risk' | 'overdue' | 'late' | 'no-track'
  let reason: string

  if (shippedAt) {
    const lateBy = shipBy ? shippedAt.getTime() - shipBy.getTime() : 0
    if (shipBy && lateBy > 0) {
      const hours = Math.round(lateBy / (60 * 60 * 1000))
      tier = 'late'
      reason = `Shipped ${hours}h past ship-by — counts toward LSR`
    } else if (!hasTracking) {
      tier = 'no-track'
      reason = 'Shipped without tracking — counts against VTR'
    } else {
      tier = 'on-time'
      reason = 'Shipped on time with tracking'
    }
  } else if (shipBy) {
    const msToShipBy = shipBy.getTime() - Date.now()
    if (msToShipBy < 0) {
      const hours = Math.round(-msToShipBy / (60 * 60 * 1000))
      tier = 'overdue'
      reason = `Past ship-by by ${hours}h — LSR risk`
    } else if (msToShipBy < 24 * 60 * 60 * 1000) {
      const hours = Math.round(msToShipBy / (60 * 60 * 1000))
      tier = 'at-risk'
      reason = `${hours}h until ship-by`
    } else {
      tier = 'on-time'
      reason = 'On track'
    }
  } else {
    return null
  }

  const tone = {
    'on-time': 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
    'at-risk': 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900',
    overdue: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
    late: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
    'no-track': 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
  }[tier]

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
          <Clock size={12} /> Amazon ship-by impact
        </div>
        <span
          className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${tone}`}
        >
          {tier.replace('-', ' ')}
        </span>
      </div>
      <div className="text-base text-slate-700 dark:text-slate-300">{reason}</div>
      <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 grid grid-cols-2 gap-x-4 gap-y-1">
        <div>
          ship-by:{' '}
          {shipBy ? shipBy.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
        </div>
        <div>
          shipped:{' '}
          {shippedAt
            ? shippedAt.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
            : '—'}
        </div>
        <div>tracking: {hasTracking ? 'yes' : 'no'}</div>
        <div>
          fulfillment: <span className="font-mono">FBM</span>
        </div>
      </div>
    </Card>
  )
}

// ── O.17: eBay buyer messaging surface ─────────────────────────────────
// eBay's full Messaging API is gated behind a separate scope (and the
// modern Messaging API is still in beta as of 2026). Until that's
// wired, this card surfaces what we already have: `buyerCheckoutNotes`
// from the Fulfillment API order payload (cached on
// Order.ebayMetadata at ingest time). Plus a deep-link to the seller-
// hub messages tab so operators can read/reply in eBay directly.
//
// When the Messaging API does get wired (env-flag-gated commit), the
// card grows a thread list — the surface stays the same.
function EbayMessagingCard({
  meta,
  channelOrderId,
}: {
  meta: any
  channelOrderId: string
}) {
  const checkoutNotes: string | null =
    meta?.buyerCheckoutNotes ?? meta?.checkoutMessage ?? null
  const buyerUsername: string | null = meta?.buyer?.username ?? null

  // Always render the card on eBay orders so operators have a
  // reliable place to deep-link from, even if no message text was
  // supplied at checkout. Empty-state copy is honest about why.
  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
          <Mail size={12} /> eBay messages
        </div>
        <a
          href={`https://www.ebay.com/mesh/msg/inbox?buyerUsername=${encodeURIComponent(buyerUsername ?? '')}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
        >
          Open inbox <ExternalLink size={11} />
        </a>
      </div>
      {checkoutNotes ? (
        <div className="text-base text-slate-800 dark:text-slate-200 whitespace-pre-wrap border-l-2 border-blue-300 pl-3 py-1">
          {checkoutNotes}
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            — {buyerUsername ?? 'buyer'}, at checkout
          </div>
        </div>
      ) : (
        <div className="text-sm text-slate-500 dark:text-slate-400">
          No checkout note from{' '}
          <span className="font-mono">{buyerUsername ?? 'the buyer'}</span>.
          Live message threads land here once the Messaging API is wired
          (set <code className="font-mono">NEXUS_ENABLE_EBAY_MESSAGING=1</code>{' '}
          + grant the messaging OAuth scope on your eBay connection).
        </div>
      )}
      <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
        Order {channelOrderId} ·{' '}
        {meta?.lastModifiedDate
          ? `updated ${new Date(meta.lastModifiedDate).toLocaleString()}`
          : 'no recent activity'}
      </div>
    </Card>
  )
}

// ── O.18: Shopify discount codes + gift-card display ───────────────────
// Read-only render of the discount info Shopify ships in the
// orders/create webhook payload (which we cache verbatim on
// Order.shopifyMetadata). No new fetch — everything we need is
// already on the row.
//
// Surfaces:
//   - discount_codes[]:    [{ code, amount, type }] applied at checkout
//   - total_discounts:     gross discount in shop currency
//   - gift_cards:          payment_details / payment_gateway_names
//                          mention of gift_card; not always granular
//   - applied_discounts:   automatic discounts (Buy X Get Y, etc.)
//
// Renders nothing when no discount/gift-card markers are present —
// most Shopify orders go through cleanly without promo, no need to
// show an empty card.
function ShopifyDiscountsCard({ meta }: { meta: any }) {
  const discountCodes: Array<{ code: string; amount: string; type: string }> =
    Array.isArray(meta?.discount_codes) ? meta.discount_codes : []
  const totalDiscounts = Number(meta?.total_discounts ?? 0)
  const giftCardAmount = Number(meta?.total_tip_received ?? 0) // Shopify sometimes folds gift-card credit here
  const gateways: string[] = Array.isArray(meta?.payment_gateway_names)
    ? meta.payment_gateway_names
    : []
  const usedGiftCard = gateways.some((g) => /gift_card|giftcard/i.test(g))
  const appliedDiscounts: Array<{ title?: string; description?: string; value?: string; value_type?: string }> =
    Array.isArray(meta?.discount_applications) ? meta.discount_applications : []

  // Nothing to show? bail.
  const hasContent =
    discountCodes.length > 0 ||
    totalDiscounts > 0 ||
    usedGiftCard ||
    appliedDiscounts.length > 0
  if (!hasContent) return null

  return (
    <Card>
      <div className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-2 inline-flex items-center gap-1.5">
        <DollarSign size={12} /> Shopify promotions
      </div>
      <div className="space-y-2 text-sm">
        {discountCodes.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
              Discount codes
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {discountCodes.map((d, i) => (
                <span
                  key={`${d.code}-${i}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-sm font-mono rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900"
                >
                  {d.code}
                  {d.amount && (
                    <span className="text-xs text-emerald-600 dark:text-emerald-400">
                      −{d.type === 'percentage' ? `${d.amount}%` : `€${Number(d.amount).toFixed(2)}`}
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}
        {appliedDiscounts.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
              Automatic discounts
            </div>
            <ul className="space-y-1">
              {appliedDiscounts.map((a, i) => (
                <li key={i} className="text-slate-700 dark:text-slate-300">
                  {a.title || a.description || 'Automatic discount'}
                  {a.value && (
                    <span className="text-slate-500 dark:text-slate-400 ml-1">
                      ({a.value_type === 'percentage' ? `${a.value}%` : `€${Number(a.value).toFixed(2)}`})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {totalDiscounts > 0 && (
          <div className="text-slate-700 dark:text-slate-300">
            Total discount:{' '}
            <span className="font-semibold tabular-nums">
              €{totalDiscounts.toFixed(2)}
            </span>
          </div>
        )}
        {usedGiftCard && (
          <div className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
            <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold uppercase rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900">
              Gift card used
            </span>
            {giftCardAmount > 0 && (
              <span className="tabular-nums">
                €{giftCardAmount.toFixed(2)}
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

/**
 * OX.12 — cross-channel buyer profile drawer. Slides in from the right
 * with everything we know about the buyer aggregated across Amazon +
 * eBay + Shopify. Replaces the broken inline "10 prior orders" widget
 * with a richer view: lifetime value, return rate, channel mix, last-
 * contact date, and a paginated recent-orders list (50 most recent).
 *
 * Match is by normalized email. Amazon's anonymised marketplace
 * aliases (@marketplace.amazon.it) can still cross-match across
 * orders from the same buyer; eBay/Shopify use real emails so cross-
 * channel matching just works.
 */
function BuyerProfileDrawer({ email, excludeOrderId, onClose }: { email: string; excludeOrderId: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/orders/buyer-profile?email=${encodeURIComponent(email)}&excludeOrderId=${encodeURIComponent(excludeOrderId)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json()
      })
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e?.message ?? 'Failed to load buyer profile') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [email, excludeOrderId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const fmt = (n: number, currency = 'EUR') => {
    const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : ''
    return sym ? `${sym}${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`
  }

  return (
    <div
      className="fixed inset-0 z-[900] bg-slate-900/40 flex justify-end"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <aside
        className="w-full max-w-md h-full bg-white dark:bg-slate-950 border-l border-slate-200 dark:border-slate-700 shadow-2xl overflow-y-auto"
        role="dialog"
        aria-label="Buyer profile"
      >
        <div className="sticky top-0 bg-white dark:bg-slate-950 border-b border-slate-200 dark:border-slate-700 px-4 py-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
              {data?.customerName ?? 'Buyer profile'}
            </h2>
            <div className="text-xs text-slate-500 dark:text-slate-400 inline-flex items-center gap-1 truncate">
              <Mail size={11} /> {email}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
            aria-label="Close buyer profile"
          >
            <XCircle size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {loading && (
            <div className="space-y-2">
              <Skeleton lines={4} />
              <Skeleton lines={6} />
            </div>
          )}
          {error && (
            <div className="text-sm text-rose-600 dark:text-rose-400">Failed to load: {error}</div>
          )}
          {data && !loading && !error && (
            <>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Lifetime value</div>
                  <div className="text-lg tabular-nums font-bold text-slate-900 dark:text-slate-100">{fmt(data.ltv)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Orders</div>
                  <div className="text-lg tabular-nums font-bold text-slate-900 dark:text-slate-100">{data.orderCount.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">AOV</div>
                  <div className="text-sm tabular-nums text-slate-700 dark:text-slate-200">{fmt(data.aov)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Returns</div>
                  <div className="text-sm tabular-nums text-slate-700 dark:text-slate-200">{data.returnsCount}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Refund rate</div>
                  <div className="text-sm tabular-nums text-slate-700 dark:text-slate-200">
                    {(data.refundRate * 100).toFixed(1)}%
                    <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">({data.refundedOrders})</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Last contact</div>
                  <div className="text-sm text-slate-700 dark:text-slate-200">
                    {data.lastOrderAt ? new Date(data.lastOrderAt).toLocaleDateString() : '—'}
                  </div>
                </div>
              </div>

              {Object.keys(data.channels ?? {}).length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">Channel mix</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {Object.entries(data.channels as Record<string, number>).map(([ch, count]) => (
                      <span
                        key={ch}
                        className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 border rounded ${CHANNEL_TONE[ch] ?? 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'}`}
                      >
                        {ch}
                        <span className="font-bold tabular-nums">{count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
                  Recent orders ({data.orders.length})
                </div>
                {data.orders.length === 0 ? (
                  <div className="text-sm text-slate-500 dark:text-slate-400 italic">No other orders from this buyer.</div>
                ) : (
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-700 rounded">
                    {data.orders.map((o: any) => {
                      const d = formatOrderTotal({
                        totalPrice: o.totalPrice,
                        currencyCode: o.currencyCode,
                        status: o.status,
                      })
                      return (
                        <li key={o.id}>
                          <Link
                            href={`/orders/${o.id}`}
                            onClick={onClose}
                            className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1 py-0 border rounded ${CHANNEL_TONE[o.channel] ?? 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                                  {o.channel}
                                </span>
                                <span className="text-sm font-mono text-slate-700 dark:text-slate-300 truncate">{o.channelOrderId}</span>
                              </div>
                              <div className="text-xs text-slate-500 dark:text-slate-400">
                                {o.purchaseDate ? new Date(o.purchaseDate).toLocaleDateString() : new Date(o.createdAt).toLocaleDateString()}
                                <span className="mx-1">·</span>
                                <span>{o.status}</span>
                              </div>
                            </div>
                            {d.kind === 'pending' ? (
                              <span className="text-xs font-medium text-amber-700 dark:text-amber-300 flex-shrink-0">Awaiting payment</span>
                            ) : (
                              <span className="text-sm tabular-nums font-medium text-slate-900 dark:text-slate-100 flex-shrink-0">
                                {d.symbol}{d.amount}{d.trailingCode ? ` ${d.trailingCode}` : ''}
                              </span>
                            )}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              <Link
                href={`/orders?customerEmail=${encodeURIComponent(email)}`}
                onClick={onClose}
                className="block text-sm text-blue-600 dark:text-blue-400 hover:underline"
              >
                View all orders from this buyer in /orders →
              </Link>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

/**
 * OX.11 — Manage Feedback sidebar card. Amazon's "Manage Feedback"
 * surface shows the buyer's seller rating + comment if they've left
 * one, otherwise an empty-state. We don't ingest per-order seller
 * feedback yet (SellerFeedback model exists but is unwired), so this
 * card defaults to empty-state with a Seller-Central deep-link so
 * operators can chase it externally.
 */
function ManageFeedbackCard({ order }: { order: any }) {
  const feedbackUrl =
    order.channel === 'AMAZON' && order.marketplace
      ? `https://sellercentral.amazon.${order.marketplace.toLowerCase()}/feedback-manager/index.html?orderId=${encodeURIComponent(order.channelOrderId)}`
      : null
  return (
    <Card title="Manage Feedback">
      <div className="text-sm text-slate-600 dark:text-slate-400">
        {order.customerName ?? 'Buyer'} has not left you feedback for this order yet.
      </div>
      {feedbackUrl && (
        <a
          href={feedbackUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          Open in Seller Central →
        </a>
      )}
    </Card>
  )
}

/**
 * OX.10 — sales proceeds sidebar card. Amazon Seller Central shows:
 *
 *   Payment methods: Standard
 *   ────────────────────────────────
 *   Items total:             €105.00
 *     Items total — Incl VAT:  €18.93
 *   Grand total:             €105.00
 *     Grand total — Incl VAT:  €18.93
 *
 * Plus an expandable fee-breakdown panel when FinancialTransaction
 * rows exist (Amazon fee, FBA fee, payment fee, refund).
 *
 * Math: prices stored are VAT-inclusive (matches SP-API B2C). VAT-
 * excl = price / (1 + rate/100). Default rate = 22% (IT) or 0% (non-IT).
 */
function SalesProceedsCard({ order, financials }: { order: any; financials: any }) {
  const isIT = order.marketplace === 'IT'
  const items: any[] = order.items ?? []
  let itemsTotalIncl = 0
  let itemsVatTotal = 0
  for (const it of items) {
    const rate = it.itVatRatePct == null ? (isIT ? 22 : 0) : Number(it.itVatRatePct)
    const incl = Number(it.price) * it.quantity
    const excl = rate > 0 ? incl / (1 + rate / 100) : incl
    itemsTotalIncl += incl
    itemsVatTotal += incl - excl
  }
  const grandTotalIncl = Number(order.totalPrice ?? itemsTotalIncl)
  // Best-effort grand-total VAT: scale per-item VAT to the grand-total
  // when shipping is rolled into totalPrice (Amazon's behaviour).
  const grandTotalVat = itemsTotalIncl > 0 ? (itemsVatTotal / itemsTotalIncl) * grandTotalIncl : 0

  const paymentMethod = order.amazonMetadata?.PaymentMethod ?? 'Standard'
  const symbol = order.currencyCode === 'EUR' || !order.currencyCode ? '€' : ''
  const fmt = (n: number) => `${symbol}${n.toFixed(2)}${order.currencyCode && order.currencyCode !== 'EUR' ? ` ${order.currencyCode}` : ''}`

  // Fee breakdown rolled up across financial transactions
  const feeRollup = financials?.transactions?.reduce(
    (acc: any, tx: any) => {
      acc.amazonFee += Number(tx.amazonFee ?? 0)
      acc.fbaFee += Number(tx.fbaFee ?? 0)
      acc.paymentServicesFee += Number(tx.paymentServicesFee ?? 0)
      acc.ebayFee += Number(tx.ebayFee ?? 0)
      acc.paypalFee += Number(tx.paypalFee ?? 0)
      acc.otherFees += Number(tx.otherFees ?? 0)
      return acc
    },
    { amazonFee: 0, fbaFee: 0, paymentServicesFee: 0, ebayFee: 0, paypalFee: 0, otherFees: 0 },
  )
  const hasFees = feeRollup && Object.values(feeRollup as Record<string, number>).some((v) => v > 0)

  return (
    <Card title="Sales proceeds">
      <div className="space-y-3 text-sm">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-slate-500 dark:text-slate-400">Payment methods:</span>
          <span className="text-slate-700 dark:text-slate-200">{paymentMethod}</span>
        </div>

        <div className="pt-2 border-t border-slate-200 dark:border-slate-700 space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-slate-700 dark:text-slate-200">Items total:</span>
            <span className="tabular-nums font-medium text-slate-900 dark:text-slate-100">{fmt(itemsTotalIncl)}</span>
          </div>
          {isIT && itemsVatTotal > 0 && (
            <div className="flex items-baseline justify-between gap-2 pl-3">
              <span className="text-xs text-slate-500 dark:text-slate-400">Items total — Included VAT:</span>
              <span className="text-xs tabular-nums text-slate-600 dark:text-slate-400">{fmt(itemsVatTotal)}</span>
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-slate-200 dark:border-slate-700 space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-base font-semibold text-slate-900 dark:text-slate-100">Grand total:</span>
            <span className="text-base tabular-nums font-bold text-slate-900 dark:text-slate-100">{fmt(grandTotalIncl)}</span>
          </div>
          {isIT && grandTotalVat > 0 && (
            <div className="flex items-baseline justify-between gap-2 pl-3">
              <span className="text-xs text-slate-500 dark:text-slate-400">Grand total — Included VAT:</span>
              <span className="text-xs tabular-nums text-slate-600 dark:text-slate-400">{fmt(grandTotalVat)}</span>
            </div>
          )}
        </div>

        {hasFees && (
          <details className="pt-2 border-t border-slate-200 dark:border-slate-700">
            <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold hover:text-slate-900 dark:hover:text-slate-100">
              Fee breakdown
            </summary>
            <div className="mt-2 space-y-1 pl-3">
              {feeRollup.amazonFee > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Amazon referral:</span>
                  <span className="tabular-nums text-rose-700 dark:text-rose-300">-{fmt(feeRollup.amazonFee)}</span>
                </div>
              )}
              {feeRollup.fbaFee > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500 dark:text-slate-400">FBA fee:</span>
                  <span className="tabular-nums text-rose-700 dark:text-rose-300">-{fmt(feeRollup.fbaFee)}</span>
                </div>
              )}
              {feeRollup.paymentServicesFee > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Payment services:</span>
                  <span className="tabular-nums text-rose-700 dark:text-rose-300">-{fmt(feeRollup.paymentServicesFee)}</span>
                </div>
              )}
              {feeRollup.ebayFee > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500 dark:text-slate-400">eBay fee:</span>
                  <span className="tabular-nums text-rose-700 dark:text-rose-300">-{fmt(feeRollup.ebayFee)}</span>
                </div>
              )}
              {feeRollup.paypalFee > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500 dark:text-slate-400">PayPal fee:</span>
                  <span className="tabular-nums text-rose-700 dark:text-rose-300">-{fmt(feeRollup.paypalFee)}</span>
                </div>
              )}
              {feeRollup.otherFees > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Other fees:</span>
                  <span className="tabular-nums text-rose-700 dark:text-rose-300">-{fmt(feeRollup.otherFees)}</span>
                </div>
              )}
              {financials?.rollup?.net != null && (
                <div className="flex justify-between text-xs pt-1 mt-1 border-t border-slate-200 dark:border-slate-700">
                  <span className="text-slate-700 dark:text-slate-200 font-medium">Net proceeds:</span>
                  <span className="tabular-nums font-semibold text-emerald-700 dark:text-emerald-300">{fmt(Number(financials.rollup.net))}</span>
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    </Card>
  )
}

/**
 * OX.9 — per-package section. One Amazon-style "Package N" panel per
 * Shipment row, with per-parcel actions (Edit consignment + Print
 * packing slip) and a per-package item table showing which SKUs from
 * the order went in that physical parcel.
 *
 * Reuses the existing /fulfillment/shipments/:id/pack-slip endpoint
 * for the per-package slip; Edit consignment deep-links to
 * /fulfillment/outbound?id=... where the consignment editor lives.
 */
function PackageSection({ idx, shipment, order }: { idx: number; shipment: any; order: any }) {
  // Map ShipmentItem.orderItemId back to OrderItem so we can show
  // product names (SKUs alone are operator-hostile for long catalogs).
  const orderItemsById = new Map<string, any>(
    (order.items ?? []).map((it: any) => [it.id, it]),
  )
  const fmtDateTime = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null

  const dispatchFrom = shipment.warehouse?.code ?? shipment.warehouse?.name ?? '—'
  const totalUnits = (shipment.items ?? []).reduce((sum: number, i: any) => sum + (i.quantity ?? 0), 0)

  return (
    <Card title={`Package ${idx + 1}`} description={`${shipment.items?.length ?? 0} SKU${shipment.items?.length === 1 ? '' : 's'} · ${totalUnits} unit${totalUnits === 1 ? '' : 's'}`}>
      {/* Per-parcel action bar — Amazon's "Action on parcel N" row */}
      <div className="flex items-center gap-2 pb-3 mb-3 border-b border-slate-200 dark:border-slate-700 flex-wrap">
        <span className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold">
          Action on parcel {idx + 1}:
        </span>
        <Link
          href={`/fulfillment/outbound?id=${shipment.id}`}
          className="h-7 px-2.5 text-xs text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
        >
          Edit consignment
        </Link>
        <a
          href={`${getBackendUrl()}/api/fulfillment/shipments/${shipment.id}/pack-slip.html`}
          target="_blank"
          rel="noopener noreferrer"
          className="h-7 px-2.5 text-xs text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
        >
          Print packing slip
        </a>
        <div className="ml-auto">
          <Badge variant="info" size="sm">{shipment.status?.replace(/_/g, ' ')}</Badge>
        </div>
      </div>

      {/* Shipment metadata block */}
      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-y-1.5 gap-x-4 text-sm mb-3">
        <div className="flex items-baseline gap-2">
          <dt className="text-slate-500 dark:text-slate-400">Ship date:</dt>
          <dd className="text-slate-700 dark:text-slate-200">{fmtDateTime(shipment.shippedAt) ?? '—'}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-slate-500 dark:text-slate-400">Shipping Carrier:</dt>
          <dd className="text-slate-700 dark:text-slate-200">{shipment.carrierCode ?? '—'}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-slate-500 dark:text-slate-400">Shipping service:</dt>
          <dd className="text-slate-700 dark:text-slate-200">{shipment.serviceName ?? shipment.serviceCode ?? '—'}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-slate-500 dark:text-slate-400">Tracking ID:</dt>
          <dd className="text-slate-700 dark:text-slate-200 font-mono break-all">
            {shipment.trackingUrl ? (
              <a href={shipment.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
                {shipment.trackingNumber ?? '—'}
              </a>
            ) : (
              shipment.trackingNumber ?? '—'
            )}
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-slate-500 dark:text-slate-400">Dispatch from:</dt>
          <dd className="text-slate-700 dark:text-slate-200 font-mono">{dispatchFrom}</dd>
        </div>
        {shipment.deliveredAt && (
          <div className="flex items-baseline gap-2">
            <dt className="text-slate-500 dark:text-slate-400">Delivered:</dt>
            <dd className="text-slate-700 dark:text-slate-200">{fmtDateTime(shipment.deliveredAt)}</dd>
          </div>
        )}
      </dl>

      {/* Per-package item table */}
      {shipment.items && shipment.items.length > 0 && (
        <div className="border border-slate-200 dark:border-slate-700 rounded overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
              <tr className="text-left text-xs uppercase tracking-wider text-slate-600 dark:text-slate-400 font-semibold">
                <th className="px-3 py-2">Product name</th>
                <th className="px-3 py-2 font-mono normal-case">SKU</th>
                <th className="px-3 py-2 text-right">Quantity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {shipment.items.map((si: any) => {
                const oi = si.orderItemId ? orderItemsById.get(si.orderItemId) : null
                const name = oi?.product?.name ?? null
                return (
                  <tr key={si.id} className="align-top">
                    <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                      {name ?? <span className="italic text-slate-500 dark:text-slate-400">{si.sku}</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-400 font-mono">{si.sku}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-900 dark:text-slate-100">
                      {si.quantity}
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

/**
 * OX.8 — Italian-fiscal-compliant order contents table.
 *
 *   Status · Image · Product name (+ASIN +SKU +Order Item ID +Condition)
 *          · Qty · Unit price (VAT excl) · Unit price (VAT incl) · Proceeds
 *
 * Why both VAT columns: Italian B2B/B2C sellers MUST display VAT-
 * exclusive AND VAT-inclusive prices on order detail / invoice
 * surfaces (DPR 633/72). Amazon's Seller Central shows both. Our prior
 * single-price card was non-compliant for IT.
 *
 * Price stored is VAT-inclusive (Amazon SP-API returns Italian B2C
 * order totals VAT-incl). VAT-excl is derived: price / (1 + rate/100).
 * Default rate = 22% (Italian standard) when itVatRatePct is not set;
 * operators can override per-line via the inline rate selector.
 *
 * Non-IT marketplaces render the same table but VAT cols collapse to
 * a single "Unit price" column (no VAT split exists for those rows).
 */
function OrderContentsTable({ order, onItemChanged }: { order: any; onItemChanged: () => void }) {
  const isIT = order.marketplace === 'IT'
  const items: any[] = order.items ?? []

  let subtotalIncl = 0
  let subtotalExcl = 0
  let vatTotal = 0
  for (const it of items) {
    const rate = it.itVatRatePct == null ? (isIT ? 22 : 0) : Number(it.itVatRatePct)
    const incl = Number(it.price) * it.quantity
    const excl = rate > 0 ? incl / (1 + rate / 100) : incl
    subtotalIncl += incl
    subtotalExcl += excl
    vatTotal += incl - excl
  }
  const fmt = (n: number) => `€${n.toFixed(2)}`

  return (
    <Card title="Order contents" description={`${items.length} line${items.length === 1 ? '' : 's'}`} noPadding>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
            <tr className="text-left text-xs uppercase tracking-wider text-slate-600 dark:text-slate-400 font-semibold">
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Image</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2 text-right">Qty</th>
              {isIT && <th className="px-3 py-2 text-right">VAT %</th>}
              <th className="px-3 py-2 text-right">
                Unit price
                {isIT && <div className="text-[10px] normal-case font-normal text-slate-500">(VAT excl)</div>}
              </th>
              {isIT && (
                <th className="px-3 py-2 text-right">
                  Unit price
                  <div className="text-[10px] normal-case font-normal text-slate-500">(VAT incl)</div>
                </th>
              )}
              <th className="px-3 py-2 text-right">Proceeds</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((it: any) => {
              const rate = it.itVatRatePct == null ? (isIT ? 22 : 0) : Number(it.itVatRatePct)
              const unitIncl = Number(it.price)
              const unitExcl = rate > 0 ? unitIncl / (1 + rate / 100) : unitIncl
              const lineIncl = unitIncl * it.quantity
              return (
                <tr key={it.id} className="hover:bg-slate-50 dark:hover:bg-slate-800 align-top">
                  <td className="px-3 py-2.5">
                    <Badge variant={STATUS_VARIANT[order.status] ?? 'default'} size="sm">
                      {order.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    {it.product?.thumbnailUrl ? (
                      <img
                        src={it.product.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        className="w-12 h-12 rounded object-cover bg-slate-100 dark:bg-slate-800"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500">
                        <Package size={14} />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 min-w-0 max-w-md">
                    {it.product ? (
                      <Link
                        href={`/products/${it.productId}/edit`}
                        className="text-sm font-medium text-slate-900 dark:text-slate-100 hover:text-blue-600 line-clamp-2"
                      >
                        {it.product.name}
                      </Link>
                    ) : (
                      <div className="text-sm text-slate-700 dark:text-slate-300">{it.sku}</div>
                    )}
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 space-y-0.5 font-mono">
                      {it.product?.amazonAsin && (
                        <div>
                          <span className="not-italic text-slate-400">ASIN:</span> {it.product.amazonAsin}
                        </div>
                      )}
                      <div>
                        <span className="not-italic text-slate-400">SKU:</span> {it.sku}
                      </div>
                      {it.externalLineItemId && (
                        <div>
                          <span className="not-italic text-slate-400">Order Item ID:</span> {it.externalLineItemId}
                        </div>
                      )}
                      <div>
                        <span className="not-italic text-slate-400">Condition:</span> New
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
                    {it.quantity}
                  </td>
                  {isIT && (
                    <td className="px-3 py-2.5 text-right">
                      <select
                        value={it.itVatRatePct == null ? '' : String(it.itVatRatePct)}
                        onChange={async (e) => {
                          const raw = e.target.value
                          const rateNext = raw === '' ? null : Number(raw)
                          try {
                            const res = await fetch(
                              `${getBackendUrl()}/api/orders/${order.id}/items/${it.id}/vat`,
                              {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ rate: rateNext }),
                              },
                            )
                            if (!res.ok) throw new Error(await res.text())
                            window.dispatchEvent(
                              new CustomEvent('nexus:toast', {
                                detail: { kind: 'success', text: `VAT updated to ${rateNext ?? 'default'}%` },
                              }),
                            )
                            onItemChanged()
                          } catch (err: any) {
                            window.dispatchEvent(
                              new CustomEvent('nexus:toast', { detail: { kind: 'error', text: err.message } }),
                            )
                          }
                        }}
                        title="Italian VAT rate for this line"
                        className="h-7 px-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded tabular-nums bg-white dark:bg-slate-900"
                      >
                        <option value="">22% (default)</option>
                        <option value="22">22%</option>
                        <option value="10">10%</option>
                        <option value="4">4%</option>
                        <option value="0">0% (esente)</option>
                      </select>
                    </td>
                  )}
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
                    {fmt(unitExcl)}
                  </td>
                  {isIT && (
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {fmt(unitIncl)}
                    </td>
                  )}
                  <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                    {fmt(lineIncl)}
                    {isIT && (
                      <div className="text-xs text-slate-500 dark:text-slate-400 font-normal">
                        incl. VAT {fmt(unitIncl * it.quantity - unitExcl * it.quantity)}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot className="bg-slate-50 dark:bg-slate-900 border-t-2 border-slate-200 dark:border-slate-700">
            <tr>
              <td colSpan={isIT ? 4 : 3} className="px-3 py-2.5 text-right text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                Item subtotal
              </td>
              {isIT && <td />}
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">{fmt(subtotalExcl)}</td>
              {isIT && <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">{fmt(subtotalIncl)}</td>}
              <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                {fmt(subtotalIncl)}
                {isIT && (
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-normal">
                    incl. VAT {fmt(vatTotal)}
                  </div>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  )
}

/**
 * OX.7 — three-card summary block matching Amazon Seller Central.
 *
 *   ┌─────────────────┬─────────────────┬───────────────────────┐
 *   │ Order summary   │ Ship to         │ Shipping Service      │
 *   │                 │                 │ for Delivery Promise  │
 *   └─────────────────┴─────────────────┴───────────────────────┘
 *
 * Data sources:
 *   • Order summary: Order.shipByDate, latestDeliveryDate, purchaseDate,
 *     fulfillmentMethod, marketplace + amazonMetadata.ShipmentServiceLevelCategory
 *   • Ship to: Order.shippingAddress JSON (name + street + city + postal
 *     + country + phone). Contact-Buyer link deep-links to Seller Central
 *     messaging for Amazon orders.
 *   • Delivery Promise: first Shipment's carrierCode + serviceName, with
 *     fallback to Amazon's promised ShipServiceLevel when nothing has
 *     been booked yet.
 */
const OX7_MARKETPLACE_FLAGS: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', UK: '🇬🇧', GB: '🇬🇧',
  NL: '🇳🇱', PL: '🇵🇱', SE: '🇸🇪', IE: '🇮🇪', BE: '🇧🇪', SA: '🇸🇦',
  AE: '🇦🇪', TR: '🇹🇷', US: '🇺🇸', CA: '🇨🇦', JP: '🇯🇵',
}

function OrderSummaryTriptych({ order }: { order: any }) {
  const addr = order.shippingAddress ?? {}
  const meta = order.amazonMetadata ?? {}
  const shipmentServiceLevel = meta.ShipmentServiceLevelCategory ?? meta.ShipServiceLevel ?? null
  const firstShipment = order.shipments?.[0] ?? null
  const marketplaceFlag = order.marketplace ? OX7_MARKETPLACE_FLAGS[order.marketplace] ?? '' : ''
  const channelLabel =
    order.channel === 'AMAZON' && order.marketplace
      ? `Amazon.${order.marketplace.toLowerCase()}`
      : order.channel.charAt(0) + order.channel.slice(1).toLowerCase()

  const fmtDate = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : null
  const fmtDateTime = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null

  // Ship-by urgency tone (matches the list row)
  let shipByTone = 'text-slate-700 dark:text-slate-200'
  if (order.shipByDate && order.status !== 'SHIPPED' && order.status !== 'DELIVERED' && order.status !== 'CANCELLED') {
    const remainingHours = (new Date(order.shipByDate).getTime() - Date.now()) / 3_600_000
    if (remainingHours < 0) shipByTone = 'text-rose-600 dark:text-rose-400 font-semibold'
    else if (remainingHours < 24) shipByTone = 'text-amber-600 dark:text-amber-400 font-semibold'
  }

  const phone: string | null = addr.phone ?? addr.Phone ?? null
  const street: string | null = addr.AddressLine1 ?? addr.street ?? addr.address1 ?? null
  const street2: string | null = addr.AddressLine2 ?? addr.street2 ?? addr.address2 ?? null
  const city: string | null = addr.City ?? addr.city ?? null
  const postal: string | null = addr.PostalCode ?? addr.postalCode ?? addr.zip ?? null
  const state: string | null = addr.StateOrRegion ?? addr.state ?? addr.region ?? null
  const country: string | null = addr.CountryCode ?? addr.country ?? null
  const recipient: string | null = addr.Name ?? addr.name ?? order.customerName

  // Contact Buyer deep-link — Amazon Seller Central messaging
  const contactBuyerUrl =
    order.channel === 'AMAZON' && order.marketplace
      ? `https://sellercentral.amazon.${order.marketplace.toLowerCase()}/messaging/inbox?orderId=${encodeURIComponent(order.channelOrderId)}`
      : null

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Order summary card */}
      <Card title="Order summary">
        <dl className="space-y-1.5 text-sm">
          {order.shipByDate && (
            <div className="flex items-baseline gap-2">
              <dt className="w-24 shrink-0 text-slate-500 dark:text-slate-400">Ship by:</dt>
              <dd className={shipByTone}>{fmtDate(order.shipByDate)}</dd>
            </div>
          )}
          {order.latestDeliveryDate && (
            <div className="flex items-baseline gap-2">
              <dt className="w-24 shrink-0 text-slate-500 dark:text-slate-400">Deliver by:</dt>
              <dd className="text-slate-700 dark:text-slate-200">{fmtDate(order.latestDeliveryDate)}</dd>
            </div>
          )}
          <div className="flex items-baseline gap-2">
            <dt className="w-24 shrink-0 text-slate-500 dark:text-slate-400">Purchase date:</dt>
            <dd className="text-slate-700 dark:text-slate-200">{fmtDateTime(order.purchaseDate ?? order.createdAt)}</dd>
          </div>
          {shipmentServiceLevel && (
            <div className="flex items-baseline gap-2">
              <dt className="w-24 shrink-0 text-slate-500 dark:text-slate-400">Shipping:</dt>
              <dd className="text-slate-700 dark:text-slate-200">{shipmentServiceLevel}</dd>
            </div>
          )}
          {order.fulfillmentMethod && (
            <div className="flex items-baseline gap-2">
              <dt className="w-24 shrink-0 text-slate-500 dark:text-slate-400">Fulfilment:</dt>
              <dd className="text-slate-700 dark:text-slate-200">
                {order.fulfillmentMethod === 'FBA' ? 'Fulfilled by Amazon' : 'Seller fulfilled'}
              </dd>
            </div>
          )}
          <div className="flex items-baseline gap-2">
            <dt className="w-24 shrink-0 text-slate-500 dark:text-slate-400">Sales channel:</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {channelLabel} {marketplaceFlag && <span aria-hidden="true">{marketplaceFlag}</span>}
            </dd>
          </div>
        </dl>
      </Card>

      {/* Ship to card */}
      <Card title="Ship to">
        <div className="text-sm space-y-0.5">
          {recipient && <div className="font-semibold text-slate-900 dark:text-slate-100">{recipient}</div>}
          {street && <div className="text-slate-700 dark:text-slate-300">{street}</div>}
          {street2 && <div className="text-slate-700 dark:text-slate-300">{street2}</div>}
          {(city || state || postal) && (
            <div className="text-slate-700 dark:text-slate-300">
              {[city, state, postal].filter(Boolean).join(', ')}
            </div>
          )}
          {country && <div className="text-slate-700 dark:text-slate-300">{country}</div>}
        </div>
        <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700 space-y-1.5 text-sm">
          {contactBuyerUrl ? (
            <a
              href={contactBuyerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-blue-600 dark:text-blue-400 hover:underline"
            >
              <Mail size={12} /> Contact Buyer
            </a>
          ) : (
            order.customerEmail && (
              <a
                href={`mailto:${order.customerEmail}`}
                className="inline-flex items-center gap-1.5 text-blue-600 dark:text-blue-400 hover:underline"
              >
                <Mail size={12} /> {order.customerEmail}
              </a>
            )
          )}
          {phone && (
            <div className="text-slate-700 dark:text-slate-200">
              <span className="text-slate-500 dark:text-slate-400">Phone:</span>{' '}
              <span className="font-mono">{phone}</span>
            </div>
          )}
        </div>
      </Card>

      {/* Shipping Service for Delivery Promise card */}
      <Card title="Shipping Service" description="Used to calculate Delivery Promise">
        {firstShipment ? (
          <dl className="space-y-1.5 text-sm">
            <div className="flex items-baseline gap-2">
              <dt className="w-20 shrink-0 text-slate-500 dark:text-slate-400">Carrier:</dt>
              <dd className="text-slate-700 dark:text-slate-200">{firstShipment.carrierCode ?? '—'}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="w-20 shrink-0 text-slate-500 dark:text-slate-400">Service:</dt>
              <dd className="text-slate-700 dark:text-slate-200">{firstShipment.serviceName ?? firstShipment.serviceCode ?? '—'}</dd>
            </div>
            {firstShipment.trackingNumber && (
              <div className="flex items-baseline gap-2">
                <dt className="w-20 shrink-0 text-slate-500 dark:text-slate-400">Tracking:</dt>
                <dd className="text-slate-700 dark:text-slate-200 font-mono break-all">{firstShipment.trackingNumber}</dd>
              </div>
            )}
          </dl>
        ) : shipmentServiceLevel ? (
          <div className="text-sm text-slate-700 dark:text-slate-200 space-y-1">
            <div>
              <span className="text-slate-500 dark:text-slate-400">Promised:</span> {shipmentServiceLevel}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 italic">
              No shipment booked yet — carrier will appear here once a parcel is created.
            </div>
          </div>
        ) : (
          <div className="text-sm text-slate-500 dark:text-slate-400 italic">
            No shipment information available.
          </div>
        )}
      </Card>
    </div>
  )
}
