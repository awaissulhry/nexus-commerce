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

import { useEffect, useMemo, useRef } from 'react'
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
        <div className="text-md text-rose-600 py-8 text-center">
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
          <span className="text-sm text-slate-500">
            {t('orders.pagination.summary', { total, page, totalPages })}
          </span>
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            className="h-7 px-2 text-sm border border-slate-200 rounded"
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
            className="h-7 px-2 text-base border border-slate-200 rounded inline-flex items-center gap-1.5 hover:bg-slate-50"
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
            <thead className="border-b border-slate-200 bg-slate-50 sticky top-0 z-10">
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
                  return (
                    <th
                      key={col.key}
                      role="columnheader"
                      scope="col"
                      aria-sort={ariaSort}
                      style={{ width: col.width, minWidth: col.width }}
                      className={`px-3 py-2 text-sm font-semibold uppercase tracking-wider text-slate-700 text-left ${
                        isSortable ? 'cursor-pointer hover:bg-slate-100' : ''
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
                              className="text-slate-400"
                              aria-hidden="true"
                            >
                              {sortDir === 'asc' ? '↑' : '↓'}
                            </span>
                          )}
                        </span>
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
                    className={`border-b border-slate-100 hover:bg-slate-50 ${
                      isSelected ? 'bg-blue-50/30' : ''
                    } ${
                      isFocused
                        ? 'outline outline-2 outline-blue-500 outline-offset-[-2px]'
                        : ''
                    }`}
                  >
                    {visible.map((col) => (
                      <td
                        key={col.key}
                        className="px-3 py-2 align-middle"
                        style={{ width: col.width, minWidth: col.width }}
                      >
                        <OrderCell
                          col={col.key}
                          order={o}
                          isSelected={isSelected}
                          onToggle={() => toggleSelect(o.id)}
                        />
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-base text-slate-500">
          <span className="tabular-nums">
            {t('orders.pagination.pageOf', { page, totalPages })}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('orders.pagination.previous')}
            </button>
            <button
              onClick={() => onPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
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
                className="text-slate-400 hover:text-slate-700"
              >
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </div>
          {o.marketplace && (
            <span className="text-xs text-slate-500 font-mono">
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
          className="text-base font-mono text-blue-600 hover:underline truncate block"
        >
          {o.channelOrderId}
        </Link>
      )
    case 'date': {
      const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
      return (
        <span className="text-base text-slate-700">
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
          <div className="text-base text-slate-900 truncate">
            {o.customerName}
          </div>
          <div className="text-sm text-slate-500 truncate">
            {o.customerEmail}
          </div>
        </div>
      )
    case 'items':
      return (
        <span className="text-base tabular-nums text-slate-700">
          {o.itemCount}
        </span>
      )
    case 'total':
      return (
        <span className="text-md tabular-nums font-semibold text-slate-900">
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
        <span className="text-slate-400 text-sm">—</span>
      )
    case 'returnRefund':
      return (
        <div className="flex items-center gap-1">
          {o.hasActiveReturn && (
            <span
              title="Active return"
              className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded"
            >
              R
            </span>
          )}
          {o.hasRefund && (
            <span
              title="Has refund"
              className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-1 py-0.5 rounded"
            >
              $
            </span>
          )}
          {!o.hasActiveReturn && !o.hasRefund && (
            <span className="text-slate-400 text-xs">—</span>
          )}
        </div>
      )
    case 'review': {
      const rr = o.reviewRequests[0]
      if (!rr) return <span className="text-xs text-slate-400">—</span>
      return (
        <span
          className={`inline-block text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 border rounded ${REVIEW_STATUS_TONE[rr.status] ?? 'bg-slate-50 text-slate-500 border-slate-200'}`}
        >
          {rr.status.slice(0, 4)}
        </span>
      )
    }
    case 'repeat':
      return o.customerOrderCount > 1 ? (
        <span
          title={`${o.customerOrderCount} orders from this customer`}
          className="text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded"
        >
          ×{o.customerOrderCount}
        </span>
      ) : (
        <span className="text-slate-400 text-xs">new</span>
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
          className="h-6 px-2 text-sm text-slate-600 hover:text-blue-600 hover:bg-blue-50 rounded inline-flex items-center gap-1"
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
      className="absolute right-0 top-full mt-1 w-56 bg-white border border-slate-200 rounded-md shadow-lg z-20 p-1.5"
    >
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 px-2 py-1.5">
        Visible columns
      </div>
      {togglable.map((c) => (
        <label
          key={c.key}
          className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded text-base cursor-pointer"
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
          <span className="text-slate-700">{c.label}</span>
        </label>
      ))}
      <div className="border-t border-slate-100 mt-1.5 pt-1.5 px-2 py-1 flex items-center justify-between">
        <button
          onClick={() => setVisible(DEFAULT_VISIBLE)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Reset
        </button>
        <button
          onClick={onClose}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Close
        </button>
      </div>
    </div>
  )
}
