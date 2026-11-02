'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { CalendarClock, ChevronLeft, ChevronRight, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu } from '@nexus/ui/components'
import { useCardList } from '@nexus/ui/grid/card-list/index'
import { Button, SegmentedControl, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { DateRangePicker } from '../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { isListKey } from '../../../../list-frame/model'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { KeysModal, LiveLine, PeoplePrivacyNote } from '../../_shared/parts'
import { TIME_ZONE } from '../../_shared/model'
import type { RosterDay } from '../api'
import { type CellRef, dayLong, dayOfInstant, localDate, OPTION_DEFAULT, optionOfCell, personRows, rangeText, valueWords, weekFrom } from '../model'
import type { ShiftsActions, ShiftsModel } from '../view-model'
import { OvertimePanel } from './OvertimePanel'
import { said, ShiftMessages, ShiftNotice, useShiftWords } from './parts'
import { RosterSheet, shiftKeys, shiftOptions } from './RosterSheet'
import { WhyWarning } from './ShiftCell'
import { ShiftDialogs } from './ShiftDialogs'

/**
 * SCR-263 — People › Shifts (design people.shifts): the band (range, freshness, Request overtime, Publish, Assign shifts, ⋯),
 * the privacy note said before any person is read, Range and people, the roster sheet, the overtime requests, their
 * pop-ups. Site from the top bar; with All sites a Site column and chip appear. Phone: one day at a time, a card per person.
 */
export function ShiftsView({ model, actions }: { model: ShiftsModel; actions?: ShiftsActions }) {
  return (
    <ShiftMessages>
      <Shifts model={model} {...(actions ? { actions } : {})} />
    </ShiftMessages>
  )
}

function Shifts({ model, actions }: { model: ShiftsModel; actions?: ShiftsActions }) {
  const t = useShiftWords()
  const locale = useLocale()
  const phone = useCardList()
  const [help, setHelp] = useState(false)
  /** The cells selected on the sheet: Assign starts from them. */
  const cells = useRef<readonly CellRef[]>([])
  const showHelp = model.help || help
  const openHelp = () => (actions ? actions.onHelp(true) : setHelp(true))

  // The page's own keys (a key on the sheet stays there; `?` is the list frame's).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isListKey(event, event.target as HTMLElement | null) || model.dialog || model.request) return
      if (event.key === '[') actions?.onMove(-1)
      else if (event.key === ']') actions?.onMove(1)
      else if (event.key === 'o' && model.can.overtime) actions?.onOvertime()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const roster = model.roster.status === 'ready' ? model.roster.value : null
  const days = useMemo<RosterDay[]>(() => {
    const out = new Map<string, RosterDay>()
    for (const site of roster?.sites ?? []) for (const day of site.days) out.set(day.date, out.get(day.date)?.open === false ? out.get(day.date)! : day)
    return [...out.values()]
  }, [roster])
  const absenceOff = roster?.sites.some((site) => !site.absences.shown) ?? false
  const editable = roster ? roster.canEdit !== 'NONE' : false
  const allSites = model.scope.allSites
  const publishHeld = !editable
    ? t('held.noEdit')
    : allSites
      ? t('held.pickSite')
      : model.drafts.blocked > 0
        ? t('held.blockedDrafts', { count: model.drafts.blocked })
        : model.drafts.drafts === 0
          ? t('held.noDrafts')
          : null
  const copyHeld = !editable ? t('held.noEdit') : allSites ? t('held.pickSite') : null
  const planning = `${model.prefix}/planning/settings`

  const more = [
    { id: 'copy', label: t('band.copy'), onSelect: () => actions?.onCopy(), ...(copyHeld ? { disabled: true, description: copyHeld } : {}) },
    { id: 'print', label: t('band.print'), href: printAddress(model), target: '_blank' as const },
    { id: 'export', label: t('band.export'), onSelect: () => actions?.onExport(), ...(roster ? {} : { disabled: true, description: t('held.notRead') }) },
    ...(model.can.planning ? [{ id: 'patterns', label: t('band.patterns'), href: planning }] : []),
    { id: 'keys', label: t('band.keys'), onSelect: openHelp },
  ]

  return (
    <div className="fw-pp fw-rs">
      <div className="fw-pp-head">
        <span className="fw-rs-status">
          <b>{rangeText(model.range, locale)}</b>
          <LiveLine asOf={model.asOf} live={model.live} />
          {model.elsewhere && (
            <Button size="sm" variant="tonal" onClick={() => actions?.onShowElsewhere()}>
              {t('band.elsewhere', { count: model.elsewhere.cells, time: formatTime(model.elsewhere.at, { locale, timeZone: TIME_ZONE }) })}
            </Button>
          )}
        </span>
        <span className="fw-pp-actions">
          {model.can.overtime && (
            <Button size="sm" variant="secondary" onClick={() => actions?.onOvertime()}>
              {t('band.overtime')}
            </Button>
          )}
          {editable && (
            <Button size="sm" variant="secondary" onClick={() => actions?.onPublish()} heldReason={publishHeld}>
              {model.drafts.drafts > 0 ? t('band.publishCount', { count: model.drafts.drafts }) : t('band.publish')}
            </Button>
          )}
          {editable && (
            <Button size="sm" variant="primary" onClick={() => actions?.onAssign(cells.current.length > 1 ? cells.current : [])}>
              {t('band.assign')}
            </Button>
          )}
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('band.more') }} items={more} />
        </span>
      </div>
      <PeoplePrivacyNote sight={model.sight} text={t('privacy.roster')} />
      <ShiftNotice notice={model.notice} onDismiss={actions?.onDismissNotice} />

      <section className="fw-rs-scope" aria-label={t('scope.title')}>
        <SegmentedControl
          size="sm"
          ariaLabel={t('scope.span')}
          value={model.range.custom ? '' : model.address.span}
          onChange={(value) => actions?.onSpan(value as 'week' | 'month')}
          options={[
            { value: 'week', label: t('scope.week') },
            { value: 'month', label: t('scope.month') },
          ]}
        />
        <span className="fw-pp-row">
          <Button size="sm" variant="quiet" aria-label={t('scope.previous')} onClick={() => actions?.onMove(-1)}>
            <ChevronLeft size={15} aria-hidden />
          </Button>
          <DateRangePicker
            value={{ start: localDate(model.range.from), end: localDate(model.range.to) }}
            onChange={(range) => actions?.onRange(dayOfInstant(range.start), dayOfInstant(range.end))}
            presets={[
              { label: t('scope.thisWeek'), get: () => weekFrom(model.today, 0) },
              { label: t('scope.nextWeek'), get: () => weekFrom(model.today, 7) },
            ]}
          />
          <Button size="sm" variant="quiet" aria-label={t('scope.next')} onClick={() => actions?.onMove(1)}>
            <ChevronRight size={15} aria-hidden />
          </Button>
          <Button size="sm" variant="quiet" onClick={() => actions?.onToday()}>
            {t('scope.today')}
          </Button>
        </span>
        <Select size="sm" aria-label={t('scope.line')} value={model.address.lineId ?? ''} onChange={(event) => actions?.onLine(event.target.value || null)}>
          <option value="">{t('scope.allLines')}</option>
          {model.lines.map((line) => (
            <option key={line.id} value={line.id}>
              {line.code} · {line.name}
            </option>
          ))}
        </Select>
        <Select size="sm" aria-label={t('scope.team')} value={model.address.teamId ?? ''} onChange={(event) => actions?.onTeam(event.target.value || null)}>
          <option value="">{t('scope.allTeams')}</option>
          {model.teams
            .filter((team) => !model.address.lineId || team.lineId === model.address.lineId)
            .map((team) => (
              <option key={team.id} value={team.id}>
                {team.code} · {team.name}
              </option>
            ))}
        </Select>
        <ScopeSiteChip model={model.scope} />
      </section>

      {absenceOff && <p className="fw-pp-hint">{t('scope.absencesOff')}</p>}

      {!model.can.view ? (
        <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('problem.forbidden')} description={t('problem.noPermission')} />
      ) : model.roster.status === 'loading' ? (
        <SheetSkeleton />
      ) : model.roster.status === 'error' ? (
        <Card padded>
          <EmptyState
            icon={<CalendarClock size={24} aria-hidden />}
            title={t('sheet.failed')}
            description={t(model.roster.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetryRead()}>
                {t('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : model.choices.length === 0 ? (
        <Card padded>
          <EmptyState
            icon={<CalendarClock size={24} aria-hidden />}
            title={t('sheet.noPatterns')}
            description={t('sheet.noPatternsBody')}
            {...(model.can.planning
              ? {
                  action: (
                    <Button size="sm" asChild>
                      <Link href={planning}>{t('band.patterns')}</Link>
                    </Button>
                  ),
                }
              : {})}
          />
        </Card>
      ) : personRows(model.rows).length === 0 ? (
        <Card padded>
          <EmptyState icon={<CalendarClock size={24} aria-hidden />} title={t('sheet.nobody')} description={t('sheet.nobodyBody')} />
        </Card>
      ) : phone ? (
        <RosterPhone model={model} actions={actions} />
      ) : (
        <RosterSheet model={model} actions={actions} days={days} onHelp={openHelp} onCells={(next) => (cells.current = next)} />
      )}

      {model.can.view && <OvertimePanel model={model} actions={actions} onHelp={openHelp} />}

      <ShiftDialogs model={model} actions={actions} />
      {showHelp && <KeysModal own={shiftKeys(t, model.choices)} onClose={() => (actions ? actions.onHelp(false) : setHelp(false))} />}
    </div>
  )
}

function printAddress(model: ShiftsModel): string {
  const terms = new URLSearchParams({ from: model.range.from, to: model.range.to })
  if (model.address.lineId) terms.set('line', model.address.lineId)
  if (model.address.teamId) terms.set('team', model.address.teamId)
  return `${model.prefix}/people/shifts/print?${terms.toString()}`
}

/** First load: the sheet's shape, with the "still loading" note after about a second. */
function SheetSkeleton() {
  const t = useShiftWords()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <Card padded aria-busy="true">
      <div className="fw-pp-stack tight">
        {Array.from({ length: 7 }, (_, index) => (
          <Skeleton key={index} height={28} />
        ))}
        {slow && (
          <p className="fw-pp-hint" role="status">
            <Spinner size={14} /> {t('sheet.slow')}
          </p>
        )}
      </div>
    </Card>
  )
}

