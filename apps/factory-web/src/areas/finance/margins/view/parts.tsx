'use client'

import Link from 'next/link'
import { MetricStrip, SummaryTable, type Metric } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { BarList as DsBarList } from '@nexus/ui/charts/bar-list/index'
import { MarginMeter as DsMarginMeter } from '@nexus/ui/charts/margin-meter/index'
import { Waterfall as DsWaterfall } from '@nexus/ui/charts/waterfall/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { OrderMargin } from '../api'
import { bridgeOf, changeTone, MARGINS_NAMESPACE, moneyText, pctText, pctTone, pointsBetween, waterfallOf, workOrderCostHref, type Bar, type MarginsCan } from '../model'
import '../margins.css'

/**
 * The margin parts the Margins page (SCR-155: its profitability DetailModal, By customer and style) and the sales order's
 * Margin tab share: MarginStrip (quoted → now → so far, the difference in tone; DS MetricStrip), MarginMeter, Waterfall
 * and BarList — the DS charts (B-W2b-18; composed here until B-W2b-09 built them) in this page's words — and
 * ProfitBridge (price − each cost − freight = margin, composed: the design's "NEW Bridge").
 * Each figure only with its grain; a margin amount only with the margin AND the cost grain (Owner answer S2).
 */

/** Margin, quoted → now (design order.margin.strip): quoted %, current estimate %, actual so far %, the difference € in tone. */
export function MarginStrip({ detail, can }: { detail: OrderMargin; can: Pick<MarginsCan, 'margin' | 'cost'> }) {
  const t = useT(MARGINS_NAMESPACE)
  const locale = useLocale()
  const points = pointsBetween(detail.quotedMarginPct, detail.estimateMarginPct)
  const metrics: Metric[] = [
    { label: t('strip.quoted'), value: pctText(detail.quotedMarginPct ?? null, locale), hint: detail.quotedCost === null ? t('strip.noQuotedCost') : t('strip.quotedHint') },
    {
      label: t('strip.estimate'),
      value: pctText(detail.estimateMarginPct ?? null, locale),
      hint: points === null ? t('strip.estimateHint') : t('strip.points', { points: pctText(String(points), locale, true).replace(' %', '') }),
    },
    { label: t('strip.actual'), value: detail.started ? pctText(detail.actualMarginPct ?? null, locale) : '—', hint: detail.final ? t('strip.actualFinal') : detail.started ? t('strip.actualOpen') : t('strip.actualNone') },
    ...(can.margin && can.cost
      ? [{ label: t('strip.difference'), value: <span className={`fw-fmg-tone is-${changeTone(detail.marginChange)}`}>{signed(detail.marginChange ?? null, detail.currency, locale)}</span>, hint: t('strip.differenceHint') } satisfies Metric]
      : []),
  ]
  return <MetricStrip metrics={metrics} minTileWidth={170} />
}

/** A decimal the API writes as text ("24.50"), as a number; null when not known. */
const numberOf = (value: string | null | undefined): number | null => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value))

/**
 * The margin now against the margin as quoted (design order.margin.meter): the DS MarginMeter (B-W2b-18) with the
 * quoted margin as its mark, in this page's sentence ("Margin now 24 % against 30 % quoted"); an unknown margin says so,
 * never 0. Drawn only with the margin grain.
 */
export function MarginMeter({ quoted, now, allowed = true }: { quoted: string | null | undefined; now: string | null | undefined; allowed?: boolean }) {
  const t = useT(MARGINS_NAMESPACE)
  const locale = useLocale()
  const ds = useDsWords()
  const against = (value: string, mark: string) => t('meter.label', { now: value, quoted: mark })
  return (
    <DsMarginMeter
      value={numberOf(now)}
      target={numberOf(quoted)}
      allowed={allowed}
      format={(value) => pctText(String(value), locale)}
      labels={{ ...ds.marginMeter, underTarget: against, onTarget: against, plain: (value) => t('meter.noQuoted', { now: value }), targetMark: (mark) => t('meter.quotedMark', { quoted: mark }) }}
    />
  )
}

