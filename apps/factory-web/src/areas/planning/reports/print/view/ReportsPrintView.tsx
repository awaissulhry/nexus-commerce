'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Adherence, Cover, Utilisation } from '../../api'
import { cellWords, laneLabel, pctText, quantityText, signedDays, weekLabel, type ReportsCan } from '../../model'
import '../../reports.css'

/** The cover rows printed (the soonest to run out first). */
export const PRINT_COVER_ROWS = 200

/** SCR-409 — Planning reports on paper or as a PDF (design tab:print): one view model, nothing fetched. */
export interface ReportsPrintModel {
  person: string
  at: string
  company: string
  /** The site the reports are about. */
  site: string | null
  can: ReportsCan
  range: { from: string; to: string }
  /** Weeks of load ahead. */
  ahead: number
  /** The report's page (the strip's way back). */
  back: string
  adherence: Adherence | null
  utilisation: Utilisation | null
  cover: Cover | null
  /** A message key (planning-reports) of the part that failed. */
  problem: string | null
}

/**
 * The monthly planning review on paper (design tab:print, "Print stylesheet with scope and period written at the top"): the
 * company, the site, the period, the weeks ahead and the day it was printed on top; then schedule adherence (lines × weeks and the
 * period), the utilisation trend (every lane by week) and the material cover (the first 200 materials, the soonest to run out
 * first). No money, no person.
 */
