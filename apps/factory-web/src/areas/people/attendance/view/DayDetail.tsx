'use client'

import { useEffect, useMemo } from 'react'
import Link from 'next/link'
import { Banner, KeyValue, SummaryTable } from '@nexus/ui/components'
import { DayStrip } from '@nexus/ui/components/DayStrip/index'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Tag } from '@nexus/ui/primitives'
import { DetailModal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { TIME_ZONE } from '../../_shared/model'
import type { AbsenceCode, DayCorrections, DayRecord } from '../api'
import { ANOMALY_LAW, anomalyWords, dayLong, eventWords, FIGURES, hoursWords, openAnomalies, plainReason, plannedText, stripOf, timeOf } from '../model'
import type { DayActions, DayState } from '../use-day'
import { DayDialogs } from './DayDialogs'
import { DayPill, RulePopover, said, useAttendanceWords, type AttendanceWords } from './parts'

export interface DayDetailProps {
  state: DayState
  actions?: DayActions | undefined
  prefix: string
  /** The ids of the list in the order shown: J / K walk them. */
  ids?: readonly string[]
  now: number
  codes: readonly AbsenceCode[]
  canPeople: boolean
  canCorrect: boolean
  onGo?: (id: string) => void
  onClose: () => void
}

/**
 * Day detail (design people.attendance pop:day; ONE window for the page and the employee's Attendance tab): the DayStrip (shift,
 * clock events, breaks), each event with its source, each anomaly in words with "How this anomaly is found", the figures and
 * the absences; Approve day (held with why), Fix a day, or on a closed month Correct. J / K next and previous · A approve · E
 * fix · Esc closes. One person's day: the name and the minutes live here and nowhere in a list.
 */
export function DayDetail({ state, actions, prefix, ids, now, codes, canPeople, canCorrect, onGo, onClose }: DayDetailProps) {
  const t = useAttendanceWords()
  const locale = useLocale()
  const value = state.loaded.status === 'ready' ? state.loaded.value : null
  const open = value ? openAnomalies(value.anomalies) : []

  const held = value ? (value.holds[0] ? t(`hold.day.${value.holds[0].code}`) : !value.actions.approve ? t('held.noApprove') : state.busy ? t('held.working') : null) : t('held.notRead')
  const closed = value?.status === 'CLOSED'

  // A / E, while no dialog of its own is on top (the DS gives J / K and Esc).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || state.dialog || !value) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)) return
      if (event.key === 'a' || event.key === 'A') {
        if (!held) actions?.onApprove()
      } else if (event.key === 'e' || event.key === 'E') {
        if (value.actions.fix) actions?.onFix()
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.dialog, value, held, actions])

  const name = value ? (canPeople ? <Link href={`${prefix}/people/employees/${encodeURIComponent(value.person.employeeId)}?tab=attendance`}>{value.person.name}</Link> : value.person.name) : t('day.title')
  const problem = state.loaded.status === 'error' ? t(state.loaded.problem) : state.loaded.status === 'notFound' ? t('problem.notFound') : state.loaded.status === 'forbidden' ? t('problem.forbidden') : undefined

  return (
    <>
      <DetailModal
        open
        onClose={onClose}
        title={name}
        subtitle={value ? `${dayLong(value.date, locale)}${value.person.employeeCode ? ` · ${value.person.employeeCode}` : ''}` : undefined}
        meta={
          value ? (
            <span className="fw-pp-row">
              <DayPill status={value.status} />
              {value.manual && <Tag tone="warning">{t('days.manual')}</Tag>}
            </span>
          ) : undefined
        }
        actions={
          value ? (
            <span className="fw-pp-row">
              {closed && canCorrect && state.corrections?.actions.correct && (
                <Button size="sm" onClick={() => actions?.onCorrect()}>
                  {t('day.correct')}
                </Button>
              )}
              {value.actions.reopen && (
                <Button size="sm" onClick={() => actions?.onReopen()}>
                  {t('day.reopen')}
                </Button>
              )}
              {!closed && (
                <Button size="sm" onClick={() => actions?.onFix()} heldReason={value.actions.fix ? null : t(value.status === 'APPROVED' ? 'held.fixApproved' : 'held.noFix')}>
                  {t('day.fix')}
                </Button>
              )}
              {!closed && value.status !== 'APPROVED' && (
                <Button size="sm" variant="primary" onClick={() => actions?.onApprove()} heldReason={held}>
                  {t('day.approve')}
                </Button>
              )}
            </span>
          ) : undefined
        }
        loading={state.loaded.status === 'loading'}
        error={problem}
        {...(actions ? { onRetry: actions.onRetry } : {})}
        {...(ids && onGo ? { nav: { ids, current: state.id, onGo, noun: t('day.noun') } } : {})}
      >
        {value && (
          <div className="fw-at-day">
            {state.problem && <Banner tone="danger" title={said(t, state.problem)} />}
            <Strip value={value} now={now} />
            <section className="fw-pp-stack tight" aria-label={t('day.figures')}>
              <KeyValue columns={3} dense phoneColumns={2} labelCase="sentence" items={[{ label: t('day.planned'), value: plannedText(value.planned) ?? t('days.noShift') }, ...FIGURES.map((figure) => ({ label: t(`figure.${figure.id}`), value: hoursWords(figure.of(value.figures), locale) }))]} />
            </section>
            {value.anomalies.length > 0 && <Anomalies value={value} canAccept={value.actions.fix} actions={actions} t={t} />}
            <Events value={value} t={t} />
            {value.absences.length > 0 && (
              <SummaryTable
                label={t('day.absences')}
                columns={[t('day.absences'), t('day.lul'), t('day.document'), t('day.hours')]}
                rows={value.absences.map((entry) => ({ id: entry.id, cells: [`${entry.code} · ${entry.label[locale] ?? entry.label.it ?? entry.code}`, entry.lulCode ?? t('day.noLul'), entry.documentRef ?? '—', hoursWords(entry.minutes, locale)] }))}
              />
            )}
            {value.manual && <p className="fw-pp-hint">{t('day.manualNote')}</p>}
            {open.length === 0 && value.holds.length > 0 && !closed && value.status !== 'APPROVED' && <p className="fw-pp-hint">{t(`hold.day.${value.holds[0]!.code}`)}</p>}
            {state.corrections && <Corrections record={state.corrections} t={t} />}
          </div>
        )}
      </DetailModal>
      <DayDialogs state={state} codes={codes} actions={actions} events={value?.events ?? []} absences={value?.absences ?? []} />
    </>
  )
}

