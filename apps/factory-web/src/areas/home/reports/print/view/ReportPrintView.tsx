'use client'

import { Printer } from 'lucide-react'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { ReportAbout, ReportResults } from '../../api'
import { cellText, columnLabel, heldOf, reportWordKey, rightsLines } from '../../model'
import '../../reports.css'

/**
 * SCR-104-print — a report as PDF (design home.reports tab:report-print "A report as PDF": print or file it): the title,
 * its question, what the run looked at and when, who printed it and "What you see" at the top, then every row the
 * person's rights reach and the totals. Opened in a new tab from the report's Print or Export ▾ › PDF; the print
 * stylesheet hides the Office frame and the browser saves the PDF. One view model, nothing fetched.
 */

export interface ReportPrintModel {
  readonly person: string
  readonly about: { readonly value: ReportAbout | null; readonly problem: string | null }
  readonly results: { readonly value: ReportResults | null; readonly problem: string | null }
}

export function ReportPrintView({ model }: { model: ReportPrintModel }) {
  return (
    <WithMessages namespaces={['home-reports']}>
      <ReportPrint model={model} />
    </WithMessages>
  )
}

function ReportPrint({ model }: { model: ReportPrintModel }) {
  const t = useT('home-reports')
  const locale = useLocale()
  const about = model.about.value
  const results = model.results.value
  const held = about ? heldOf(about) : null
  const problem = model.about.problem ?? model.results.problem
  const numeric = (kind: string) => kind === 'number' || kind === 'money' || kind === 'percent'
  const filterText = (key: string, value: string | null, label: string | null) => {
    const filter = about?.filters.find((entry) => entry.key === key)
    if (!about || !filter) return label ?? value ?? ''
    if (value === null) return filter.kind === 'site' ? t('filters.allSites') : t('filters.any')
    if (filter.kind === 'period') return t(`period.${value}`)
    if (filter.kind === 'choice') return t(reportWordKey(about.key, `choice.${key}.${value}`))
    return label ?? value
  }
  return (
    <article className="fw-rep-print">
      <header className="fw-rep-print-head">
        <h1 className="fw-rep-print-title">{about ? t(reportWordKey(about.key, 'title')) : t('print.titleLoading')}</h1>
        {about && <p className="fw-rep-question">{t(reportWordKey(about.key, 'question'))}</p>}
        {results && about && (
          <p className="fw-rep-muted">
            {results.applied.map((entry) => `${t(reportWordKey(about.key, `filter.${entry.key}`))}: ${filterText(entry.key, entry.value, entry.label)}`).join(' · ')}
            {results.range ? ` · ${t('filters.range', { from: formatDate(`${results.range.from}T12:00:00Z`, { locale }), to: formatDate(`${results.range.to}T12:00:00Z`, { locale }) })}` : ''}
          </p>
        )}
        <p className="fw-rep-muted">{results ? t('print.meta', { at: formatDateTime(results.asOf, { locale }), person: model.person }) : model.person}</p>
        {rightsLines(results?.rights ?? null, t).map((line) => (
          <p key={line} className="fw-rep-muted">
            {line}
          </p>
        ))}
        <Button className="fw-rep-print-button" variant="secondary" onClick={() => window.print()} heldReason={results && !held ? undefined : t('print.held')}>
          <Printer size={14} aria-hidden /> {t('print.button')}
        </Button>
      </header>
      {problem ? (
        <Banner tone="danger" title={t('results.failed')}>
          {t(problem)}
        </Banner>
      ) : held ? (
        <Banner tone="warning" title={t(held.key, { grain: t(`grain.${held.grain ?? 'price'}`) })}>
          {t(`${held.key}Body`, { grain: t(`grain.${held.grain ?? 'price'}`) })}
        </Banner>
      ) : !about || !results ? (
        <p className="fw-rep-muted" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : results.rows.length === 0 ? (
        <p className="fw-rep-muted">{t('results.empty')}</p>
      ) : (
        <>
          <SummaryTable
            label={t(reportWordKey(about.key, 'title'))}
            columns={results.columns.map((column) => columnLabel(about.key, column, t))}
            align={results.columns.map((column) => (numeric(column.kind) ? 'right' : 'left'))}
            rows={results.rows.map((row) => ({ id: row.id, cells: results.columns.map((column) => cellText(column, row.cells[column.key], row.currency, t, locale) || (column.people ? '—' : '')) }))}
          />
          <p className="fw-rep-print-totals">
            {[
              t('results.count', { count: results.totals.rows }),
              ...results.columns
                .filter((column) => column.sum && column.key in results.totals.sums)
                .map((column) => {
                  const value = results.totals.sums[column.key]
                  return `${columnLabel(about.key, column, t)}: ${value === null || value === undefined ? t('results.severalCurrencies') : cellText(column, value, results.totals.currency, t, locale)}`
                }),
            ].join(' · ')}
          </p>
          {!results.complete && <p className="fw-rep-muted">{t('results.cut', { count: results.rows.length })}</p>}
        </>
      )}
    </article>
  )
}
