'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { MoreHorizontal, SlidersHorizontal, UserRound } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { SectionLayout, type SectionLayoutValue, type SectionSpec } from '@nexus/ui/patterns'
import { Button, Input, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { AsOf, DetailModal, Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../record-panels/i18n'
import type { OfficeScope } from '../../../../shell/scope/scope-model'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { NoPeopleAccess, useWords } from '../../_shared/parts'
import { TIME_ZONE } from '../../_shared/model'
import { ArrangeDialog } from '../../efficiency/view/ArrangeDialog'
import { REPORT_GROUPS, type AttendanceReport, type AttendanceSight, type DayRecord, type Differences, type EarningsReport, type EarningsWorkers, type GroupRow, type ReportGroup } from '../api'
import {
  absenceCodes,
  absenceMinutes,
  amountText,
  cellMinutes,
  changedCells,
  differenceKey,
  groupLabel,
  hours,
  lineRows,
  MATCH_TONE,
  matches,
  matchWords,
  monthChoices,
  monthRows,
  monthText,
  piecesText,
  REPORT_SECTIONS,
  reportsPrintHref,
  SEND_EXPIRY_DAYS,
  SEND_FORMATS,
  sendHeld,
  shareText,
  workerRows,
  type EarningsRow,
  type ReportSection,
  type ReportsAddress,
  type ReportsCan,
  type ReportsProblem,
  type SendDraft,
  type SendFormat,
} from '../model'
import '../../efficiency/efficiency.css'
import '../reports.css'

export type ReportRead<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: ReportsProblem }

export type ReportsDialog = { kind: 'differences'; read: ReportRead<Differences> } | { kind: 'day'; read: ReportRead<DayRecord> } | { kind: 'send'; draft: SendDraft }

/** A file's words: the container has no catalogue, the view does. */
export interface ReportCsvWords {
  header: readonly string[]
  none: string
  tooFew: string
}

export interface ReportsModel {
  prefix: string
  scope: OfficeScope
  can: ReportsCan
  address: ReportsAddress
  /** The month on show (the address's, else this month). */
  month: string
  today: string
  monthWords: string
  sight: ReportRead<AttendanceSight>
  attendance: ReportRead<AttendanceReport>
  earnings: ReportRead<EarningsReport>
  /** The recorded opening: in this state only, never an address, a file or a print. */
  workers: ReportRead<EarningsWorkers>
  teams: readonly { id: string; label: string }[]
  asOf: string | null
  dialog: ReportsDialog | null
  layout: SectionLayoutValue
  specs: readonly SectionSpec[]
  arranging: boolean
}

export interface ReportsActions {
  onAddress?: (change: Partial<ReportsAddress>) => void
  onRetrySight?: () => void
  onRetryAttendance?: () => void
  onRetryEarnings?: () => void
  onWorkers?: () => void
  onCloseWorkers?: () => void
  onDifferences?: () => void
  onDay?: (dayId: string) => void
  onCloseDialog?: () => void
  onSend?: () => void
  onSendDraft?: (change: Partial<SendDraft>) => void
  onExportAttendance?: (words: ReportCsvWords) => void
  onExportEarnings?: (words: ReportCsvWords) => void
  onArrange?: (open: boolean) => void
  onArranged?: (order: string[]) => void
}

/**
 * SCR-264 — People › People reports (design people.reports; MES-303, MES-304): what the page shows first; the attendance report per
 * line or team with the proof that it matches the closed LUL; the earnings report per line or month with the make-up cost,
 * and per worker only with the right, each opening recorded. Export, print and Send in the band's ⋯. Rows are groups, so a
 * row opens nothing: one person's month is one record (Owner answer W1).
 */
export function ReportsView({ model, actions }: { model: ReportsModel; actions?: ReportsActions }) {
  return (
    <WithMessages namespaces={['people-reports', 'people-efficiency', 'people', 'lists']}>
      <Reports model={model} actions={actions} />
    </WithMessages>
  )
}

function Reports({ model, actions }: { model: ReportsModel; actions?: ReportsActions | undefined }) {
  const t = useT('people-reports')
  const locale = useLocale()
  const { address, can } = model
  const exportAttendance = () => actions?.onExportAttendance?.({ header: [t('attendance.group'), t('attendance.people'), t('attendance.ordinary'), t('attendance.overtimeDay'), t('attendance.overtimeNight'), t('attendance.overtimeHoliday'), t('attendance.night'), t('attendance.holiday')], none: t('attendance.noGroup'), tooFew: t('tooFew') })
  const exportEarnings = () => actions?.onExportEarnings?.({ header: [address.earnings === 'month' ? t('earnings.month') : t('earnings.line'), t('earnings.people'), t('earnings.pieces'), t('earnings.earnings'), t('earnings.makeUp'), t('earnings.share')], none: t('earnings.noLine'), tooFew: t('tooFew') })
  if (!can.attendance && !can.earnings) return <NoPeopleAccess permission="people.attendance.view" />
  const earningsReady = model.earnings.status === 'ready'
  const attendanceReady = model.attendance.status === 'ready'
  const panels: Record<ReportSection, ReactNode> = {
    privacy: <PrivacyPanel model={model} actions={actions} />,
    attendance: <AttendancePanel model={model} actions={actions} />,
    earnings: <EarningsPanel model={model} actions={actions} />,
  }
  return (
    <div className="fw-pp fw-prp">
      <div className="fw-pp-head">
        <span className="fw-pp-status">
          {model.asOf ? <AsOf at={model.asOf} /> : null}
        </span>
        <span className="fw-pp-actions">
          <Button size="sm" onClick={() => actions?.onArrange?.(true)}>
            <SlidersHorizontal size={14} aria-hidden /> {t('band.arrange')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'attendance', label: t('band.exportAttendance'), onSelect: exportAttendance, ...(attendanceReady ? {} : { disabled: true, description: t('held.noReport') }) },
              { id: 'earnings', label: t('band.exportEarnings'), onSelect: exportEarnings, ...(earningsReady ? {} : { disabled: true, description: t('held.noReport') }) },
              { id: 'print', label: t('band.print'), href: reportsPrintHref(model.prefix, address), target: '_blank' },
              { id: 'send', label: t('band.send'), onSelect: () => actions?.onSend?.() },
            ]}
          />
        </span>
      </div>

      <div className="fw-prp-scope" role="group" aria-label={t('scope.label')}>
        <Select size="sm" aria-label={t('scope.month')} value={model.month} onChange={(event) => actions?.onAddress?.({ month: event.target.value })}>
          {monthChoices(model.today).map((month) => (
            <option key={month} value={month}>
              {monthText(month, locale)}
            </option>
          ))}
        </Select>
        <ScopeSiteChip model={model.scope} />
      </div>

      <SectionLayout sections={model.specs} value={model.layout} onChange={() => undefined} className="fw-ef-sections">
        {Object.fromEntries(REPORT_SECTIONS.map((id) => [id, panels[id]]))}
      </SectionLayout>

      {model.dialog?.kind === 'differences' && <DifferencesDialog read={model.dialog.read} month={model.month} actions={actions} />}
      {model.dialog?.kind === 'day' && <DayDialog read={model.dialog.read} prefix={model.prefix} actions={actions} />}
      {model.dialog?.kind === 'send' && <SendDialog draft={model.dialog.draft} model={model} actions={actions} onCsv={model.dialog.draft.report === 'attendance' ? exportAttendance : exportEarnings} />}
      {model.arranging && <ArrangeDialog specs={model.specs.map((spec) => ({ ...spec, label: t(`section.${spec.id}`) }))} layout={model.layout} onApply={(order) => actions?.onArranged?.(order)} onClose={() => actions?.onArrange?.(false)} titleKey="arrange.titleReports" />}
    </div>
  )
}

