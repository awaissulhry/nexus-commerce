'use client'

import { Printer } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { TIME_ZONE } from '../../../_shared/model'
import type { Loaded } from '../../../_shared/parts'
import type { TimesheetRecord } from '../../api'
import { dayShort, hoursWords, monthWords, TIMESHEET_TONE, timeOf, type AttendanceCan, type Words } from '../../model'
import { Footer, Form, Problem } from '../../view/DayDialogs'
import { AttendanceMessages, DayPill, GateHeld, said, useAttendanceWords, type AttendanceWords } from '../../view/parts'

const REASON_MIN = 3

export interface TimesheetDialog {
  reason: string
  busy: boolean
  problem: Words | null
}

/** SCR-157-timesheet — one view model, nothing fetched. */
export interface TimesheetModel {
  prefix: string
  can: AttendanceCan
  loaded: Loaded<TimesheetRecord>
  gateShut: boolean
  busy: boolean
  problem: Words | null
  dialog: TimesheetDialog | null
  at: string
  person: string
}

export interface TimesheetActions {
  onRetry: () => void
  onLead: () => void
  onHr: () => void
  onSendBack: () => void
  onReason: (reason: string) => void
  onSave: () => void
  onCancel: () => void
}

export function TimesheetView({ model, actions }: { model: TimesheetModel; actions?: TimesheetActions }) {
  return (
    <AttendanceMessages>
      <Sheet model={model} actions={actions} />
    </AttendanceMessages>
  )
}