/**
 * Where the margin went (design order.margin.waterfall): the DS Waterfall (B-W2b-18) — the margin as quoted, each part's
 * difference (a cost part that rose takes margin off), the margin now; a cost step opens Finance › Standard vs actual
 * (the order's work order when it has one). Without the margin and the cost grain, the reason in place of the chart.
 */
export function Waterfall({ detail, can, prefix }: { detail: OrderMargin; can: Pick<MarginsCan, 'margin' | 'cost' | 'costing'>; prefix: string }) {
  const t = useT(MARGINS_NAMESPACE)
  const locale = useLocale()
  const ds = useDsWords()
  const allowed = can.margin && can.cost
  const steps = allowed ? waterfallOf(detail) : null
  if (allowed && !steps) return <p className="fw-fmg-muted">{t('waterfall.none')}</p>
  const workOrders = detail.workOrderShares.map((share) => share.workOrder.id)
  const target = workOrders.length === 1 ? workOrders[0]! : null
  return (
    <DsWaterfall
      label={t('waterfall.title')}
      format={(value) => moneyText(value, detail.currency, locale)}
      heldReason={allowed ? null : t('waterfall.noGrain')}
      labels={ds.waterfall}
      steps={(steps ?? []).map((step) =>
        step.reason === 'QUOTED' || step.reason === 'NOW'
          ? { id: step.id, kind: step.reason === 'QUOTED' ? ('start' as const) : ('total' as const), label: t(`waterfall.${step.reason}`), amount: step.amount }
          : {
              id: step.id,
              kind: 'step' as const,
              label: t(`waterfall.reason.${step.reason}`),
              amount: step.amount,
              ...(step.reason !== 'PRICE' && can.costing ? { href: workOrderCostHref(prefix, target) } : {}),
            },
      )}
    />
  )
}

/** Margin % per customer or per style (design "BarList with margin %" = the DS BarList, B-W2b-18): a row filters the orders. */
export function BarList({ bars, label, onPick, active }: { bars: readonly Bar[]; label: string; onPick?: (id: string) => void; active?: string | null }) {
  const t = useT(MARGINS_NAMESPACE)
  const locale = useLocale()
  const ds = useDsWords()
  if (bars.length === 0) return <p className="fw-fmg-muted">{t('by.empty')}</p>
  return (
    <DsBarList
      label={label}
      format={(value) => pctText(String(value), locale)}
      labels={ds.barList}
      {...(onPick ? { onPick } : {})}
      active={active ?? null}
      items={bars.map((bar) => ({
        id: bar.id,
        label: bar.label,
        sub: bar.sub ? `${bar.sub} · ${t('by.orders', { count: bar.orders })}` : t('by.orders', { count: bar.orders }),
        value: numberOf(bar.pct),
        ...(pctTone(bar.pct) === 'danger' ? { tone: 'danger' as const } : {}),
      }))}
    />
  )
}

