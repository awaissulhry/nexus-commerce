'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { TIME_ZONE } from '../../../_shared/model'
import { useWords } from '../../../_shared/parts'
import type { AttendanceReport, EarningsReport } from '../../api'
import { absenceCodes, absenceMinutes, amountText, groupLabel, hours, lineRows, matchWords, monthRows, monthText, piecesText, shareText, type ReportsAddress, type ReportsCan, type ReportsProblem } from '../../model'
import '../../../efficiency/efficiency.css'

export interface PrintRead<T> {
  value: T | null
  problem: ReportsProblem | null
}

/** SCR-264-print — the reports on paper: one view model, nothing fetched. */
export interface ReportsPrintModel {
  person: string
  at: string
  company: string
  site: string | null
  month: string
  can: ReportsCan
  address: ReportsAddress
  attendance: PrintRead<AttendanceReport>
  earnings: PrintRead<EarningsReport>
  noSite: boolean
}

/** Design tab:pdf "Report (PDF)": printable, the filters on top, groups only; the browser saves it as a PDF. */
export function ReportsPrintView({ model }: { model: ReportsPrintModel }) {
  return (
    <WithMessages namespaces={['people-reports', 'people']}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: ReportsPrintModel }) {
  const t = useT('people-reports')
  const people = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const place = { locale, timeZone: TIME_ZONE }
  const { can, attendance, earnings } = model
  const say = (problem: ReportsProblem) => (problem.ns === 'people-reports' ? t(problem.words.key) : people(problem.words.key, problem.words.params))
  const attendanceWaits = can.attendance && !model.noSite && !attendance.value && !attendance.problem
  const earningsWaits = can.earnings && can.pay && !earnings.value && !earnings.problem
  const report = attendance.value
  const codes = report ? absenceCodes(report.groups) : []
  const match = report ? matchWords(report.match, report.month, locale) : null
  const earningRows = earnings.value ? (model.address.earnings === 'month' ? monthRows(earnings.value, locale) : lineRows(earnings.value)) : []
  return (
    <PrintView
      title={t('print.title', { month: monthText(model.month, locale) })}
      meta={[model.company, ...(model.site ? [model.site] : [])]}
      printedAt={formatDateTime(model.at, place)}
      printedBy={model.person}
      filters={[
        { label: t('scope.month'), value: monthText(model.month, locale) },
        { label: t('attendance.groupBy'), value: t(`attendance.by.${model.address.group}`) },
        ...(earnings.value ? [{ label: t('print.earningsRange'), value: `${monthText(earnings.value.from, locale)} – ${monthText(earnings.value.to, locale)}` }] : []),
      ]}
      printHeld={attendanceWaits || earningsWaits ? t('common.loading') : null}
      labels={ds.printView}
    >
      <p className="fw-ef-print-note">{t('print.privacy')}</p>
      {can.attendance && (
        <PrintSection title={t('section.attendance')}>
          {model.noSite ? (
            <p>{t('attendance.pickSite')}</p>
          ) : attendance.problem ? (
            <Banner tone="warning" title={say(attendance.problem)} />
          ) : !report ? (
            <p className="fw-pp-hint" role="status">
              <Spinner size={14} /> {t('common.loading')}
            </p>
          ) : (
            <>
              {match && <p>{t(match.key, match.params)}</p>}
              {report.groups.length === 0 ? (
                <p>{t('attendance.empty', { month: monthText(model.month, locale) })}</p>
              ) : (
                <SummaryTable
                  label={t('attendance.tableLabel')}
                  columns={[t('attendance.group'), t('attendance.people'), t('attendance.ordinary'), t('attendance.overtimeDay'), t('attendance.overtimeNight'), t('attendance.overtimeHoliday'), t('attendance.night'), t('attendance.holiday'), ...codes]}
                  align={[undefined, undefined, 'right', 'right', 'right', 'right', 'right', 'right', ...codes.map(() => 'right' as const)]}
                  rows={report.groups.map((row) => ({
                    id: row.id ?? 'none',
                    cells: [
                      groupLabel(row) ?? t('attendance.noGroup'),
                      row.tooFew ? t('tooFew') : String(row.people ?? '—'),
                      hours(row.figures?.ordinaryMinutes, locale),
                      hours(row.figures?.overtimeDayMinutes, locale),
                      hours(row.figures?.overtimeNightMinutes, locale),
                      hours(row.figures?.overtimeHolidayMinutes, locale),
                      hours(row.figures?.nightMinutes, locale),
                      hours(row.figures?.holidayMinutes, locale),
                      ...codes.map((code) => hours(absenceMinutes(row.figures, code), locale)),
                    ],
                  }))}
                />
              )}
            </>
          )}
        </PrintSection>
      )}
      {can.earnings && can.pay && (
        <PrintSection title={t('section.earnings')}>
          {earnings.problem ? (
            <Banner tone="warning" title={say(earnings.problem)} />
          ) : !earnings.value ? (
            <p className="fw-pp-hint" role="status">
              <Spinner size={14} /> {t('common.loading')}
            </p>
          ) : earningRows.length === 0 ? (
            <p>{t('earnings.empty')}</p>
          ) : (
            <SummaryTable
              label={t('earnings.tableLabel')}
              columns={[model.address.earnings === 'month' ? t('earnings.month') : t('earnings.line'), t('earnings.people'), t('earnings.pieces'), t('earnings.earnings'), t('earnings.makeUp'), t('earnings.share')]}
              align={[undefined, undefined, 'right', 'right', 'right', 'right']}
              rows={earningRows.map((row) => ({
                id: row.id,
                cells: row.tooFew ? [row.label ?? t('earnings.noLine'), t('tooFew'), '—', '—', '—', '—'] : [row.label ?? t('earnings.noLine'), String(row.people ?? '—'), piecesText(row.pieces, locale), amountText(row.earnings, locale), amountText(row.makeUp, locale), shareText(row.share, locale)],
              }))}
            />
          )}
        </PrintSection>
      )}
      {!can.attendance && !(can.earnings && can.pay) && <EmptyState title={people('problem.forbidden')} />}
    </PrintView>
  )
}
