'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { EmptyState, MetricStrip, PerformanceGraph, SummaryTable } from '@nexus/ui/components'
import { Button, SegmentedControl, Spinner, Tag } from '@nexus/ui/primitives'
import { chart } from '@nexus/ui/tokens'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantityText } from '../../../_shared/model'
import { materialText, pctWords, signedPct } from '../../../wip/cutting/model'
import type { CutYield } from '../api'
import { anythingCut, belowPlan, cutOrderHref, cuttingHref, lotBars, lotHref, lotsPageHref, YIELD_PERIODS, type YieldCan, type YieldPeriod } from '../model'
import '../yield.css'

/** SCR-240 prr-yield — Cutting and yield's view model (the panel fetches nothing). */
export interface YieldPanelModel {
  readonly prefix: string
  readonly can: YieldCan
  readonly days: YieldPeriod
  readonly read: { readonly value: CutYield | null; readonly problem: string | null }
}

export interface YieldPanelActions {
  onDays?: (days: YieldPeriod) => void
  onRetry?: () => void
}

const NS = 'production-cutboard'

/**
 * SCR-240 prr-yield — Cutting and yield (B-W2b-130; design production.reports "Cutting and yield": "Cut vs ordered, material used,
 * yield per hide lot and supplier (MES-302)"; bars per lot and supplier; → Cutting, Lots). The period (7, 30 or 90 days ending on
 * the page's day), the tiles (cut vs ordered, waiting for reconciliation, fabric used against the estimate, leather yield against
 * the plan), the bars of yield per hide lot (worst first) with the plan as a line, and the tables per supplier, per lot, fabric per
 * material and the cut orders of the period. Never by cutter (SCM-255; Statuto dei Lavoratori art. 4).
 */
export function YieldPanel({ model, actions }: { model: YieldPanelModel; actions?: YieldPanelActions }) {
  const t = useT(NS)
  const tr = useT('production-reports')
  const locale = useLocale()
  const report = model.read.value
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const toCutting = cuttingHref(model.prefix, model.can)
  const toLots = lotsPageHref(model.prefix, model.can)
  return (
    <section className="fw-yr" aria-labelledby="fw-yr-title" id="prr-yield">
      <div className="fw-prr-card-head">
        <span className="fw-prr-inline">
          <h2 className="fw-prr-h2" id="fw-yr-title">
            {t('yield.title')}
          </h2>
          {report && <span className="fw-prr-muted">{t('yield.period', { from: day(report.from), to: day(report.to) })}</span>}
        </span>
        <span className="fw-prr-inline">
          <SegmentedControl
            size="sm"
            ariaLabel={t('yield.periodLabel')}
            value={String(model.days)}
            onChange={(value) => actions?.onDays?.(Number(value) as YieldPeriod)}
            options={YIELD_PERIODS.map((days) => ({ value: String(days), label: t('yield.days', { count: days }) }))}
          />
          {toCutting && (
            <Link className="fw-prr-link fw-yr-go" href={toCutting}>
              {t('yield.openCutting')} <ArrowRight size={14} aria-hidden />
            </Link>
          )}
          {toLots && (
            <Link className="fw-prr-link fw-yr-go" href={toLots}>
              {t('yield.openLots')} <ArrowRight size={14} aria-hidden />
            </Link>
          )}
        </span>
      </div>
      <span className="fw-prr-muted">{t('yield.privacy')}</span>
      {model.read.problem ? (
        <EmptyState title={t('yield.failed')} description={tr(model.read.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('board.retry')}</Button>} />
      ) : !report ? (
        <p className="fw-prr-muted" role="status">
          <Spinner size={12} /> {t('board.loading')}
        </p>
      ) : !anythingCut(report) ? (
        <EmptyState title={t('yield.emptyTitle')} description={t('yield.emptyBody')} />
      ) : (
        <YieldBody report={report} model={model} />
      )}
    </section>
  )
}

