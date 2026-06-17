'use client'

/**
 * O.8e — final monolith extraction. The Grid lens is the dense
 * order list: filterable, sortable, columns customizable
 * (localStorage-persisted), with the BulkActionBar floating on
 * row selection. OrderCell is the per-column renderer; the
 * ColumnPickerMenu is the visible-columns dropdown.
 *
 * Both helpers are internal to GridLens — no other lens needs
 * them — so they live here rather than in _components/. If a
 * future surface (e.g. /customers detail's "recent orders" panel)
 * wants the same row shape, lift OrderCell out then.
 *
 * URL state stays in OrdersWorkspace; this lens just receives the
 * already-fetched orders + the URL-update callbacks.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { ChevronDown, ChevronRight, ExternalLink, Settings2, ShoppingCart } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useTranslations } from '@/lib/i18n/use-translations'
import { ALL_COLUMNS, DEFAULT_VISIBLE, type OrderColumn } from '../_lib/columns'
import { deepLinkForOrder } from '../_lib/deep-links'
import { formatOrderTotal } from '../_lib/money'
import {
  channelTone,
  REVIEW_STATUS_TONE,
  STATUS_VARIANT,
} from '../_lib/tone'

type Tag = { id: string; name: string; color: string | null }
type ReviewRequest = { id: string; channel: string; status: string; sentAt: string | null; scheduledFor: string | null }

export type GridOrder = {
  id: string
  channel: string
  marketplace: string | null
  channelOrderId: string
  status: string
  fulfillmentMethod: string | null
  totalPrice: number
  currencyCode: string | null
  customerName: string
  customerEmail: string
  purchaseDate: string | null
  createdAt: string
  itemCount: number
  hasActiveReturn?: boolean
  hasRefund?: boolean
  customerOrderCount: number
  reviewRequests: ReviewRequest[]
  tags?: Tag[]
  // OX.4 — added for the Amazon-parity row layout
  shipByDate?: string | null
  latestDeliveryDate?: string | null
  isPrime?: boolean | null
  isBusinessOrder?: boolean
  firstItem?: {
    sku: string
    quantity: number
    price: number
    subtotal: number
    productName: string | null
    amazonAsin: string | null
    thumbnailUrl: string | null
  } | null
}

interface GridLensProps {
  orders: GridOrder[]
  loading: boolean
  error: string | null
  page: number
  pageSize: number
  totalPages: number
  total: number
  visibleColumns: string[]
  setVisibleColumns: (v: string[]) => void
  columnPickerOpen: boolean
  setColumnPickerOpen: (v: boolean) => void
  sortBy: string
  sortDir: 'asc' | 'desc'
  onSort: (key: string) => void
  selected: Set<string>
  setSelected: (next: Set<string>) => void
  /** O.14 — keyboard-focused row, -1 when no row is focused. */
  activeRowIndex?: number
  onPage: (p: number) => void
  onPageSize: (s: number) => void
}

