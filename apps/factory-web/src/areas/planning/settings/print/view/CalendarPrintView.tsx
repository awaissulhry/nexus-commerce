'use client'

import Link from 'next/link'
import { ChevronLeft, ChevronRight, Printer } from 'lucide-react'
import { SummaryTable } from '@nexus/ui/components'
import { CalendarGrid } from '@nexus/ui/components/CalendarGrid/index'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useCalendarWords } from '../../../../_shared/calendar-grid/words'
import type { Calendar, Pattern, PlanningSite, WorkingTime } from '../../api'
import { calendarKinds, gridDaysOf, hoursOf, scopeNamer, weekBaseOf, type DayKindId } from '../../calendars/kinds'
import { chainOf, weekdayName, weekdaysWords } from '../../calendars/model'
import { PLANNING_SETTINGS_NAMESPACES } from '../../model'
import { ReadFailed } from '../../view/parts'
import '../print.css'

export interface LaneDays {
  code: string
  name: string
  time: WorkingTime
}

/** The ONE view model of the plant calendar print: the site's year and the lines and workshops whose days differ. */
export interface CalendarPrintModel {
  prefix: string
  person: string
  companyName: string | null
  site: PlanningSite | null
  year: number
  /** When it was printed (an instant). */
  printedAt: string
  load: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready'; time: WorkingTime; calendars: readonly Calendar[]; patterns: readonly Pattern[]; lanes: readonly LaneDays[] }
}

/**
 * SCR-124-print — Planning settings › Plant calendar (print) (design planning.settings tab:calendar-print, "posted on
 * the notice board"): the site's year on one sheet — the DS CalendarGrid's year view with its key, the working week and
 * shifts in words, the closed days and exceptions in date order, and the lines and workshops whose days differ from the
 * site's. Print sends it to the printer or a PDF; the frame is hidden on paper. Fetches nothing.
 */
export function CalendarPrintView({ model }: { model: CalendarPrintModel }) {
  return (
    <WithMessages namespaces={PLANNING_SETTINGS_NAMESPACES}>
      <Sheet model={model} />
    </WithMessages>
  )
}