export function ReportsPrintView({ model }: { model: ReportsPrintModel }) {
  return (
    <WithMessages namespaces={['planning-reports', 'stock']}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: ReportsPrintModel }) {
  const t = useT('planning-reports')
  const stock = useT('stock')
  const locale = useLocale()
  const ds = useDsWords()
  const day = (date: string | null) => (date ? formatDate(`${date}T12:00:00Z`, { locale }) : '—')
  const { adherence, utilisation, cover } = model
  const ready = !!adherence && !!utilisation && !!cover
  const filters = [
    { label: t('print.site'), value: model.site ?? '—' },
    { label: t('print.period'), value: `${day(model.range.from)} – ${day(model.range.to)}` },
    { label: t('print.ahead'), value: model.ahead === 0 ? t('utilisation.aheadNone') : t('utilisation.aheadWeeks', { count: model.ahead }) },
    ...(cover ? [{ label: t('print.horizon'), value: `${day(cover.horizon.from)} – ${day(cover.horizon.to)}` }] : []),
  ]
  const words = { cell: (onTime: number, planned: number) => t('adherence.cell', { onTime, planned }), none: '—', unplanned: (count: number) => t('adherence.cellUnplanned', { count }) }
  const withPct = (figures: Adherence['all'] | null) => (figures && figures.finished > 0 ? `${cellWords(figures, words)}${figures.onTimePct ? ` · ${pctText(figures.onTimePct, locale)}` : ''}` : '—')
  const lineName = (line: Adherence['lines'][number]['line']) => (line ? `${line.code} · ${line.name}` : t('adherence.noLine'))
  const printable = !model.can.view ? null : !model.can.plans || !model.site ? t('noSite.title') : null
  return (
    <PrintView
      title={t('print.title')}
      meta={[model.company]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={filters}
      printHeld={ready ? null : t('print.held')}
      back={{ href: model.back, label: t('print.back') }}
      labels={ds.printView}
    >
      {!model.can.view ? (
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      ) : printable ? (
        <EmptyState title={printable} description={model.can.plans ? t('noSite.body') : t('noSite.notPlanned')} />
      ) : model.problem ? (
        <Banner tone="danger" title={t('print.failed')}>
          {t(model.problem)}
        </Banner>
      ) : !ready ? (
        <p className="fw-plr-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <>
          <PrintSection title={t('section.adherence')}>
            {adherence!.all.finished === 0 ? (
              <p>{t('adherence.empty')}</p>
            ) : (
              <>
                <SummaryTable
                  label={t('adherence.tableLabel')}
                  widths={['20%']}
                  columns={[t('adherence.col.line'), ...adherence!.weeks.map((week) => weekLabel(week, locale)), t('adherence.col.period')]}
                  rows={[
                    ...adherence!.lines.map((line) => ({ id: line.line?.id ?? 'none', cells: [lineName(line.line), ...adherence!.weeks.map((week) => withPct(line.weeks.find((entry) => entry.key === week.key)?.figures ?? null)), withPct(line.figures)] })),
                    { id: 'all', cells: [<strong key="t">{t('adherence.all')}</strong>, ...adherence!.weeks.map((week) => withPct(week.figures)), withPct(adherence!.all)] },
                  ]}
                />
                <p className="fw-plr-print-note">
                  {[t('adherence.printTotals', { late: adherence!.all.late, notPlanned: adherence!.all.notPlanned, days: signedDays(adherence!.all.meanFinishDays, locale) }), t('adherence.definition')].join(' ')}
                </p>
              </>
            )}
          </PrintSection>
          <PrintSection title={t('section.utilisation')}>
            <SummaryTable
              label={t('utilisation.tableLabel')}
              widths={['20%']}
              columns={[t('utilisation.col.lane'), ...utilisation!.weeks.map((week) => weekLabel(week, locale))]}
              rows={utilisation!.lanes.map((lane) => ({
                id: `${lane.kind}:${lane.id ?? ''}:${lane.workCentreKind ?? ''}`,
                cells: [
                  laneLabel(lane, { plant: t('utilisation.plant'), kind: (kind) => t(`utilisation.kind.${kind}`) }),
                  ...utilisation!.weeks.map((week) => {
                    const cell = lane.cells.find((entry) => entry.key === week.key)
                    const parts = [cell?.utilisationPct ? t('utilisation.used', { pct: pctText(cell.utilisationPct, locale) }) : null, cell?.loadPct ? t('utilisation.load', { pct: pctText(cell.loadPct, locale) }) : null].filter(Boolean)
                    return parts.length > 0 ? parts.join(' · ') : '—'
                  }),
                ],
              }))}
            />
            <p className="fw-plr-print-note">{t('utilisation.definition')}</p>
          </PrintSection>
          <PrintSection title={t('section.cover')}>
            {cover!.rows.length === 0 ? (
              <p>{t('cover.empty')}</p>
            ) : (
              <>
                <SummaryTable
                  label={t('section.cover')}
                  widths={['26%']}
                  columns={[t('cover.col.material'), t('cover.col.cover'), t('cover.col.when'), t('cover.col.stock'), t('cover.col.purchases')]}
                  rows={cover!.rows.slice(0, PRINT_COVER_ROWS).map((row) => {
                    const unit = stock(`uom.${row.item.baseUom}`)
                    return {
                      id: `${row.item.id}|${row.colour?.id ?? '-'}`,
                      cells: [
                        `${row.item.code} · ${row.item.name}${row.colour ? ` · ${row.colour.name}` : ''}`,
                        `${row.daysOfCover === null ? t('cover.beyond', { count: cover!.horizon.days }) : t('cover.days', { count: row.daysOfCover })} · ${t(`cover.state.${row.state}`)}`,
                        row.stockOutOn ? t('cover.stockOutOn', { day: day(row.stockOutOn) }) : t('cover.noStockOut'),
                        `${quantityText(row.onHand, unit, locale)} / ${quantityText(row.demand, unit, locale)}`,
                        row.openPurchases.lines === 0 ? t('cover.noPurchases') : `${t('cover.purchases', { count: row.openPurchases.orders, quantity: quantityText(row.openPurchases.quantity, unit, locale) })}${row.openPurchases.next ? ` · ${t('cover.nextDue', { day: day(row.openPurchases.next.day) })} ${row.openPurchases.next.number}` : ''}`,
                      ],
                    }
                  })}
                />
                <p className="fw-plr-print-note">{[t('cover.definition'), cover!.rows.length > PRINT_COVER_ROWS || cover!.more > 0 ? t('print.coverMore', { count: Math.min(cover!.rows.length, PRINT_COVER_ROWS) }) : null].filter(Boolean).join(' ')}</p>
              </>
            )}
          </PrintSection>
        </>
      )}
    </PrintView>
  )
}
