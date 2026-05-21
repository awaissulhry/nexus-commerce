'use client'

import { useCallback, useEffect, useState } from 'react'
import { useInsightsLiveRefresh } from '../../_components/useInsightsLiveRefresh'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft, Info } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  BreakdownPie,
  InsightsHeader,
  KPICard,
  TableWithSparkline,
  formatCurrency,
  formatNum,
  formatPct,
  readFilterState,
  type InsightsFilterState,
  type TableColumn,
} from '@/components/insights'
import { getBackendUrl } from '@/lib/backend-url'

interface IvaRateBucket {
  ratePct: number
  label: string
  taxableBase: number
  vatAmount: number
  orderCount: number
}

interface OssCountryRow {
  country: string
  orderCount: number
  taxableBase: number
  vatAmount: number
}

interface FiscalKindBucket {
  key: string
  label: string
  orderCount: number
  revenue: number
}

interface SettlementChannelRow {
  channel: string
  ordersRevenue: number
  refundsValue: number
  netSettlement: number
  ordersCount: number
  refundsCount: number
}

interface CurrencyBridgeRow {
  code: string
  revenue: number
  share: number
}

interface CreditNoteLedgerRow {
  id: string
  noteNumber: string | null
  refundId: string
  amount: number
  issuedAt: string
}

interface FiscalReport {
  window: { from: string; to: string }
  fiscalYear: number
  quarter: number
  totals: {
    grossRevenue: number
    vatCollected: number
    netRevenue: number
    refundsValue: number
    creditNotesValue: number
    invoiceCount: number
    creditNoteCount: number
    b2bRevenue: number
    b2cRevenue: number
  }
  ivaByRate: IvaRateBucket[]
  fiscalKindMix: FiscalKindBucket[]
  ossByCountry: OssCountryRow[]
  intrastatGoods: OssCountryRow[]
  settlement: SettlementChannelRow[]
  currencyBridge: CurrencyBridgeRow[]
  creditNoteLedger: CreditNoteLedgerRow[]
}

function buildQuery(state: InsightsFilterState): URLSearchParams {
  const p = new URLSearchParams()
  if (state.window) p.set('window', state.window)
  if (state.from) p.set('from', state.from)
  if (state.to) p.set('to', state.to)
  if (state.compare) p.set('compare', state.compare)
  if (state.channels.length) p.set('channels', state.channels.join(','))
  if (state.markets.length) p.set('markets', state.markets.join(','))
  if (state.brands.length) p.set('brands', state.brands.join(','))
  return p
}

