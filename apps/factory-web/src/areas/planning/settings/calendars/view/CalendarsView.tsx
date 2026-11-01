'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Archive, CalendarOff, CalendarPlus, Clock, Plus, RefreshCw } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { CalendarGrid, type CalendarRange, type CalendarView as GridView } from '@nexus/ui/components/CalendarGrid/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Pill, Radio, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useCalendarWords } from '../../../../_shared/calendar-grid/words'
import type { Calendar, CalendarDetail, OwnerRef, Pattern, PlanningSite, SiteLanes, WorkingTime } from '../../api'
import { PLANNING_SETTINGS_NAMESPACES, type SettingsCan } from '../../model'
import { Loading, ReadFailed, SaveBar } from '../../view/parts'
import { calendarKinds, gridDaysOf, scopeNamer, weekBaseOf, type DayKindId } from '../kinds'
import {
  archiveHeld,
  chainOf,
  chosenOwner,
  closureHeld,
  DAY_CHOICES,
  dayDraftOf,
  dayHeld,
  dayPlanOf,
  hoursWords,
  lanesReached,
  NEW_PATTERN,
  ownersOf,
  patternDraftOf,
  patternProblems,
  patternsFor,
  rangeDays,
  rowsMinutes,
  rowsOfPattern,
  weekChanges,
  weekdayName,
  weekdaysWords,
  weekDraftOf,
  weekHeld,
  type ClosureDraft,
  type DayDraft,
  type OwnerKey,
  type OwnerOption,
  type PatternDraft,
  type PatternRow,
  type WeekDraft,
} from '../model'
import '../calendars.css'

export type CalendarsDialog =
  | { kind: 'day'; date: string }
  | { kind: 'closure'; draft: ClosureDraft }
  | { kind: 'pattern'; draft: PatternDraft }
  | { kind: 'follow' }
  | { kind: 'keys' }

export interface ClosureImpact {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The lanes of this site the closure reaches, with what is booked on them in those days. */
  lanes: { kind: 'LINE' | 'WORK_CENTRE'; id: string; code: string; name: string; bookedMinutes: number; workOrders: number }[]
  /** Other sites closed whole (their lanes are counted on their own page). */
  otherSites: string[]
}

export interface Notice {
  tone: 'success' | 'danger' | 'warning' | 'info'
  key: string
  params?: Record<string, string | number>
}

/** The ONE view model of Calendars & shifts: what the container read and what is in flight. It fetches nothing. */
export interface CalendarsModel {
  prefix: string
  site: PlanningSite
  /** The company's name (the company calendar's owner). */
  companyName: string | null
  /** Other sites the person plans at (a closure may close them whole). */
  otherSites: readonly PlanningSite[]
  can: SettingsCan
  /** The site's day today (`YYYY-MM-DD`). */
  today: string
  load: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready' }
  calendars: readonly Calendar[]
  lanes: SiteLanes | null
  patterns: readonly Pattern[]
  /** The owner the address names (null: the site). */
  owner: OwnerRef | null
  view: GridView
  /** `YYYY-MM`. */
  month: string
  /** The owner's year: each day's state, and its own calendar's dated days (null: it has none). */
  year: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready'; time: WorkingTime; own: CalendarDetail | null }
  busy: boolean
  notice: Notice | null
  changedElsewhere: boolean
  /** A dialog open at the start (the address's `?pattern=`, a design case). */
  dialog?: CalendarsDialog | null
  /** The day's refusal, in words. */
  dayProblem?: string | null
  /** The closure's refusal: the dates already set (409), or a problem in words. */
  closureTaken?: readonly string[]
  closureProblem?: string | null
  impact?: ClosureImpact | null
  patternProblem?: { key: string; row: number | null } | null
  /** Design cases: the rows of the patterns list selected; a week draft typed. */
  selected?: readonly string[]
  weekDraft?: WeekDraft
}

export interface CalendarsActions {
  onOwner?: (key: OwnerKey) => void
  onMonth?: (month: string) => void
  onView?: (view: GridView) => void
  onRetry?: () => void
  onReload?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: CalendarsDialog | null) => void
  onSaveDay?: (date: string, draft: DayDraft) => Promise<boolean>
  onClosureImpact?: (draft: ClosureDraft) => void
  onAddClosure?: (draft: ClosureDraft) => Promise<boolean>
  onSaveWeek?: (draft: WeekDraft) => Promise<boolean>
  onMakeOwn?: () => Promise<boolean>
  onFollowAbove?: () => Promise<boolean>
  onSavePattern?: (draft: PatternDraft) => Promise<boolean>
  onArchivePatterns?: (ids: readonly string[]) => Promise<void>
}

/**
 * SCR-124 — Planning settings › Calendars & shifts (design planning.settings sec:calendars): whose calendar (the company's
 * — every site —, the site's, a line's, a workshop's), the DS CalendarGrid of its days (month or year; the week hatched,
 * public holidays, closures, extra shifts and short days each with its own pattern and word; days decided by a
 * calendar above say so), its working week and shift pattern, the capacity it recalculates; click a day → the day's
 * exception (pop:day: "Tuesday 4 Nov — Line 2"), drag across days or "Add closure" → pop:closure with the lanes and work
 * orders it reaches; the shift patterns list with its editor. An owner with no calendar of its own follows the ones
 * above; none at all: the planning default (Monday to Friday, one shift), said, never hidden. Fetches nothing.
 */
export function CalendarsView({ model, actions }: { model: CalendarsModel; actions?: CalendarsActions }) {
  return (
    <WithMessages namespaces={PLANNING_SETTINGS_NAMESPACES}>
      <Calendars model={model} actions={actions} />
    </WithMessages>
  )
}

type T = (key: string, params?: Readonly<Record<string, string | number>>) => string