function Sheet({ model }: { model: CalendarPrintModel }) {
  const t = useT('planning-settings')
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const words = useCalendarWords()
  const kinds = calendarKinds(t)
  const timeZone = model.site?.timeZone ?? 'Europe/Rome'
  const ready = model.load.status === 'ready' ? model.load : null
  const yearHref = (year: number) => `${model.prefix}/planning/settings/calendar-print?site=${encodeURIComponent(model.site?.id ?? '')}&year=${year}`
  const dayText = (date: string) => new Intl.DateTimeFormat(intl, { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))

  const chain = ready ? chainOf(ready.time.owner.calendars, ready.calendars as Calendar[]) : []
  const base = weekBaseOf(chain, ready?.patterns ?? [])
  const grid = ready ? gridDaysOf(ready.time.days, base, ready.patterns, { ownCalendarId: null, scopeName: scopeNamer(chain, t), timeZone, t }) : null
  const listed = ready && grid ? ready.time.days.filter((day) => day.date in grid.days && grid.kinds[day.date] !== 'off') : []
  const kindOf = (id: DayKindId | undefined) => (id ? t(`cal.kind.${id}`) : '—')
  const lanes = ready
    ? ready.lanes.flatMap((lane) =>
        lane.time.days
          .filter((day) => {
            const site = ready.time.days.find((entry) => entry.date === day.date)
            return site && (site.reason !== day.reason || site.name !== day.name || site.minutes !== day.minutes)
          })
          .map((day) => ({ lane, day })),
      )
    : []
  const laneBase = (lane: LaneDays) => weekBaseOf(chainOf(lane.time.owner.calendars, (ready?.calendars ?? []) as Calendar[]), ready?.patterns ?? [])

  return (
    <article className="fw-psp" aria-label={t('print.title', { year: model.year, site: model.site?.name ?? '' })}>
      <header className="fw-psp-head">
        <div>
          <h1 className="fw-psp-title">{t('print.title', { year: model.year, site: model.site ? `${model.site.code} · ${model.site.name}` : '' })}</h1>
          <p className="fw-ps-hint">
            {model.companyName ? `${model.companyName} · ` : ''}
            {t('print.printed', { date: formatDate(model.printedAt, { locale, timeZone }), person: model.person })}
          </p>
        </div>
        <span className="fw-psp-actions">
          <Button size="sm" variant="quiet" asChild>
            <Link href={yearHref(model.year - 1)} aria-label={t('print.previousYear')}>
              <ChevronLeft size={14} aria-hidden /> {model.year - 1}
            </Link>
          </Button>
          <Button size="sm" variant="quiet" asChild>
            <Link href={yearHref(model.year + 1)} aria-label={t('print.nextYear')}>
              {model.year + 1} <ChevronRight size={14} aria-hidden />
            </Link>
          </Button>
          <Button size="sm" variant="primary" heldReason={ready ? null : t('print.held')} onClick={() => window.print()}>
            <Printer size={14} aria-hidden /> {t('print.print')}
          </Button>
        </span>
      </header>

      {model.load.status === 'error' ? (
        <ReadFailed title={t('print.failed')} problem={model.load.problem} />
      ) : !ready || !grid ? (
        <div className="fw-psp-body" aria-busy="true">
          <Skeleton height={360} />
          <Skeleton height={160} />
        </div>
      ) : (
        <div className="fw-psp-body">
          <p className="fw-psp-week">
            {t('print.week', {
              days: weekdaysWords(base.weekdays, (day) => weekdayName(day, intl), { to: t('cal.words.to'), and: t('cal.words.and') }),
              pattern: base.pattern ? `${base.pattern.code} · ${base.pattern.name}` : t('cal.week.patternDefault'),
            })}
          </p>
          <CalendarGrid
            label={t('cal.gridLabel', { name: model.site?.name ?? '' })}
            kinds={kinds}
            days={grid.days}
            weekKinds={grid.weekKinds}
            view="year"
            views={['year']}
            month={`${model.year}-01`}
            today={null}
            layout="grid"
            listBelow={0}
            words={words}
            locale={intl}
          />
          <section className="fw-psp-section">
            <h2 className="fw-psp-h">{t('print.days')}</h2>
            {listed.length === 0 ? (
              <p className="fw-ps-hint">{t('print.daysNone')}</p>
            ) : (
              <SummaryTable
                label={t('print.days')}
                columns={[t('print.col.date'), t('print.col.kind'), t('print.col.name'), t('print.col.hours')]}
                widths={['26%', '22%', '34%', '18%']}
                align={['left', 'left', 'left', 'left']}
                rows={listed.map((day) => ({ id: day.date, cells: [dayText(day.date), kindOf(grid.kinds[day.date]), day.name ?? '—', day.working ? hoursOf(day, timeZone) : '—'] }))}
              />
            )}
          </section>
          <section className="fw-psp-section">
            <h2 className="fw-psp-h">{t('print.lanes')}</h2>
            {lanes.length === 0 ? (
              <p className="fw-ps-hint">{t('print.lanesNone')}</p>
            ) : (
              <SummaryTable
                label={t('print.lanes')}
                columns={[t('print.col.lane'), t('print.col.date'), t('print.col.kind'), t('print.col.name'), t('print.col.hours')]}
                widths={['18%', '24%', '18%', '24%', '16%']}
                align={['left', 'left', 'left', 'left', 'left']}
                rows={lanes.map(({ lane, day }) => {
                  const own = gridDaysOf([day], laneBase(lane), ready.patterns, { ownCalendarId: null, scopeName: () => '', timeZone, t }).kinds[day.date]
                  return { id: `${lane.code}:${day.date}`, cells: [`${lane.code} · ${lane.name}`, dayText(day.date), kindOf(own), day.name ?? '—', day.working ? hoursOf(day, timeZone) : '—'] }
                })}
              />
            )}
          </section>
        </div>
      )}
    </article>
  )
}