function Failed({ title, problem, onRetry }: { title: string; problem: ReportsProblem; onRetry?: (() => void) | undefined }) {
  const t = useT('people-reports')
  const people = useWords()
  return (
    <EmptyState
      title={title}
      description={problem.ns === 'people-reports' ? t(problem.words.key) : people(problem.words.key, problem.words.params)}
      action={
        <Button size="sm" onClick={() => onRetry?.()}>
          {people('common.retry')}
        </Button>
      }
    />
  )
}

function Reading() {
  const t = useT('people-reports')
  return (
    <p className="fw-pp-hint" role="status">
      <Spinner size={12} /> {t('common.loading')}
    </p>
  )
}

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

/** What the page shows, said before a figure is read. */
function PrivacyPanel({ model, actions }: Props) {
  const t = useT('people-reports')
  const people = useWords()
  const ds = useDsWords()
  const sight = model.sight
  const size = sight.status === 'ready' ? sight.value.minimumGroupSize : null
  return (
    <Card padded>
      <div className="fw-ef-head">
        <h2 className="fw-ef-h2">{t('section.privacy')}</h2>
      </div>
      <div className="fw-pp-stack tight">
        <PrivacyNote level="line" variant="panel" text={t('privacy.level')} whoMore={t('privacy.who')} law={<LawRef law={people('privacy.law')} plain={people('privacy.lawPlain')} labels={ds.lawRef} />} labels={ds.privacyNote} />
        <ul className="fw-pp-list">
          {size !== null && <li>{t('privacy.minimum', { count: size })}</li>}
          <li>{t('privacy.onePerson')}</li>
          {model.can.records && <li>{t('privacy.workers')}</li>}
        </ul>
        {sight.status === 'error' && (
          <p className="fw-pp-hint">
            {t('privacy.failed')}{' '}
            <Button size="sm" variant="quiet" onClick={() => actions?.onRetrySight?.()}>
              {people('common.retry')}
            </Button>
          </p>
        )}
      </div>
    </Card>
  )
}

