'use client'

/**
 * O.21b — /customers list view.
 *
 * Built on the O.21a backend (GET /api/customers). One dense
 * sortable table: customer email + name, total orders, LTV,
 * last-order-at, channel mix badges, risk flag (if scored), tags.
 *
 * Mirrors the /orders Grid pattern: search input + sort headers +
 * pagination. URL state for sort + page; local state for search
 * input (debounced 250ms before pushing to query string).
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Search, Users, RefreshCw, Download } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

type Customer = {
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
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-900',
  EBAY: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900',
  SHOPIFY: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  WOOCOMMERCE: 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900',
  ETSY: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
  MANUAL: 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700',
}

const RISK_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  LOW: 'success',
  MEDIUM: 'warning',
  HIGH: 'danger',
}

export default function CustomersWorkspace() {
  const { t, locale } = useTranslations()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const sortBy = searchParams.get('sortBy') ?? 'ltv'
  const sortDir = (searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc'
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
  const pageSize = 50
  const search = searchParams.get('search') ?? ''
  const riskFlagFilters = (searchParams.get('riskFlag') ?? '')
    .split(',')
    .filter(Boolean)
  const needsReview = searchParams.get('manualReviewState') === 'PENDING'

  const [searchInput, setSearchInput] = useState(search)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)

  const updateUrl = useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(searchParams.toString())
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') next.delete(k)
        else next.set(k, v)
      }
      router.replace(`${pathname}?${next.toString()}`)
    },
    [router, pathname, searchParams],
  )

  // Debounced search → URL
  useEffect(() => {
    const id = setTimeout(() => {
      if (searchInput !== search) updateUrl({ search: searchInput || undefined, page: undefined })
    }, 250)
    return () => clearTimeout(id)
  }, [searchInput, search, updateUrl])

  const fetchCustomers = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        sortBy,
        sortDir,
      })
      if (search) qs.set('search', search)
      if (riskFlagFilters.length > 0) qs.set('riskFlag', riskFlagFilters.join(','))
      if (needsReview) qs.set('manualReviewState', 'PENDING')
      const res = await fetch(`${getBackendUrl()}/api/customers?${qs.toString()}`, {
        cache: 'no-store',
      })
      const data = await res.json()
      setCustomers(data.customers ?? [])
      setTotal(data.total ?? 0)
      setTotalPages(data.totalPages ?? 0)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, sortBy, sortDir, search, riskFlagFilters.join(','), needsReview])

  useEffect(() => {
    fetchCustomers()
  }, [fetchCustomers])

  const onSort = (key: string) => {
    updateUrl({
      sortBy: key,
      sortDir: sortBy === key && sortDir === 'desc' ? 'asc' : 'desc',
      page: undefined,
    })
  }

  const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const fmtDate = (s: string | null) =>
    s
      ? new Date(s).toLocaleDateString(dateLocale, {
          day: 'numeric',
          month: 'short',
          year: '2-digit',
        })
      : '—'

  const fmtMoney = (cents: number, code = 'EUR') => {
    const v = (cents / 100).toFixed(2)
    return code === 'EUR' ? `€${v}` : `${v} ${code}`
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('customers.title')}
        description={
          total > 0
            ? t('customers.subtitle.count', { total: total.toLocaleString() })
            : t('customers.subtitle.empty')
        }
        actions={
          <div className="flex items-center gap-2">
            <a
              href={`${getBackendUrl()}/api/customers/export.csv?${searchParams.toString()}`}
              className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
              download
            >
              <Download size={12} /> {t('customers.action.exportCsv')}
            </a>
            <button
              onClick={() => fetchCustomers()}
              className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} /> {t('common.refresh')}
            </button>
          </div>
        }
      />

      <Card>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="flex-1 max-w-md relative">
              <Search
                size={12}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
              />
              <Input
                id="customers-search"
                placeholder={t('customers.search.placeholder')}
                value={searchInput}
                onChange={(e: any) => setSearchInput(e.target.value)}
                className="pl-7"
              />
            </div>
            <span className="text-sm text-slate-500 dark:text-slate-400 tabular-nums ml-auto">
              {t('customers.pagination.summary', { total, page, totalPages })}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-slate-100 dark:border-slate-800">
            <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('customers.filter.risk')}
            </span>
            {(['HIGH', 'MEDIUM', 'LOW'] as const).map((flag) => {
              const active = riskFlagFilters.includes(flag)
              const tone = flag === 'HIGH' ? 'rose' : flag === 'MEDIUM' ? 'amber' : 'emerald'
              return (
                <button
                  key={flag}
                  type="button"
                  role="checkbox"
                  aria-checked={active}
                  onClick={() => {
                    const next = active
                      ? riskFlagFilters.filter((f) => f !== flag)
                      : [...riskFlagFilters, flag]
                    updateUrl({
                      riskFlag: next.length > 0 ? next.join(',') : undefined,
                      page: undefined,
                    })
                  }}
                  className={`h-7 px-2 text-sm border rounded inline-flex items-center gap-1.5 ${
                    active
                      ? `bg-${tone}-50 text-${tone}-700 border-${tone}-300`
                      : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
                >
                  {flag}
                </button>
              )
            })}
            <button
              type="button"
              aria-pressed={needsReview}
              onClick={() =>
                updateUrl({
                  manualReviewState: needsReview ? undefined : 'PENDING',
                  page: undefined,
                })
              }
              className={`h-7 px-3 text-sm border rounded-full font-medium ${
                needsReview
                  ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-300'
                  : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
              }`}
            >
              {t('customers.filter.needsReview')}
            </button>
            {(riskFlagFilters.length > 0 || needsReview) && (
              <button
                onClick={() =>
                  updateUrl({
                    riskFlag: undefined,
                    manualReviewState: undefined,
                    page: undefined,
                  })
                }
                className="h-7 px-2 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                {t('orders.filter.clear')}
              </button>
            )}
          </div>
        </div>
      </Card>

      {loading && customers.length === 0 ? (
        <Card>
          <Skeleton lines={8} />
        </Card>
      ) : customers.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t('customers.empty.title')}
          description={t('customers.empty.description')}
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md" role="grid" aria-label={t('customers.title')}>
              <thead className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 sticky top-0 z-10">
                <tr role="row">
                  <th
                    role="columnheader"
                    scope="col"
                    aria-sort={sortBy === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    onClick={() => onSort('name')}
                    className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700"
                  >
                    {t('customers.table.header.customer')}
                    {sortBy === 'name' && (
                      <span className="text-slate-400 dark:text-slate-500 ml-1" aria-hidden="true">
                        {sortDir === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </th>
                  <th
                    role="columnheader"
                    scope="col"
                    aria-sort={sortBy === 'orders' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    onClick={() => onSort('orders')}
                    className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700"
                  >
                    {t('customers.table.header.orders')}
                    {sortBy === 'orders' && (
                      <span className="text-slate-400 dark:text-slate-500 ml-1" aria-hidden="true">
                        {sortDir === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </th>
                  <th
                    role="columnheader"
                    scope="col"
                    aria-sort={sortBy === 'ltv' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    onClick={() => onSort('ltv')}
                    className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700"
                  >
                    {t('customers.table.header.ltv')}
                    {sortBy === 'ltv' && (
                      <span className="text-slate-400 dark:text-slate-500 ml-1" aria-hidden="true">
                        {sortDir === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </th>
                  <th
                    role="columnheader"
                    scope="col"
                    aria-sort={sortBy === 'lastOrder' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    onClick={() => onSort('lastOrder')}
                    className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700"
                  >
                    {t('customers.table.header.lastOrder')}
                    {sortBy === 'lastOrder' && (
                      <span className="text-slate-400 dark:text-slate-500 ml-1" aria-hidden="true">
                        {sortDir === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </th>
                  <th
                    role="columnheader"
                    scope="col"
                    className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300"
                  >
                    {t('customers.table.header.channels')}
                  </th>
                  <th
                    role="columnheader"
                    scope="col"
                    className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300"
                  >
                    {t('customers.table.header.flags')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr
                    key={c.id}
                    role="row"
                    className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/customers/${c.id}`}
                        className="text-base text-blue-600 dark:text-blue-400 hover:underline font-medium"
                      >
                        {c.name || c.email}
                      </Link>
                      {c.name && (
                        <div className="text-sm text-slate-500 dark:text-slate-400 truncate">
                          {c.email}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.totalOrders > 1 ? (
                        <span className="font-semibold text-blue-700 dark:text-blue-300">
                          {c.totalOrders}
                        </span>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-400">{c.totalOrders}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                      {fmtMoney(c.totalSpentCents)}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                      {fmtDate(c.lastOrderAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1 flex-wrap">
                        {Object.entries(c.channelOrderCounts ?? {}).map(([ch, n]) => (
                          <span
                            key={ch}
                            className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${CHANNEL_TONE[ch] ?? 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'}`}
                            title={`${n} order${n === 1 ? '' : 's'} on ${ch}`}
                          >
                            {ch} {n}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1 flex-wrap">
                        {c.riskFlag && (
                          <Badge variant={RISK_TONE[c.riskFlag] ?? 'default'} size="sm">
                            {c.riskFlag}
                          </Badge>
                        )}
                        {c.manualReviewState && (
                          <Badge variant="warning" size="sm">
                            {c.manualReviewState.replace(/_/g, ' ')}
                          </Badge>
                        )}
                        {c.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-base text-slate-500 dark:text-slate-400">
          <span className="tabular-nums">
            {t('customers.pagination.pageOf', { page, totalPages })}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => updateUrl({ page: page <= 2 ? undefined : String(page - 1) })}
              disabled={page === 1}
              className="h-7 px-3 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('common.previous')}
            </button>
            <button
              onClick={() => updateUrl({ page: String(Math.min(totalPages, page + 1)) })}
              disabled={page >= totalPages}
              className="h-7 px-3 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