/** A phone: one day of the range, a card per person, a list for the shift (no sheet sideways). */
function RosterPhone({ model, actions }: { model: ShiftsModel; actions?: ShiftsActions | undefined }) {
  const t = useShiftWords()
  const locale = useLocale()
  const options = useMemo(() => shiftOptions(model.choices, t), [model.choices, t])
  const first = model.dates.includes(model.today) ? model.today : model.dates[0]!
  const [day, setDay] = useState(first)
  const date = model.dates.includes(day) ? day : first
  const at = model.dates.indexOf(date)
  const people = personRows(model.rows)
  return (
    <div className="fw-rs-phone">
      <div className="fw-pp-row fw-rs-phone-day">
        <Button size="sm" variant="quiet" aria-label={t('scope.previousDay')} heldReason={at > 0 ? null : t('held.firstDay')} onClick={() => setDay(model.dates[at - 1]!)}>
          <ChevronLeft size={15} aria-hidden />
        </Button>
        <b>{dayLong(date, locale)}</b>
        <Button size="sm" variant="quiet" aria-label={t('scope.nextDay')} heldReason={at < model.dates.length - 1 ? null : t('held.lastDay')} onClick={() => setDay(model.dates[at + 1]!)}>
          <ChevronRight size={15} aria-hidden />
        </Button>
      </div>
      <p className="fw-pp-hint">{t('sheet.people', { count: people.length })}</p>
      <ul className="fw-rs-phone-list" aria-label={t('sheet.label')}>
        {people.map((row) => {
          const cell = row.cells[date]
          if (!cell) return null
          return (
            <li key={row.id} className="fw-rs-phone-card">
              <div>
                <b>{row.row.name}</b>
                <p className="fw-pp-hint">
                  {[row.row.line?.code, row.row.team?.code].filter(Boolean).join(' › ')}
                  {row.row.canEdit ? ` · ${said(t, valueWords(cell.value))}` : ''}
                </p>
              </div>
              {row.row.canEdit ? (
                <Select size="sm" aria-label={t('sheet.setFor', { name: row.row.name })} value={optionOfCell(cell)} onChange={(event) => actions?.onSetOption(event.target.value, [{ employeeId: row.row.employeeId, date }])}>
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.value === OPTION_DEFAULT && cell.fallback ? t('cell.defaultIs', { shift: said(t, valueWords(cell.fallback)) }) : option.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <span>{said(t, valueWords(cell.value))}</span>
              )}
              {cell.warnings.length > 0 && <WhyWarning warnings={cell.warnings} />}
            </li>
          )
        })}
      </ul>
      {model.save.kind === 'failed' && <Banner tone="danger" title={t('sheet.notSaved', { count: model.save.count ?? 1 })} />}
    </div>
  )
}
