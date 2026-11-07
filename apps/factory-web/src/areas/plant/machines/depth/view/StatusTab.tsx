'use client'

import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { DayStrip } from '@nexus/ui/components/DayStrip/index'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { MachineStatus } from '../../../_shared/api'
import { ageWords, TIME_ZONE } from '../../../_shared/model'
import { MachinePill, useWords, type Loaded } from '../../../_shared/parts'
import type { HistoryAnswer } from '../api'
import { addDays, historyOf, STATUS_ORDER, STATUS_TONE } from '../model'
import { useDepthWords, useSay } from '../parts'

export const WEEK_DAYS = 7

/**
 * Machine › Status & downtime (design plant.machines rec:Machine/status; QHS-167): the week's status over time, one DayStrip
 * per day (the machine's statuses as a named row under the day, in the site's zone), the time in each status that week, and
 * the changes with their reasons (newest first). The history starts at the machine's first change (no backfill) and names
 * no person (Statuto dei Lavoratori art. 4). Idle comes with machine signals (Later); the downtime log is W3.
 */
export function StatusTab({
  loaded,
  week,
  today,
  changeHeld,
  onWeek,
  onChange,
  onRetry,
}: {
  loaded: Loaded<HistoryAnswer>
  /** The Monday shown (`YYYY-MM-DD`). */
  week: string
  today: string
  /** Why Change status is held (a key of this catalogue), or null. */
  changeHeld: string | null
  onWeek?: (monday: string) => void
  onChange?: () => void
  onRetry?: () => void
}) {
  const t = useDepthWords()
  const plant = useWords()
  const say = useSay()
  const locale = useLocale()
  const ds = useDsWords()
  const place = { locale, timeZone: TIME_ZONE }
  const thisWeek = addDays(today, -((new Date(`${today}T00:00:00.000Z`).getUTCDay() + 6) % 7))
  const head = (
    <div className="fw-md-head">
      <span className="fw-md-row" role="group" aria-label={t('history.weekNav')}>
        <Button size="sm" variant="quiet" aria-label={t('history.previous')} onClick={() => onWeek?.(addDays(week, -7))}>
          <ChevronLeft size={14} aria-hidden />
        </Button>
        <strong>{t('history.week', { from: formatDate(week, { locale, timeZone: 'UTC' }), to: formatDate(addDays(week, 6), { locale, timeZone: 'UTC' }) })}</strong>
        <Button size="sm" variant="quiet" aria-label={t('history.next')} heldReason={week >= thisWeek ? t('history.held.future') : null} onClick={() => onWeek?.(addDays(week, 7))}>
          <ChevronRight size={14} aria-hidden />
        </Button>
        {week !== thisWeek && (
          <Button size="sm" onClick={() => onWeek?.(thisWeek)}>
            {t('history.thisWeek')}
          </Button>
        )}
      </span>
      <Button size="sm" variant="primary" heldReason={changeHeld ? t(changeHeld) : null} onClick={() => onChange?.()}>
        <RefreshCw size={13} aria-hidden /> {t('status.open')}
      </Button>
    </div>
  )
  if (loaded.status === 'loading') {
    return (
      <div className="fw-md-stack">
        {head}
        <Card padded aria-busy="true">
          <p className="fw-md-muted" role="status">
            <Spinner size={14} /> {t('history.loading')}
          </p>
          <div className="fw-md-stack tight">
            {Array.from({ length: WEEK_DAYS }, (_, index) => (
              <Skeleton key={index} height={44} />
            ))}
          </div>
        </Card>
      </div>
    )
  }
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-md-stack">
        {head}
        <Card padded>
          <EmptyState
            title={t('history.failed')}
            description={loaded.status === 'error' ? say({ key: loaded.problem }) : t('docs.notFound')}
            action={loaded.status === 'error' ? <Button size="sm" onClick={() => onRetry?.()}>{t('common.retry')}</Button> : undefined}
          />
        </Card>
      </div>
    )
  }
  const answer = loaded.value
  const { days, minutes } = historyOf(answer, week, WEEK_DAYS, TIME_ZONE)
  const shown = STATUS_ORDER.filter((status) => (minutes[status] ?? 0) > 0)
  const drawn = days.filter((day) => day.spans.length > 0)
  return (
    <div className="fw-md-stack">
      {head}
      <Card padded>
        <section className="fw-md-stack tight" aria-label={t('history.overTime')}>
          <h3 className="fw-md-h3">{t('history.overTime')}</h3>
          <p className="fw-md-row">
            <span className="fw-md-muted">{t('history.now')}</span>
            <MachinePill status={answer.current.status} />
            <span className="fw-md-muted">{plant('machine.since', { time: formatDateTime(answer.current.since, place) })}</span>
            {answer.current.reason ? <span>{answer.current.reason}</span> : null}
          </p>
          {shown.length > 0 && (
            <ul className="fw-md-plain fw-md-totals" aria-label={t('history.totals')}>
              {shown.map((status) => (
                <li key={status}>
                  <MachinePill status={status} /> <span>{ageWords(plant, minutes[status] ?? 0)}</span>
                </li>
              ))}
            </ul>
          )}
          {drawn.length === 0 ? (
            <p className="fw-md-muted">{t('history.noneThisWeek')}</p>
          ) : (
            <div className="fw-md-days">
              {drawn.map((day) => (
                <DayStrip
                  key={day.date}
                  label={formatDate(day.date, { locale, timeZone: 'UTC' })}
                  from={day.from}
                  to={day.to}
                  overlays={[
                    {
                      id: 'status',
                      name: t('history.statusRow'),
                      spans: day.spans.map((span, index) => ({ id: `${day.date}-${index}`, from: span.from, to: span.to, tone: STATUS_TONE[span.status as MachineStatus], label: span.reason ? `${plant(`machineStatus.${span.status}`)} · ${span.reason}` : plant(`machineStatus.${span.status}`) })),
                    },
                  ]}
                  locale={locale === 'it' ? 'it-IT' : 'en-GB'}
                  timeZone={TIME_ZONE}
                  tickHours={3}
                  labels={ds.dayStrip}
                />
              ))}
            </div>
          )}
          <p className="fw-md-muted">{t('history.foot')}</p>
        </section>
      </Card>
      <Card padded>
        <section className="fw-md-stack tight" aria-label={t('history.changes')}>
          <h3 className="fw-md-h3">{t('history.changes')}</h3>
          {answer.latest.length === 0 ? (
            <p className="fw-md-muted">{t('history.noChanges')}</p>
          ) : (
            <SummaryTable
              label={t('history.changes')}
              columns={[t('history.when'), t('history.from'), t('history.to'), t('history.reason')]}
              rows={answer.latest.map((event) => ({
                id: event.id,
                cells: [
                  formatDateTime(event.at, place),
                  event.from ? <MachinePill key="from" status={event.from} /> : t('history.registered'),
                  <MachinePill key="to" status={event.to} />,
                  event.reason ?? '—',
                ],
              }))}
            />
          )}
        </section>
      </Card>
    </div>
  )
}