// ---- the attendance report -------------------------------------------------------------------------------------------------

function AttendancePanel({ model, actions }: Props) {
  const t = useT('people-reports')
  const locale = useLocale()
  const { address, can, sight } = model
  const read = model.attendance
  const report = read.status === 'ready' ? read.value : null
  const [q, setQ] = useState('')
  const codes = useMemo(() => (report ? absenceCodes(report.groups) : []), [report])
  const shown = report ? report.groups.filter((row) => matches(groupLabel(row), q)) : null
  const columns = useMemo<ColDef<GroupRow>[]>(() => {
    const figure = (colId: string, headerName: string, minutes: (row: GroupRow) => number | null | undefined): ColDef<GroupRow> => ({ colId, headerName, sortable: false, minWidth: 96, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? hours(minutes(params.data), locale) : '') })
    return [
      { colId: 'group', headerName: t('attendance.group'), sortable: false, minWidth: 180, flex: 1.5, valueGetter: (params) => (params.data ? (groupLabel(params.data) ?? t('attendance.noGroup')) : '') },
      {
        colId: 'people',
        headerName: t('attendance.people'),
        sortable: false,
        minWidth: 130,
        flex: 0.8,
        valueGetter: (params) => (params.data ? (params.data.tooFew ? t('tooFew') : String(params.data.people ?? '—')) : ''),
        cellRenderer: (params: ICellRendererParams<GroupRow>) => (params.data?.tooFew ? <Tag tone="neutral">{t('tooFew')}</Tag> : params.value),
      },
      figure('ordinary', t('attendance.ordinary'), (row) => row.figures?.ordinaryMinutes),
      figure('overtimeDay', t('attendance.overtimeDay'), (row) => row.figures?.overtimeDayMinutes),
      figure('overtimeNight', t('attendance.overtimeNight'), (row) => row.figures?.overtimeNightMinutes),
      figure('overtimeHoliday', t('attendance.overtimeHoliday'), (row) => row.figures?.overtimeHolidayMinutes),
      figure('night', t('attendance.night'), (row) => row.figures?.nightMinutes),
      figure('holiday', t('attendance.holiday'), (row) => row.figures?.holidayMinutes),
      ...codes.map((code) => figure(`absence.${code}`, code, (row) => absenceMinutes(row.figures, code))),
    ]
  }, [t, locale, codes])

  if (!can.attendance) {
    return (
      <Card padded>
        <div className="fw-ef-head">
          <h2 className="fw-ef-h2">{t('section.attendance')}</h2>
        </div>
        <EmptyState title={t('attendance.noRight')} description={t('attendance.noRightBody')} />
      </Card>
    )
  }

  const noSite = !model.scope.siteId
  const gateOff = sight.status === 'ready' && !sight.value.open
  const match = report ? matchWords(report.match, report.month, locale) : null
  const state = noSite ? (
    <EmptyState title={t('attendance.pickSite')} description={t('attendance.pickSiteBody')} />
  ) : gateOff ? (
    <EmptyState
      title={t('attendance.gateOff')}
      description={t('attendance.gateOffBody')}
      action={
        can.settings ? (
          <Button size="sm" asChild>
            <Link href={`${model.prefix}/people/settings`}>{t('common.settings')}</Link>
          </Button>
        ) : undefined
      }
    />
  ) : read.status === 'error' ? (
    <Failed title={t('attendance.failed')} problem={read.problem} onRetry={actions?.onRetryAttendance} />
  ) : report && report.groups.length === 0 ? (
    <EmptyState title={t('attendance.empty', { month: model.monthWords })} />
  ) : shown && shown.length === 0 ? (
    <EmptyState title={t('common.noMatch')} />
  ) : null
  return (
    <div className="fw-pp-stack tight" id="fw-prp-attendance">
      {report && match && (
        <div className="fw-prp-match">
          <Tag tone={MATCH_TONE[report.match.state]}>{t(match.key, match.params)}</Tag>
          {report.match.state === 'DIFFERS' && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onDifferences?.()}>
              {t('match.show')}
            </Button>
          )}
          <span className="fw-pp-hint">{t(report.final ? 'attendance.final' : 'attendance.open')}</span>
        </div>
      )}
      <ListFrame<GroupRow>
        label={t('attendance.tableLabel')}
        title={t('section.attendance')}
        rows={noSite || gateOff || read.status === 'error' ? [] : shown}
        rowId={(row) => row.id ?? 'none'}
        columns={columns}
        count={shown ? t('attendance.count', { count: shown.length }) : t('common.loading')}
        search={<Input type="search" size="sm" aria-label={t('common.search')} placeholder={t('common.search')} value={q} onChange={(event) => setQ(event.target.value)} />}
        listKey="people.reports.attendance"
        tools={
          <>
            <b className="fw-ef-list-title">{t('section.attendance')}</b>
            <SegmentedControl size="sm" ariaLabel={t('attendance.groupBy')} options={REPORT_GROUPS.map((group) => ({ value: group, label: t(`attendance.by.${group}`) }))} value={address.group} onChange={(group) => actions?.onAddress?.({ group: group as ReportGroup, teamId: null })} />
            {address.group === 'team' && model.teams.length > 0 && (
              <Select size="sm" aria-label={t('attendance.team')} value={address.teamId ?? ''} onChange={(event) => actions?.onAddress?.({ teamId: event.target.value || null })}>
                <option value="">{t('attendance.allTeams')}</option>
                {model.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.label}
                  </option>
                ))}
              </Select>
            )}
          </>
        }
        state={state}
      />
      {report && (
        <p className="fw-pp-hint">
          {report.summary
            ? t('attendance.total', { count: report.summary.people, ordinary: hours(report.summary.figures.ordinaryMinutes, locale), overtime: hours(report.summary.figures.overtimeDayMinutes + report.summary.figures.overtimeNightMinutes + report.summary.figures.overtimeHolidayMinutes, locale), absent: hours(report.summary.figures.absenceMinutes, locale) })
            : t('attendance.totalHidden')}
        </p>
      )}
    </div>
  )
}