export function GridLens(props: GridLensProps) {
  const { t } = useTranslations()
  const {
    orders,
    loading,
    error,
    page,
    pageSize,
    totalPages,
    total,
    visibleColumns,
    setVisibleColumns,
    columnPickerOpen,
    setColumnPickerOpen,
    sortBy,
    sortDir,
    onSort,
    selected,
    setSelected,
    activeRowIndex = -1,
    onPage,
    onPageSize,
  } = props
  const visible = useMemo(
    () =>
      ALL_COLUMNS.filter(
        (c) => visibleColumns.includes(c.key) || c.locked,
      ),
    [visibleColumns],
  )
  // CR.2 — per-column width overrides, keyed by column.key. Persists
  // in localStorage so a resize survives reload. Auto when missing —
  // the column's default `width` from columns.ts is used. Mirrors the
  // /fulfillment/stock CR.1 pattern; could share a hook later if a
  // third surface needs it.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('orders.columnWidths')
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') {
        const valid: Record<string, number> = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (
            ALL_COLUMNS.some((col) => col.key === k) &&
            typeof v === 'number' &&
            v >= 40 &&
            v <= 800
          ) {
            valid[k] = v
          }
        }
        setColumnWidths(valid)
      }
    } catch {
      /* ignore */
    }
  }, [])
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'orders.columnWidths',
        JSON.stringify(columnWidths),
      )
    } catch {
      /* ignore */
    }
  }, [columnWidths])
  const widthFor = (col: OrderColumn) => columnWidths[col.key] ?? col.width
  const onResizeColumn = (key: string, width: number) =>
    setColumnWidths((prev) => ({ ...prev, [key]: width }))
  const onResetColumn = (key: string) =>
    setColumnWidths((prev) => {
      const { [key]: _omit, ...rest } = prev
      return rest
    })
  const allSelected =
    orders.length > 0 && orders.every((o) => selected.has(o.id))
  const toggleSelectAll = () => {
    const next = new Set<string>(selected)
    if (allSelected) orders.forEach((o) => next.delete(o.id))
    else orders.forEach((o) => next.add(o.id))
    setSelected(next)
  }
  const toggleSelect = (id: string) => {
    const next = new Set<string>(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  if (loading && orders.length === 0)
    return (
      <Card>
        <Skeleton lines={8} />
      </Card>
    )
  if (error)
    return (
      <Card>
        <div className="text-md text-rose-600 dark:text-rose-400 py-8 text-center">
          Failed to load: {error}
        </div>
      </Card>
    )
  if (orders.length === 0)
    return (
      <EmptyState
        icon={ShoppingCart}
        title={t('orders.empty.grid.title')}
        description={t('orders.empty.grid.description')}
      />
    )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {t('orders.pagination.summary', { total, page, totalPages })}
          </span>
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            className="h-7 px-2 text-sm border border-default dark:border-slate-700 rounded"
          >
            {[25, 50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {t('orders.pagination.pageSize', { n })}
              </option>
            ))}
          </select>
        </div>
        <div className="relative">
          <button
            onClick={() => setColumnPickerOpen(!columnPickerOpen)}
            className="h-7 px-2 text-base border border-default dark:border-slate-700 rounded inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Settings2 size={12} />{' '}
            {t('orders.columns.button', { n: visibleColumns.length })}
          </button>
          {columnPickerOpen && (
            <ColumnPickerMenu
              visible={visibleColumns}
              setVisible={setVisibleColumns}
              onClose={() => setColumnPickerOpen(false)}
            />
          )}
        </div>
      </div>

      <Card noPadding>
        <div className="overflow-x-auto">
          <table
            className="w-full text-md"
            role="grid"
            aria-label={t('orders.title')}
            aria-rowcount={total}
          >
            <thead className="border-b border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800 sticky top-0 z-10">
              <tr role="row">
                {visible.map((col) => {
                  const sortMap: Record<string, string> = {
                    date: 'purchaseDate',
                    customer: 'customer',
                    total: 'totalPrice',
                    status: 'status',
                  }
                  const isSortable = sortMap[col.key] != null
                  const isSorted = isSortable && sortBy === sortMap[col.key]
                  const ariaSort: 'ascending' | 'descending' | 'none' | undefined =
                    isSortable
                      ? isSorted
                        ? sortDir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      : undefined
                  const width = widthFor(col)
                  // CR.2 — locked columns (select, channel, orderId,
                  // actions) skip the resize handle. The select column
                  // is the only one with no visible label; layout
                  // would render the handle floating in dead space.
                  const showResize = !col.locked
                  const isSticky = col.key === 'actions'
                  return (
                    <th
                      key={col.key}
                      role="columnheader"
                      scope="col"
                      aria-sort={ariaSort}
                      style={{
                        width,
                        minWidth: width,
                        ...(isSticky
                          ? { position: 'sticky' as const, right: 0, zIndex: 11 }
                          : {}),
                      }}
                      className={`px-3 py-2 text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 text-left relative group ${
                        isSortable ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700' : ''
                      } ${isSticky ? 'bg-slate-50 dark:bg-slate-800 shadow-[-4px_0_8px_-4px_rgba(15,23,42,0.08)]' : ''}`}
                      onClick={() => {
                        if (sortMap[col.key]) onSort(sortMap[col.key])
                      }}
                    >
                      {col.key === 'select' ? (
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleSelectAll}
                          aria-label={
                            allSelected
                              ? 'Deselect all visible orders'
                              : 'Select all visible orders'
                          }
                        />
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {isSorted && (
                            <span
                              className="text-tertiary dark:text-slate-500"
                              aria-hidden="true"
                            >
                              {sortDir === 'asc' ? '↑' : '↓'}
                            </span>
                          )}
                        </span>
                      )}
                      {showResize && (
                        <OrdersResizeHandle
                          columnKey={col.key}
                          currentWidth={columnWidths[col.key]}
                          onResize={onResizeColumn}
                          onReset={onResetColumn}
                        />
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {orders.map((o, idx) => {
                const isSelected = selected.has(o.id)
                const isFocused = idx === activeRowIndex
                return (
                  <tr
                    key={o.id}
                    role="row"
                    aria-selected={isSelected}
                    aria-current={isFocused ? 'true' : undefined}
                    className={`border-b border-subtle dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 ${
                      isSelected ? 'bg-blue-50/30' : ''
                    } ${
                      isFocused
                        ? 'outline outline-2 outline-blue-500 outline-offset-[-2px]'
                        : ''
                    }`}
                  >
                    {visible.map((col) => {
                      const w = widthFor(col)
                      const isSticky = col.key === 'actions'
                      // OX.4 follow-up — sticky right-pinned action column.
                      // Background tracks hover/selected so the underlying
                      // row doesn't bleed through the sticky cell.
                      const stickyBg = isSelected
                        ? 'bg-blue-50 dark:bg-blue-950/40'
                        : isFocused
                        ? 'bg-white dark:bg-slate-900'
                        : 'bg-white dark:bg-slate-900 group-hover:bg-slate-50'
                      return (
                        <td
                          key={col.key}
                          className={`px-3 py-2 align-middle ${
                            isSticky ? `${stickyBg} shadow-[-4px_0_8px_-4px_rgba(15,23,42,0.08)]` : ''
                          }`}
                          style={{
                            width: w,
                            minWidth: w,
                            ...(isSticky
                              ? { position: 'sticky' as const, right: 0, zIndex: 5 }
                              : {}),
                          }}
                        >
                          <OrderCell
                            col={col.key}
                            order={o}
                            isSelected={isSelected}
                            onToggle={() => toggleSelect(o.id)}
                          />
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-base text-slate-500 dark:text-slate-400">
          <span className="tabular-nums">
            {t('orders.pagination.pageOf', { page, totalPages })}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="h-7 px-3 border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('orders.pagination.previous')}
            </button>
            <button
              onClick={() => onPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="h-7 px-3 border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('orders.pagination.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * OX.18 — colored FBM/FBA pill. Solid Amazon-style coloring (amber for
 * FBA, blue for FBM) so operators can spot fulfilment method at a
 * glance in dense lists. Used in:
 *   - row Order details cell (replaces plain "Fulfilment: FBM" text)
 *   - legacy `fulfillment` column case
 *   - detail-page header badge
 *   - OrderSummaryTriptych "Fulfilment" line
 */
export function FulfillmentPill({ method }: { method: string }) {
  const tone =
    method === 'FBA'
      ? 'bg-amber-500 text-white border-amber-600'
      : method === 'FBM'
      ? 'bg-blue-600 text-white border-blue-700'
      : 'bg-slate-200 text-slate-700 border-slate-300'
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0 h-5 text-[10px] font-bold uppercase tracking-wider border rounded ${tone}`}
      title={method === 'FBA' ? 'Fulfilled by Amazon' : method === 'FBM' ? 'Seller fulfilled' : method}
    >
      {method}
    </span>
  )
}

// OX.4 — flag emojis for the marketplaces Xavia sells on. Used in the
// "Order details" cell to mirror Amazon Seller Central's "Sales channel"
// line (e.g. "Amazon.it 🇮🇹"). Falls back to no flag for unknown codes.
const MARKETPLACE_FLAGS: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', UK: '🇬🇧', GB: '🇬🇧',
  NL: '🇳🇱', PL: '🇵🇱', SE: '🇸🇪', IE: '🇮🇪', BE: '🇧🇪', SA: '🇸🇦',
  AE: '🇦🇪', TR: '🇹🇷', US: '🇺🇸', CA: '🇨🇦', JP: '🇯🇵',
}

// OX.4 — coarse relative-time formatter for the "Order date" cell.
// Mirrors Amazon's "8 hours ago / 2 days ago" treatment. Fall through
// to absolute date for anything older than 14 days.
function relativeFromNow(input: string | null): string | null {
  if (!input) return null
  const ts = new Date(input).getTime()
  if (Number.isNaN(ts)) return null
  const diffMs = Date.now() - ts
  if (diffMs < 0) return null
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days <= 14) return `${days} day${days === 1 ? '' : 's'} ago`
  return null
}

function OrderCell({
  col,
  order,
  isSelected,
  onToggle,
}: {
  col: string
  order: GridOrder
  isSelected: boolean
  onToggle: () => void
}) {
  const { locale } = useTranslations()
  const o = order
  switch (col) {
    case 'select':
      return (
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          aria-label={`Select order ${o.channelOrderId}`}
        />
      )
    // OX.4 — Amazon-parity cells ────────────────────────────────────
    case 'orderDate': {
      const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
      const ts = o.purchaseDate ?? o.createdAt
      const relative = relativeFromNow(ts)
      const d = new Date(ts)
      const absolute = d.toLocaleDateString(dateLocale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
      const time = d.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' })
      return (
        <div className="flex flex-col gap-0.5">
          {relative && (
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{relative}</span>
          )}
          <span className="text-sm text-slate-700 dark:text-slate-300 tabular-nums">{absolute}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">{time}</span>
        </div>
      )
    }
    case 'orderDetails': {
      const link = deepLinkForOrder({
        channel: o.channel,
        marketplace: o.marketplace,
        channelOrderId: o.channelOrderId,
      })
      const flag = o.marketplace ? MARKETPLACE_FLAGS[o.marketplace] ?? '' : ''
      const channelLabel =
        o.channel === 'AMAZON' && o.marketplace
          ? `Amazon.${o.marketplace.toLowerCase()}`
          : o.channel.charAt(0) + o.channel.slice(1).toLowerCase()
      return (
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-1">
            <Link
              href={`/orders/${o.id}`}
              className="text-base font-mono text-blue-600 dark:text-blue-400 hover:underline truncate"
            >
              {o.channelOrderId}
            </Link>
            {link && (
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                aria-label={link.label}
                title={link.label}
                className="text-tertiary dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 flex-shrink-0"
              >
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </div>
          <div className="text-sm text-slate-700 dark:text-slate-300 truncate">
            <span className="text-slate-500 dark:text-slate-400">Buyer:</span> {o.customerName || '—'}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 truncate inline-flex items-center gap-1.5">
            {o.fulfillmentMethod ? (
              <FulfillmentPill method={o.fulfillmentMethod} />
            ) : (
              <span>—</span>
            )}
            <span>·</span>
            <span>{channelLabel}</span>
            {flag && <span aria-hidden="true">{flag}</span>}
          </div>
        </div>
      )
    }
    case 'image': {
      const fi = o.firstItem
      if (!fi?.thumbnailUrl) {
        return (
          <div className="w-12 h-12 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-tertiary dark:text-slate-500">
            <ShoppingCart size={14} aria-hidden="true" />
          </div>
        )
      }
      return (
        <img
          src={fi.thumbnailUrl}
          alt=""
          loading="lazy"
          className="w-12 h-12 rounded object-cover bg-slate-100 dark:bg-slate-800"
        />
      )
    }
    case 'productName': {
      const fi = o.firstItem
      const display = formatOrderTotal({
        totalPrice: fi ? fi.subtotal : o.totalPrice,
        currencyCode: o.currencyCode,
        status: o.status,
      })
      const extra = o.itemCount > 1 ? ` (+${o.itemCount - 1} more)` : ''
      return (
        <div className="min-w-0 space-y-0.5">
          <Link
            href={`/orders/${o.id}`}
            className="text-base text-slate-900 dark:text-slate-100 hover:text-blue-600 line-clamp-2 leading-tight"
            title={fi?.productName ?? undefined}
          >
            {fi?.productName ?? <span className="italic text-slate-500">(product missing)</span>}
            {extra && <span className="text-xs text-slate-500 dark:text-slate-400 font-normal">{extra}</span>}
          </Link>
          {(fi?.amazonAsin || fi?.sku) && (
            <div className="text-xs text-slate-500 dark:text-slate-400 truncate space-x-2 font-mono">
              {fi.amazonAsin && (
                <span>
                  <span className="not-italic">ASIN:</span> {fi.amazonAsin}
                </span>
              )}
              {fi.sku && (
                <span>
                  <span className="not-italic">SKU:</span> {fi.sku}
                </span>
              )}
            </div>
          )}
          <div className="text-xs text-slate-500 dark:text-slate-400">
            <span>Qty: <span className="text-slate-700 dark:text-slate-300 font-medium tabular-nums">{fi?.quantity ?? 0}</span></span>
            <span className="mx-1.5">·</span>
            <span>Item subtotal:</span>{' '}
            {display.kind === 'pending' ? (
              <span className="text-amber-700 dark:text-amber-300 font-medium">Awaiting payment</span>
            ) : (
              <span className="text-slate-900 dark:text-slate-100 font-semibold tabular-nums">
                {display.symbol}{display.amount}{display.trailingCode ? ` ${display.trailingCode}` : ''}
              </span>
            )}
          </div>
        </div>
      )
    }
    case 'orderType': {
      const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
      const fmtDate = (d: string | null | undefined) => {
        if (!d) return null
        return new Date(d).toLocaleDateString(dateLocale, { weekday: 'short', day: '2-digit', month: 'short' })
      }
      const shipBy = fmtDate(o.shipByDate)
      const deliverBy = fmtDate(o.latestDeliveryDate)
      // Ship-by urgency: < 24h to ship → amber; overdue → rose
      let shipByTone = 'text-slate-600 dark:text-slate-400'
      if (o.shipByDate && o.status !== 'SHIPPED' && o.status !== 'DELIVERED' && o.status !== 'CANCELLED') {
        const remainingHours = (new Date(o.shipByDate).getTime() - Date.now()) / 3_600_000
        if (remainingHours < 0) shipByTone = 'text-rose-600 dark:text-rose-400 font-semibold'
        else if (remainingHours < 24) shipByTone = 'text-amber-600 dark:text-amber-400 font-semibold'
      }
      const typeBadge = o.isBusinessOrder ? 'Business' : o.isPrime ? 'Prime' : 'Standard'
      const typeTone =
        typeBadge === 'Business'
          ? 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900'
          : typeBadge === 'Prime'
          ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900'
          : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-default dark:border-slate-700'
      return (
        <div className="space-y-0.5">
          <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${typeTone}`}>
            {typeBadge}
          </span>
          {shipBy && (
            <div className={`text-xs ${shipByTone}`}>
              <span className="text-slate-500 dark:text-slate-400">Ship by:</span> {shipBy}
            </div>
          )}
          {deliverBy && (
            <div className="text-xs text-slate-500 dark:text-slate-400">
              <span>Deliver by:</span> {deliverBy}
            </div>
          )}
        </div>
      )
    }
    // ────────────────────────────────────────────────────────────────
    case 'channel': {
      const link = deepLinkForOrder({
        channel: o.channel,
        marketplace: o.marketplace,
        channelOrderId: o.channelOrderId,
      })
      return (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <span
              className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded w-fit ${channelTone(o.channel)}`}
            >
              {o.channel}
            </span>
            {link && (
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                aria-label={link.label}
                title={link.label}
                className="text-tertiary dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              >
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </div>
          {o.marketplace && (
            <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
              {o.marketplace}
            </span>
          )}
        </div>
      )
    }
    case 'orderId':
      return (
        <Link
          href={`/orders/${o.id}`}
          className="text-base font-mono text-blue-600 dark:text-blue-400 hover:underline truncate block"
        >
          {o.channelOrderId}
        </Link>
      )
    case 'date': {
      const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
      return (
        <span className="text-base text-slate-700 dark:text-slate-300">
          {o.purchaseDate
            ? new Date(o.purchaseDate).toLocaleDateString(dateLocale, {
                day: 'numeric',
                month: 'short',
                year: '2-digit',
              })
            : new Date(o.createdAt).toLocaleDateString(dateLocale, {
                day: 'numeric',
                month: 'short',
                year: '2-digit',
              })}
        </span>
      )
    }
    case 'customer':
      return (
        <div className="min-w-0">
          <div className="text-base text-slate-900 dark:text-slate-100 truncate">
            {o.customerName}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400 truncate">
            {o.customerEmail}
          </div>
        </div>
      )
    case 'items':
      return (
        <span className="text-base tabular-nums text-slate-700 dark:text-slate-300">
          {o.itemCount}
        </span>
      )
    case 'total': {
      const display = formatOrderTotal({
        totalPrice: o.totalPrice,
        currencyCode: o.currencyCode,
        status: o.status,
      })
      if (display.kind === 'pending') {
        return (
          <span
            className="inline-flex items-center text-xs font-medium text-amber-700 dark:text-amber-300"
            title="Amazon withholds the order total until payment is verified."
          >
            Awaiting payment
          </span>
        )
      }
      return (
        <span className="text-md tabular-nums font-semibold text-slate-900 dark:text-slate-100">
          {display.symbol}
          {display.amount}
          {display.trailingCode ? ` ${display.trailingCode}` : ''}
        </span>
      )
    }
    case 'status': {
      // OX.4 — Amazon-style: badge + secondary line. The secondary
      // text gives the operator context for what the status means or
      // what to do next.
      const secondary =
        o.status === 'PENDING' || o.status === 'AWAITING_PAYMENT'
          ? 'Awaiting payment verification'
          : o.status === 'PROCESSING'
          ? 'Ready to ship'
          : o.status === 'ON_HOLD'
          ? 'Hold — review required'
          : o.status === 'PARTIALLY_SHIPPED'
          ? 'Some items shipped'
          : o.status === 'SHIPPED'
          ? 'In transit'
          : o.status === 'DELIVERED'
          ? 'Completed'
          : o.status === 'CANCELLED'
          ? 'Cancelled'
          : o.status === 'REFUNDED'
          ? 'Refunded'
          : o.status === 'RETURNED'
          ? 'Returned'
          : null
      return (
        <div className="space-y-0.5">
          <Badge variant={STATUS_VARIANT[o.status] ?? 'default'} size="sm">
            {o.status}
          </Badge>
          {secondary && (
            <div className="text-xs text-slate-500 dark:text-slate-400">{secondary}</div>
          )}
        </div>
      )
    }
    case 'fulfillment':
      return o.fulfillmentMethod ? (
        <FulfillmentPill method={o.fulfillmentMethod} />
      ) : (
        <span className="text-tertiary dark:text-slate-500 text-sm">—</span>
      )
    case 'returnRefund':
      return (
        <div className="flex items-center gap-1">
          {o.hasActiveReturn && (
            <span
              title="Active return"
              className="text-xs font-semibold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-1 py-0.5 rounded"
            >
              R
            </span>
          )}
          {o.hasRefund && (
            <span
              title="Has refund"
              className="text-xs font-semibold text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 px-1 py-0.5 rounded"
            >
              $
            </span>
          )}
          {!o.hasActiveReturn && !o.hasRefund && (
            <span className="text-tertiary dark:text-slate-500 text-xs">—</span>
          )}
        </div>
      )
    case 'review': {
      const rr = o.reviewRequests[0]
      if (!rr) return <span className="text-xs text-tertiary dark:text-slate-500">—</span>
      return (
        <span
          className={`inline-block text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 border rounded ${REVIEW_STATUS_TONE[rr.status] ?? 'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-default dark:border-slate-700'}`}
        >
          {rr.status.slice(0, 4)}
        </span>
      )
    }
    case 'repeat':
      return o.customerOrderCount > 1 ? (
        <span
          title={`${o.customerOrderCount} orders from this customer`}
          className="text-xs font-semibold text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 px-1.5 py-0.5 rounded"
        >
          ×{o.customerOrderCount}
        </span>
      ) : (
        <span className="text-tertiary dark:text-slate-500 text-xs">new</span>
      )
    case 'tags':
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {(o.tags ?? []).slice(0, 3).map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center px-1.5 py-0.5 text-xs rounded"
              style={{
                background: t.color ? `${t.color}20` : '#f1f5f9',
                color: t.color ?? '#64748b',
              }}
            >
              {t.name}
            </span>
          ))}
        </div>
      )
    case 'actions':
      // OX.4 — Amazon-parity action column: 3 visible quick actions
      // (Manage invoice · Print packing slip · Refund) + More dropdown
      // (Edit consignment / Open detail / Request review / Cancel).
      // Wires deep-links to detail-page sections; OX.5 will add the
      // bulk variants and OX.6 will wire functional handlers.
      return <RowActionMenu order={o} />
    case 'open':
      return (
        <Link
          href={`/orders/${o.id}`}
          className="h-6 px-2 text-sm text-slate-600 dark:text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded inline-flex items-center gap-1"
        >
          Open <ChevronRight size={11} />
        </Link>
      )
    default:
      return null
  }
}

/**
 * OX.4 — Amazon-style row action column. Vertically stacked buttons in
 * a single right-pinned column matching Seller Central's layout. The
 * "More information" dropdown is rendered via React portal so it
 * escapes the table's `overflow-x-auto` clip-rect — otherwise rows
 * near the right edge or bottom edge would crop the menu.
 *
 * Handlers are deep-links for now; OX.5/OX.6 wire functional invoice
 * generation and bulk packing slips.
 */
function RowActionMenu({ order }: { order: GridOrder }) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  const baseHref = `/orders/${order.id}`
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  const primary = [
    { label: 'Manage invoice', href: `${baseHref}?tab=fiscal` },
    { label: 'Edit consignment', href: `${baseHref}?tab=fulfillment#consignment` },
    { label: 'Print packing slip', href: `${baseHref}?tab=fulfillment#packing` },
    { label: 'Refund Order', href: `${baseHref}?tab=fulfillment#refund` },
  ]
  const more = [
    { label: 'Open detail', href: baseHref },
    { label: 'Request a review', href: `${baseHref}#review` },
    { label: 'Add note', href: `${baseHref}#notes` },
    { label: 'View timeline', href: `${baseHref}?tab=activity` },
  ]

  const openMenu = (e: React.MouseEvent) => {
    stop(e)
    if (open) {
      setOpen(false)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      const menuWidth = 200
      const menuHeight = more.length * 32 + 8
      const top = rect.bottom + 4 + menuHeight > window.innerHeight ? rect.top - menuHeight - 4 : rect.bottom + 4
      const left = Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)
      setCoords({ top, left })
    }
    setOpen(true)
  }

  return (
    <div className="flex flex-col gap-1 items-stretch" onClick={stop}>
      {primary.map((a) => (
        <Link
          key={a.label}
          href={a.href}
          className="h-7 px-2 text-xs text-slate-700 dark:text-slate-200 border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center whitespace-nowrap"
          title={a.label}
        >
          {a.label}
        </Link>
      ))}
      <button
        ref={triggerRef}
        type="button"
        onClick={openMenu}
        className="h-7 px-2 text-xs text-slate-700 dark:text-slate-200 border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center gap-1 whitespace-nowrap"
        aria-label="More information"
        aria-expanded={open}
        title="More information"
      >
        More information <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open && coords && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            style={{ position: 'fixed', top: coords.top, left: coords.left, width: 200 }}
            className="z-[1000] bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-md shadow-xl py-1"
          >
            {more.map((a) => (
              <Link
                key={a.label}
                href={a.href}
                onClick={() => setOpen(false)}
                className="block px-3 py-1.5 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {a.label}
              </Link>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}

function ColumnPickerMenu({
  visible,
  setVisible,
  onClose,
}: {
  visible: string[]
  setVisible: (v: string[]) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])
  const togglable: OrderColumn[] = ALL_COLUMNS.filter(
    (c) => !c.locked && c.label,
  )
  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-md shadow-lg z-20 p-1.5"
    >
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 px-2 py-1.5">
        Visible columns
      </div>
      {togglable.map((c) => (
        <label
          key={c.key}
          className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 rounded text-base cursor-pointer"
        >
          <input
            type="checkbox"
            checked={visible.includes(c.key)}
            onChange={() =>
              visible.includes(c.key)
                ? setVisible(visible.filter((k) => k !== c.key))
                : setVisible([...visible, c.key])
            }
          />
          <span className="text-slate-700 dark:text-slate-300">{c.label}</span>
        </label>
      ))}
      <div className="border-t border-subtle dark:border-slate-800 mt-1.5 pt-1.5 px-2 py-1 flex items-center justify-between">
        <button
          onClick={() => setVisible(DEFAULT_VISIBLE)}
          className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
        >
          Reset
        </button>
        <button
          onClick={onClose}
          className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
        >
          Close
        </button>
      </div>
    </div>
  )
}


// CR.2 — column resize handle on /orders thead. mousedown on the
// right edge captures starting clientX + width, drag updates the
// override, mouseup commits. Double-click resets to the columns.ts
// default. Pulled inline rather than into a shared component so the
// /fulfillment/stock CR.1 version and this one can diverge if the
// surfaces gain different needs (e.g. min-widths per column).
function OrdersResizeHandle({
  columnKey,
  currentWidth,
  onResize,
  onReset,
}: {
  columnKey: string
  currentWidth: number | undefined
  onResize: (key: string, width: number) => void
  onReset: (key: string) => void
}) {
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const th = (e.currentTarget.parentElement as HTMLElement | null) ?? null
    const startWidth =
      typeof currentWidth === "number"
        ? currentWidth
        : th?.getBoundingClientRect().width ?? 120
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(40, Math.min(800, startWidth + (ev.clientX - startX)))
      onResize(columnKey, next)
    }
    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onReset(columnKey)
      }}
      onClick={(e) => e.stopPropagation()}
      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize select-none opacity-0 group-hover:opacity-100 hover:bg-blue-400/60 dark:hover:bg-blue-500/60 transition-opacity"
      title="Drag to resize · double-click to reset"
    />
  )
}
