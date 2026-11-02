'use client'

import { useEffect, useState } from 'react'
import { AlertOctagon, Bell, Check, CircleAlert, Hourglass, MonitorOff, Monitor, TrendingDown, TrendingUp, UserCheck, WifiOff, Minus, type LucideIcon } from 'lucide-react'
import { displayDensityAttrs } from '@nexus/ui/tokens/density'
import { formatNumber, formatTime } from '../../i18n/format'
import { useLocale, useT } from '../../i18n/provider'
import { BOARD_VIEWS, boardNoteLines, hourBars, reasonWords, waitingOperations, type BoardProblem, type HourBar } from '../model'
import type { BoardOperation, BoardStation, LineBoard } from '../schema'
import '../line-board.css'

/** SCR-173 — the line TV's view model: the one board, from the device's read or the Office's preview. */
export interface LineBoardModel {
  readonly board: LineBoard | null
  /** Why no board is drawn; `offline` with a board: it keeps the last one. */
  readonly problem: BoardProblem | null
  /** The view on the wall (BOARD_VIEWS' index). */
  readonly view: number
  /** The time the board last read well, while it has not for a minute (the amber band). */
  readonly staleSince: string | null
  /** Design cases: the clock stands still at this time. */
  readonly clockAt?: string
  /** The Office's preview: the board fills its window, not the whole screen. */
  readonly preview?: boolean
}

const STATE_ICON: Readonly<Record<BoardStation['state'], LucideIcon>> = { MACHINE_DOWN: AlertOctagon, CALLING: Bell, COMING: UserCheck, CLEAR: Check }
const PACE_ICON: Readonly<Record<LineBoard['output']['pace'], LucideIcon>> = { ON_PACE: TrendingUp, BEHIND: TrendingDown, NO_TARGET: Minus }
const PROBLEM_ICON: Readonly<Record<BoardProblem, LucideIcon>> = { notABoard: Monitor, noLine: MonitorOff, noAccess: CircleAlert, signedOut: MonitorOff, offline: WifiOff }

/**
 * SCR-173 — the line TV board (design floor.display; ANA-007, MES-147, MES-166; Owner answer F2): read-only, nobody signed
 * in, on the display tier. The line, its shift, a big clock, the time of the last read and "View 1 of 3"; then one of three
 * views turning every 20 seconds (reduced motion cuts instead of sliding): the output today (two huge numbers, the hour
 * bars with the hourly target as a line, a short hour's reason code), the stations (colour, shape and word; no names, no
 * output per station), the work in progress with the DHU and the team leader's note (hidden when there is none; never a
 * ticker). A board that has not read well for a minute says so in an amber band. Composed here: the DS has no DisplayBoard;
 * and its PerformanceGraph draws 11 px axes, no use on a wall.
 */
export function LineBoardView({ model }: { model: LineBoardModel }) {
  const t = useT('line-board')
  const board = model.board
  if (!board) return <BoardState problem={model.problem} preview={model.preview} />
  const name = BOARD_VIEWS[model.view] ?? 'output'
  return (
    <section className={model.preview ? 'fw-lb is-preview' : 'fw-lb'} aria-label={t('title', { line: board.line.name })} {...displayDensityAttrs()}>
      <BoardHead board={board} view={model.view} clockAt={model.clockAt} />
      {model.staleSince && <StaleBand since={model.staleSince} timeZone={board.site.timeZone} />}
      <div className="fw-lb-stage" key={name}>
        {name === 'output' && <OutputView board={board} />}
        {name === 'stations' && <StationsView board={board} />}
        {name === 'wip' && <WipView board={board} />}
      </div>
    </section>
  )
}

function BoardHead({ board, view, clockAt }: { board: LineBoard; view: number; clockAt?: string }) {
  const t = useT('line-board')
  const locale = useLocale()
  const updated = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { timeZone: board.site.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(board.asOf))
  return (
    <header className="fw-lb-head">
      <div className="fw-lb-names">
        <h1 className="fw-lb-line">
          {board.line.code} · {board.line.name}
        </h1>
        <p className="fw-lb-meta">
          {board.shift?.label ? <span>{t('shift', { shift: board.shift.label })}</span> : <span>{t('noShift')}</span>}
          <span>{t('updated', { time: updated })}</span>
          <span>{t('viewOf', { view: view + 1, count: BOARD_VIEWS.length })}</span>
        </p>
      </div>
      <BigClock timeZone={board.site.timeZone} at={clockAt} />
    </header>
  )
}