/** "Differs in 2 cells · Show": which day and which cell, no figure and no person; a row opens that day's record. */
function DifferencesDialog({ read, month, actions }: { read: ReportRead<Differences>; month: string; actions?: ReportsActions | undefined }) {
  const t = useT('people-reports')
  const people = useWords()
  const locale = useLocale()
  return (
    <Modal open onClose={() => actions?.onCloseDialog?.()} title={t('differences.title', { month: monthText(month, locale) })} size="md" footer={<Button onClick={() => actions?.onCloseDialog?.()}>{people('common.close')}</Button>}>
      {read.status === 'error' ? (
        <Failed title={t('differences.failed')} problem={read.problem} onRetry={actions?.onDifferences} />
      ) : read.status !== 'ready' ? (
        <Reading />
      ) : read.value.cells.length === 0 ? (
        <EmptyState title={t('differences.none')} />
      ) : (
        <SummaryTable
          label={t('differences.tableLabel')}
          columns={[t('differences.day'), t('differences.kind'), '']}
          density="roomy"
          align={[undefined, undefined, 'right']}
          stackOnPhone
          rows={read.value.cells.map((cell) => ({
            id: differenceKey(cell),
            cells: [
              formatDate(`${cell.date}T12:00:00Z`, { locale }),
              cell.absenceCode ? `${t(`kind.${cell.kind}`)} · ${cell.absenceCode}` : t(`kind.${cell.kind}`),
              <Button key="open" size="sm" variant="quiet" onClick={() => actions?.onDay?.(cell.dayId)}>
                {t('differences.open')}
              </Button>,
            ],
          }))}
        />
      )}
    </Modal>
  )
}