/** The order's profitability now (design pop:order "Bridge: price − material − labour − subcontract − freight = margin"). */
export function ProfitBridge({ detail, can }: { detail: OrderMargin; can: Pick<MarginsCan, 'cost' | 'price' | 'margin'> }) {
  const t = useT(MARGINS_NAMESPACE)
  const locale = useLocale()
  const rows = bridgeOf(detail, can)
  if (!rows) return <p className="fw-fmg-muted">{t('bridge.noGrain')}</p>
  return (
    <dl className="fw-fmg-bridge" aria-label={t('bridge.title')}>
      {rows.map((row) => (
        <div key={row.id} className={`fw-fmg-bridge-row is-${row.kind}`}>
          <dt>{t(row.label)}</dt>
          <dd>
            {row.kind === 'freight' ? (
              <span className="fw-fmg-muted">{t('bridge.noFreight')}</span>
            ) : row.kind === 'cost' ? (
              `− ${moneyText(row.amount, detail.currency, locale)}`
            ) : row.kind === 'margin' ? (
              <span className="fw-fmg-inline">
                {moneyText(row.amount, detail.currency, locale)}
                {can.margin && <Pill tone={pctTone(detail.estimateMarginPct)}>{pctText(detail.estimateMarginPct ?? null, locale)}</Pill>}
              </span>
            ) : (
              moneyText(row.amount, detail.currency, locale)
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** By line (design order.margin.lines): line, net (price), cost estimate and actual (cost), margin % (margin). */
export function MarginLines({ detail, can }: { detail: OrderMargin; can: Pick<MarginsCan, 'price' | 'cost' | 'margin'> }) {
  const t = useT(MARGINS_NAMESPACE)
  const locale = useLocale()
  if (detail.lines.length === 0) return <p className="fw-fmg-muted">{t('lines.none')}</p>
  const columns = [t('lines.line'), ...(can.price ? [t('lines.net')] : []), ...(can.cost ? [t('lines.estimate'), t('lines.actual')] : []), ...(can.margin ? [t('lines.quotedPct'), t('lines.marginPct')] : [])]
  return (
    <SummaryTable
      label={t('lines.title')}
      stackOnPhone
      columns={columns}
      align={[undefined, ...columns.slice(1).map(() => 'right' as const)]}
      rows={detail.lines.map((line) => ({
        id: line.id,
        cells: [
          <span key="l" className="fw-fmg-cell">
            <span>{`${line.seq} · ${line.style.code} · ${line.colourway.code}`}</span>
            <span className="fw-fmg-cell-sub">{line.closedShort > 0 ? t('lines.pieces', { count: line.quantity, closed: line.closedShort }) : t('lines.piecesOnly', { count: line.quantity })}</span>
          </span>,
          ...(can.price ? [moneyText(line.value ?? null, detail.currency, locale)] : []),
          ...(can.cost ? [moneyText(line.estimateCost ?? null, detail.currency, locale), moneyText(line.actualCost ?? null, detail.currency, locale)] : []),
          ...(can.margin ? [pctText(line.quotedMarginPct ?? null, locale), <Pill key="p" tone={pctTone(line.estimateMarginPct)}>{pctText(line.estimateMarginPct ?? null, locale)}</Pill>] : []),
        ],
      }))}
    />
  )
}

/** The work orders behind the cost: each a link to its cost in Finance › Standard vs actual. */
export function WorkOrderShares({ detail, can, prefix }: { detail: OrderMargin; can: Pick<MarginsCan, 'cost' | 'costing'>; prefix: string }) {
  const t = useT(MARGINS_NAMESPACE)
  const locale = useLocale()
  if (detail.workOrderShares.length === 0) return <p className="fw-fmg-muted">{t('shares.none')}</p>
  return (
    <SummaryTable
      label={t('shares.title')}
      stackOnPhone
      columns={[t('shares.workOrder'), t('shares.pieces'), t('shares.plan'), ...(can.cost ? [t('shares.estimate'), t('shares.actual')] : [])]}
      align={[undefined, 'right', undefined, ...(can.cost ? (['right', 'right'] as const) : [])]}
      rows={detail.workOrderShares.map((share) => ({
        id: share.workOrder.id,
        cells: [
          can.costing ? (
            <Link key="w" className="fw-fmg-link" href={workOrderCostHref(prefix, share.workOrder.id)}>
              {share.workOrder.number}
            </Link>
          ) : (
            share.workOrder.number
          ),
          t('shares.of', { pieces: share.pieces, of: share.ofPieces }),
          <span key="p" className="fw-fmg-cell">
            <span>{t(`plan.${share.plan}`)}</span>
            <span className="fw-fmg-cell-sub">{share.done ? t('shares.done') : share.provisional ? t('shares.provisional') : t('shares.open')}</span>
          </span>,
          ...(can.cost ? [moneyText(share.estimateCost ?? null, detail.currency, locale), moneyText(share.actualCost ?? null, detail.currency, locale)] : []),
        ],
      }))}
    />
  )
}

function signed(minor: number | null, currency: string, locale: Locale): string {
  if (minor === null) return '—'
  const text = moneyText(Math.abs(minor), currency, locale)
  return minor > 0 ? `+${text}` : minor < 0 ? `−${text}` : text
}