/** The wall's clock, in the site's time; it re-draws itself alone, so the board never does for it. */
function BigClock({ timeZone, at }: { timeZone: string; at?: string }) {
  const locale = useLocale()
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    if (at) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [at])
  const shown = at ?? now
  return <time className="fw-lb-clock">{shown === null ? '–' : formatTime(shown, { locale, timeZone })}</time>
}

function StaleBand({ since, timeZone }: { since: string; timeZone: string }) {
  const t = useT('line-board')
  const locale = useLocale()
  return (
    <p className="fw-lb-stale" role="status">
      <WifiOff aria-hidden="true" />
      {t('stale', { time: formatTime(since, { locale, timeZone }) })}
    </p>
  )
}

function OutputView({ board }: { board: LineBoard }) {
  const t = useT('line-board')
  const locale = useLocale()
  const output = board.output
  const Pace = PACE_ICON[output.pace]
  const bars = hourBars(output.hours)
  const shortWords = bars.filter((bar) => bar.short && bar.reason)
  return (
    <div className="fw-lb-output">
      <section className="fw-lb-figures" aria-label={t('output.title')}>
        <h2 className="fw-lb-h2">{t('output.title')}</h2>
        <p className="fw-lb-huge">
          <span className="fw-lb-done">{formatNumber(output.done, locale)}</span>
          <span className="fw-lb-of">/ {output.target === null ? '—' : formatNumber(output.target, locale)}</span>
        </p>
        <p className="fw-lb-label">{output.target === null ? t('output.doneNoTarget') : t('output.doneOfTarget')}</p>
        <p className="fw-lb-pace" data-tone={output.paceLook.tone}>
          <Pace aria-hidden="true" />
          {t(`pace.${output.pace}`)}
        </p>
        {output.targetSoFar !== null && <p className="fw-lb-label">{t('output.soFar', { count: output.targetSoFar })}</p>}
      </section>
      <section className="fw-lb-hours" aria-label={t('output.hours')}>
        {bars.length === 0 ? <p className="fw-lb-label">{t('output.noHours')}</p> : <HourBars bars={bars} />}
        {bars.some((bar) => bar.target !== null) && (
          <p className="fw-lb-legend">
            <span className="fw-lb-legend-line" aria-hidden="true" />
            {t('output.hourlyTarget')}
          </p>
        )}
        {shortWords.length > 0 && (
          <ul className="fw-lb-reasons">
            {shortWords.slice(-3).map((bar) => (
              <li key={bar.hour}>
                <span className="fw-lb-reason-hour">{bar.label}</span> {reasonWords(bar.reason!, locale)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function HourBars({ bars }: { bars: readonly HourBar[] }) {
  const t = useT('line-board')
  const locale = useLocale()
  return (
    <ol className="fw-lb-bars">
      {bars.map((bar) => {
        const words = bar.target === null ? t('output.hourNoTarget', { hour: bar.label, done: bar.done }) : t(bar.short ? 'output.hourShort' : 'output.hour', { hour: bar.label, done: bar.done, target: bar.target })
        return (
          <li key={bar.hour} className="fw-lb-bar" data-state={bar.state} data-short={bar.short || undefined} aria-label={words}>
            <span className="fw-lb-bar-plot" aria-hidden="true">
              {bar.state !== 'LATER' && <span className="fw-lb-bar-fill" style={{ height: `${bar.donePct}%` }} />}
              {bar.targetPct !== null && <span className="fw-lb-bar-target" style={{ bottom: `${bar.targetPct}%` }} />}
              {bar.state !== 'LATER' && (
                <span className="fw-lb-bar-value" style={{ bottom: `${bar.donePct}%` }}>
                  {formatNumber(bar.done, locale)}
                </span>
              )}
            </span>
            <span className="fw-lb-bar-tick" aria-hidden="true">
              {bar.tick}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function StationsView({ board }: { board: LineBoard }) {
  const t = useT('line-board')
  return (
    <section className="fw-lb-section" aria-label={t('stations.title')}>
      <h2 className="fw-lb-h2">{t('stations.title')}</h2>
      {board.stations.length === 0 ? (
        <p className="fw-lb-label">{t('stations.none')}</p>
      ) : (
        <ul className="fw-lb-stations" data-many={board.stations.length > 12 || undefined}>
          {board.stations.map((station) => (
            <StationTile key={station.id} station={station} />
          ))}
        </ul>
      )}
    </section>
  )
}

function StationTile({ station }: { station: BoardStation }) {
  const t = useT('line-board')
  const Icon = STATE_ICON[station.state]
  return (
    <li className="fw-lb-station" data-tone={station.look.tone}>
      <span className="fw-lb-shape" data-shape={station.look.shape}>
        <Icon aria-hidden="true" />
      </span>
      <span className="fw-lb-station-text">
        <span className="fw-lb-station-code">{station.code}</span>
        <span className="fw-lb-station-word">
          {t(`stations.state.${station.state}`)}
          {station.state === 'CALLING' && station.material ? ` · ${t('stations.material')}` : ''}
        </span>
      </span>
    </li>
  )
}

function WipView({ board }: { board: LineBoard }) {
  const t = useT('line-board')
  const locale = useLocale()
  const waiting = waitingOperations(board.wip.operations)
  const note = board.note ? boardNoteLines(board.note) : null
  return (
    <div className="fw-lb-wip">
      <section className="fw-lb-section" aria-label={t('wip.title')}>
        <h2 className="fw-lb-h2">{t('wip.title')}</h2>
        <p className="fw-lb-wip-totals">
          <span className="fw-lb-wip-total">
            <span className="fw-lb-numeral">{formatNumber(board.wip.bundles, locale)}</span> {t('wip.bundles', { count: board.wip.bundles })}
          </span>
          <span className="fw-lb-wip-total" data-tone={board.wip.stuck > 0 ? 'warning' : undefined}>
            {board.wip.stuck > 0 && <Hourglass aria-hidden="true" />}
            <span className="fw-lb-numeral">{formatNumber(board.wip.stuck, locale)}</span> {t('wip.stuck', { count: board.wip.stuck })}
          </span>
        </p>
        {waiting.length === 0 ? (
          <p className="fw-lb-label">{t('wip.none')}</p>
        ) : (
          <ul className="fw-lb-ops">
            {waiting.slice(0, 6).map((operation) => (
              <OperationRow key={operation.code} operation={operation} />
            ))}
          </ul>
        )}
      </section>
      <div className="fw-lb-side">
        <section className="fw-lb-section" aria-label={t('quality.title')}>
          <h2 className="fw-lb-h2">{t('quality.title')}</h2>
          <p className="fw-lb-dhu">
            <span className="fw-lb-numeral">{board.quality.dhu ?? '—'}</span> <span className="fw-lb-label">{t('quality.dhu')}</span>
          </p>
          <p className="fw-lb-label">{board.quality.dhu === null ? t('quality.none') : t('quality.counts', { count: board.quality.defects, units: board.quality.units })}</p>
        </section>
        {board.note && note && (
          <section className="fw-lb-section" aria-label={t('note.title')}>
            <h2 className="fw-lb-h2">{t('note.title')}</h2>
            {note.topics.length > 0 && <p className="fw-lb-label">{note.topics.map((topic) => t(`note.topic.${topic}`)).join(' · ')}</p>}
            {note.text && <p className="fw-lb-note">{note.text}</p>}
          </section>
        )}
      </div>
    </div>
  )
}

function OperationRow({ operation }: { operation: BoardOperation }) {
  const t = useT('line-board')
  return (
    <li className="fw-lb-op" data-level={operation.level}>
      <span className="fw-lb-op-name">{operation.name}</span>
      <span className="fw-lb-op-count">{t('wip.opBundles', { count: operation.bundles })}</span>
      {operation.pile && <span className="fw-lb-op-word">{t('wip.pile')}</span>}
      {operation.stuck > 0 && <span className="fw-lb-op-word">{t('wip.opStuck', { count: operation.stuck })}</span>}
    </li>
  )
}

/** No board to draw: why in words, on the same tier; the wall says it keeps trying. */
function BoardState({ problem, preview }: { problem: BoardProblem | null; preview?: boolean }) {
  const t = useT('line-board')
  const key = problem ?? 'loading'
  const Icon = problem ? PROBLEM_ICON[problem] : Monitor
  return (
    <section className={preview ? 'fw-lb fw-lb-state is-preview' : 'fw-lb fw-lb-state'} aria-busy={problem ? undefined : true} role={problem ? 'alert' : undefined} {...displayDensityAttrs()}>
      <Icon aria-hidden="true" />
      <h1 className="fw-lb-state-title">{t(`state.${key}.title`)}</h1>
      <p className="fw-lb-label">{t(`state.${key}.body`)}</p>
    </section>
  )
}
