'use client'

import Link from 'next/link'
import { MetricStrip, SummaryTable, type Metric } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { OrderMargin } from '../api'
import { barWidth, bridgeOf, changeTone, MARGINS_NAMESPACE, moneyText, pctText, pctTone, pointsBetween, waterfallOf, workOrderCostHref, type Bar, type MarginsCan } from '../model'
import '../margins.css'

/**
 * The margin parts the Margins page (SCR-155: its profitability DetailModal, By customer and style) and the sales order's
 * Margin tab share. Composed in the app (packages/ui is frozen; the design marks them "(new)"): MarginStrip (quoted →
 * now → so far, the difference in tone), MarginMeter (the margin now against the margin as quoted, on one bar),
 * Waterfall (where the margin went, quoted → each part → now; a step opens Finance › Standard vs actual), BarList
 * (margin % per customer or style; a bar filters the orders) and ProfitBridge (price − each cost − freight = margin).
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

/** The margin now against the margin as quoted, on one bar (0 to 100 %; a negative margin draws no fill, the words say it). */
export function MarginMeter({ quoted, now }: { quoted: string | null | undefined; now: string | null | undefined }) {
  const t = useT(MARGINS_NAMESPACE)
  const locale = useLocale()
  const clamp = (value: string | null | undefined) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.max(0, Math.min(100, Number(value))))
  const fill = clamp(now)
  const mark = clamp(quoted)
  const label = mark === null ? t('meter.noQuoted', { now: pctText(now ?? null, locale) }) : t('meter.label', { now: pctText(now ?? null, locale), quoted: pctText(quoted ?? null, locale) })
  return (
    <div className="fw-fmg-meter" role="img" aria-label={label}>
      <div className="fw-fmg-meter-track">
        {fill !== null && <span className={`fw-fmg-meter-fill is-${pctTone(now)}`} style={{ width: `${fill}%` }} />}
        {mark !== null && <span className="fw-fmg-meter-mark" style={{ left: `${mark}%` }} aria-hidden />}
      </div>
      <p className="fw-fmg-muted">{label}</p>
    </div>
  )
}

/**
 * Where the margin went (design order.margin.waterfall): the margin as quoted, each part's difference (a cost part that
 * rose takes margin off), the margin now; drawn as floating bars on one scale, the amounts beside them. A cost step
 * opens Finance › Standard vs actual (the order's work order when it has one). Needs the margin and the cost grain.
 */
export function Waterfall({ detail, can, prefix }: { detail: OrderMargin; can: Pick<MarginsCan, 'margin' | 'cost' | 'costing'>; prefix: string }) {
  const t = useT(MARGINS_NAMESPACE)
  const locale = useLocale()
  if (!can.margin || !can.cost) return <p className="fw-fmg-muted">{t('waterfall.noGrain')}</p>
  const steps = waterfallOf(detail)
  if (!steps) return <p className="fw-fmg-muted">{t('waterfall.none')}</p>
  const lowest = Math.min(0, ...steps.map((step) => Math.min(step.from, step.to)))
  const highest = Math.max(0, ...steps.map((step) => Math.max(step.from, step.to)))
  const span = highest - lowest || 1
  const at = (value: number) => ((value - lowest) / span) * 100
  const workOrders = detail.workOrderShares.map((share) => share.workOrder.id)
  const target = workOrders.length === 1 ? workOrders[0]! : null
  return (
    <ol className="fw-fmg-waterfall" aria-label={t('waterfall.title')}>
      {steps.map((step) => {
        const total = step.reason === 'QUOTED' || step.reason === 'NOW'
        const left = at(Math.min(step.from, step.to))
        const width = Math.max(0.6, at(Math.max(step.from, step.to)) - left)
        const tone = total ? 'total' : step.amount < 0 ? 'down' : 'up'
        const label = total ? t(`waterfall.${step.reason}`) : t(`waterfall.reason.${step.reason}`)
        const amount = total ? moneyText(step.amount, detail.currency, locale) : signed(step.amount, detail.currency, locale)
        const linked = !total && step.reason !== 'PRICE' && can.costing
        return (
          <li key={step.id} className={`fw-fmg-step is-${tone}`}>
            <span className="fw-fmg-step-label">
              {linked ? (
                <Link className="fw-fmg-link" href={workOrderCostHref(prefix, target)} aria-label={t('waterfall.open', { part: label })}>
                  {label}
                </Link>
              ) : (
                label
              )}
            </span>
            <span className="fw-fmg-step-track" aria-hidden>
              <span className="fw-fmg-step-bar" style={{ left: `${left}%`, width: `${width}%` }} />
            </span>
            <span className="fw-fmg-step-amount">{amount}</span>
          </li>
        )
      })}
    </ol>
  )
}

/** Margin % per customer or per style (design "NEW BarList"): one row each, the bar to the widest margin; a row filters the orders. */
export function BarList({ bars, label, onPick, active }: { bars: readonly Bar[]; label: string; onPick?: (id: string) => void; active?: string | null }) {
  const t = useT(MARGINS_NAMESPACE)
  const locale = useLocale()
  if (bars.length === 0) return <p className="fw-fmg-muted">{t('by.empty')}</p>
  return (
    <ul className="fw-fmg-bars" aria-label={label}>
      {bars.map((bar) => {
        const width = barWidth(bar.pct, bars)
        const text = pctText(bar.pct, locale)
        return (
          <li key={bar.id}>
            <button type="button" className={`fw-fmg-bar${active === bar.id ? ' is-active' : ''}`} aria-pressed={active === bar.id} onClick={() => onPick?.(bar.id)} aria-label={t('by.pick', { name: bar.label, pct: text, count: bar.orders })}>
              <span className="fw-fmg-bar-label">
                <span className="fw-fmg-ellipsis">{bar.label}</span>
                <span className="fw-fmg-bar-sub">{bar.sub ? `${bar.sub} · ${t('by.orders', { count: bar.orders })}` : t('by.orders', { count: bar.orders })}</span>
              </span>
              <span className="fw-fmg-bar-track" aria-hidden>
                <span className={`fw-fmg-bar-fill is-${pctTone(bar.pct)}`} style={{ width: `${width}%` }} />
              </span>
              <span className="fw-fmg-bar-value">{text}</span>
            </button>
          </li>
        )
      })}
    </ul>
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