export default function FiscalClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [report, setReport] = useState<FiscalReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // AL.1 — live refresh on order events (debounced 2s)
  const bumpNonce = useCallback(() => setNonce((n) => n + 1), [])
  useInsightsLiveRefresh(bumpNonce)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (report) setRefreshing(true)
      try {
        const qs = buildQuery(filterState).toString()
        const res = await fetch(
          `${getBackendUrl()}/api/insights/fiscal?${qs}`,
          { credentials: 'include' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: FiscalReport = await res.json()
        if (!cancelled) {
          setReport(json)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed')
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterState.window,
    filterState.from,
    filterState.to,
    filterState.compare,
    filterState.channels.join(','),
    filterState.markets.join(','),
    filterState.brands.join(','),
    nonce,
  ])

  function downloadCsv() {
    const qs = buildQuery(filterState)
    qs.set('format', 'csv')
    window.open(
      `${getBackendUrl()}/api/insights/fiscal?${qs.toString()}`,
      '_blank',
    )
  }

  const ivaColumns: TableColumn<IvaRateBucket>[] = [
    {
      key: 'rate',
      label: 'Rate',
      align: 'left',
      accessor: (r) => (
        <span className="font-semibold text-slate-800 dark:text-slate-200">
          {r.label}
        </span>
      ),
      format: 'text',
      width: '80px',
    },
    {
      key: 'base',
      label: 'Taxable base',
      align: 'right',
      accessor: (r) => r.taxableBase,
      format: 'currency',
    },
    {
      key: 'vat',
      label: 'VAT amount',
      align: 'right',
      accessor: (r) => r.vatAmount,
      format: 'currency',
    },
    {
      key: 'orders',
      label: 'Lines',
      align: 'right',
      accessor: (r) => r.orderCount,
      format: 'number',
    },
  ]

  const ossColumns: TableColumn<OssCountryRow>[] = [
    {
      key: 'country',
      label: 'Country',
      align: 'left',
      accessor: (r) => (
        <span className="font-mono font-semibold">{r.country}</span>
      ),
      format: 'text',
      width: '70px',
    },
    {
      key: 'orders',
      label: 'Orders',
      align: 'right',
      accessor: (r) => r.orderCount,
      format: 'number',
    },
    {
      key: 'base',
      label: 'Taxable',
      align: 'right',
      accessor: (r) => r.taxableBase,
      format: 'currency',
    },
    {
      key: 'vat',
      label: 'VAT',
      align: 'right',
      accessor: (r) => r.vatAmount,
      format: 'currency',
    },
  ]

  const settleColumns: TableColumn<SettlementChannelRow>[] = [
    {
      key: 'channel',
      label: 'Channel',
      align: 'left',
      accessor: (r) => r.channel,
      format: 'text',
      width: '90px',
    },
    {
      key: 'orders',
      label: 'Orders rev.',
      align: 'right',
      accessor: (r) => r.ordersRevenue,
      format: 'currency',
    },
    {
      key: 'refunds',
      label: 'Refunds',
      align: 'right',
      accessor: (r) => r.refundsValue,
      format: 'currency',
    },
    {
      key: 'net',
      label: 'Net settlement',
      align: 'right',
      accessor: (r) => r.netSettlement,
      format: 'currency',
    },
    {
      key: 'oc',
      label: 'Orders',
      align: 'right',
      accessor: (r) => r.ordersCount,
      format: 'number',
      width: '70px',
    },
    {
      key: 'rc',
      label: 'Refunds',
      align: 'right',
      accessor: (r) => r.refundsCount,
      format: 'number',
      width: '70px',
    },
  ]

  const noteColumns: TableColumn<CreditNoteLedgerRow>[] = [
    {
      key: 'number',
      label: 'Note #',
      align: 'left',
      accessor: (r) => (
        <span className="font-mono text-[11px]">{r.noteNumber ?? '—'}</span>
      ),
      format: 'text',
    },
    {
      key: 'refundId',
      label: 'Refund ref',
      align: 'left',
      accessor: (r) => (
        <span className="font-mono text-[10px] text-slate-500">{r.refundId.slice(0, 12)}</span>
      ),
      format: 'text',
    },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      accessor: (r) => r.amount,
      format: 'currency',
    },
    {
      key: 'issued',
      label: 'Issued',
      align: 'left',
      accessor: (r) => new Date(r.issuedAt).toLocaleDateString('it-IT'),
      format: 'text',
    },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
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
        title="Italian fiscal & compliance"
        description={
          report
            ? `Anno fiscale ${report.fiscalYear}, Q${report.quarter} — IVA, OSS, intrastat, settlement, note di credito.`
            : 'IVA, OSS, intrastat, settlement reconciliation, note di credito.'
        }
        filterState={filterState}
        refreshing={refreshing}
        onRefresh={() => setNonce((n) => n + 1)}
        onExport={downloadCsv}
        exportLabel="Export commercialista CSV"
      />

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        <KPICard
          label="Gross revenue"
          value={
            report ? formatCurrency(report.totals.grossRevenue, 'EUR') : loading ? '…' : '—'
          }
          accent="emerald"
        />
        <KPICard
          label="VAT collected"
          value={
            report ? formatCurrency(report.totals.vatCollected, 'EUR') : loading ? '…' : '—'
          }
          accent="amber"
          secondary="owed to AdE"
        />
        <KPICard
          label="Net revenue"
          value={
            report ? formatCurrency(report.totals.netRevenue, 'EUR') : loading ? '…' : '—'
          }
          accent="blue"
        />
        <KPICard
          label="Refunds"
          value={
            report ? formatCurrency(report.totals.refundsValue, 'EUR') : loading ? '…' : '—'
          }
          accent="rose"
          invertDelta
        />
        <KPICard
          label="Invoices issued"
          value={report ? formatNum(report.totals.invoiceCount) : loading ? '…' : '—'}
          accent="violet"
          secondary={`${report?.totals.creditNoteCount ?? 0} credit notes`}
        />
        <KPICard
          label="B2B share"
          value={
            report?.totals.grossRevenue
              ? formatPct((report.totals.b2bRevenue / report.totals.grossRevenue) * 100)
              : loading
                ? '…'
                : '—'
          }
          accent="slate"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
        <Card title="IVA by rate" description="Italian VAT rates: 22 / 10 / 4">
          {report && report.ivaByRate.length > 0 ? (
            <TableWithSparkline
              rows={report.ivaByRate}
              columns={ivaColumns}
              currency="EUR"
              rowKey={(r) => String(r.ratePct)}
              dense
            />
          ) : (
            <div className="text-sm text-slate-400 py-6 text-center">
              {loading ? 'Loading…' : 'No VAT data'}
            </div>
          )}
        </Card>
        <Card title="B2B vs B2C" description="Drives FatturaPA SDI cadence">
          {report && report.fiscalKindMix.some((b) => b.orderCount > 0) ? (
            <BreakdownPie
              entries={report.fiscalKindMix
                .filter((b) => b.orderCount > 0)
                .map((b) => ({
                  key: b.key,
                  label: b.label,
                  value: b.revenue,
                  color:
                    b.key === 'B2B'
                      ? 'rgb(59 130 246)'
                      : b.key === 'B2C'
                        ? 'rgb(16 185 129)'
                        : 'rgb(100 116 139)',
                }))}
              variant="donut"
              format="currency"
              currency="EUR"
              height={220}
              centerLabel="Orders"
              centerValue={formatNum(
                report.fiscalKindMix.reduce((s, b) => s + b.orderCount, 0),
              )}
            />
          ) : (
            <div className="h-[220px] flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </Card>
        <Card
          title="Currency bridge"
          description="Multi-currency revenue mix"
          action={<Info className="w-3.5 h-3.5 text-slate-400" />}
        >
          {report && report.currencyBridge.length > 0 ? (
            <ul className="space-y-1.5">
              {report.currencyBridge.map((row) => (
                <li
                  key={row.code}
                  className="flex items-center justify-between gap-2 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs"
                >
                  <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                    {row.code}
                  </span>
                  <span className="tabular-nums text-slate-700 dark:text-slate-200">
                    {formatCurrency(row.revenue, row.code)}
                  </span>
                  <span className="text-[10px] text-slate-500 tabular-nums">
                    {formatPct(row.share * 100)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-slate-400 py-6 text-center">
              {loading ? 'Loading…' : ''}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <Card
          title="OSS — cross-border EU VAT"
          description="EU country sales (excluding Italy) — One-Stop Shop reporting"
        >
          {report && report.ossByCountry.length > 0 ? (
            <TableWithSparkline
              rows={report.ossByCountry}
              columns={ossColumns}
              currency="EUR"
              rowKey={(r) => r.country}
              dense
              emptyLabel="No OSS-eligible sales"
            />
          ) : (
            <div className="text-sm text-slate-400 py-6 text-center">
              {loading ? 'Loading…' : 'No OSS-eligible sales this window'}
            </div>
          )}
        </Card>
        <Card
          title="Intrastat — goods movement"
          description="EU destination countries for goods dispatch"
        >
          {report && report.intrastatGoods.length > 0 ? (
            <TableWithSparkline
              rows={report.intrastatGoods}
              columns={ossColumns}
              currency="EUR"
              rowKey={(r) => r.country}
              dense
              emptyLabel="No EU dispatches"
            />
          ) : (
            <div className="text-sm text-slate-400 py-6 text-center">
              {loading ? 'Loading…' : 'No EU dispatches this window'}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Settlement reconciliation"
        description="Per-channel revenue vs refunds — match against payout deposits"
        className="mb-3"
      >
        {report && report.settlement.length > 0 ? (
          <TableWithSparkline
            rows={report.settlement}
            columns={settleColumns}
            currency="EUR"
            rowKey={(r) => r.channel}
            dense
          />
        ) : (
          <div className="text-sm text-slate-400 py-6 text-center">
            {loading ? 'Loading…' : 'No settlement data'}
          </div>
        )}
      </Card>

      {report && report.creditNoteLedger.length > 0 && (
        <Card
          title="Note di credito"
          description="Credit notes issued this window (DPR 633/72 Art. 26)"
        >
          <TableWithSparkline
            rows={report.creditNoteLedger}
            columns={noteColumns}
            currency="EUR"
            rowKey={(r) => r.id}
            dense
          />
        </Card>
      )}
    </div>
  )
}