function Calendars({ model, actions }: { model: CalendarsModel; actions?: CalendarsActions }) {
  const t = useT('planning-settings')
  const locale = useLocale()
  const words = useCalendarWords()
  const intl = INTL_LOCALE[locale]
  const [dialog, setDialogState] = useState<CalendarsDialog | null>(model.dialog ?? null)
  useEffect(() => setDialogState(model.dialog ?? null), [model.dialog])
  const setDialog = (next: CalendarsDialog | null) => {
    setDialogState(next)
    actions?.onDialog?.(next)
  }
  const [range, setRange] = useState<CalendarRange | null>(null)
  const anchors = useRef<Record<string, HTMLElement | null>>({})
  const gridRef = useRef<HTMLDivElement>(null)
  // The day popover sits beside its day: the opener's cell, else (a dialog open from the start) the day's cell once drawn.
  const [dayAnchor, setDayAnchor] = useState<HTMLElement | null>(null)
  const openDate = dialog?.kind === 'day' ? dialog.date : null
  useEffect(() => {
    if (!openDate) return setDayAnchor(null)
    setDayAnchor(anchors.current[openDate] ?? gridRef.current?.querySelector<HTMLElement>(`[data-cal-date="${openDate}"]`) ?? null)
  }, [openDate, model.year.status])
  const [view, setView] = useState<GridView>(model.view)
  const [month, setMonth] = useState(model.month)
  useEffect(() => setView(model.view), [model.view])
  useEffect(() => setMonth(model.month), [model.month])

  const kinds = useMemo(() => calendarKinds(t), [t])
  const options = useMemo(() => ownersOf(model.site, model.companyName, model.lanes, model.calendars), [model.site, model.companyName, model.lanes, model.calendars])
  const owner = options.length > 0 ? chosenOwner(options, model.owner) : null
  const year = model.year.status === 'ready' ? model.year : null
  const chain = year ? chainOf(year.time.owner.calendars, model.calendars as Calendar[]) : []
  const base = weekBaseOf(chain, model.patterns)
  const namer = scopeNamer(chain, t)
  const grid = year ? gridDaysOf(year.time.days, base, model.patterns, { ownCalendarId: owner?.calendar?.id ?? null, scopeName: namer, timeZone: model.site.timeZone, t }) : null
  const canManage = model.can.manageCalendars
  const held = canManage ? null : t('ps.held.calendars')
  const ownerName = owner ? ownerLabel(owner, t) : ''

  if (!model.can.calendars) return <ReadFailed title={t('cal.noAccess.title')} problem="ps.problem.forbidden" />
  if (model.load.status === 'loading') return <Loading rows={3}><Skeleton height={360} /></Loading>
  if (model.load.status === 'error') return <ReadFailed title={t('cal.failed')} problem={model.load.problem} onRetry={actions?.onRetry} />
  if (!owner) return null

  const reached = lanesReached(owner, model.lanes)
  const openDay = (date: string, anchor: HTMLElement | null) => {
    anchors.current[date] = anchor
    setDialog({ kind: 'day', date })
  }
  const newClosure = (from: string, to: string) => setDialog({ kind: 'closure', draft: { from, to, reason: '', targets: [owner.key], taken: [], takenChoice: null } })
  const monthDays = year ? year.time.days.filter((day) => day.date.startsWith(month)) : []
  const monthWorking = monthDays.filter((day) => day.working).length
  const monthMinutes = monthDays.reduce((sum, day) => sum + (day.minutes ?? 0), 0)

  return (
    <section className="fw-cal" aria-label={t('ps.tab.calendars')}>
      {model.changedElsewhere && (
        <Banner
          tone="info"
          title={t('cal.elsewhere.title')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              <RefreshCw size={13} aria-hidden /> {t('cal.elsewhere.reload')}
            </Button>
          }
        >
          {t('cal.elsewhere.body')}
        </Banner>
      )}
      {model.notice && (
        <Banner tone={model.notice.tone} onDismiss={actions?.onDismissNotice}>
          {t(model.notice.key, model.notice.params)}
        </Banner>
      )}
      {!canManage && <Banner tone="neutral" title={t('cal.readOnly.title')}>{t('cal.readOnly.body')}</Banner>}

      <div className="fw-cal-top">
        <label className="fw-cal-owner">
          <span className="fw-cal-label">{t('cal.owner.label')}</span>
          <Select size="sm" value={owner.key} onChange={(event) => actions?.onOwner?.(event.target.value as OwnerKey)}>
            {(['COMPANY', 'SITE', 'LINE', 'WORK_CENTRE'] as const).map((scope) => {
              const group = options.filter((option) => option.scope === scope)
              if (group.length === 0) return null
              return (
                <optgroup key={scope} label={t(`cal.owner.group.${scope}`)}>
                  {group.map((option) => (
                    <option key={option.key} value={option.key}>
                      {ownerLabel(option, t)}
                    </option>
                  ))}
                </optgroup>
              )
            })}
          </Select>
        </label>
        <span className="fw-ps-hint">{year ? chainWords(owner, chain, t) : ''}</span>
        <span className="grow" />
        <Button size="sm" variant="primary" heldReason={held} onClick={() => newClosure(model.today, model.today)}>
          <CalendarPlus size={14} aria-hidden /> {t('cal.closure.open')}
        </Button>
      </div>

      {year && chain.length === 0 && (
        <Banner tone="info" title={t('cal.none.title')}>
          {t('cal.none.body', { name: ownerName })}
        </Banner>
      )}
      {year && chain.length > 0 && !owner.calendar && (
        <Banner tone="neutral" title={t('cal.follows.title', { name: ownerName })}>
          {t('cal.follows.body', { above: chain.map((calendar) => namer(calendar.scope, calendar.id)).join(' › ') })}
        </Banner>
      )}

      <div className="fw-cal-cols">
        <Card padded className="fw-cal-main">
          <div ref={gridRef}>
            {model.year.status === 'error' ? (
              <ReadFailed title={t('cal.yearFailed')} problem={model.year.problem} onRetry={actions?.onRetry} />
            ) : (
              <CalendarGrid
                label={t('cal.gridLabel', { name: ownerName })}
                kinds={kinds}
                days={grid?.days ?? {}}
                weekKinds={grid?.weekKinds}
                view={view}
                onViewChange={(next) => {
                  setView(next)
                  actions?.onView?.(next)
                }}
                month={month}
                onMonthChange={(next) => {
                  setMonth(next)
                  actions?.onMonth?.(next)
                }}
                today={model.today}
                loading={model.year.status === 'loading'}
                onDayOpen={openDay}
                onRangeSelect={(next) => {
                  setRange(next)
                  if (canManage) newClosure(next.from, next.to)
                }}
                range={range}
                onRangeClear={() => setRange(null)}
                heldReason={held}
                words={words}
                locale={intl}
              />
            )}
          </div>
        </Card>
        <div className="fw-cal-side">
          <WeekCard model={model} owner={owner} chain={chain} base={base} actions={actions} onFollow={() => setDialog({ kind: 'follow' })} />
          <Card padded>
            <h3 className="fw-cal-h">{t('cal.month.title', { month: monthTitle(month, intl) })}</h3>
            {year ? (
              <p className="fw-ps-hint">{t('cal.month.body', { count: monthWorking, hours: hoursWords(Math.round(monthMinutes)) })}</p>
            ) : (
              <Skeleton height={20} />
            )}
            <p className="fw-ps-hint">
              <Clock size={13} aria-hidden /> {reached.length > 0 ? t('cal.recalculates', { lanes: reached.map((lane) => lane.name).join(' · ') }) : t('cal.recalculatesNone')}
            </p>
          </Card>
        </div>
      </div>

      <PatternsList model={model} actions={actions} onOpen={(draft) => setDialog({ kind: 'pattern', draft })} onKeys={() => setDialog({ kind: 'keys' })} />

      {dialog?.kind === 'day' && year && grid && (
        <DayDialog
          model={model}
          date={dialog.date}
          anchor={dayAnchor}
          ownerName={ownerName}
          kind={grid.kinds[dialog.date] ?? null}
          day={year.time.days.find((day) => day.date === dialog.date) ?? null}
          own={year.own?.days.find((day) => day.date === dialog.date) ?? null}
          hasOwn={!!owner.calendar}
          base={base}
          namer={namer}
          reached={reached.map((lane) => lane.name)}
          onClose={() => setDialog(null)}
          onSave={(draft) => (actions?.onSaveDay ? actions.onSaveDay(dialog.date, draft) : Promise.resolve(true))}
        />
      )}
      {dialog?.kind === 'closure' && (
        <ClosureDialog
          model={model}
          options={options}
          draft={dialog.draft}
          onDraft={(draft) => {
            setDialogState({ kind: 'closure', draft })
            actions?.onClosureImpact?.(draft)
          }}
          onClose={() => {
            setRange(null)
            setDialog(null)
          }}
          onAdd={async (draft) => {
            const ok = actions?.onAddClosure ? await actions.onAddClosure(draft) : true
            if (ok) {
              setRange(null)
              setDialog(null)
            }
          }}
        />
      )}
      {dialog?.kind === 'pattern' && (
        <PatternDialog
          model={model}
          draft={dialog.draft}
          onDraft={(draft) => setDialogState({ kind: 'pattern', draft })}
          onClose={() => setDialog(null)}
          onSave={async (draft) => {
            const ok = actions?.onSavePattern ? await actions.onSavePattern(draft) : true
            if (ok) setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'follow' && owner.calendar && (
        <Modal
          open
          onClose={() => setDialog(null)}
          title={t('cal.follow.title', { name: ownerName })}
          footer={
            <>
              <Button onClick={() => setDialog(null)}>{t('cal.cancel')}</Button>
              <Button
                variant="danger"
                heldReason={held ?? (model.busy ? t('ps.held.busy') : null)}
                onClick={async () => {
                  const ok = actions?.onFollowAbove ? await actions.onFollowAbove() : true
                  if (ok) setDialog(null)
                }}
              >
                {t('cal.follow.confirm')}
              </Button>
            </>
          }
        >
          <p className="fw-ps-hint">{t('cal.follow.body', { name: ownerName, count: owner.calendar.exceptions })}</p>
        </Modal>
      )}
      {dialog?.kind === 'keys' && <KeysDialog onClose={() => setDialog(null)} />}
    </section>
  )
}

const ownerLabel = (option: Pick<OwnerOption, 'scope' | 'code' | 'name'>, t: T): string =>
  option.scope === 'COMPANY' ? t('cal.owner.company', { name: option.name }) : t('cal.owner.named', { code: option.code, name: option.name })

const monthTitle = (month: string, locale: string): string => {
  const [y, m] = month.split('-').map(Number)
  const text = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, (m ?? 1) - 1, 1)))
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** "Its own calendar · reads Site A › the company" / "Follows Site A › the company". */
function chainWords(owner: OwnerOption, chain: readonly Calendar[], t: T): string {
  if (chain.length === 0) return t('cal.chain.default')
  const above = chain.filter((calendar) => calendar.id !== owner.calendar?.id)
  if (owner.calendar) return above.length > 0 ? t('cal.chain.ownAbove', { count: owner.calendar.exceptions, above: above.map((calendar) => calendar.owner.name).join(' › ') }) : t('cal.chain.own', { count: owner.calendar.exceptions })
  return t('cal.chain.follows', { above: chain.map((calendar) => calendar.owner.name).join(' › ') })
}

// ---- the week and shifts of the owner ---------------------------------------------------------------------------------

function WeekCard({ model, owner, chain, base, actions, onFollow }: { model: CalendarsModel; owner: OwnerOption; chain: readonly Calendar[]; base: ReturnType<typeof weekBaseOf>; actions?: CalendarsActions; onFollow: () => void }) {
  const t = useT('planning-settings')
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const read = weekDraftOf(owner.calendar, base)
  const [draft, setDraft] = useState<WeekDraft>(model.weekDraft ?? read)
  const readKey = `${owner.key}|${read.weekdays.join(',')}|${read.patternId}`
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the read's key decides (a new owner, a saved week)
  useEffect(() => setDraft(model.weekDraft ?? read), [readKey, model.weekDraft])
  const changes = weekChanges(read, draft)
  const canManage = model.can.manageCalendars
  const patterns = model.patterns.filter((pattern) => pattern.status === 'ACTIVE' || pattern.id === draft.patternId)
  const above = chain.filter((calendar) => calendar.id !== owner.calendar?.id)
  const inherited = weekBaseOf(above, model.patterns)
  const patternWord = base.pattern ? t('cal.week.patternNamed', { code: base.pattern.code, name: base.pattern.name }) : t('cal.week.patternDefault')
  const ownerName = ownerLabel(owner, t)

  return (
    <Card padded>
      <h3 className="fw-cal-h">{t('cal.week.title')}</h3>
      {!owner.calendar ? (
        <>
          <p className="fw-ps-hint">{t('cal.week.inherited', { days: weekdaysWords(base.weekdays, (day) => weekdayName(day, intl), { to: t('cal.words.to'), and: t('cal.words.and') }), pattern: patternWord })}</p>
          <Button size="sm" heldReason={canManage ? (model.busy ? t('ps.held.busy') : null) : t('ps.held.calendars')} onClick={() => void actions?.onMakeOwn?.()}>
            <Plus size={13} aria-hidden /> {t('cal.week.makeOwn', { name: ownerName })}
          </Button>
          <p className="fw-ps-hint">{t('cal.week.makeOwnHint')}</p>
        </>
      ) : (
        <>
          <fieldset className="fw-cal-weekdays">
            <legend className="fw-cal-label">{t('cal.week.days')}</legend>
            {[1, 2, 3, 4, 5, 6, 7].map((weekday) => (
              <Checkbox
                key={weekday}
                label={weekdayName(weekday, intl, 'short')}
                aria-label={weekdayName(weekday, intl)}
                checked={draft.weekdays.includes(weekday)}
                disabled={!canManage}
                onChange={(event) => setDraft({ ...draft, weekdays: event.target.checked ? [...draft.weekdays, weekday].sort((a, b) => a - b) : draft.weekdays.filter((day) => day !== weekday) })}
              />
            ))}
          </fieldset>
          <Field label={t('cal.week.pattern')} hint={draft.patternId ? undefined : t('cal.week.patternFromAbove', { pattern: inherited.pattern ? `${inherited.pattern.code} · ${inherited.pattern.name}` : t('cal.week.patternDefault') })}>
            <Select size="sm" value={draft.patternId} disabled={!canManage} onChange={(event) => setDraft({ ...draft, patternId: event.target.value })}>
              <option value="">{t('cal.week.patternNone')}</option>
              {patterns.map((pattern) => (
                <option key={pattern.id} value={pattern.id}>
                  {`${pattern.code} · ${pattern.name} (${hoursWords(pattern.weeklyMinutes)})`}
                </option>
              ))}
            </Select>
          </Field>
          {owner.scope !== 'COMPANY' && (
            <Button size="sm" variant="quiet" heldReason={canManage ? null : t('ps.held.calendars')} onClick={onFollow}>
              <Archive size={13} aria-hidden /> {t('cal.follow.open')}
            </Button>
          )}
          {changes > 0 && (
            <SaveBar
              count={changes}
              busy={model.busy}
              held={weekHeld(draft, canManage, model.busy) ? t(weekHeld(draft, canManage, model.busy)!) : null}
              onDiscard={() => setDraft(read)}
              onSave={() => void actions?.onSaveWeek?.(draft)}
            />
          )}
        </>
      )}
    </Card>
  )
}

// ---- pop:day — "Tuesday 4 Nov — Line 2" --------------------------------------------------------------------------------

function DayDialog({
  model,
  date,
  anchor,
  ownerName,
  kind,
  day,
  own,
  hasOwn,
  base,
  namer,
  reached,
  onClose,
  onSave,
}: {
  model: CalendarsModel
  date: string
  anchor: HTMLElement | null
  ownerName: string
  kind: DayKindId | null
  day: WorkingTime['days'][number] | null
  own: CalendarDetail['days'][number] | null
  hasOwn: boolean
  base: ReturnType<typeof weekBaseOf>
  namer: (scope: Calendar['scope'], id: string) => string
  reached: readonly string[]
  onClose: () => void
  onSave: (draft: DayDraft) => Promise<boolean>
}) {
  const t = useT('planning-settings')
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const [draft, setDraft] = useState<DayDraft>(() => dayDraftOf(own, kind))
  const weekday = day?.weekday ?? 1
  const choices = patternsFor(draft.choice, weekday, base, model.patterns)
  const plan = dayPlanOf(date, draft, own)
  const heldKey = dayHeld(draft, plan, model.can.manageCalendars, model.busy)
  const dayWords = new Intl.DateTimeFormat(intl, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
  const title = t('cal.day.title', { date: dayWords.charAt(0).toUpperCase() + dayWords.slice(1), name: ownerName })
  const state = kind ? t(`cal.kind.${kind}`) : '—'
  const by = day?.decidedBy && !own ? namer(day.decidedBy.scope, day.decidedBy.calendarId) : null
  const name = (choice: DayDraft['choice']) => (draft.name.trim() === '' || DAY_CHOICES.some((other) => other !== 'week' && t(`cal.day.defaultName.${other}`) === draft.name) ? t(`cal.day.defaultName.${choice}`) : draft.name)

  return (
    <Modal
      open
      onClose={onClose}
      anchor={anchor}
      size="sm"
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{t('cal.cancel')}</Button>
          <Button
            variant="primary"
            heldReason={heldKey ? t(heldKey) : null}
            onClick={async () => {
              if (heldKey) return
              if (await onSave(draft)) onClose()
            }}
          >
            {t('cal.day.save')}
          </Button>
        </>
      }
    >
      <div className="fw-cal-form">
        <p className="fw-cal-state">
          <Pill tone={kind === 'holiday' ? 'danger' : kind === 'closure' ? 'warning' : kind === 'extra' || kind === 'opened' ? 'success' : kind === 'short' ? 'info' : 'neutral'}>{state}</Pill>{' '}
          {day?.name ? <span>{day.name}</span> : null}
          {day && day.minutes !== null && day.working ? <span className="fw-ps-hint"> · {t('cal.day.minutes', { hours: hoursWords(Math.round(day.minutes)) })}</span> : null}
        </p>
        {by && <p className="fw-ps-hint">{t('cal.day.decidedBy', { by, name: ownerName })}</p>}
        {day?.issue === 'NO_SHIFTS' && <p className="fw-ps-hint">{t('cal.day.noShifts')}</p>}
        <fieldset className="fw-cal-choices">
          <legend className="fw-cal-label">{t('cal.day.choice')}</legend>
          {DAY_CHOICES.map((choice) => (
            <Radio
              key={choice}
              name={`day-${date}`}
              value={choice}
              checked={draft.choice === choice}
              disabled={!model.can.manageCalendars}
              label={t(`cal.day.choices.${choice}`)}
              onChange={() => setDraft({ ...draft, choice, patternId: choice === 'extra' || choice === 'short' ? draft.patternId : '', name: choice === 'week' ? '' : name(choice) })}
            />
          ))}
        </fieldset>
        {(draft.choice === 'extra' || draft.choice === 'short') && (
          <Field label={t('cal.day.pattern')} hint={choices.length === 0 ? t(`cal.day.noPattern.${draft.choice}`) : undefined}>
            <Select size="sm" value={draft.patternId} onChange={(event) => setDraft({ ...draft, patternId: event.target.value })}>
              <option value="">{t('cal.day.patternPick')}</option>
              {choices.map((pattern) => (
                <option key={pattern.id} value={pattern.id}>
                  {`${pattern.code} · ${pattern.name}`}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {draft.choice !== 'week' && (
          <>
            <Field label={t('cal.day.name')} required>
              <Input size="sm" value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label={t('cal.day.note')}>
              <Textarea rows={2} value={draft.note} maxLength={500} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
            </Field>
          </>
        )}
        {!hasOwn && plan.action === 'set' && <p className="fw-ps-hint">{t('cal.day.makesOwn', { name: ownerName })}</p>}
        <p className="fw-ps-hint">
          <Clock size={13} aria-hidden /> {reached.length > 0 ? t('cal.recalculates', { lanes: reached.join(' · ') }) : t('cal.recalculatesNone')}
        </p>
        {model.dayProblem && <Banner tone="danger">{t(model.dayProblem)}</Banner>}
      </div>
    </Modal>
  )
}

// ---- pop:closure — "Add a closure" -------------------------------------------------------------------------------------

function ClosureDialog({ model, options, draft, onDraft, onClose, onAdd }: { model: CalendarsModel; options: readonly OwnerOption[]; draft: ClosureDraft; onDraft: (draft: ClosureDraft) => void; onClose: () => void; onAdd: (draft: ClosureDraft) => void }) {
  const t = useT('planning-settings')
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const taken = model.closureTaken && model.closureTaken.length > 0 ? model.closureTaken : (draft.taken ?? [])
  const current = { ...draft, taken }
  const heldKey = closureHeld(current, model.can.manageCalendars, model.busy)
  const date = (value: string) => new Intl.DateTimeFormat(intl, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
  const toggle = (key: OwnerKey, on: boolean) => onDraft({ ...draft, targets: on ? [...draft.targets, key] : draft.targets.filter((entry) => entry !== key), taken: [], takenChoice: null })
  const impact = model.impact
  const siteKeys = model.otherSites.map((site) => `SITE:${site.id}` as OwnerKey)
  const days = draft.from && draft.to && draft.to >= draft.from ? rangeDays(draft.from, draft.to) : 0

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('cal.closure.title')}
      footer={
        <>
          <Button onClick={onClose}>{t('cal.cancel')}</Button>
          <Button variant="primary" heldReason={heldKey ? t(heldKey) : null} onClick={() => !heldKey && onAdd(current)}>
            {t('cal.closure.add')}
          </Button>
        </>
      }
    >
      <div className="fw-cal-form">
        <div className="fw-cal-pair">
          <Field label={t('cal.closure.from')} required>
            <Input size="sm" type="date" value={draft.from} onChange={(event) => onDraft({ ...draft, from: event.target.value, taken: [], takenChoice: null })} />
          </Field>
          <Field label={t('cal.closure.to')} required>
            <Input size="sm" type="date" value={draft.to} min={draft.from} onChange={(event) => onDraft({ ...draft, to: event.target.value, taken: [], takenChoice: null })} />
          </Field>
        </div>
        {days > 0 && <p className="fw-ps-hint">{t('cal.closure.days', { count: days })}</p>}
        <Field label={t('cal.closure.reason')} required hint={t('cal.closure.reasonHint')}>
          <Input size="sm" value={draft.reason} maxLength={120} placeholder={t('cal.closure.reasonPlaceholder')} onChange={(event) => onDraft({ ...draft, reason: event.target.value })} />
        </Field>
        <fieldset className="fw-cal-targets">
          <legend className="fw-cal-label">{t('cal.closure.where')}</legend>
          {options.map((option) => (
            <Checkbox key={option.key} checked={draft.targets.includes(option.key)} onChange={(event) => toggle(option.key, event.target.checked)} label={`${ownerLabel(option, t)}${option.calendar ? '' : ` — ${t('cal.closure.makesOwn')}`}`} />
          ))}
          {model.otherSites.map((site, index) => (
            <Checkbox key={site.id} checked={draft.targets.includes(siteKeys[index]!)} onChange={(event) => toggle(siteKeys[index]!, event.target.checked)} label={t('cal.closure.otherSite', { code: site.code, name: site.name })} />
          ))}
        </fieldset>
        <div className="fw-cal-impact" aria-live="polite">
          <h4 className="fw-cal-label">{t('cal.closure.impact')}</h4>
          {!impact || impact.status === 'idle' ? (
            <p className="fw-ps-hint">{t('cal.closure.impactIdle')}</p>
          ) : impact.status === 'loading' ? (
            <Skeleton height={44} />
          ) : impact.status === 'error' ? (
            <p className="fw-ps-hint">{t('cal.closure.impactFailed')}</p>
          ) : (
            <ul className="fw-cal-impact-list">
              {impact.lanes.map((lane) => (
                <li key={`${lane.kind}:${lane.id}`}>
                  <span className="fw-ps-site">{`${lane.code} · ${lane.name}`}</span>{' '}
                  <span className="fw-ps-hint">
                    {lane.workOrders > 0 ? t('cal.closure.laneBooked', { count: lane.workOrders, minutes: formatNumber(lane.bookedMinutes, locale, { maximumFractionDigits: 0 }) }) : t('cal.closure.laneFree')}
                  </span>
                </li>
              ))}
              {impact.otherSites.map((name) => (
                <li key={name}>
                  <span className="fw-ps-site">{name}</span> <span className="fw-ps-hint">{t('cal.closure.otherSiteLanes')}</span>
                </li>
              ))}
              {impact.lanes.length === 0 && impact.otherSites.length === 0 && <li className="fw-ps-hint">{t('cal.closure.impactNone')}</li>}
            </ul>
          )}
          {impact?.status === 'ready' && impact.lanes.some((lane) => lane.workOrders > 0) && (
            <Link className="fw-cal-link" href={`${model.prefix}/planning/board?site=${encodeURIComponent(model.site.id)}&from=${encodeURIComponent(draft.from)}`}>
              {t('cal.closure.toBoard')}
            </Link>
          )}
          <p className="fw-ps-hint">
            <Clock size={13} aria-hidden /> {t('cal.closure.recalculates')}
          </p>
        </div>
        {taken.length > 0 && (
          <div className="fw-cal-taken">
            <Banner tone="warning" title={t('cal.closure.taken.title', { count: taken.length })}>
              {taken.map(date).join(' · ')}
            </Banner>
            <Radio name="taken" checked={draft.takenChoice === 'keep'} onChange={() => onDraft({ ...draft, taken, takenChoice: 'keep' })} label={t('cal.closure.taken.keep')} />
            <Radio name="taken" checked={draft.takenChoice === 'replace'} onChange={() => onDraft({ ...draft, taken, takenChoice: 'replace' })} label={t('cal.closure.taken.replace')} />
          </div>
        )}
        {model.closureProblem && <Banner tone="danger">{t(model.closureProblem)}</Banner>}
      </div>
    </Modal>
  )
}

// ---- the shift patterns ---------------------------------------------------------------------------------------------

function patternLines(rows: readonly PatternRow[], t: T, intl: string): string[] {
  return rows.map((row) => {
    const days = weekdaysWords(row.days, (day) => weekdayName(day, intl, 'short'), { to: t('cal.words.to'), and: t('cal.words.and') })
    const what = row.kind === 'BREAK' ? t('cal.pattern.breakWord') : row.label || t('cal.pattern.shiftWord')
    return `${days} ${row.start}–${row.end} (${what})`
  })
}

function PatternsList({ model, actions, onOpen, onKeys }: { model: CalendarsModel; actions?: CalendarsActions; onOpen: (draft: PatternDraft) => void; onKeys: () => void }) {
  const t = useT('planning-settings')
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const rows = model.patterns
  const picked = rows.filter((row) => selected.includes(row.id))
  const canManage = model.can.manageCalendars
  const latest = useRef({ onOpen })
  latest.current = { onOpen }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || !canManage) return
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      event.preventDefault()
      latest.current.onOpen({ ...NEW_PATTERN, rows: NEW_PATTERN.rows.map((row) => ({ ...row })) })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canManage])

  const columns = useMemo<ColDef<Pattern>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<Pattern>) =>
      data ? (
        <span className="fw-cal-cell">
          <span className="fw-ps-site">{data.code}</span>
          <span className="fw-ps-hint">{data.name}</span>
        </span>
      ) : null
    const ShiftsCell = ({ data }: ICellRendererParams<Pattern>) => (data ? <span className="fw-cal-cell-text">{patternLines(rowsOfPattern(data), t, intl).join(' · ')}</span> : null)
    const UsedCell = ({ data }: ICellRendererParams<Pattern>) => (data ? <span>{t('cal.patterns.used', { count: data.calendars })}</span> : null)
    const ForCell = ({ data }: ICellRendererParams<Pattern>) => (data ? <span>{data.companyId ? t('cal.patterns.forCompany') : t('cal.patterns.forAll')}</span> : null)
    const StatusCell = ({ data }: ICellRendererParams<Pattern>) => (data ? <Tag tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`cal.patterns.status.${data.status}`)}</Tag> : null)
    return [
      { colId: 'pattern', headerName: t('cal.patterns.col.pattern'), minWidth: 170, flex: 1, cellRenderer: NameCell },
      { colId: 'shifts', headerName: t('cal.patterns.col.shifts'), minWidth: 280, flex: 2.4, cellRenderer: ShiftsCell },
      { colId: 'hours', headerName: t('cal.patterns.col.hours'), width: 130, minWidth: 110, valueGetter: (params) => (params.data ? hoursWords(params.data.weeklyMinutes) : '') },
      { colId: 'used', headerName: t('cal.patterns.col.used'), width: 150, minWidth: 120, cellRenderer: UsedCell },
      { colId: 'for', headerName: t('cal.patterns.col.for'), width: 160, minWidth: 130, cellRenderer: ForCell },
      { colId: 'status', headerName: t('cal.patterns.col.status'), width: 130, minWidth: 110, cellRenderer: StatusCell },
    ]
  }, [t, intl])

  const archivable = picked.filter((row) => !archiveHeld(row))
  const archiveWhy = picked.length > 0 && archivable.length === 0 ? t(archiveHeld(picked[0]!)!, { count: picked[0]!.calendars }) : null

  return (
    <section className="fw-cal-patterns" aria-label={t('cal.patterns.title')}>
      <h3 className="fw-cal-h">{t('cal.patterns.title')}</h3>
      <p className="fw-ps-hint">{t('cal.patterns.hint')}</p>
      <ListFrame<Pattern>
        label={t('cal.patterns.title')}
        listKey="planning.settings.patterns"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        rowKind="two-line"
        count={t('cal.patterns.count', { count: rows.length })}
        right={
          <Button size="sm" heldReason={canManage ? null : t('ps.held.calendars')} onClick={() => onOpen({ ...NEW_PATTERN, rows: NEW_PATTERN.rows.map((row) => ({ ...row })) })} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('cal.patterns.new')}
          </Button>
        }
        selection={
          canManage
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <Button
                    size="sm"
                    variant="danger-outline"
                    heldReason={archiveWhy ?? (model.busy ? t('ps.held.busy') : null)}
                    aria-label={t('cal.patterns.archive', { count: archivable.length })}
                    onClick={() => void actions?.onArchivePatterns?.(archivable.map((row) => row.id)).then(() => setSelected([]))}
                  >
                    <Archive size={13} aria-hidden /> <SelectionLabel>{t('cal.patterns.archive', { count: archivable.length })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        isRowSelectable={(row) => (archiveHeld(row) ? t(archiveHeld(row)!, { count: row.calendars }) : null)}
        keys={canManage ? [{ keys: ['c'], does: t('cal.patterns.new') }] : []}
        onHelp={onKeys}
        onOpen={(row) => onOpen(patternDraftOf(row))}
        state={
          rows.length === 0 ? (
            <EmptyState icon={<CalendarOff size={20} aria-hidden />} title={t('cal.patterns.empty.title')} description={t('cal.patterns.empty.body')} />
          ) : undefined
        }
      />
    </section>
  )
}