function Strip({ value, now }: { value: DayRecord; now: number }) {
  const t = useAttendanceWords()
  const ds = useDsWords()
  const locale = useLocale()
  const strip = useMemo(() => stripOf(value, now), [value, now])
  const words = value.anomalies.filter((entry) => entry.resolvedAt === null).map((entry) => ({ id: entry.id, label: said(t, anomalyWords(entry, value, locale)) }))
  return (
    <DayStrip
      label={`${value.person.displayName} · ${dayLong(value.date, locale)}`}
      from={strip.from}
      to={strip.to}
      {...(strip.shift ? { shift: strip.shift } : {})}
      segments={strip.segments}
      events={strip.events.map((event) => ({ id: event.id, at: event.at, kind: event.kind, flagged: event.flagged, label: said(t, event.words) }))}
      anomalies={words}
      locale={locale === 'it' ? 'it-IT' : 'en-GB'}
      timeZone={TIME_ZONE}
      labels={ds.dayStrip}
    />
  )
}

function Anomalies({ value, canAccept, actions, t }: { value: DayRecord; canAccept: boolean; actions?: DayActions | undefined; t: AttendanceWords }) {
  const locale = useLocale()
  const ds = useDsWords()
  return (
    <section className="fw-pp-stack tight" aria-label={t('day.anomalies')}>
      <h3 className="fw-at-sub">{t('day.anomalies')}</h3>
      <ul className="fw-at-anomalies">
        {value.anomalies.map((entry) => {
          const law = ANOMALY_LAW[entry.kind]
          return (
            <li key={entry.id} className={entry.resolvedAt ? 'is-resolved' : undefined}>
              <span className="fw-pp-row">
                <span>{said(t, anomalyWords(entry, value, locale))}</span>
                <RulePopover anomaly={entry} />
                {law && <LawRef law={law.law} plain={t(law.plain)} labels={ds.lawRef} />}
              </span>
              <span className="fw-pp-row">
                {entry.resolution ? (
                  <Tag tone="neutral">{t(`resolution.${entry.resolution}`)}</Tag>
                ) : (
                  canAccept && (
                    <Button size="sm" variant="quiet" onClick={() => actions?.onAccept(entry.id)}>
                      {t('day.accept')}
                    </Button>
                  )
                )}
                {entry.resolutionNote && <span className="fw-pp-hint">{plainReason(entry.resolutionNote)}</span>}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Events({ value, t }: { value: DayRecord; t: AttendanceWords }) {
  const locale = useLocale()
  if (value.events.length === 0) return <p className="fw-pp-hint">{t('day.noEvents')}</p>
  return (
    <SummaryTable
      label={t('day.events')}
      columns={[t('day.time'), t('day.event'), t('day.source'), t('day.reason')]}
      align={['left', 'left', 'left', 'left']}
      rows={value.events.map((event) => ({
        id: event.id,
        cells: [
          <span key="time" className={event.voided ? 'fw-at-voided' : undefined}>{timeOf(event.occurredAt, locale)}</span>,
          <span key="kind" className={event.voided ? 'fw-at-voided' : undefined}>{t(`event.kind.${event.kind}`)}{event.voided ? ` · ${t('event.voided')}` : ''}</span>,
          said(t, eventWords(event)),
          event.reason ? plainReason(event.reason) : event.source === 'AUTO' ? t('event.autoReason') : '—',
        ],
      }))}
    />
  )
}

function Corrections({ record, t }: { record: DayCorrections; t: AttendanceWords }) {
  const locale = useLocale()
  return (
    <section className="fw-pp-stack tight" aria-label={t('day.corrections')}>
      <h3 className="fw-at-sub">{t('day.corrections')}</h3>
      <p className="fw-pp-hint">{t(record.differs ? 'day.differs' : 'day.matches')}</p>
      {record.corrections.length > 0 && (
        <SummaryTable
          label={t('day.corrections')}
          columns={[t('correct.kind'), t('correct.from'), t('correct.to'), t('day.reason'), t('correct.who')]}
          align={['left', 'left', 'left', 'left', 'left']}
          rows={record.corrections.map((entry) => ({
            id: entry.id,
            cells: [entry.kind === 'ABSENCE' ? `${t('correctKind.ABSENCE')} ${entry.absenceCode ?? ''}` : t(`correctKind.${entry.kind}`), hoursWords(entry.minutesBefore, locale), hoursWords(entry.minutesAfter, locale), entry.reason, entry.by ?? '—'],
          }))}
        />
      )}
    </section>
  )
}