/** One closed day, one record: the person is named here and nowhere else on the page. */
function DayDialog({ read, prefix, actions }: { read: ReportRead<DayRecord>; prefix: string; actions?: ReportsActions | undefined }) {
  const t = useT('people-reports')
  const people = useWords()
  const locale = useLocale()
  const day = read.status === 'ready' ? read.value : null
  return (
    <DetailModal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={day ? day.person.name : t('day.title')}
      subtitle={day ? formatDate(`${day.date}T12:00:00Z`, { locale }) : undefined}
      loading={read.status === 'loading' || read.status === 'idle'}
      error={read.status === 'error' ? (read.problem.ns === 'people-reports' ? t(read.problem.words.key) : people(read.problem.words.key, read.problem.words.params)) : undefined}
      actions={
        day ? (
          <Button size="sm" variant="quiet" asChild>
            <Link href={`${prefix}/people/employees/${encodeURIComponent(day.person.employeeId)}?tab=attendance`}>
              <UserRound size={13} aria-hidden /> {t('day.employee')}
            </Link>
          </Button>
        ) : undefined
      }
    >
      {day && (
        <div className="fw-pp-stack">
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={changedCells(day).map((cell) => ({
              label: cell.absenceCode ? `${t(`kind.${cell.kind}`)} · ${cell.absenceCode}` : t(`kind.${cell.kind}`),
              value: t('day.closedNow', { closed: hours(cellMinutes(day.closedFigures, cell.kind, cell.absenceCode), locale), now: hours(cellMinutes(day.figuresNow, cell.kind, cell.absenceCode), locale) }),
            }))}
          />
          <SummaryTable
            label={t('day.corrections')}
            columns={[t('day.when'), t('day.who'), t('day.change'), t('day.why')]}
            align={[undefined, undefined, undefined, 'left']}
            stackOnPhone
            rows={day.corrections.map((entry) => ({ id: entry.id, cells: [formatDateTime(entry.at, { locale, timeZone: TIME_ZONE }), entry.by, `${hours(entry.minutesBefore, locale)} → ${hours(entry.minutesAfter, locale)}`, entry.reason] }))}
          />
        </div>
      )}
    </DetailModal>
  )
}

// ---- the earnings report ---------------------------------------------------------------------------------------------------

