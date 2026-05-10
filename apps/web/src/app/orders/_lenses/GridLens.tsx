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
import Link from 'next/link'
import { ChevronRight, ExternalLink, Settings2, ShoppingCart } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useTranslations } from '@/lib/i18n/use-translations'
import { ALL_COLUMNS, DEFAULT_VISIBLE, type OrderColumn } from '../_lib/columns'
import { deepLinkForOrder } from '../_lib/deep-links'
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
            className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded"
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
            className="h-7 px-2 text-base border border-slate-200 dark:border-slate-700 rounded inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800"
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
            <thead className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 sticky top-0 z-10">
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
                  return (
                    <th
                      key={col.key}
                      role="columnheader"
                      scope="col"
                      aria-sort={ariaSort}
                      style={{ width, minWidth: width }}
                      className={`px-3 py-2 text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 text-left relative group ${
                        isSortable ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700' : ''
                      }`}
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
                              className="text-slate-400 dark:text-slate-500"
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
                    className={`border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 ${
                      isSelected ? 'bg-blue-50/30' : ''
                    } ${
                      isFocused
                        ? 'outline outline-2 outline-blue-500 outline-offset-[-2px]'
                        : ''
                    }`}
                  >
                    {visible.map((col) => {
                      const w = widthFor(col)
                      return (
                        <td
                          key={col.key}
                          className="px-3 py-2 align-middle"
                          style={{ width: w, minWidth: w }}
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
              className="h-7 px-3 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('orders.pagination.previous')}
            </button>
            <button
              onClick={() => onPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="h-7 px-3 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('orders.pagination.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
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
                className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
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
    case 'total':
      return (
        <span className="text-md tabular-nums font-semibold text-slate-900 dark:text-slate-100">
          {o.currencyCode === 'EUR' || !o.currencyCode ? '€' : ''}
          {o.totalPrice.toFixed(2)}
          {o.currencyCode && o.currencyCode !== 'EUR'
            ? ` ${o.currencyCode}`
            : ''}
        </span>
      )
    case 'status':
      return (
        <Badge variant={STATUS_VARIANT[o.status] ?? 'default'} size="sm">
          {o.status}
        </Badge>
      )
    case 'fulfillment':
      return o.fulfillmentMethod ? (
        <Badge
          variant={o.fulfillmentMethod === 'FBA' ? 'warning' : 'info'}
          size="sm"
        >
          {o.fulfillmentMethod}
        </Badge>
      ) : (
        <span className="text-slate-400 dark:text-slate-500 text-sm">—</span>
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
            <span className="text-slate-400 dark:text-slate-500 text-xs">—</span>
          )}
        </div>
      )
    case 'review': {
      const rr = o.reviewRequests[0]
      if (!rr) return <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
      return (
        <span
          className={`inline-block text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 border rounded ${REVIEW_STATUS_TONE[rr.status] ?? 'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'}`}
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
        <span className="text-slate-400 dark:text-slate-500 text-xs">new</span>
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
      className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg z-20 p-1.5"
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
      <div className="border-t border-slate-100 dark:border-slate-800 mt-1.5 pt-1.5 px-2 py-1 flex items-center justify-between">
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
