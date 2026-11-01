'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CalendarDays, CalendarPlus, Download, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { CalendarGrid, type CalendarDay, type CalendarRange } from '@nexus/ui/components/CalendarGrid/index'
import { Button, Input, SegmentedControl, Skeleton, Toggle } from '@nexus/ui/primitives'
import { DateField, Modal } from '../../../../../lib/i18n/ds-parts'
import { useCalendarWords } from '../../../../_shared/calendar-grid/words'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { calendarKinds, gridDaysOf, scopeNamer, weekBaseOf, weekKindsOf, type DayKindId } from '../../../../planning/settings/calendars/kinds'
import { Loading, ReadFailed, SaveBar } from '../../../../planning/settings/view/parts'
import {
  COMPANY_CALENDAR_NAMESPACES,
  draftHeld,
  EMPTY_DRAFT,
  holidayRows,
  nationalDaysIn,
  normalWeek,
  sitesWords,
  weekChanged,
  weekHeld,
  weekWords,
  WEEKDAYS,
  type CompanyCalendarsModel,
  type HolidayDraft,
  type HolidayRow,
  type WriteOutcome,
} from '../model'
import '../company-calendars.css'

export type { CompanyCalendarsModel } from '../model'

export interface CompanyCalendarsActions {
  /** The year shown changed (the grid's previous / next year). */
  onYear?: (year: number) => void
  onRetry?: () => void
  onReload?: () => void
  /** "Set up the company calendar". */
  onCreate?: () => void
  /** Resolve true when saved. */
  onSaveWeek?: (weekdays: number[]) => Promise<boolean>
  /** Add a holiday or closure (replace: the days already set in the range). */
  onAdd?: (draft: HolidayDraft, replace: boolean) => Promise<WriteOutcome>
  onRemove?: (row: HolidayRow) => void
  /** Load the Italian public holidays of the year. */
  onLoad?: (year: number) => void
  onDismissNotice?: () => void
}

/**
 * Admin › Company › Calendars › Working days and holidays (design admin.org rec:Company/calendars/calendar, W2a; PLT-103):
 * the company calendar that every site inherits — a year calendar (the DS CalendarGrid: holidays, closures, the working
 * week), the list of its dated days (name, date, kind, the sites that override it, from the national list or by hand,
 * Remove), Add holiday (drag across days, or the button), "Load Italian holidays {year}", the working week (⌘S), and the
 * sites with a link each to their own calendar in Planning settings, where a site may open or close a date of its own.
 * No company calendar yet: said, with "Set up the company calendar". Read-only without calendars.manage: the actions
 * stay focusable and say why. Fetches nothing (CompanyCalendarsTab.tsx reads the API).
 */