function EarningsPanel({ model, actions }: Props) {
  const t = useT('people-reports')
  const locale = useLocale()
  const { address, can } = model
  const read = model.earnings
  const report = read.status === 'ready' ? read.value : null
  const workersOpen = model.workers.status !== 'idle'
  const workers = model.workers.status === 'ready' ? model.workers.value : null
  const [q, setQ] = useState('')
  const all: EarningsRow[] | null = workersOpen ? (workers ? workerRows(workers) : model.workers.status === 'error' ? [] : null) : report ? (address.earnings === 'month' ? monthRows(report, locale) : lineRows(report)) : read.status === 'error' ? [] : null

  const rows = all ? all.filter((row) => matches(row.label, q)) : null

  const columns = useMemo<ColDef<EarningsRow>[]>(() => {
    const hidden = (row: EarningsRow, text: string) => (row.tooFew ? '—' : text)
    const figure = (colId: string, headerName: string, value: (row: EarningsRow) => string): ColDef<EarningsRow> => ({ colId, headerName, sortable: false, minWidth: 96, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? hidden(params.data, value(params.data)) : '') })
    return [
      { colId: 'group', headerName: workersOpen ? t('earnings.worker') : address.earnings === 'month' ? t('earnings.month') : t('earnings.line'), sortable: false, minWidth: 180, flex: 1.5, valueGetter: (params) => (params.data ? (params.data.label ?? t('earnings.noLine')) : '') },
      ...(workersOpen
        ? []
        : [
            {
              colId: 'people',
              headerName: t('earnings.people'),
              sortable: false,
              minWidth: 130,
        flex: 0.8,
              valueGetter: (params) => (params.data ? (params.data.tooFew ? t('tooFew') : String(params.data.people ?? '—')) : ''),
              cellRenderer: (params: ICellRendererParams<EarningsRow>) => (params.data?.tooFew ? <Tag tone="neutral">{t('tooFew')}</Tag> : params.value),
            } satisfies ColDef<EarningsRow>,
          ]),
      figure('pieces', t('earnings.pieces'), (row) => piecesText(row.pieces, locale)),
      figure('earnings', t('earnings.earnings'), (row) => amountText(row.earnings, locale)),
      figure('makeUp', t('earnings.makeUp'), (row) => amountText(row.makeUp, locale)),
      figure('share', t('earnings.share'), (row) => shareText(row.share, locale)),
    ]
  }, [t, locale, workersOpen, address.earnings])

  if (!can.earnings) return null
  if (!can.pay) {
    return (
      <Card padded>
        <div className="fw-ef-head">
          <h2 className="fw-ef-h2">{t('section.earnings')}</h2>
        </div>
        <EmptyState title={t('earnings.noGrain')} description={t('earnings.noGrainBody')} />
      </Card>
    )
  }
  const months = monthChoices(model.today).filter((month) => month >= model.month)
  const failed = workersOpen ? (model.workers.status === 'error' ? model.workers.problem : null) : read.status === 'error' ? read.problem : null
  return (
    <div className="fw-pp-stack tight" id="fw-prp-earnings">
      {workersOpen && (
        <Banner tone="info" title={t('earnings.workersOpen')} action={<Button size="sm" variant="quiet" onClick={() => actions?.onCloseWorkers?.()}>{t('earnings.backToLines')}</Button>}>
          {t('earnings.workersNote')}
        </Banner>
      )}
      <ListFrame<EarningsRow>
        label={t('earnings.tableLabel')}
        title={t('section.earnings')}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('earnings.count', { count: rows.length }) : t('common.loading')}
        listKey={null}
        search={<Input type="search" size="sm" aria-label={t('common.search')} placeholder={t('common.search')} value={q} onChange={(event) => setQ(event.target.value)} />}
        tools={
          <>
            <b className="fw-ef-list-title">{t('section.earnings')}</b>
            {!workersOpen && (
              <SegmentedControl size="sm" ariaLabel={t('earnings.groupBy')} options={[{ value: 'line', label: t('earnings.byLine') }, { value: 'month', label: t('earnings.byMonth') }]} value={address.earnings} onChange={(earnings) => actions?.onAddress?.({ earnings: earnings as ReportsAddress['earnings'] })} />
            )}
            <Select size="sm" aria-label={t('earnings.to')} value={address.to && address.to >= model.month ? address.to : model.month} onChange={(event) => actions?.onAddress?.({ to: event.target.value === model.month ? null : event.target.value })}>
              {months.map((month) => (
                <option key={month} value={month}>
                  {t('earnings.toMonth', { month: monthText(month, locale) })}
                </option>
              ))}
            </Select>
          </>
        }
        right={
          can.records && !workersOpen ? (
            <Button size="sm" onClick={() => actions?.onWorkers?.()}>
              <UserRound size={13} aria-hidden /> {t('earnings.openWorkers')}
            </Button>
          ) : undefined
        }
        state={
          failed ? (
            <Failed title={t('earnings.failed')} problem={failed} onRetry={workersOpen ? actions?.onWorkers : actions?.onRetryEarnings} />
          ) : all && all.length === 0 ? (
            <EmptyState title={t('earnings.empty')} />
          ) : rows && rows.length === 0 ? (
            <EmptyState title={t('common.noMatch')} />
          ) : null
        }
      />
      <p className="fw-pp-hint">{t('earnings.foot')}</p>
    </div>
  )
}