function Sheet({ model, actions }: { model: TimesheetModel; actions?: TimesheetActions | undefined }) {
  const t = useAttendanceWords()
  const locale = useLocale()
  const place = { locale, timeZone: TIME_ZONE }
  if (model.gateShut) return <GateHeld gate="closed" prefix={model.prefix} can={model.can} />
  if (model.loaded.status === 'loading') {
    return (
      <p className="fw-pp-hint" role="status">
        <Spinner size={14} /> {t('timesheet.reading')}
      </p>
    )
  }
  if (model.loaded.status !== 'ready') {
    const { loaded } = model
    return (
      <EmptyState
        title={t(loaded.status === 'error' ? 'timesheet.failed' : loaded.status === 'forbidden' ? 'problem.forbidden' : 'problem.notFound')}
        {...(loaded.status === 'error' ? { description: t(loaded.problem), action: <Button size="sm" onClick={actions?.onRetry}>{t('common.retry')}</Button> } : {})}
      />
    )
  }
  const value = model.loaded.value
  const leadHeld = value.holds.lead[0] ? t(`hold.timesheet.${value.holds.lead[0].code}`) : model.busy ? t('held.working') : null
  const hrHeld = value.holds.hr[0] ? t(`hold.timesheet.${value.holds.hr[0].code}`) : model.busy ? t('held.working') : null
  return (
    <article className="fw-at-tab fw-at-sheet">
      <header className="fw-pp-head">
        <div>
          <h1 className="fw-at-title">{value.person.name}</h1>
          <p className="fw-pp-hint">{t('timesheet.meta', { month: monthWords(value.periodStart.slice(0, 7), locale), code: value.person.employeeCode ?? '—', at: formatDateTime(model.at, place), person: model.person })}</p>
        </div>
        <span className="fw-pp-actions fw-at-noprint">
          <Pill tone={TIMESHEET_TONE[value.stage]} dot>
            {t(`stage.${value.stage}`)}
          </Pill>
          {value.actions.sendBack && (
            <Button size="sm" onClick={actions?.onSendBack}>
              {t('timesheet.sendBack')}
            </Button>
          )}
          {(value.stage === 'LEAD' || value.actions.leadApprove) && model.can.timesheetLead && (
            <Button size="sm" variant="primary" onClick={actions?.onLead} heldReason={leadHeld}>
              {t('timesheet.approveLead')}
            </Button>
          )}
          {value.stage === 'HR' && model.can.timesheetHr && (
            <Button size="sm" variant="primary" onClick={actions?.onHr} heldReason={hrHeld}>
              {t('timesheet.approveHr')}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => window.print()}>
            <Printer size={14} aria-hidden /> {t('roll.print')}
          </Button>
        </span>
      </header>
      {model.problem && <Banner tone="danger" title={said(t, model.problem)} />}
      {value.changedSince && <Banner tone="warning" title={t('timesheet.changed')} />}
      {value.returned && <Banner tone="info" title={t('timesheet.returned', { who: value.returned.by ?? '—', reason: value.returned.reason })} />}
      {!value.figuresShown && <Banner tone="info" title={t('timesheet.leadView')} />}
      {value.summary && (
        <Card padded>
          <KeyValue
            columns={3}
            dense
            phoneColumns={2}
            labelCase="sentence"
            items={[
              { label: t('timesheet.daysPresent'), value: value.summary.daysPresent },
              { label: t('figure.present'), value: hoursWords(value.summary.presentMinutes, locale) },
              { label: t('figure.ordinary'), value: hoursWords(value.summary.ordinaryMinutes, locale) },
              { label: t('figure.night'), value: hoursWords(value.summary.nightMinutes, locale) },
              { label: t('figure.holiday'), value: hoursWords(value.summary.holidayMinutes, locale) },
              { label: t('figure.absence'), value: hoursWords(value.summary.absenceMinutes, locale) },
              { label: t('timesheet.overtimeApproved'), value: hoursWords(value.summary.overtimeApprovedMinutes, locale) },
              { label: t('timesheet.overtimePending'), value: hoursWords(value.summary.overtimePendingMinutes, locale) },
              { label: t('timesheet.overtimeRejected'), value: hoursWords(value.summary.overtimeRejectedMinutes, locale) },
            ]}
          />
        </Card>
      )}
      <div className="fw-at-table">
        <Days value={value} t={t} />
      </div>
      <p className="fw-pp-hint">
        {t('timesheet.lead', { who: value.lead.approvedBy ?? '—', at: value.lead.approvedAt ? formatDateTime(value.lead.approvedAt, place) : '—' })} · {t('timesheet.hr', { who: value.hr.approvedBy ?? '—', at: value.hr.approvedAt ? formatDateTime(value.hr.approvedAt, place) : '—' })}
      </p>
      {model.dialog && <SendBack t={t} dialog={model.dialog} actions={actions} />}
    </article>
  )
}

function Days({ value, t }: { value: TimesheetRecord; t: AttendanceWords }) {
  const locale = useLocale()
  if (!value.figuresShown) {
    return (
      <SummaryTable
        label={t('timesheet.days')}
        columns={[t('col.date'), t('col.planned'), t('timesheet.presence'), t('col.anomaly'), t('col.status')]}
        align={['left', 'left', 'left', 'left', 'left']}
        rows={value.days.map((day) => ({
          id: day.id,
          cells: [dayShort(day.date, locale), day.plannedLabel ?? t('days.noShift'), t(day.presence ? 'days.clocked' : day.absent ? 'timesheet.absent' : 'days.notClocked'), day.anomaliesOpen > 0 ? t('timesheet.anomalies', { count: day.anomaliesOpen }) : '—', <DayPill key="status" status={day.status} />],
        }))}
      />
    )
  }
  return (
    <SummaryTable
      label={t('timesheet.days')}
      columns={[t('col.date'), t('col.planned'), t('timesheet.in'), t('timesheet.out'), t('figure.present'), t('figure.ordinary'), t('figure.absence'), t('figure.overtime'), t('col.status')]}
      align={['left', 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'left']}
      rows={value.days.map((day) => {
        const figures = day.figures
        return {
          id: day.id,
          cells: [
            <span key="date">
              {dayShort(day.date, locale)} {day.manual && <Tag tone="warning">M</Tag>}
            </span>,
            day.plannedLabel ?? t('days.noShift'),
            figures?.firstInAt ? timeOf(figures.firstInAt, locale) : '—',
            figures?.lastOutAt ? timeOf(figures.lastOutAt, locale) : '—',
            figures ? hoursWords(figures.presentMinutes, locale) : '—',
            figures ? hoursWords(figures.ordinaryMinutes, locale) : '—',
            (day.absences ?? []).map((entry) => `${entry.code} ${hoursWords(entry.minutes, locale)}`).join(', ') || '—',
            (day.overtime ?? []).map((entry) => `${t(`class.${entry.class}`)} ${hoursWords(entry.minutes, locale)} (${t(`entryStatus.${entry.status}`)})`).join(', ') || '—',
            <DayPill key="status" status={day.status} />,
          ],
        }
      })}
    />
  )
}

function SendBack({ t, dialog, actions }: { t: AttendanceWords; dialog: TimesheetDialog; actions?: TimesheetActions | undefined }) {
  const held = dialog.reason.trim().length < REASON_MIN ? t('held.reason') : null
  return (
    <Modal open onClose={() => actions?.onCancel()} title={t('timesheet.sendBack')} size="sm" footer={<Footer t={t} held={held} busy={dialog.busy} label={t('timesheet.sendBack')} onCancel={() => actions?.onCancel()} onSave={() => actions?.onSave()} />}>
      <Form held={held} onSave={() => actions?.onSave()}>
        <Problem t={t} words={dialog.problem} />
        <p className="fw-pp-hint">{t('timesheet.sendBackBody')}</p>
        <Field label={t('field.reason')} required>
          <Textarea value={dialog.reason} maxLength={500} rows={3} onChange={(event) => actions?.onReason(event.target.value)} />
        </Field>
      </Form>
    </Modal>
  )
}
