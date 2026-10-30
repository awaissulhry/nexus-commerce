'use client'

import { useMemo, useState } from 'react'
import { CalendarX2 } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { CalendarGrid, dateOf, rangeLength, type CalendarDay, type CalendarKind, type CalendarRange } from '@nexus/ui/components/CalendarGrid/index'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { CALENDAR_KIT_NAMESPACE, useCalendarWords } from '../words'
import '../calendar-grid-lab.css'

/** Made-up text in both interface languages (fixture data stands in for what the API and the tenant would give). */
export type Two = Readonly<{ it: string; en: string }>

/** The kinds of day a site calendar has (B-W2a-08's calendars and shifts; the screen names them in the page's words). */
export type LabKind = 'work' | 'weekend' | 'holiday' | 'closure' | 'extra' | 'short' | 'lineClosed'

export interface LabDay {
  /** YYYY-MM-DD. */
  date: string
  kind: LabKind
  /** The holiday's or the closure's name. */
  reason?: Two
  /** Hours (24 h, the same in both languages). */
  detail?: string
}

/** The ONE view model of the calendar grid lab: a site line's calendar and its state. It fetches nothing. */
export interface CalendarGridLabModel {
  view: 'month' | 'year'
  /** YYYY-MM: the month shown (its year in the year view). */
  month: string
  /** YYYY-MM-DD: today in the site's calendar. */
  today: string
  layout?: 'grid' | 'list'
  /** The weekly pattern, Monday first. */
  week: readonly (LabKind | null)[]
  days: readonly LabDay[]
  load: 'ready' | 'loading' | 'error'
  /** This person may only look (no Planning settings permission). */
  held?: 'readOnly' | null
  /** A range already selected (by a drag or Shift + arrows). */
  range?: CalendarRange
  /** No calendar set yet: the site default is drawn and said. */
  noCalendar?: boolean
}

/** Tone and pattern per kind: every kind that can sit beside another differs by its pattern, not only its colour. */
const KINDS: readonly Omit<CalendarKind, 'label'>[] = [
  { id: 'work' },
  { id: 'weekend', tone: 'neutral', off: true },
  { id: 'holiday', tone: 'danger', off: true, pattern: 'cross' },
  { id: 'closure', tone: 'warning', off: true },
  { id: 'extra', tone: 'success', pattern: 'dots' },
  { id: 'short', tone: 'info', pattern: 'stripe' },
  { id: 'lineClosed', tone: 'danger', off: true, pattern: 'outline' },
]

/**
 * SCR-245 — the calendar grid, DS part CalendarGrid (B-W2a-24; NEW id: the design gives the DS part no screen of its
 * own; its screens are Planning settings › Calendars & shifts SCR-124 (B-W2a-59, on the calendars API of B-W2a-08), a
 * supplier's closures and a purchase order's dates). Made-up site calendar with the Italian public holidays; opening a
 * day and selecting days are kept in this view only (nothing is saved). Every word from `calendar-kit` in Italian and
 * English; month and weekday names in the page's language.
 */
export function CalendarGridLabView({ model }: { model: CalendarGridLabModel }) {
  return (
    <WithMessages namespaces={[CALENDAR_KIT_NAMESPACE]}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Lab({ model }: { model: CalendarGridLabModel }) {
  const t = useT(CALENDAR_KIT_NAMESPACE)
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const words = useCalendarWords()
  const [opened, setOpened] = useState<string | null>(null)
  const [asked, setAsked] = useState<CalendarRange | null>(model.range ?? null)
  const dayMonth = useMemo(() => new Intl.DateTimeFormat(intl, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }), [intl])
  const kinds = useMemo<CalendarKind[]>(() => KINDS.map((kind) => ({ ...kind, label: t(`lab.kind.${kind.id}`) })), [t])
  const days = useMemo<Record<string, CalendarDay>>(
    () => Object.fromEntries(model.days.map((day) => [day.date, { kind: day.kind, reason: day.reason?.[locale], detail: day.detail }])),
    [model.days, locale],
  )

  if (model.load === 'error') {
    return (
      <div className="fw-callab">
        <EmptyState icon={<CalendarX2 size={22} aria-hidden="true" />} title={t('lab.errorTitle')} description={t('lab.errorReason')} action={<Button variant="primary">{t('lab.retry')}</Button>} />
      </div>
    )
  }

  const format = (iso: string) => dayMonth.format(dateOf(iso))
  return (
    <div className="fw-callab">
      {model.noCalendar ? <Banner tone="info">{t('lab.noCalendar')}</Banner> : null}
      <CalendarGrid
        label={t('lab.label')}
        kinds={kinds}
        days={days}
        weekKinds={model.week}
        defaultView={model.view}
        defaultMonth={model.month}
        defaultLayout={model.layout}
        defaultRange={model.range ?? null}
        today={model.today}
        loading={model.load === 'loading'}
        heldReason={model.held === 'readOnly' ? t('lab.readOnly') : null}
        onDayOpen={(date) => setOpened(date)}
        onRangeSelect={(range) => setAsked(range)}
        words={words}
        locale={intl}
      />
      {asked ? <p className="fw-callab-note">{t('lab.rangeAsked', { from: format(asked.from), to: format(asked.to), count: rangeLength(asked) })}</p> : null}
      {opened ? <p className="fw-callab-note">{t('lab.opened', { date: format(opened) })}</p> : null}
    </div>
  )
}
