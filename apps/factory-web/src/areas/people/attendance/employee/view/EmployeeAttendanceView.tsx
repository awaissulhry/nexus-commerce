'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { CalendarClock, ChevronLeft, ChevronRight, FileQuestion, ShieldOff } from 'lucide-react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { TIME_ZONE } from '../../../_shared/model'
import type { AbsenceCode, EmployeeDay, EmployeeDays, PersonMonth } from '../../api'
import { dayShort, hoursWords, monthWords, movedMonth, plannedText, type AttendanceCan } from '../../model'
import type { DayActions, DayState } from '../../use-day'
import { DayDetail } from '../../view/DayDetail'
import { AttendanceMessages, DayPill, GateHeld, useAttendanceWords } from '../../view/parts'

/** SCR-085-attendance — one view model, nothing fetched. */
export interface EmployeeAttendanceModel {
  prefix: string
  can: AttendanceCan
  gate: 'reading' | 'open' | 'closed' | 'failed'
  month: string
  today: string
  now: number
  days: EmployeeDays | null
  status: PersonMonth | null
  problem: string | null
  day: DayState | null
  codes: readonly AbsenceCode[]
}

export interface EmployeeAttendanceActions {
  onMonth: (month: string) => void
  onOpenDay: (id: string | null) => void
  onRetry: () => void
  day: DayActions
}

export function EmployeeAttendanceView({ model, actions }: { model: EmployeeAttendanceModel; actions?: EmployeeAttendanceActions }) {
  return (
    <AttendanceMessages>
      <Tab model={model} actions={actions} />
    </AttendanceMessages>
  )
}