// ---- Send report -----------------------------------------------------------------------------------------------------------

/**
 * Send report (design pop:send, the publish-dialog pattern): the report, the recipient, the expiry, PDF or CSV. "Send link" is held with
 * why: the secure link for a file is B-W2b-54's and carries only its payroll file today, and pay figures never reach a link.
 * What the person can do today stands beside it: take the same report as a file.
 */
function SendDialog({ draft, model, actions, onCsv }: { draft: SendDraft; model: ReportsModel; actions?: ReportsActions | undefined; onCsv: () => void }) {
  const t = useT('people-reports')
  const people = useWords()
  const held = sendHeld(draft)
  const attendanceReady = model.attendance.status === 'ready'
  const earningsReady = model.earnings.status === 'ready'
  const ready = draft.report === 'attendance' ? attendanceReady : earningsReady
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t('send.title')}
      size="sm"
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onCloseDialog?.()}>
            {people('common.close')}
          </Button>
          {draft.format === 'CSV' ? (
            <Button heldReason={ready ? null : t('held.noReport')} onClick={onCsv}>
              {t('send.download')}
            </Button>
          ) : (
            <Button asChild>
              <a href={reportsPrintHref(model.prefix, model.address)} target="_blank" rel="noopener noreferrer">
                {t('send.openPdf')}
              </a>
            </Button>
          )}
          <Button variant="primary" heldReason={t(held)}>
            {t('send.send')}
          </Button>
        </>
      }
    >
      <div className="fw-pp-stack tight">
        <Banner tone="info" title={t(held)} />
        <label className="fw-pp-stack tight">
          <span>{t('send.report')}</span>
          <Select value={draft.report} onChange={(event) => actions?.onSendDraft?.({ report: event.target.value as SendDraft['report'] })}>
            <option value="attendance">{t('section.attendance')}</option>
            <option value="earnings">{t('section.earnings')}</option>
          </Select>
        </label>
        <label className="fw-pp-stack tight">
          <span>{t('send.recipient')}</span>
          <Input type="email" autoComplete="off" value={draft.recipient} onChange={(event) => actions?.onSendDraft?.({ recipient: event.target.value })} />
        </label>
        <label className="fw-pp-stack tight">
          <span>{t('send.expiry')}</span>
          <Select value={String(draft.expiryDays)} onChange={(event) => actions?.onSendDraft?.({ expiryDays: Number(event.target.value) as SendDraft['expiryDays'] })}>
            {SEND_EXPIRY_DAYS.map((days) => (
              <option key={days} value={days}>
                {t('send.days', { count: days })}
              </option>
            ))}
          </Select>
        </label>
        <div className="fw-pp-stack tight">
          <span>{t('send.format')}</span>
          <SegmentedControl ariaLabel={t('send.format')} options={SEND_FORMATS.map((format) => ({ value: format, label: format }))} value={draft.format} onChange={(format) => actions?.onSendDraft?.({ format: format as SendFormat })} />
        </div>
      </div>
    </Modal>
  )
}
