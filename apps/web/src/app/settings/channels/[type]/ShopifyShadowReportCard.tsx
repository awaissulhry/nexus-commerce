'use client'

/**
 * Shopify orders — shadow report (read-only). Shown on /settings/channels/shopify.
 *
 * One button, one GET. The report reads the shop's recent orders and Nexus SKUs and shows counts:
 * orders per week, how many lines the order webhook would match to a Nexus product, fulfilment
 * locations, status mix, test and POS shares. It never writes and never shows buyer data. The
 * server switch (NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT=1) is off by default; off reads as information.
 * The pure half (the call and the sentences) is ./shopifyShadowReport.ts.
 */

import { useCallback, useState } from 'react'
import { Banner, Card, KeyValue, MetricStrip, SummaryTable, type KeyValueItem } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import {
  NO_SKU_ROW,
  coverageSentence,
  fetchShopifyShadowReport,
  matchSentence,
  percent,
  readSentence,
  weekCell,
  type CountRow,
  type ShadowReportResult,
  type ShopifyShadowReport,
} from './shopifyShadowReport'

const WINDOW_DAYS = 60
const stack = (gap: string): React.CSSProperties => ({ display: 'grid', gap })
const muted: React.CSSProperties = { color: 'var(--nds-text-muted)', margin: 0 }

export function ShopifyShadowReportCard({ accountId }: { accountId: string }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ShadowReportResult | null>(null)

  const onRead = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      setResult(await fetchShopifyShadowReport(accountId, WINDOW_DAYS))
    } finally {
      setBusy(false)
    }
  }, [accountId, busy])

  return (
    <Card
      header="Shopify orders — shadow report"
      description={`Read-only. Reads this shop's orders from the last ${WINDOW_DAYS} days and shows counts only, with no buyer data. Nothing is written to Shopify or to Nexus orders, stock or listings.`}
      headerAction={
        <Button size="sm" onClick={onRead} aria-disabled={busy} aria-busy={busy}>
          {busy ? 'Reading orders…' : result?.kind === 'ok' ? 'Read again' : 'Read orders'}
        </Button>
      }
    >
      {result === null ? (
        <p style={muted}>Reads Shopify when you press the button. A shop with a few hundred orders takes a few seconds.</p>
      ) : result.kind === 'off' ? (
        <Banner tone="info" title="Switched off on this server">
          {result.message} Set it to 1 on the API service to read the report.
        </Banner>
      ) : result.kind === 'error' ? (
        <Banner tone="danger" title="The report could not be read">
          {result.message} Nothing was written.
        </Banner>
      ) : (
        <ShadowReportBody report={result.report} />
      )}
    </Card>
  )
}