function PatternDialog({ model, draft, onDraft, onClose, onSave }: { model: CalendarsModel; draft: PatternDraft; onDraft: (draft: PatternDraft) => void; onClose: () => void; onSave: (draft: PatternDraft) => void }) {
  const t = useT('planning-settings')
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const canManage = model.can.manageCalendars
  const taken = model.patterns.filter((pattern) => pattern.id !== draft.id).map((pattern) => pattern.code)
  const problems = patternProblems(draft, taken)
  const heldKey = !canManage ? 'ps.held.calendars' : model.busy ? 'ps.held.busy' : problems.length > 0 ? 'cal.pattern.held.problems' : null
  const minutes = rowsMinutes(draft.rows)
  const week = Object.values(minutes).reduce((sum, value) => sum + value, 0)
  const setRow = (index: number, patch: Partial<PatternRow>) => onDraft({ ...draft, rows: draft.rows.map((row, at) => (at === index ? { ...row, ...patch } : row)) })
  const rowProblem = (index: number) => problems.find((problem) => problem.row === index) ?? (model.patternProblem?.row === index ? { key: model.patternProblem.key } : null)
  const top = problems.filter((problem) => problem.row === null)
  const inUse = draft.id ? (model.patterns.find((pattern) => pattern.id === draft.id)?.calendars ?? 0) : 0

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={draft.id ? t('cal.pattern.editTitle', { code: draft.code }) : t('cal.pattern.newTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('cal.cancel')}</Button>
          <Button variant="primary" heldReason={heldKey ? t(heldKey, { count: problems.length }) : null} onClick={() => !heldKey && onSave(draft)} aria-keyshortcuts="Meta+Enter Control+Enter">
            {draft.id ? t('cal.pattern.save') : t('cal.pattern.create')}
          </Button>
        </>
      }
    >
      <div className="fw-cal-form">
        <div className="fw-cal-pair">
          <Field label={t('cal.pattern.code')} required error={top.find((problem) => problem.field === 'code') ? t(top.find((problem) => problem.field === 'code')!.key) : undefined} hint={draft.id ? t('cal.pattern.codeFixed') : t('cal.pattern.codeHint')}>
            <Input size="sm" value={draft.code} disabled={!!draft.id || !canManage} maxLength={20} onChange={(event) => onDraft({ ...draft, code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('cal.pattern.name')} required error={top.find((problem) => problem.field === 'name') ? t('cal.pattern.problem.name') : undefined}>
            <Input size="sm" value={draft.name} disabled={!canManage} maxLength={200} onChange={(event) => onDraft({ ...draft, name: event.target.value })} />
          </Field>
        </div>
        <Field label={t('cal.pattern.description')}>
          <Input size="sm" value={draft.description} disabled={!canManage} maxLength={300} onChange={(event) => onDraft({ ...draft, description: event.target.value })} />
        </Field>
        {!draft.id && <Checkbox checked={draft.everyCompany} disabled={!canManage} onChange={(event) => onDraft({ ...draft, everyCompany: event.target.checked })} label={t('cal.pattern.everyCompany')} />}
        {inUse > 0 && <p className="fw-ps-hint">{t('cal.pattern.inUse', { count: inUse })}</p>}
        <div className="fw-cal-rows" role="group" aria-label={t('cal.pattern.rows')}>
          {draft.rows.map((row, index) => {
            const problem = rowProblem(index)
            return (
              <div key={index} className="fw-cal-row">
                <fieldset className="fw-cal-weekdays">
                  <legend className="fw-ps-hint">{t(row.kind === 'SHIFT' ? 'cal.pattern.shiftOn' : 'cal.pattern.breakOn', { n: index + 1 })}</legend>
                  {[1, 2, 3, 4, 5, 6, 7].map((weekday) => (
                    <Checkbox
                      key={weekday}
                      label={weekdayName(weekday, intl, 'short')}
                      aria-label={t('cal.pattern.dayOf', { day: weekdayName(weekday, intl), n: index + 1 })}
                      checked={row.days.includes(weekday)}
                      disabled={!canManage}
                      onChange={(event) => setRow(index, { days: event.target.checked ? [...row.days, weekday].sort((a, b) => a - b) : row.days.filter((day) => day !== weekday) })}
                    />
                  ))}
                </fieldset>
                <div className="fw-cal-row-fields">
                  <Select size="sm" aria-label={t('cal.pattern.kind', { n: index + 1 })} value={row.kind} disabled={!canManage} onChange={(event) => setRow(index, { kind: event.target.value as PatternRow['kind'] })}>
                    <option value="SHIFT">{t('cal.pattern.shiftWord')}</option>
                    <option value="BREAK">{t('cal.pattern.breakWord')}</option>
                  </Select>
                  <Input size="sm" aria-label={t('cal.pattern.label', { n: index + 1 })} placeholder={t('cal.pattern.labelPlaceholder')} value={row.label} disabled={!canManage} maxLength={60} onChange={(event) => setRow(index, { label: event.target.value })} />
                  <Input size="sm" type="time" aria-label={t('cal.pattern.start', { n: index + 1 })} value={row.start} disabled={!canManage} onChange={(event) => setRow(index, { start: event.target.value })} />
                  <Input size="sm" type="time" aria-label={t('cal.pattern.end', { n: index + 1 })} value={row.end} disabled={!canManage} onChange={(event) => setRow(index, { end: event.target.value })} />
                  <Button size="sm" variant="quiet" aria-label={t('cal.pattern.remove', { n: index + 1 })} heldReason={canManage ? null : t('ps.held.calendars')} onClick={() => onDraft({ ...draft, rows: draft.rows.filter((_, at) => at !== index) })}>
                    {t('cal.pattern.removeShort')}
                  </Button>
                </div>
                {row.kind === 'SHIFT' && row.end <= row.start && row.end !== '' && <span className="fw-ps-hint">{t('cal.pattern.nextDay')}</span>}
                {problem && <span className="fw-cal-problem">{t(problem.key)}</span>}
              </div>
            )
          })}
        </div>
        <span className="fw-ps-row">
          <Button size="sm" heldReason={canManage ? null : t('ps.held.calendars')} onClick={() => onDraft({ ...draft, rows: [...draft.rows, { days: [1, 2, 3, 4, 5], kind: 'SHIFT', label: '', start: '14:00', end: '22:00' }] })}>
            <Plus size={13} aria-hidden /> {t('cal.pattern.addShift')}
          </Button>
          <Button size="sm" heldReason={canManage ? null : t('ps.held.calendars')} onClick={() => onDraft({ ...draft, rows: [...draft.rows, { days: [1, 2, 3, 4, 5], kind: 'BREAK', label: '', start: '10:00', end: '10:15' }] })}>
            <Plus size={13} aria-hidden /> {t('cal.pattern.addBreak')}
          </Button>
        </span>
        <p className="fw-ps-hint">
          {t('cal.pattern.preview', {
            week: hoursWords(week),
            days: [1, 2, 3, 4, 5, 6, 7]
              .filter((weekday) => (minutes[weekday] ?? 0) > 0)
              .map((weekday) => `${weekdayName(weekday, intl, 'short')} ${hoursWords(minutes[weekday]!)}`)
              .join(' · ') || '—',
          })}
        </p>
        {top.filter((problem) => problem.field === 'rows').map((problem) => (
          <span key={problem.key} className="fw-cal-problem">
            {t(problem.key)}
          </span>
        ))}
        {model.patternProblem && model.patternProblem.row === null && <Banner tone="danger">{t(model.patternProblem.key)}</Banner>}
      </div>
    </Modal>
  )
}

function KeysDialog({ onClose }: { onClose: () => void }): ReactNode {
  const t = useT('planning-settings')
  const keys = ['open', 'range', 'month', 'escape', 'new'] as const
  return (
    <Modal open onClose={onClose} title={t('cal.keys.title')} footer={<Button onClick={onClose}>{t('cal.keys.close')}</Button>}>
      <ul className="fw-cal-keys">
        {keys.map((key) => (
          <li key={key}>{t(`cal.keys.${key}`)}</li>
        ))}
      </ul>
    </Modal>
  )
}
