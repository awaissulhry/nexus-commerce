'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { TIME_ZONE } from '../../../_shared/model'
import { useWords } from '../../../_shared/parts'
import type { Overview } from '../../api'
import { lineLabel, minutesText, overviewNotes, percentText, type EfficiencyProblem } from '../../model'
import '../../efficiency.css'

/** SCR-161-print — the line report on paper: one view model, nothing fetched. */
export interface EfficiencyPrintModel {
  person: string
  at: string
  company: string
  site: string | null
  noSite: boolean
  can: boolean
  read: { value: Overview | null; problem: EfficiencyProblem | null }
}

/** Design tab:print "Line report (print)": the scope on top, the tiles' figures, one row per line. Never a person. */
export function EfficiencyPrintView({ model }: { model: EfficiencyPrintModel }) {
  return (
    <WithMessages namespaces={['people-efficiency', 'people']}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: EfficiencyPrintModel }) {
  const t = useT('people-efficiency')
  const people = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const place = { locale, timeZone: TIME_ZONE }
  const value = model.read.value
  const problem = model.read.problem
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, place)
  const waiting = !value && !problem && !model.noSite && model.can
  return (
    <PrintView
      title={t('print.title')}
      meta={[model.company, ...(model.site ? [model.site] : [])]}
      printedAt={formatDateTime(model.at, place)}
      printedBy={model.person}
      filters={value ? [{ label: t('print.period'), value: `${day(value.from)} – ${day(value.to)}` }] : []}
      printHeld={value ? null : t('held.reading')}
      labels={ds.printView}
    >
      {!model.can ? (
        <EmptyState title={people('problem.forbidden')} />
      ) : model.noSite ? (
        <EmptyState title={t('privacy.pickSite')} description={t('privacy.pickSiteBody')} />
      ) : problem ? (
        <Banner tone="danger" title={t('tiles.failed')}>
          {problem.ns === 'efficiency' ? t(problem.words.key) : people(problem.words.key, problem.words.params)}
        </Banner>
      ) : waiting ? (
        <p className="fw-pp-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : value ? (
        <>
          <p className="fw-ef-print-note">{t('print.privacy')}</p>
          <PrintSection title={t('section.tiles')}>
            <SummaryTable
              label={t('section.tiles')}
              columns={[t('tile.efficiency'), t('tile.onStandard'), t('tile.earned'), t('tile.attended'), t('tile.offStandard')]}
              align={['right', 'right', 'right', 'right', 'right']}
              rows={[{ id: 'totals', cells: [percentText(value.tiles?.efficiency, locale), percentText(value.tiles?.onStandardEfficiency, locale), minutesText(value.tiles?.earnedMinutes, locale), minutesText(value.tiles?.attendedMinutes, locale), minutesText(value.tiles?.offStandardMinutes, locale)] }]}
            />
          </PrintSection>
          <PrintSection title={t('section.lines')}>
            {value.lines.length === 0 ? (
              <p>{t('lines.empty')}</p>
            ) : (
              <SummaryTable
                label={t('lines.tableLabel')}
                columns={[t('lines.line'), t('lines.people'), t('tile.efficiency'), t('tile.onStandard'), t('tile.earned'), t('tile.attended'), t('tile.offStandard')]}
                align={[undefined, undefined, 'right', 'right', 'right', 'right', 'right']}
                rows={value.lines.map((row) => ({
                  id: row.line?.id ?? 'none',
                  cells: row.tooFew
                    ? [lineLabel(row.line) ?? t('lines.noLine'), t('tooFew.short'), '—', '—', '—', '—', '—']
                    : [lineLabel(row.line) ?? t('lines.noLine'), String(row.people ?? '—'), percentText(row.figures.efficiency, locale), percentText(row.figures.onStandardEfficiency, locale), minutesText(row.figures.earnedMinutes, locale), minutesText(row.figures.attendedMinutes, locale), minutesText(row.figures.offStandardMinutes, locale)],
                }))}
              />
            )}
            <ul className="fw-pp-list">
              {overviewNotes(value).map((note) => (
                <li key={note.key}>{t(note.key, note.count === undefined ? {} : { count: note.count })}</li>
              ))}
            </ul>
          </PrintSection>
        </>
      ) : null}
    </PrintView>
  )
}