function Tab({ model, actions }: { model: EmployeeAttendanceModel; actions?: EmployeeAttendanceActions | undefined }) {
  const t = useAttendanceWords()
  const locale = useLocale()
  const rows = model.days?.days ?? null
  const columns = useMemo<ColDef<EmployeeDay>[]>(() => {
    const hours = (minutes: number | undefined) => (minutes ? hoursWords(minutes, locale) : '—')
    const DayCell = ({ data }: ICellRendererParams<EmployeeDay>) =>
      data ? (
        <Link href={`?tab=attendance&month=${model.month}&day=${encodeURIComponent(data.id)}`} scroll={false} onClick={(event) => { if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); actions?.onOpenDay(data.id) } }}>
          {dayShort(data.date, locale)}
        </Link>
      ) : null
    return [
      { colId: 'date', headerName: t('col.day'), width: 130, pinned: 'left', valueGetter: (params) => params.data?.date ?? '', cellRenderer: DayCell },
      { colId: 'planned', headerName: t('col.planned'), minWidth: 170, flex: 1, valueGetter: (params) => (params.data ? (plannedText(params.data.planned) ?? t('days.noShift')) : '') },
      { colId: 'present', headerName: t('figure.present'), width: 116, valueGetter: (params) => hours(params.data?.figures.presentMinutes) },
      { colId: 'ordinary', headerName: t('figure.ordinary'), width: 116, valueGetter: (params) => hours(params.data?.figures.ordinaryMinutes) },
      { colId: 'overtime', headerName: t('figure.overtime'), width: 136, valueGetter: (params) => hours(params.data?.figures.overtimeMinutes) },
      { colId: 'night', headerName: t('figure.night'), width: 112, valueGetter: (params) => hours(params.data?.figures.nightMinutes) },
      { colId: 'holiday', headerName: t('figure.holiday'), width: 104, valueGetter: (params) => hours(params.data?.figures.holidayMinutes) },
      { colId: 'absence', headerName: t('col.absence'), minWidth: 130, flex: 1, valueGetter: (params) => (params.data?.absences ?? []).map((entry) => `${entry.code} ${hoursWords(entry.minutes, locale)}`).join(', ') },
      { colId: 'anomaly', headerName: t('col.anomaly'), width: 120, valueGetter: (params) => (params.data?.anomaliesOpen ? t('timesheet.anomalies', { count: params.data.anomaliesOpen }) : '') },
      { colId: 'manual', headerName: t('col.manual'), width: 112, valueGetter: (params) => (params.data?.manual ? t('days.manual') : '') },
      { colId: 'status', headerName: t('col.status'), width: 130, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: (params: ICellRendererParams<EmployeeDay>) => (params.data ? <DayPill status={params.data.status} /> : null) },
    ]
  }, [t, locale, actions, model.month])

  if (!model.can.view) return <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('problem.forbidden')} description={t('employee.noRight')} />
  if (model.gate === 'closed' || model.gate === 'failed') {
    return (
      <div className="fw-pp fw-at">
        <GateHeld gate={model.gate} prefix={model.prefix} can={model.can} />
      </div>
    )
  }
  const figures = model.status?.figures
  const closed = model.status?.monthState === 'CLOSED'
  return (
    <div className="fw-pp fw-at">
      <div className="fw-pp-head">
        <span className="fw-pp-row">
          <Button size="sm" variant="quiet" aria-label={t('scope.previous')} onClick={() => actions?.onMonth(movedMonth(model.month, -1))}>
            <ChevronLeft size={15} aria-hidden />
          </Button>
          <b className="fw-at-month">{monthWords(model.month, locale)}</b>
          <Button size="sm" variant="quiet" aria-label={t('scope.next')} onClick={() => actions?.onMonth(movedMonth(model.month, 1))}>
            <ChevronRight size={15} aria-hidden />
          </Button>
        </span>
        {model.status && (
          <span className="fw-pp-row">
            <Pill tone={closed ? 'success' : 'info'} dot>
              {closed && model.status.closedAt ? t('employee.closedOn', { date: formatDate(model.status.closedAt, { locale, timeZone: TIME_ZONE }) }) : t('monthState.OPEN')}
            </Pill>
            {model.status.differs && <Tag tone="warning">{t('employee.corrected')}</Tag>}
          </span>
        )}
      </div>
      {model.problem ? (
        <Card padded>
          <EmptyState
            icon={<FileQuestion size={22} aria-hidden />}
            title={t('days.failed')}
            description={t(model.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry()}>
                {t('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : model.gate === 'reading' ? (
        <Skeleton height={240} />
      ) : (
        <>
          {figures && (
            <Card padded>
              <KeyValue
                columns={3}
                dense
                phoneColumns={2}
                labelCase="sentence"
                items={[
                  { label: t('figure.present'), value: hoursWords(figures.presentMinutes, locale) },
                  { label: t('figure.ordinary'), value: hoursWords(figures.ordinaryMinutes, locale) },
                  { label: t('figure.absence'), value: hoursWords(figures.absenceMinutes, locale) },
                  { label: t('employee.overtimeDay'), value: hoursWords(figures.overtimeDayMinutes, locale) },
                  { label: t('employee.overtimeNight'), value: hoursWords(figures.overtimeNightMinutes, locale) },
                  { label: t('employee.overtimeHoliday'), value: hoursWords(figures.overtimeHolidayMinutes, locale) },
                ]}
              />
              <p className="fw-pp-hint">{t('employee.note')}</p>
            </Card>
          )}
          <ListFrame<EmployeeDay>
            label={t('employee.title')}
            rows={rows}
            rowId={(row) => row.id}
            columns={columns}
            count={rows ? t('days.count', { count: rows.length }) : ''}
            rowKind="text"
            listKey={null}
            onOpen={(row) => actions?.onOpenDay(row.id)}
            cards={{ hrefOf: (row) => `?tab=attendance&month=${model.month}&day=${encodeURIComponent(row.id)}` }}
            state={rows && rows.length === 0 ? <EmptyState icon={<CalendarClock size={22} aria-hidden />} title={t('employee.none')} description={t('days.noneBody')} /> : undefined}
          />
        </>
      )}
      {model.day && <DayDetail state={model.day} actions={actions?.day} prefix={model.prefix} ids={(rows ?? []).map((row) => row.id)} now={model.now} codes={model.codes} canPeople={false} canCorrect={model.can.correct} onGo={(id) => actions?.onOpenDay(id)} onClose={() => actions?.onOpenDay(null)} />}
    </div>
  )
}
