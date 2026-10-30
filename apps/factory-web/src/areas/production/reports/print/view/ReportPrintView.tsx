'use client'

import { Printer } from 'lucide-react'
import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { DailyReport } from '../../api'
import { anythingRecorded, pctText, siteEfficiency } from '../../model'
import '../../reports.css'

/** SCR-240-print — the daily production report on paper (the morning meeting): one view model, nothing fetched. */
export interface ReportPrintModel {
  /** Who printed it (the page's person, said at the top with the time). */
  readonly person: string
  readonly daily: { readonly value: DailyReport | null; readonly problem: string | null }
}

/**
 * Production › Reports › Print (design production.reports tab:prr-tab-print "Report print / PDF"; the morning meeting):
 * the site, the day and when it was read written at the top, the day's totals, then per lane its figures and its table
 * by style and size. Opened in a new tab from the page's ⋯; the print stylesheet hides the Office frame, and the browser
 * saves it as a PDF. Per line, work centre, style and size only, never per person.
 */
export function ReportPrintView({ model }: { model: ReportPrintModel }) {
  return (
    <WithMessages namespaces={['production-reports']}>
      <ReportPrint model={model} />
    </WithMessages>
  )
}

function ReportPrint({ model }: { model: ReportPrintModel }) {
  const t = useT('production-reports')
  const locale = useLocale()
  const daily = model.daily.value
  return (
    <article className="fw-prr-print">
      <header className="fw-prr-print-head">
        <h1 className="fw-prr-print-title">{daily ? t('print.title', { site: `${daily.site.code} · ${daily.site.name}`, day: formatDate(`${daily.day}T12:00:00Z`, { locale }) }) : t('print.titleLoading')}</h1>
        <p className="fw-prr-muted">
          {daily ? t('print.meta', { at: formatDateTime(daily.asOf, { locale }), person: model.person }) : model.person}
          {daily && daily.day === daily.today ? ` · ${t('print.soFar')}` : ''}
        </p>
        <p className="fw-prr-muted">{t('privacy')}</p>
        <Button className="fw-prr-print-button" variant="secondary" onClick={() => window.print()} heldReason={daily ? undefined : t('print.held')}>
          <Printer size={14} aria-hidden /> {t('print.button')}
        </Button>
      </header>
      {model.daily.problem ? (
        <Banner tone="danger" title={t('daily.failed')}>
          {t(model.daily.problem)}
        </Banner>
      ) : !daily ? (
        <p className="fw-prr-muted" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <>
          <SummaryTable
            label={t('print.totals')}
            columns={[t('tile.good'), t('tile.scrap'), t('tile.rework'), t('tile.efficiency')]}
            rows={[{ id: 'totals', cells: [String(daily.totals.good), String(daily.totals.scrap), String(daily.totals.rework), pctText(siteEfficiency(daily.lanes), locale)] }]}
          />
          {!anythingRecorded(daily.lanes) && <EmptyState title={t('daily.empty.title')} description={t('daily.empty.body')} />}
          <div className="fw-prr-lanes">
            {daily.lanes.map((lane) => {
              const title = `${lane.code} · ${lane.name}`
              return (
                <section key={`${lane.kind}:${lane.id}`} className="fw-prr-lane" aria-label={title}>
                  <div className="fw-prr-lane-head">
                    <h2 className="fw-prr-h3">{`${title} (${t(`kind.${lane.kind}`)})`}</h2>
                    <span className="fw-prr-muted">{t('lane.figures', { good: lane.good, scrap: lane.scrap, rework: lane.rework })}</span>
                    {lane.kind === 'LINE' && (
                      <span className="fw-prr-muted">
                        {lane.efficiencyPct === null
                          ? t('lane.noMinutes')
                          : t('lane.efficiency', { pct: pctText(lane.efficiencyPct, locale), earned: lane.earnedMinutes ?? '0', available: lane.availableMinutes ?? '0', people: lane.people ?? 0, minutes: lane.workingMinutes ?? 0 })}
                      </span>
                    )}
                  </div>
                  {lane.rows.length === 0 ? (
                    <p className="fw-prr-muted">{t('lane.nothing')}</p>
                  ) : (
                    <SummaryTable
                      label={t('lane.tableLabel', { lane: title })}
                      columns={[t('col.style'), t('col.size'), t('col.good'), t('col.scrap'), t('col.rework')]}
                      align={[undefined, undefined, 'right', 'right', 'right']}
                      rows={lane.rows.map((row) => ({ id: `${row.style.id}|${row.size}`, cells: [`${row.style.code} · ${row.style.name}`, row.size, String(row.good), String(row.scrap), String(row.rework)] }))}
                    />
                  )}
                </section>
              )
            })}
          </div>
        </>
      )}
    </article>
  )
}
