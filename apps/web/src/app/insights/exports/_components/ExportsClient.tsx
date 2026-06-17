'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  CheckCircle2,
  ChevronLeft,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  Mail,
  Megaphone,
  Package,
  Receipt,
  Settings2,
  ShoppingCart,
  Truck,
  Users,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  InsightsHeader,
  readFilterState,
  type InsightsFilterState,
} from '@/components/insights'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

const REPORTS: Array<{
  key: string
  endpoint: string
  title: string
  blurb: string
  icon: typeof Download
  formats: Array<'csv'>
}> = [
  {
    key: 'sales',
    endpoint: 'sales',
    title: 'Sales report',
    blurb: 'Revenue, channel/market splits, brand + productType, Pareto',
    icon: ShoppingCart,
    formats: ['csv'],
  },
  {
    key: 'profit',
    endpoint: 'profit',
    title: 'Profit & cost',
    blurb: 'Per-SKU margin, fees, ad spend, refunds — full P&L',
    icon: Receipt,
    formats: ['csv'],
  },
  {
    key: 'advertising',
    endpoint: 'advertising',
    title: 'Advertising',
    blurb: 'Impressions, ACoS, ROAS, per-campaign metrics',
    icon: Megaphone,
    formats: ['csv'],
  },
  {
    key: 'products',
    endpoint: 'products',
    title: 'Product performance',
    blurb: 'Lifecycle, buy box, quality, stock per SKU',
    icon: Package,
    formats: ['csv'],
  },
  {
    key: 'customers',
    endpoint: 'customers',
    title: 'Top customers',
    blurb: 'RFM-tagged customers with lifetime spend',
    icon: Users,
    formats: ['csv'],
  },
  {
    key: 'inventory',
    endpoint: 'inventory',
    title: 'Inventory',
    blurb: 'Value, ABC, dead stock, stockout cost per SKU',
    icon: Truck,
    formats: ['csv'],
  },
  {
    key: 'fiscal',
    endpoint: 'fiscal',
    title: 'Italian fiscal (commercialista)',
    blurb: 'IVA, OSS, intrastat, settlement, totals',
    icon: Receipt,
    formats: ['csv'],
  },
]

function buildQuery(state: InsightsFilterState, fmt: 'csv'): URLSearchParams {
  const p = new URLSearchParams()
  if (state.window) p.set('window', state.window)
  if (state.from) p.set('from', state.from)
  if (state.to) p.set('to', state.to)
  if (state.compare) p.set('compare', state.compare)
  if (state.channels.length) p.set('channels', state.channels.join(','))
  if (state.markets.length) p.set('markets', state.markets.join(','))
  if (state.brands.length) p.set('brands', state.brands.join(','))
  p.set('format', fmt)
  return p
}

export default function ExportsClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [downloading, setDownloading] = useState<Set<string>>(new Set())
  const [bundling, setBundling] = useState(false)
  const [bundleDone, setBundleDone] = useState(false)

  function startDownload(key: string, endpoint: string) {
    const qs = buildQuery(filterState, 'csv')
    setDownloading((s) => new Set(s).add(key))
    window.open(`${getBackendUrl()}/api/insights/${endpoint}?${qs.toString()}`, '_blank')
    setTimeout(() => {
      setDownloading((s) => {
        const next = new Set(s)
        next.delete(key)
        return next
      })
    }, 2000)
  }

  function bundleAll() {
    setBundling(true)
    setBundleDone(false)
    const qs = buildQuery(filterState, 'csv')
    REPORTS.forEach((r, i) => {
      setTimeout(() => {
        window.open(
          `${getBackendUrl()}/api/insights/${r.endpoint}?${qs.toString()}`,
          '_blank',
        )
      }, i * 400)
    })
    setTimeout(() => {
      setBundling(false)
      setBundleDone(true)
      setTimeout(() => setBundleDone(false), 3000)
    }, REPORTS.length * 400 + 500)
  }

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="mb-2">
        <Link
          href="/insights"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
        >
          <ChevronLeft className="w-3 h-3" />
          Insights
        </Link>
      </div>
      <InsightsHeader
        title="Export hub"
        description="Download every insights surface as CSV for the current filter window. Use Bundle all for a one-click handoff."
        filterState={filterState}
        rightExtra={
          <button
            type="button"
            onClick={bundleAll}
            disabled={bundling}
            className={cn(
              'inline-flex items-center gap-1.5 h-7 px-2.5 text-sm rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
              'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60',
            )}
          >
            {bundling ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : bundleDone ? (
              <CheckCircle2 className="w-3.5 h-3.5" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            {bundling
              ? 'Bundling…'
              : bundleDone
                ? 'Sent'
                : 'Bundle all (CSV)'}
          </button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
        {REPORTS.map((report) => {
          const Icon = report.icon
          const isDownloading = downloading.has(report.key)
          return (
            <Card key={report.key}>
              <div className="flex items-start gap-3">
                <div className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {report.title}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 mb-3">
                    {report.blurb}
                  </p>
                  <div className="flex items-center gap-2">
                    {report.formats.map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        onClick={() => startDownload(report.key, report.endpoint)}
                        disabled={isDownloading}
                        className={cn(
                          'inline-flex items-center gap-1.5 h-7 px-2.5 text-xs rounded-md border focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                          'border-default dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                          'disabled:opacity-60',
                        )}
                      >
                        {isDownloading ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : fmt === 'csv' ? (
                          <FileSpreadsheet className="w-3 h-3" />
                        ) : (
                          <FileText className="w-3 h-3" />
                        )}
                        {fmt.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          )
        })}
      </div>

      <Card
        title="Scheduled email delivery"
        description="Recurring delivery of these CSVs lives in the existing /bulk-operations/exports queue. The IH.13.1 follow-up wires a quick subscribe-from-here form once ScheduledExport accepts insights endpoints."
        action={
          <Link
            href="/bulk-operations/exports"
            className="inline-flex items-center gap-1.5 h-7 px-2.5 text-sm rounded-md border border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Manage in Bulk Operations
          </Link>
        }
      >
        <ul className="space-y-1.5 text-xs text-slate-600 dark:text-slate-400">
          <li className="flex items-start gap-2">
            <Mail className="w-3.5 h-3.5 mt-0.5 shrink-0 text-tertiary" />
            <span>
              Configure a daily/weekly/monthly delivery in /bulk-operations/exports
              — recipient email + frequency + format.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <FileText className="w-3.5 h-3.5 mt-0.5 shrink-0 text-tertiary" />
            <span>
              Each report on this page is the same shape ScheduledExport
              consumes; the queue worker will stream and email per the schedule.
            </span>
          </li>
        </ul>
      </Card>
    </div>
  )
}
