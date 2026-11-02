'use client'

import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, MoreHorizontal, ShieldOff } from 'lucide-react'
import { EmptyState, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { Button, Pill, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import { isListKey } from '../../../../list-frame/model'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { hoursText } from '../../_shared/model'
import { KeysModal, LiveLine } from '../../_shared/parts'
import type { DayRow } from '../api'
import { monthWords, movedMonth, seesThePage } from '../model'
import type { AttendanceActions, AttendanceModel } from '../view-model'
import { ClosePanel } from './ClosePanel'
import { DayDetail } from './DayDetail'
import { dayKeys, DaysPanel } from './DaysPanel'
import { EntryDetail } from './EntryDetail'
import { OvertimePanel } from './OvertimePanel'
import { PageDialogs } from './PageDialogs'
import { AttendanceMessages, AttendanceNotice, AttendancePrivacyNote, GateHeld, useAttendanceWords } from './parts'
import { TimesheetsPanel } from './TimesheetsPanel'
import { WhoPanel } from './WhoPanel'

/**
 * SCR-157 — People › Attendance (design people.attendance): the legal text first, then the band (the month and its state, Who
 * is in now, Approve N clean days, ⋯), Period and team, the tiles of what blocks the close, Days, Overtime to approve,
 * Timesheets, Month close, Who is in now and the pop-ups. Site from the top bar: the API reads one site at a time, each with
 * its own gate, so "All sites" asks for a site. With the gate shut the page says why and shows nothing of a person.
 */
export function AttendanceView({ model, actions }: { model: AttendanceModel; actions?: AttendanceActions }) {
  return (
    <AttendanceMessages>
      <Attendance model={model} actions={actions} />
    </AttendanceMessages>
  )
}

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

function Attendance({ model, actions }: { model: AttendanceModel; actions?: AttendanceActions | undefined }) {
  const t = useAttendanceWords()
  const locale = useLocale()
  const [help, setHelp] = useState(false)
  const showHelp = model.help || help
  const openHelp = () => (actions ? actions.onHelp(true) : setHelp(true))
  const { can, gate, tiles } = model
  const rollCallHref = `${model.prefix}/people/attendance/roll-call`
  const rows = model.days.items
  const blocked = model.dialog || model.day || model.entry

  // The page's keys: [ ] month, r roll call; a / e on the focused row (the frame has j k x).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (!isListKey(event, target) || blocked || gate !== 'open') return
      const row = (): DayRow | null => {
        const id = target?.closest?.('[row-id]')?.getAttribute('row-id') ?? null
        return rows?.find((entry) => entry.id === id) ?? null
      }
      if (event.key === '[') actions?.onMonth(movedMonth(model.month, -1))
      else if (event.key === ']') actions?.onMonth(movedMonth(model.month, 1))
      else if (event.key === 'r' && can.rollCall) window.open(rollCallHref, '_blank', 'noopener')
      else if (event.key === 'a' && can.approve && row()) actions?.onApproveFocused(row()!)
      else if (event.key === 'e' && row()) actions?.onFixFocused(row()!)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const month = monthWords(model.month, locale)
  const panelValue = model.panel.status === 'ready' ? model.panel.value : null
  const closed = panelValue?.state === 'CLOSED'
  const clean = tiles.days?.tiles.cleanDaysToApprove ?? null
  const approveHeld = !can.approve ? t('held.noApprove') : closed ? t('held.closed') : model.approving ? t('held.working') : clean === 0 ? t('held.noneClean') : null
  const closeMenu = can.close && gate === 'open' && panelValue && !closed
  const more = [
    ...(can.manage && gate === 'open' ? [{ id: 'manual', label: t('band.manual'), onSelect: () => actions?.onManual() }] : []),
    ...(closeMenu ? [{ id: 'close', label: t('band.close'), onSelect: () => scrollTo('fw-at-close') }] : []),
    ...(panelValue?.actions.openLul && panelValue.closeId ? [{ id: 'lul', label: t('band.lul'), href: `${model.prefix}/people/attendance/lul?close=${encodeURIComponent(panelValue.closeId)}`, target: '_blank' as const }] : []),
    ...(can.view && gate === 'open' ? [{ id: 'export', label: t('band.export'), onSelect: () => actions?.onExport(), ...(rows ? {} : { disabled: true, description: t('held.notRead') }) }] : []),
    ...(can.rollCall && gate === 'open' ? [{ id: 'roll', label: t('who.rollCall'), href: rollCallHref, target: '_blank' as const }] : []),
    { id: 'keys', label: t('band.keys'), onSelect: openHelp },
  ]

  if (!seesThePage(can)) {
    return (
      <div className="fw-pp fw-at">
        <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('problem.forbidden')} description={t('problem.noPermission')} />
      </div>
    )
  }

  return (
    <div className="fw-pp fw-at">
      <AttendancePrivacyNote gate={gate} can={can} />

      <div className="fw-pp-head">
        <span className="fw-at-status">
          <b>{month}</b>
          {panelValue && (
            <Pill tone={closed ? 'success' : 'info'} dot>
              {t(`monthState.${panelValue.state}`)}
            </Pill>
          )}
          {gate === 'open' && <LiveLine asOf={model.asOf} live={model.live} />}
        </span>
        <span className="fw-pp-actions">
          {gate === 'open' && (
            <Button size="sm" variant="secondary" onClick={() => scrollTo('fw-at-who')}>
              {t('band.who')}
            </Button>
          )}
          {gate === 'open' && can.view && (
            <Button size="sm" variant="primary" onClick={() => actions?.onApproveClean()} heldReason={approveHeld}>
              {clean === null ? t('band.approveClean') : t('band.approveCleanCount', { count: clean })}
            </Button>
          )}
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('band.more') }} items={more} />
        </span>
      </div>

      <AttendanceNotice notice={model.notice} onDismiss={actions?.onDismissNotice} />

      {gate === 'reading' ? (
        <Reading />
      ) : gate !== 'open' ? (
        <GateHeld gate={gate} prefix={model.prefix} can={can} />
      ) : (
        <>
          <Scope model={model} actions={actions} />
          {can.view && <Tiles model={model} actions={actions} />}
          {can.view && <DaysPanel model={model} actions={actions} onHelp={openHelp} />}
          {can.view && <OvertimePanel model={model} actions={actions} onHelp={openHelp} />}
          <TimesheetsPanel model={model} actions={actions} onHelp={openHelp} />
          <div className="fw-at-pair">
            <ClosePanel model={model} actions={actions} />
            <WhoPanel model={model} actions={actions} />
          </div>
        </>
      )}

      {model.day && (
        <DayDetail
          state={model.day}
          actions={actions?.day}
          prefix={model.prefix}
          ids={(rows ?? []).map((row) => row.id)}
          now={model.now}
          codes={model.codes}
          canPeople={can.people}
          canCorrect={can.correct}
          onGo={(id) => actions?.onOpenDay(id)}
          onClose={() => actions?.onOpenDay(null)}
        />
      )}
      {model.entry && <EntryDetail state={model.entry} ids={(model.overtime.items ?? []).map((row) => row.id)} prefix={model.prefix} actions={actions} canPeople={can.people} />}
      <PageDialogs model={model} actions={actions} />
      {showHelp && <KeysModal own={dayKeys(t)} onClose={() => (actions ? actions.onHelp(false) : setHelp(false))} />}
    </div>
  )
}