function ShadowReportBody({ report }: { report: ShopifyShadowReport }) {
  const { orders, skus, locations, read } = report
  const coverage = coverageSentence(report)
  const share = (n: number) => (orders.total ? percent(n / orders.total) : '—')
  const lineItems: KeyValueItem[] = [
    { label: 'Lines matched', value: `${skus.matchedLines} of ${skus.lines}`, hint: `${skus.matchedUnits} of ${skus.units} units` },
    {
      label: 'Lines not matched',
      value: skus.unmatchedLines,
      hint: skus.nearMatchLines ? `${skus.nearMatchLines} differ from a Nexus SKU only in case or spaces` : undefined,
    },
    { label: NO_SKU_ROW.label, value: skus.linesWithoutSku, hint: skus.linesWithoutSku ? NO_SKU_ROW.hint : undefined },
    { label: 'Lines on a deleted product', value: skus.deletedProductLines, hint: skus.deletedProductLines ? 'matched, but the product is deleted' : undefined },
    { label: 'Orders partly matched', value: skus.ordersPartlyMatched },
    { label: 'Orders not matched', value: skus.ordersUnmatched },
    {
      label: `Orders with over ${read.linesPerOrder} lines`,
      value: skus.ordersWithUnreadLines,
      hint: skus.ordersWithUnreadLines ? `not fully read: not counted as matched; only the first ${read.linesPerOrder} lines are counted` : undefined,
    },
    {
      label: 'Orders with over 5 fulfilments',
      value: locations.ordersWithUnreadFulfilments,
      hint: locations.ordersWithUnreadFulfilments ? 'not fully read: only the first 5 fulfilments are counted' : undefined,
    },
    { label: 'Orders with no fulfilment', value: locations.ordersWithoutFulfillment },
    { label: 'Fulfilments with no location', value: locations.fulfillmentsWithoutLocation },
  ]

  return (
    <div style={stack('var(--nds-space-14)')}>
      <p style={muted}>
        {read.ordersRead} orders read in {read.pages} page{read.pages === 1 ? '' : 's'}, {new Date(report.generatedAt).toLocaleString()}.
      </p>
      {coverage && (
        <Banner tone="warning" title={read.complete ? 'Shopify holds back part of this window' : 'Partial read'}>
          {read.complete ? coverage : `${readSentence(report)} ${coverage}`}
        </Banner>
      )}
      {!read.locationsReadable && (
        <Banner tone="warning" title="Fulfilment locations not shown">
          Shopify did not show the fulfilment locations: the app needs the read_locations permission. The other counts are unaffected.
        </Banner>
      )}
      <MetricStrip
        metrics={[
          { label: 'Orders', value: orders.total, hint: report.coverage.complete ? `last ${report.window.days} days` : `created from ${report.coverage.since.slice(0, 10)} on` },
          { label: 'Every line matched', value: percent(skus.orderMatchRate), hint: `${skus.ordersFullyMatched} of ${orders.total} orders` },
          { label: 'Test orders', value: orders.test, hint: share(orders.test) },
          { label: 'POS orders', value: orders.pos, hint: share(orders.pos) },
          { label: 'Cancelled', value: orders.cancelled, hint: share(orders.cancelled) },
        ]}
      />
      <p style={{ margin: 0 }}>{matchSentence(report)}</p>
      <KeyValue items={lineItems} columns={3} dense />
      <div className="nds-cd-shadow-grid">
        <Titled title="Orders per week">
          <SummaryTable
            label="Orders per week"
            columns={['Week of', 'Orders', 'Units']}
            rows={orders.perWeek.map((w) => ({ id: w.weekStart, cells: [w.weekStart, weekCell(w.orders, w.coverage), weekCell(w.units, w.coverage)] }))}
          />
        </Titled>
        <div style={stack('var(--nds-space-14)')}>
          <Titled title="Fulfilment locations">
            <SummaryTable
              label="Fulfilment locations"
              columns={['Location', 'Orders', 'Fulfilments', 'Cancelled']}
              rows={
                locations.used.length
                  ? locations.used.map((l) => ({ id: l.id, cells: [<span key="n" title={l.id}>{l.name}</span>, l.orders, l.fulfillments, l.cancelledFulfillments] }))
                  : [{ id: 'none', cells: ['None recorded', '—', '—', '—'] }]
              }
            />
          </Titled>
          <CountTable title="Financial status" rows={orders.financialStatus} />
          <CountTable title="Fulfilment status" rows={orders.fulfillmentStatus} />
          <CountTable title="Order source" rows={orders.sources} />
        </div>
      </div>
      {skus.unmatched.length > 0 && (
        <div className="nds-cd-shadow-grid">
          <Titled title={`SKUs not matched (top ${skus.unmatched.length})`}>
            <SummaryTable
              label="SKUs not matched"
              columns={['Shopify SKU', 'Lines', 'Units', 'Near match']}
              rows={skus.unmatched.map((u) => ({ id: u.sku, cells: [u.sku, u.lines, u.units, u.nearMatch ? 'Yes' : 'No'] }))}
            />
          </Titled>
          <Titled title="Their shapes (A, a letters · 9 digits)">
            <SummaryTable
              label="Shapes of the SKUs not matched"
              columns={['Shape', 'Lines']}
              rows={skus.unmatchedShapes.map((s) => ({ id: s.shape, cells: [s.shape, s.lines] }))}
            />
          </Titled>
        </div>
      )}
    </div>
  )
}

function Titled({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={stack('var(--nds-space-6)')}>
      <span className="nds-cd-grouplabel">{title}</span>
      {children}
    </div>
  )
}

function CountTable({ title, rows }: { title: string; rows: CountRow[] }) {
  return (
    <Titled title={title}>
      <SummaryTable
        label={title}
        columns={['Value', 'Orders']}
        rows={rows.length ? rows.map((r) => ({ id: r.value, cells: [r.value, r.orders] })) : [{ id: 'none', cells: ['—', 0] }]}
      />
    </Titled>
  )
}
