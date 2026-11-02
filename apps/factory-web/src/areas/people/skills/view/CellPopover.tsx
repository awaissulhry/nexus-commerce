'use client'

import { Spinner, Button } from '@nexus/ui/primitives'
import { Banner } from '@nexus/ui/components'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import type { CellDetail, SkillLevel } from '../api'
import { historyAction, historyLevel, isTrainee, SKILL_LEVELS, TIME_ZONE, type CellRef } from '../model'
import type { SkillProblem } from '../use-skill-dialogs'
import { LevelMark, MachineMark } from './cells'
import { useProblemWords, useSkillWords } from './SkillDialogs'

export interface CellPopoverActions {
  onLevel?: (level: SkillLevel) => void
  onTrainee?: () => void
  onSignOff?: () => void
  onRemove?: () => void
  onAuthorise?: () => void
  onValidUntil?: () => void
  onRevoke?: () => void
}

export type CellState = { cell: CellRef; title: string; detail: CellDetail | null; problem: SkillProblem | null }

/**
 * Cell detail (SCR-160 pop:cell; the DS DetailPopover around it is the cell's own, so it opens by Enter or a click and Esc
 * goes back to the cell): what stands now, who decided it and when, the actions in reach, the history from the audit log.
 * The certificate and the next due date join with the training columns (W2b-2).
 */
export function CellPopoverBody({ state, actions, onClose }: { state: CellState; actions?: CellPopoverActions; onClose?: () => void }) {
  const t = useSkillWords()
  const locale = useLocale()
  const say = useProblemWords()
  const place = { locale, timeZone: TIME_ZONE }
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, place)
  const { cell, detail, problem } = state
  const run = (act?: () => void) => () => {
    onClose?.()
    act?.()
  }
  if (problem) return <div className="fw-sk-pop"><Banner tone="danger" title={say(problem) ?? ''} /></div>
  if (!detail) {
    return (
      <div className="fw-sk-pop">
        <p className="fw-sk-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      </div>
    )
  }
  const level = detail.levels.find((row) => row.removedAt === null) ?? null
  const authorisation = detail.authorisations.find((row) => row.revokedAt === null) ?? null
  const heldLevels = detail.canManage ? null : t('held.noManage')
  const heldMachine = detail.canAuthorise ? null : t('held.noAuthorise')
  return (
    <div className="fw-sk-pop">
      <h3 className="fw-sk-pop-title">{state.title}</h3>
      <p className="fw-sk-pop-person">{detail.employee.name}</p>
      {cell.kind === 'skill' ? (
        <>
          <p>
            <LevelMark level={level?.level ?? null} trainee={level?.trainee ?? 'NONE'} />
          </p>
          {level && (
            <ul className="fw-sk-plain">
              <li>{t('cell.since', { date: day(level.since) })}</li>
              <li>{t('cell.assessed', { name: level.assessedBy ?? t('common.unknown'), date: formatDate(level.assessedAt, place) })}</li>
              {level.traineeUntil && <li>{t(level.signedOffOn ? 'cell.traineeWas' : 'cell.traineeUntil', { date: day(level.traineeUntil) })}</li>}
              {level.signedOffOn && <li>{t('cell.signedOff', { name: level.signedOffBy ?? t('common.unknown'), date: day(level.signedOffOn), trainer: level.trainer?.name ?? t('signOff.outside') })}</li>}
            </ul>
          )}
          <div className="fw-sk-levels" role="group" aria-label={t('cell.setLevel')}>
            {SKILL_LEVELS.map((entry, index) => (
              <Button key={entry} size="sm" variant={level?.level === entry ? 'primary' : 'secondary'} heldReason={heldLevels} aria-pressed={level?.level === entry} onClick={run(() => actions?.onLevel?.(entry))}>
                {index + 1} · {t(`level.${entry}`)}
              </Button>
            ))}
          </div>
          <span className="fw-sk-row">
            {level && isTrainee(level.trainee) && (
              <Button size="sm" variant="primary" heldReason={heldLevels} onClick={run(actions?.onSignOff)}>
                {t('cell.signOff')}
              </Button>
            )}
            {(!level || !level.signedOffOn) && (
              <Button size="sm" heldReason={heldLevels} onClick={run(actions?.onTrainee)}>
                {t(level?.traineeUntil ? 'cell.moveTrainee' : 'cell.makeTrainee')}
              </Button>
            )}
            {level && (
              <Button size="sm" variant="quiet" heldReason={heldLevels} onClick={run(actions?.onRemove)}>
                {t('cell.remove')}
              </Button>
            )}
          </span>
        </>
      ) : (
        <>
          <p>
            <MachineMark state={authorisation?.state ?? null} />
          </p>
          {authorisation && (
            <ul className="fw-sk-plain">
              <li>{t('cell.authorised', { name: authorisation.authorisedBy ?? t('common.unknown'), date: day(authorisation.authorisedOn) })}</li>
              <li>{authorisation.validUntil ? t('cell.validUntil', { date: day(authorisation.validUntil) }) : t('cell.noEnd')}</li>
            </ul>
          )}
          <span className="fw-sk-row">
            {(!authorisation || authorisation.state === 'EXPIRED') && (
              <Button size="sm" variant="primary" heldReason={heldMachine} onClick={run(actions?.onAuthorise)}>
                {t('cell.authorise')}
              </Button>
            )}
            {authorisation && authorisation.state !== 'EXPIRED' && (
              <Button size="sm" heldReason={heldMachine} onClick={run(actions?.onValidUntil)}>
                {t('cell.changeUntil')}
              </Button>
            )}
            {authorisation && (
              <Button size="sm" variant="quiet" heldReason={heldMachine} onClick={run(actions?.onRevoke)}>
                {t('cell.revoke')}
              </Button>
            )}
          </span>
        </>
      )}
      <h4 className="fw-sk-pop-sub">{t('cell.history')}</h4>
      {detail.history.length === 0 ? (
        <p className="fw-sk-hint">{t('cell.noHistory')}</p>
      ) : (
        <ol className="fw-sk-history">
          {detail.history.slice(0, 8).map((entry) => {
            const set = historyLevel(entry)
            return (
              <li key={entry.id}>
                <b>{t(historyAction(entry))}</b>
                {set ? ` · ${t(`level.${set}`)}` : ''}
                <span>
                  {entry.by ?? t('common.unknown')} · {formatDateTime(entry.at, place)}
                </span>
                {entry.reason && <span>{entry.reason}</span>}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
