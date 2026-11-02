'use client'

import { Check, Clock, GraduationCap, Minus, X } from 'lucide-react'
import { Pill, Tag } from '@nexus/ui/primitives'
import type { ReactNode } from 'react'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import type { AuthorisationState, SkillLevel, TraineeState } from '../api'
import { isTrainee, SKILL_LEVELS, TIME_ZONE } from '../model'
import { useSkillWords } from './SkillDialogs'

/**
 * The matrix's two cells, composed here (design SkillLevelCell: no DS part yet, a one-area part as plan §10 allows). A level
 * is said by its word and its filled steps out of four, never by a colour alone; a trainee carries its mark beside it.
 * The steps are a kind of level, not a score: no number adds them up (AI Act Annex III 4(b)).
 */
export function LevelMark({ level, trainee, compact = false }: { level: SkillLevel | null; trainee: TraineeState; compact?: boolean }) {
  const t = useSkillWords()
  if (!level) return <span className="fw-sk-none" aria-label={t('cell.noLevel')}><Minus size={12} aria-hidden /></span>
  const step = SKILL_LEVELS.indexOf(level) + 1
  return (
    <span className="fw-sk-level" data-level={level}>
      <span className="fw-sk-steps" aria-hidden>
        {SKILL_LEVELS.map((entry, index) => (
          <i key={entry} data-on={index < step ? 'true' : undefined} />
        ))}
      </span>
      <span className="fw-sk-word">{t(`level.${level}`)}</span>
      {isTrainee(trainee) && (
        <Tag tone={trainee === 'OVERDUE' ? 'warning' : 'info'}>
          <GraduationCap size={11} aria-hidden /> {compact ? t('cell.traineeShort') : t(trainee === 'OVERDUE' ? 'cell.traineeOverdue' : 'cell.trainee')}
        </Tag>
      )}
    </span>
  )
}

const STATE: Readonly<Record<AuthorisationState, { tone: 'success' | 'info' | 'warning' | 'neutral'; icon: ReactNode }>> = {
  AUTHORISED: { tone: 'success', icon: <Check size={12} aria-hidden /> },
  NOT_YET: { tone: 'info', icon: <Clock size={12} aria-hidden /> },
  EXPIRED: { tone: 'warning', icon: <X size={12} aria-hidden /> },
  REVOKED: { tone: 'neutral', icon: <X size={12} aria-hidden /> },
}

export function MachineMark({ state, until, ending }: { state: AuthorisationState | null; until?: string | null; ending?: boolean }) {
  const t = useSkillWords()
  const locale = useLocale()
  if (!state) return <span className="fw-sk-none" aria-label={t('cell.noAuthorisation')}><Minus size={12} aria-hidden /></span>
  const entry = STATE[state]
  return (
    <span className="fw-sk-level">
      <Pill tone={ending ? 'warning' : entry.tone}>
        {entry.icon} {t(`machine.${state}`)}
      </Pill>
      {ending && until && <span className="fw-sk-word">{t('cell.until', { date: formatDate(`${until}T12:00:00Z`, { locale, timeZone: TIME_ZONE }) })}</span>}
    </span>
  )
}