/** Period and team: ‹ month ›, today's month, the Team and Line lists, the top bar's site. */
function Scope({ model, actions }: { model: AttendanceModel; actions?: AttendanceActions | undefined }) {
  const t = useAttendanceWords()
  const locale = useLocale()
  const teams = model.teams.filter((team) => !model.address.lineId || team.lineId === model.address.lineId)
  return (
    <section className="fw-at-scope" aria-label={t('scope.title')}>
      <span className="fw-pp-row">
        <Button size="sm" variant="quiet" aria-label={t('scope.previous')} onClick={() => actions?.onMonth(movedMonth(model.month, -1))}>
          <ChevronLeft size={15} aria-hidden />
        </Button>
        <b className="fw-at-month">{monthWords(model.month, locale)}</b>
        <Button size="sm" variant="quiet" aria-label={t('scope.next')} onClick={() => actions?.onMonth(movedMonth(model.month, 1))}>
          <ChevronRight size={15} aria-hidden />
        </Button>
        {model.address.month && (
          <Button size="sm" variant="quiet" onClick={() => actions?.onMonth(null)}>
            {t('scope.thisMonth')}
          </Button>
        )}
      </span>
      {model.can.view && (
        <>
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
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.code} · {team.name}
              </option>
            ))}
          </Select>
        </>
      )}
      <ScopeSiteChip model={model.scope} />
    </section>
  )
}

/** What blocks the month close. Too few people in the selection: no figure at all (ANA-075), and it says so. */
function Tiles({ model, actions }: { model: AttendanceModel; actions?: AttendanceActions | undefined }) {
  const t = useAttendanceWords()
  const locale = useLocale()
  const { tiles, address } = model
  if (tiles.problem) {
    return (
      <p className="fw-pp-hint fw-pp-row" role="status">
        {t('tile.failed')}
        <Button size="sm" variant="quiet" onClick={() => actions?.onRetryDays()}>
          {t('common.retry')}
        </Button>
      </p>
    )
  }
  if (!tiles.days) {
    return (
      <div className="fw-pp-row" aria-busy="true">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} width={170} height={64} />
        ))}
      </div>
    )
  }
  const value = (figure: number | null) => (figure === null ? '—' : String(figure))
  const hours = tiles.entries?.tiles.waitingMinutes ?? null
  const hint = tiles.days.tooFew ? t('tile.tooFew') : undefined
  const tile = (id: 'ANOMALIES' | 'TO_APPROVE' | 'NO_CODE', figure: number | null): Metric => ({
    label: t(`tile.${id}.label`),
    value: value(figure),
    ...(hint ? { hint } : {}),
    active: address.tile === id,
    onClick: () => actions?.onTile(address.tile === id ? null : id),
  })
  return (
    <MetricStrip
      metrics={[
        tile('ANOMALIES', tiles.days.tiles.openAnomalies),
        tile('TO_APPROVE', tiles.days.tiles.daysToApprove),
        { label: t('tile.overtime.label'), value: hours === null ? '—' : (hoursText(hours, locale) ?? '0'), ...(tiles.entries?.tooFew ? { hint: t('tile.tooFew') } : {}), onClick: () => scrollTo('fw-at-overtime') },
        tile('NO_CODE', tiles.days.tiles.absencesWithoutCode),
        { label: t('tile.clockedIn.label'), value: value(tiles.days.tiles.clockedInNow), ...(hint ? { hint } : {}), onClick: () => scrollTo('fw-at-who') },
      ]}
    />
  )
}

function Reading() {
  const t = useAttendanceWords()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-pp-stack tight" aria-busy="true">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} height={28} />
      ))}
      {slow && (
        <p className="fw-pp-hint" role="status">
          <Spinner size={14} /> {t('gate.reading')}
        </p>
      )}
    </div>
  )
}

