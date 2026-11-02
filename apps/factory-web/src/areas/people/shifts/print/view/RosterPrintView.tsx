'use client'

import { useMemo } from 'react'
import { Printer } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { TIME_ZONE } from '../../../_shared/model'
import type { Roster } from '../../api'
import { datesOf, dayLong, draftsOf, paperCell, paperLines, rangeText, sheetRowsOf, type DayRange } from '../../model'
import { ShiftMessages, useShiftWords } from '../../view/parts'

/** SCR-263-print — the roster on paper: one view model, nothing fetched. */
export interface RosterPrintModel {
  readonly person: string
  readonly at: string
  readonly company: string
  readonly range: DayRange
  readonly roster: { readonly value: Roster | null; readonly problem: string | null }
}

export function RosterPrintView({ model }: { model: RosterPrintModel }) {
  return (
    <ShiftMessages>
      <Paper model={model} />
    </ShiftMessages>
  )
}

function Paper({ model }: { model: RosterPrintModel }) {
  const t = useShiftWords()
  const locale = useLocale()
  const roster = model.roster.value
  const lines = useMemo(() => (roster ? paperLines(sheetRowsOf(roster)) : []), [roster])
  const dates = useMemo(() => datesOf(model.range), [model.range])
  const drafts = roster ? draftsOf(roster.rows.map((row) => ({ ...row, canEdit: true }))).drafts : 0
  return (
    <article className="fw-rs-print">
      <header className="fw-pp-head">
        <div>
          <h1 className="fw-rs-print-title">{t('print.title', { range: rangeText(model.range, locale) })}</h1>
          <p className="fw-pp-hint">{t('print.meta', { company: model.company, at: formatDateTime(model.at, { locale, timeZone: TIME_ZONE }), person: model.person })}</p>
        </div>
        <Button className="fw-rs-print-button" variant="secondary" onClick={() => window.print()} heldReason={lines.length > 0 ? null : t('print.held')}>
          <Printer size={14} aria-hidden /> {t('print.button')}
        </Button>
      </header>
      {drafts > 0 && <Banner tone="warning" title={t('print.drafts', { count: drafts })} />}
      {model.roster.problem ? (
        <Banner tone="danger" title={t('sheet.failed')}>
          {t(model.roster.problem)}
        </Banner>
      ) : !roster ? (
        <p className="fw-pp-hint" role="status">
          <Spinner size={14} /> {t('sheet.slow')}
        </p>
      ) : lines.length === 0 ? (
        <p className="fw-pp-text">{t('sheet.nobody')}</p>
      ) : (
        lines.map((line) => (
          <section key={line.key} className="fw-rs-print-line">
            <h2 className="fw-rs-print-title">
              {line.site.name} · {line.line ? `${line.line.code} ${line.line.name}` : t('sheet.noLine')}
            </h2>
            <div className="fw-rs-print-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('sheet.person')}</th>
                    {dates.map((date) => (
                      <th key={date} scope="col">
                        {dayLong(date, locale)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {line.people.map((person) => (
                    <tr key={person.id}>
                      <th scope="row">{person.row.displayName}</th>
                      {dates.map((date) => (
                        <td key={date}>{paperCell(person.cells[date], t('cell.off'))}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </article>
  )
}