function YieldBody({ report, model }: { report: CutYield; model: YieldPanelModel }) {
  const t = useT(NS)
  const locale = useLocale()
  const q = (value: string) => quantityText(value, locale)
  const pct = (value: string | number | null) => pctWords(value, locale)
  const unit = report.leather.units.length === 1 ? report.leather.units[0]! : null
  const bars = lotBars(report.leather.lots)
  const cut = report.cut
  return (
    <div className="fw-yr-body">
      <MetricStrip
        minTileWidth={180}
        metrics={[
          {
            label: t('yield.tile.cut'),
            value: cut.orders === 0 ? '—' : `${cut.cut} / ${cut.ordered}`,
            hint: cut.orders === 0 ? t('yield.tile.cutNone') : t('yield.tile.cutHint', { pct: pct(cut.pct), difference: cut.difference > 0 ? `+${cut.difference}` : cut.difference < 0 ? `−${Math.abs(cut.difference)}` : '0', count: cut.orders }),
            ...(cut.difference < 0 ? { accent: 'var(--nds-warning)' } : {}),
          },
          {
            label: t('yield.tile.waiting'),
            value: String(cut.waiting),
            hint: cut.waiting > 0 ? t('yield.tile.waitingHint') : t('yield.tile.waitingNone'),
          },
          {
            label: t('yield.tile.fabric'),
            value: report.fabric.lays === 0 ? '—' : `${q(report.fabric.used)} m`,
            hint: report.fabric.lays === 0 ? t('yield.tile.fabricNone') : t('yield.tile.fabricHint', { estimated: q(report.fabric.estimated), difference: signedPct(report.fabric.differencePct, locale), count: report.fabric.lays }),
          },
          {
            label: t('yield.tile.leather'),
            value: unit ? pct(unit.yieldPct) : '—',
            hint: !unit
              ? report.leather.units.length === 0
                ? t('yield.tile.leatherNone')
                : t('yield.tile.leatherUnits')
              : unit.yieldPct === null
                ? t('tile.yieldUnknown')
                : t('yield.tile.leatherHint', { planned: pct(unit.plannedPct), variance: signedPct(unit.variancePct, locale), count: unit.hides, area: q(unit.used), uom: unit.uom }),
            ...(unit && belowPlan(unit.variancePct) ? { accent: 'var(--nds-warning)' } : {}),
          },
        ]}
      />

      {report.leather.units.length > 1 && (
        <ul className="fw-yr-units" aria-label={t('board.unitsLabel')}>
          {report.leather.units.map((row) => (
            <li key={row.uom}>{t('board.unitRow', { uom: row.uom, count: row.hides, area: q(row.used), yield: pct(row.yieldPct), variance: signedPct(row.variancePct, locale) })}</li>
          ))}
        </ul>
      )}

      {bars.length > 0 && (
        <figure className="fw-prr-chart" aria-label={t('yield.chart.label')}>
          <PerformanceGraph
            data={bars}
            xKey="lot"
            left={{ key: 'yield', label: t('yield.chart.yield'), axisLabel: t('yield.chart.axis'), color: chart.actual, axis: 'left', shape: 'bar', format: (value) => `${value} %` }}
            right={{ key: 'planned', label: t('yield.chart.planned'), color: chart.reference, axis: 'left', format: (value) => `${value} %` }}
            height={240}
          />
          <figcaption className="fw-prr-muted">{t('yield.chart.caption')}</figcaption>
        </figure>
      )}

      <div className="fw-yr-tables">
        {report.leather.suppliers.length > 0 && (
          <section className="fw-prr-lane" aria-label={t('yield.suppliers.title')}>
            <h3 className="fw-prr-h3">{t('yield.suppliers.title')}</h3>
            <SummaryTable
              label={t('yield.suppliers.title')}
              stackOnPhone
              columns={[t('yield.col.supplier'), t('yield.col.lotsHides'), t('yield.col.used'), t('yield.col.yield'), t('yield.col.planned')]}
              align={[undefined, 'right', 'right', 'right', 'right']}
              rows={report.leather.suppliers.map((row) => ({
                id: `${row.supplier?.id ?? '-'}|${row.uom}`,
                cells: [
                  row.supplier?.name ?? t('yield.noSupplier'),
                  t('yield.lotsHides', { lots: row.lots, hides: row.hides }),
                  `${q(row.used)} ${row.uom}`,
                  <YieldCell key="y" yieldPct={row.yieldPct} variancePct={row.variancePct} />,
                  pct(row.plannedPct),
                ],
              }))}
            />
          </section>
        )}

        {report.leather.lots.length > 0 && (
          <section className="fw-prr-lane" aria-label={t('yield.lots.title')}>
            <h3 className="fw-prr-h3">{t('yield.lots.title')}</h3>
            <SummaryTable
              label={t('yield.lots.title')}
              stackOnPhone
              columns={[t('yield.col.lot'), t('yield.col.supplier'), t('yield.col.hides'), t('yield.col.used'), t('yield.col.yield'), t('yield.col.planned')]}
              widths={['22%', '20%', '8%', '14%', '22%', undefined]}
              align={[undefined, undefined, 'right', 'right', 'right', 'right']}
              rows={report.leather.lots.map((row) => {
                const href = lotHref(model.prefix, row, model.can)
                return {
                  id: row.lot.id,
                  cells: [
                    <span key="l" className="fw-prr-inline">
                      {href ? (
                        <Link className="fw-prr-link" href={href}>
                          {row.lot.code}
                        </Link>
                      ) : (
                        row.lot.code
                      )}
                      {row.lot.supplierLotRef && <span className="fw-prr-muted">{t('yield.supplierLot', { ref: row.lot.supplierLotRef })}</span>}
                    </span>,
                    row.supplier?.name ?? t('yield.noSupplier'),
                    String(row.hides),
                    `${q(row.used)} ${row.uom}`,
                    <YieldCell key="y" yieldPct={row.yieldPct} variancePct={row.variancePct} />,
                    pct(row.plannedPct),
                  ],
                }
              })}
            />
          </section>
        )}

        {report.fabric.materials.length > 0 && (
          <section className="fw-prr-lane" aria-label={t('yield.fabric.title')}>
            <h3 className="fw-prr-h3">{t('yield.fabric.title')}</h3>
            <SummaryTable
              label={t('yield.fabric.title')}
              stackOnPhone
              columns={[t('yield.col.material'), t('yield.col.lays'), t('yield.col.estimated'), t('yield.col.usedM'), t('yield.col.difference')]}
              align={[undefined, 'right', 'right', 'right', 'right']}
              rows={report.fabric.materials.map((row) => ({
                id: `${row.item.id}|${row.colour?.id ?? '-'}`,
                cells: [materialText(row), String(row.lays), `${q(row.estimated)} m`, `${q(row.used)} m`, signedPct(row.differencePct, locale)],
              }))}
            />
            {report.fabric.waiting > 0 && <p className="fw-prr-muted">{t('yield.fabric.waiting', { count: report.fabric.waiting })}</p>}
          </section>
        )}

        {report.orders.length > 0 && (
          <section className="fw-prr-lane" aria-label={t('yield.orders.title')}>
            <h3 className="fw-prr-h3">{t('yield.orders.title')}</h3>
            <SummaryTable
              label={t('yield.orders.title')}
              stackOnPhone
              columns={[t('col.cutOrder'), t('col.material'), t('yield.col.cutOn'), t('yield.col.ordered'), t('yield.col.cutCol')]}
              align={[undefined, undefined, undefined, 'right', 'right']}
              rows={report.orders.map((row) => {
                const href = cutOrderHref(model.prefix, row, model.can)
                return {
                  id: row.id,
                  cells: [
                    <span key="n" className="fw-prr-inline">
                      {href ? (
                        <Link className="fw-prr-link" href={href}>
                          {row.number}
                        </Link>
                      ) : (
                        row.number
                      )}
                      <Tag tone={row.reconciled ? 'success' : 'neutral'}>{t(row.reconciled ? 'yield.reconciled' : 'yield.notReconciled')}</Tag>
                    </span>,
                    <span key="m" className="fw-yr-cell">
                      <span>{materialText(row)}</span>
                      <span className="nds-summary-sub">{t(`kind.${row.kind}`)}</span>
                    </span>,
                    formatDate(row.cutAt, { locale }),
                    String(row.ordered),
                    row.cut === null ? t('yield.waitsReconcile') : row.cut === row.ordered ? String(row.cut) : `${row.cut} (${row.cut > row.ordered ? '+' : '−'}${Math.abs(row.cut - row.ordered)})`,
                  ],
                }
              })}
            />
            {report.more > 0 && <p className="fw-prr-muted">{t('yield.orders.more', { count: report.more })}</p>}
          </section>
        )}
      </div>
    </div>
  )
}

/** A yield with its plan's difference in words (below the plan is said, never shown by colour alone). */
function YieldCell({ yieldPct, variancePct }: { yieldPct: string | null; variancePct: string | null }) {
  const t = useT(NS)
  const locale = useLocale()
  if (yieldPct === null) return <span>{t('yield.unknown')}</span>
  return (
    <span className="fw-yr-yield">
      <span>{pctWords(yieldPct, locale)}</span>
      {belowPlan(variancePct) && (
        <Tag tone="warning" title={t('yield.belowTitle', { variance: signedPct(variancePct, locale) })}>
          {t('yield.below')}
        </Tag>
      )}
    </span>
  )
}
