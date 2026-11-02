'use client'

import { Hand, UsersRound } from 'lucide-react'
import { FloorElapsed } from '@nexus/ui/floor/FloorElapsed/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { TaskLine } from '../../shared/view/TaskParts'
import { wordOf, type PickerReason } from '../../reasons/model'
import { barOf, clockOf, type Timing } from '../timing'

/**
 * SCR-090 "Start, pause, finish": the bundle's own clock at numeral size (DS FloorElapsed; a screen reader hears it once a
 * minute), frozen with its reason while paused, the pieces said so far and a team's size. Never a pace or a target
 * (Statuto dei Lavoratori art. 4): only the time this bundle has taken so far. Another person's open work has no clock
 * here and no name: "another person, your team leader can see who".
 */
export function TimingPanel({ timing, skewMs, reasons }: { timing: Timing | null; skewMs: number; reasons: readonly PickerReason[] }) {
  const t = useT('floor-scans')
  const locale = useLocale()
  const labels = useDsWords().floorElapsed
  if (!timing) return null
  const bar = barOf(timing)
  const pieces = timing.piecesSoFar > 0 ? <p className="fw-floor-muted">{t('timing.piecesSoFar', { count: timing.piecesSoFar })}</p> : null
  if (bar === 'other' && (timing.state === 'RUNNING' || timing.state === 'PAUSED')) {
    return (
      <TaskLine tone="info" icon={<Hand />}>
        {t('timing.other')}
      </TaskLine>
    )
  }
  if (bar !== 'running' && bar !== 'paused') return pieces
  const clock = clockOf(timing, skewMs)
  const reason = timing.pauseReasonCode ? reasons.find((entry) => entry.code === timing.pauseReasonCode) : null
  const why = timing.pausedAtClockOut ? t('timing.pausedAtClockOut') : reason ? wordOf(reason, locale) : null
  return (
    <section className="fw-scans-clock" data-state={bar} aria-label={t('timing.title')}>
      <FloorElapsed label={t(bar === 'running' ? 'timing.running' : 'timing.paused')} since={clock.since} carriedMs={clock.carriedMs} paused={clock.paused} labels={labels} />
      {bar === 'paused' && why ? <p className="fw-scans-clock-why">{why}</p> : null}
      {pieces}
      {timing.people > 1 ? (
        <p className="fw-floor-muted">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            <UsersRound />
          </span>
          {t('timing.team', { count: timing.people })}
        </p>
      ) : null}
    </section>
  )
}
