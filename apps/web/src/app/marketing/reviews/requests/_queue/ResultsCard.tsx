'use client'

/**
 * Reviews › Requests › Queue — "What requests brought" (`GET /api/reviews/analytics`): requests sent, the reviews that
 * followed within 30 days and the rate, by market, by product type and by rule, for 7, 30 or 90 days. Every rate is an
 * estimate: Amazon does not say which buyer wrote a review. The A/B rows (PR J) are the rules' A/B splits
 * (`GET /api/review-timing-tests?kind=AB`): each side's sent and rate, and the result in words with how sure.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner, Card, MetricStrip, SummaryTable, type Metric } from '@/design-system/components'
import { Button, SegmentedControl, Skeleton } from '@/design-system/primitives'
import { reviewsGet } from '../../_lib/reviewsFetch'
import { abResultRows, type TimingTestsAnswer } from '../timing/_timing/timingTestsModel'
import type { ResultsPeriod } from './queueQuery'
import { marketName, rateText } from './queueTiles'
import s from './queue.module.css'

interface Rollup { sent: number; reviewedAfter: number; conversionRate: number }
interface Analytics {
  overall: Rollup
  perMarketplace: Array<Rollup & { marketplace: string }>
  perProductType: Array<Rollup & { productType: string }>
  perRule: Array<Rollup & { ruleId: string | null; ruleName: string; ruleActive: boolean }>
}

const PERIODS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
]
const DAYS: Record<ResultsPeriod, number> = { '7d': 7, '30d': 30, '90d': 90 }

const n = (v: number) => v.toLocaleString('en-IE')
const rate = (r: Rollup) => (r.sent > 0 ? rateText(r.conversionRate) : '—')
const bySent = <T extends Rollup>(rows: T[]) => [...rows].sort((a, b) => b.sent - a.sent)

export interface ResultsCardProps {
  period: ResultsPeriod
  onPeriod: (period: ResultsPeriod) => void
}

export function ResultsCard({ period, onPeriod }: ResultsCardProps) {
  const [answer, setAnswer] = useState<{ period: ResultsPeriod; data: Analytics | null; error: string | null } | null>(null)
  const abort = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    try {
      const res = await reviewsGet<Analytics>('/reviews/analytics', { windowDays: DAYS[period], attributionWindowDays: 30 }, { signal: controller.signal })
      if (!controller.signal.aborted) setAnswer({ period, data: res.data, error: res.error })
    } catch {
      // aborted
    }
  }, [period])
  useEffect(() => {
    void load()
    return () => abort.current?.abort()
  }, [load])
  const [ab, setAb] = useState<{ data: TimingTestsAnswer | null; error: string | null } | null>(null)
  useEffect(() => {
    void reviewsGet<TimingTestsAnswer>('/review-timing-tests', { kind: 'AB' }).then((res) => setAb({ data: res.data, error: res.error }))
  }, [])
  const abRows = ab?.data ? abResultRows(ab.data.tests) : []

  const current = answer && answer.period === period ? answer : null
  const a = current?.data ?? null
  const metrics: Metric[] | null = a
    ? [
        { label: 'Sent', value: n(a.overall.sent), hint: `last ${DAYS[period]} days` },
        { label: 'Reviews after', value: n(a.overall.reviewedAfter), hint: 'within 30 days of the request' },
        { label: 'Review rate', value: rate(a.overall), hint: 'estimate' },
      ]
    : null

  return (
    <Card
      header={`What requests brought — last ${DAYS[period]} days`}
      description="A review counts when a new review for the same product and market arrives within 30 days of the request."
      headerAction={<SegmentedControl size="sm" ariaLabel="Period of the results" options={PERIODS} value={period} onChange={(v) => onPeriod(v as ResultsPeriod)} />}
    >
      {current?.error ? (
        <Banner tone="danger" title="Could not read the results" action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>
          {current.error}
        </Banner>
      ) : !a || !metrics ? (
        <Skeleton height={220} />
      ) : (
        <div className={s.results}>
          <MetricStrip metrics={metrics} minTileWidth={150} />
          <p className={s.muted}>
            Amazon gives no review count and does not say which buyer wrote a review, so its rate counts the reviews you imported and
            is an estimate (“—” where nothing was sent). eBay counts feedback left after our email.
          </p>
          <div className={s.resultTables}>
            <SummaryTable
              label="By market"
              columns={['By market', 'Sent', 'Rate']}
              rows={bySent(a.perMarketplace).map((r) => ({ id: r.marketplace, cells: [r.marketplace === '—' ? 'No market' : marketName(r.marketplace), n(r.sent), rate(r)] }))}
            />
            <SummaryTable
              label="By product type"
              columns={['By product type', 'Sent', 'Rate']}
              rows={bySent(a.perProductType).map((r) => ({ id: r.productType, cells: [r.productType, n(r.sent), rate(r)] }))}
            />
            <SummaryTable
              label="By rule"
              columns={['By rule', 'Sent', 'Rate']}
              rows={bySent(a.perRule).map((r) => ({ id: r.ruleId ?? 'none', cells: [`${r.ruleName}${r.ruleActive ? '' : ' (off)'}`, n(r.sent), rate(r)] }))}
            />
          </div>
          {abRows.length > 0 ? (
            <SummaryTable label="A/B splits" columns={['A/B split', 'Side A', 'Side B', 'Result']} rows={abRows} stackOnPhone />
          ) : (
            <p className={s.muted}>
              {ab?.error
                ? `The A/B splits could not be read: ${ab.error}`
                : 'No A/B split has run yet. On a rule, use “Duplicate as A/B”, change B, then start the split from the rule’s A/B card.'}
            </p>
          )}
        </div>
      )}
    </Card>
  )
}