export function CompanyCalendarsView({ model, actions }: { model: CompanyCalendarsModel; actions?: CompanyCalendarsActions }) {
  return (
    <WithMessages namespaces={COMPANY_CALENDAR_NAMESPACES}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: CompanyCalendarsModel; actions?: CompanyCalendarsActions }) {
  const t = useT('admin-calendars')
  const tp = useT('planning-settings')
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const words = useCalendarWords()
  const [dialog, setDialog] = useState<HolidayDraft | null>(model.dialog ?? null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog])
  const [range, setRange] = useState<CalendarRange | null>(null)
  const [month, setMonth] = useState(`${model.year}-01`)
  useEffect(() => setMonth((current) => (current.startsWith(`${model.year}-`) ? current : `${model.year}-01`)), [model.year])

  const short = useMemo(() => new Intl.DateTimeFormat(intl, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }), [intl])
  const dayName = useMemo(() => {
    const format = new Intl.DateTimeFormat(intl, { weekday: 'long', timeZone: 'UTC' })
    return (weekday: number) => format.format(new Date(Date.UTC(2024, 0, weekday)))
  }, [intl])
  const dateWords = (date: string) => short.format(new Date(`${date}T00:00:00Z`))

  const calendar = model.calendar
  const kinds = useMemo(() => calendarKinds(tp), [tp])
  const grid = useMemo(() => {
    if (!calendar) return null
    const base = weekBaseOf([calendar], model.patterns)
    if (model.working) return gridDaysOf(model.working.days, base, model.patterns, { ownCalendarId: calendar.id, scopeName: scopeNamer([calendar], tp), timeZone: model.company.timezone, t: tp })
    // Without the resolved year (a design case): the calendar's own days as they are.
    const days: Record<string, CalendarDay> = {}
    const ownKind: Record<string, DayKindId> = { HOLIDAY: 'holiday', CLOSURE: 'closure', WORKING: 'opened' }
    for (const day of model.days) days[day.date] = { kind: ownKind[day.kind] ?? 'work', reason: day.name }
    return { days, weekKinds: weekKindsOf(base), kinds: {} as Record<string, DayKindId> }
  }, [calendar, model.working, model.days, model.patterns, model.company.timezone, tp])
  const rows = useMemo(() => holidayRows(model.days, model.sites), [model.days, model.sites])

  if (model.load.status === 'loading')
    return (
      <div className="fw-acal" aria-busy="true">
        <div className="fw-acal-grid">
          <Card padded>
            <Loading rows={2}>
              <Skeleton height={360} />
            </Loading>
          </Card>
          <Card padded>
            <Loading rows={8} />
          </Card>
        </div>
      </div>
    )
  if (model.load.status === 'error')
    return (
      <div className="fw-acal">
        <ReadFailed title={t('acal.failed')} problem={model.load.problem} onRetry={actions?.onRetry} />
      </div>
    )

  const busyHeld = model.busy ? tp('ps.held.busy') : null
  const manageHeld = model.canManage ? null : tp('ps.held.calendars')
  const held = manageHeld ?? busyHeld
  const sitesLine = (
    <div className="fw-acal-inherit">
      <p className="fw-acal-hint">{t('acal.inherit')}</p>
      {model.sites.length > 0 && (
        <ul className="fw-acal-sites">
          {model.sites.map((entry) => (
            <li key={entry.site.id}>
              <Link href={`${model.prefix}/planning/settings?site=${encodeURIComponent(entry.site.id)}&tab=calendars`}>{t('acal.siteLink', { code: entry.site.code, name: entry.site.name })}</Link>
              <span className="fw-acal-hint"> · {entry.calendar ? t('acal.siteOwn', { count: entry.days.length }) : t('acal.siteFollows')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  if (!calendar)
    return (
      <div className="fw-acal">
        <Notices model={model} actions={actions} />
        <Card padded>
          <EmptyState
            icon={<CalendarDays size={22} aria-hidden />}
            title={t('acal.none.title')}
            description={t('acal.none.body')}
            action={
              <Button variant="primary" size="sm" heldReason={held} onClick={() => actions?.onCreate?.()}>
                {t('acal.none.create')}
              </Button>
            }
          />
        </Card>
        {sitesLine}
      </div>
    )

  const openDialog = (from: string, to = '') => {
    const own = model.days.find((day) => day.date === from && day.kind !== 'WORKING')
    setDialog({ ...EMPTY_DRAFT, from, to: to === from ? '' : to, name: own && !to ? own.name : '', kind: own?.kind === 'CLOSURE' ? 'CLOSURE' : to && to !== from ? 'CLOSURE' : 'HOLIDAY' })
  }
  const loaded = nationalDaysIn(model.days, model.year)

  return (
    <div className="fw-acal">
      <Notices model={model} actions={actions} />
      {!model.canManage && <Banner tone="info" title={t('acal.readOnly')} />}
      <div className="fw-acal-grid">
        <Card header={t('acal.title', { year: model.year })} description={t('acal.hint')} headingLevel={2} padded>
          <CalendarGrid
            label={t('acal.gridLabel', { name: model.company.legalName, year: model.year })}
            kinds={kinds}
            days={grid?.days ?? {}}
            weekKinds={grid?.weekKinds}
            defaultView="year"
            month={month}
            onMonthChange={(next) => {
              setMonth(next)
              const year = Number(next.slice(0, 4))
              if (year !== model.year) actions?.onYear?.(year)
            }}
            today={model.today}
            heldReason={held}
            range={range}
            onRangeClear={() => setRange(null)}
            onRangeSelect={(next) => {
              setRange(null)
              if (!held) openDialog(next.from, next.to)
            }}
            onDayOpen={(date) => openDialog(date)}
            words={words}
            locale={intl}
          />
          {sitesLine}
        </Card>

        <div className="fw-acal-side">
          <Card
            header={t('acal.list.title')}
            description={t('acal.list.hint')}
            headingLevel={2}
            headerAction={
              <span className="fw-acal-actions">
                <Button size="sm" heldReason={held} onClick={() => setDialog({ ...EMPTY_DRAFT })}>
                  <CalendarPlus size={14} aria-hidden /> {t('acal.add.open')}
                </Button>
                <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onLoad?.(model.year)}>
                  <Download size={14} aria-hidden /> {t('acal.load', { year: model.year })}
                </Button>
              </span>
            }
          >
            {loaded > 0 && <p className="fw-acal-hint">{t('acal.loadedAlready', { count: loaded, year: model.year })}</p>}
            {rows.length === 0 ? (
              <EmptyState icon={<CalendarDays size={20} aria-hidden />} title={t('acal.list.empty', { year: model.year })} description={t('acal.list.emptyBody', { year: model.year })} />
            ) : (
              <SummaryTable
                label={t('acal.list.label', { year: model.year })}
                columns={[t('acal.col.date'), t('acal.col.name'), t('acal.col.kind'), t('acal.col.sites'), t('acal.col.actions')]}
                density="roomy"
                stackOnPhone
                widths={['28%', '24%', '16%', '20%', '12%']}
                rows={rows.map((row) => ({
                  id: row.id,
                  cells: [
                    <span key="date">
                      {row.days === 1 ? dateWords(row.from) : t('acal.span', { from: dateWords(row.from), to: dateWords(row.to) })}
                      {row.days > 1 && <span className="nds-summary-sub">{t('acal.days', { count: row.days })}</span>}
                    </span>,
                    <span key="name">
                      {row.name}
                      <span className="nds-summary-sub">{t(row.holidaySet ? 'acal.source.national' : 'acal.source.hand')}</span>
                    </span>,
                    row.kind === 'HOLIDAY' ? tp('cal.kind.holiday') : row.kind === 'CLOSURE' ? tp('cal.kind.closure') : t('acal.kind.working'),
                    sitesWords(row, t),
                    <Button key="remove" size="sm" variant="quiet" aria-label={t('acal.remove', { name: row.name })} heldReason={held} onClick={() => actions?.onRemove?.(row)}>
                      <Trash2 size={14} aria-hidden /> {t('acal.col.remove')}
                    </Button>,
                  ],
                }))}
              />
            )}
          </Card>

          <WeekCard model={model} actions={actions} dayName={dayName} held={manageHeld} busy={!!model.busy} />
        </div>
      </div>
      {dialog && <AddDialog draft={dialog} model={model} actions={actions} dateWords={dateWords} held={held} onChange={setDialog} onClose={() => setDialog(null)} />}
    </div>
  )
}

function Notices({ model, actions }: { model: CompanyCalendarsModel; actions?: CompanyCalendarsActions }) {
  const t = useT('admin-calendars')
  const tp = useT('planning-settings')
  return (
    <>
      {model.changedElsewhere && (
        <Banner
          tone="warning"
          title={t('acal.elsewhere.title')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('acal.elsewhere.reload')}
            </Button>
          }
        >
          {t('acal.elsewhere.body')}
        </Banner>
      )}
      {model.notice && (
        <Banner tone={model.notice.tone} onDismiss={actions?.onDismissNotice}>
          {model.notice.key.startsWith('ps.') ? tp(model.notice.key, model.notice.params) : t(model.notice.key, model.notice.params)}
        </Banner>
      )}
    </>
  )
}

function WeekCard({ model, actions, dayName, held, busy }: { model: CompanyCalendarsModel; actions?: CompanyCalendarsActions; dayName: (weekday: number) => string; held: string | null; busy: boolean }) {
  const t = useT('admin-calendars')
  const tp = useT('planning-settings')
  const read = model.calendar?.workingWeekdays ?? []
  const [draft, setDraft] = useState<number[]>(normalWeek(model.weekDraft ?? read))
  const readKey = read.join(',')
  useEffect(() => setDraft(normalWeek(model.weekDraft ?? read)), [readKey, model.weekDraft])
  const changed = weekChanged(read, draft)
  const pattern = model.calendar?.shiftPattern ?? null
  return (
    <Card header={t('acal.week.title')} description={t('acal.week.hint')} headingLevel={2} padded>
      {held ? (
        <KeyValue labelCase="sentence" items={[{ label: t('acal.week.days'), value: weekWords(read, dayName) || t('acal.week.none') }]} />
      ) : (
        <div className="fw-acal-week" role="group" aria-label={t('acal.week.days')}>
          {WEEKDAYS.map((weekday) => (
            <label key={weekday} className="fw-acal-weekday">
              <Toggle size="sm" checked={draft.includes(weekday)} aria-label={dayName(weekday)} onChange={(next) => setDraft((current) => normalWeek(next ? [...current, weekday] : current.filter((day) => day !== weekday)))} />
              <span>{dayName(weekday)}</span>
            </label>
          ))}
        </div>
      )}
      <KeyValue labelCase="sentence" items={[{ label: t('acal.pattern.label'), value: pattern ? pattern.name : t('acal.pattern.default') }]} />
      <p className="fw-acal-hint">
        {t('acal.pattern.where')}{' '}
        {model.calendar && <Link href={`${model.prefix}/planning/settings?tab=calendars&cal=${encodeURIComponent(model.calendar.id)}`}>{t('acal.pattern.link')}</Link>}
      </p>
      {held && <p className="fw-acal-hint">{held}</p>}
      {changed && !held && (
        <SaveBar
          count={1}
          busy={busy}
          held={weekHeld(draft) ? t(weekHeld(draft)!) : null}
          saveLabel={tp('ps.save.save')}
          onDiscard={() => setDraft(normalWeek(read))}
          onSave={() => void actions?.onSaveWeek?.(draft)}
        />
      )}
    </Card>
  )
}

function AddDialog({
  draft,
  model,
  actions,
  dateWords,
  held,
  onChange,
  onClose,
}: {
  draft: HolidayDraft
  model: CompanyCalendarsModel
  actions?: CompanyCalendarsActions
  dateWords: (date: string) => string
  held: string | null
  onChange: (draft: HolidayDraft) => void
  onClose: () => void
}) {
  const t = useT('admin-calendars')
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const set = (patch: Partial<HolidayDraft>) => onChange({ ...draft, ...patch, problem: null, ...('from' in patch || 'to' in patch ? { conflict: [] } : {}) })
  const reason = held ?? (draftHeld(draft) ? t(draftHeld(draft)!) : null)
  const replace = draft.conflict.length > 0
  const add = async () => {
    if (reason) return
    const outcome = await actions?.onAdd?.(draft, replace)
    if (!outcome) return
    if (outcome.ok) onClose()
    else onChange({ ...draft, problem: outcome.problem, conflict: outcome.conflict ?? draft.conflict })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('acal.add.title')}
      subtitle={t('acal.add.subtitle', { name: model.company.legalName })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('acal.add.cancel')}</Button>
          <Button variant="primary" heldReason={reason} onClick={() => void add()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {replace ? t('acal.add.replace', { count: draft.conflict.length }) : t('acal.add.go')}
          </Button>
        </>
      }
    >
      <div
        className="fw-acal-form"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void add()
          }
        }}
      >
        <Field label={t('acal.add.from')}>
          <DateField value={draft.from} onChange={(value) => set({ from: value })} locale={intl} placeholder={t('acal.add.datePlaceholder')} clearLabel={t('acal.add.clear')} />
        </Field>
        <Field label={t('acal.add.to')} hint={t('acal.add.toHint')}>
          <DateField value={draft.to} onChange={(value) => set({ to: value })} locale={intl} min={draft.from || undefined} placeholder={t('acal.add.datePlaceholder')} clearLabel={t('acal.add.clear')} />
        </Field>
        <Field label={t('acal.add.name')} hint={t('acal.add.nameHint')} className="fw-acal-form-wide">
          <Input value={draft.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} placeholder={t('acal.add.namePlaceholder')} />
        </Field>
        <Field label={t('acal.add.kind')} className="fw-acal-form-wide">
          <SegmentedControl
            size="sm"
            ariaLabel={t('acal.add.kind')}
            value={draft.kind}
            onChange={(value) => set({ kind: value === 'CLOSURE' ? 'CLOSURE' : 'HOLIDAY' })}
            options={[
              { value: 'HOLIDAY', label: t('acal.add.holiday') },
              { value: 'CLOSURE', label: t('acal.add.closure') },
            ]}
          />
        </Field>
        <p className="fw-acal-hint fw-acal-form-wide">{t('acal.add.capacity')}</p>
        {replace && (
          <Banner tone="warning" title={t('acal.add.conflictTitle', { count: draft.conflict.length })} className="fw-acal-form-wide">
            {draft.conflict.map(dateWords).join(' · ')}
          </Banner>
        )}
        {draft.problem && draft.problem !== 'acal.add.conflict' && (
          <Banner tone="danger" className="fw-acal-form-wide">
            {draft.problem.startsWith('ps.') ? <ProblemWords problem={draft.problem} /> : t(draft.problem)}
          </Banner>
        )}
      </div>
    </Modal>
  )
}

function ProblemWords({ problem }: { problem: string }) {
  const tp = useT('planning-settings')
  return <>{tp(problem)}</>
}
