'use client'

import { useMemo, type ReactNode } from 'react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { DueCell } from '@nexus/ui/components/DueCell/index'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import type { Translate } from '../../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { DueCellValue } from '../api'
import { LIMITS } from '../constants'
import { dueValueOf, isShaded, type TrainingProblem } from '../model'
import '../training.css'

/**
 * View parts every training view shares (B-W2b-146): the words (`people-training`), a day and an instant in the page's
 * language, a section's loading (its shape, "Still loading…" after a second) and failed states (our words + Try again,
 * never drawn as empty), a refusal banner, the DueCell of one person × course (shaded when the role sheet asks it) and the
 * law chips.
 */

export function useTrainingWords(): Translate {
  const t = useT('people-training')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (day) => (day ? formatDate(`${day.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'Europe/Rome' }) : '—'), [locale])
}

export function useWhen(): (at: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (at) => (at ? formatDateTime(at, { locale, timeZone: 'Europe/Rome' }) : '—'), [locale])
}

export function SectionLoading({ rows = 4 }: { rows?: number }) {
  const t = useTrainingWords()
  return (
    <div className="fw-tr-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? 34 : 28} />
      ))}
      <span className="fw-tr-slow" role="status">
        {t('common.stillLoading')}
      </span>
    </div>
  )
}

export function SectionFailed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: (() => void) | undefined }) {
  const t = useTrainingWords()
  const forbidden = problem === 'problem.forbidden'
  return (
    <EmptyState
      title={title}
      description={t(problem)}
      action={
        forbidden ? undefined : (
          <Button size="sm" onClick={() => onRetry?.()}>
            {t('common.retry')}
          </Button>
        )
      }
    />
  )
}

export function ProblemBanner({ problem }: { problem: TrainingProblem | null | undefined }) {
  const t = useTrainingWords()
  return problem ? <Banner tone="danger" title={t(problem.key, problem.params)} /> : null
}

export function SectionHead({ id, title, note, children }: { id?: string; title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="fw-tr-head">
      <span className="fw-tr-row">
        <h2 id={id}>{title}</h2>
        {note}
      </span>
      {children ? <span className="fw-tr-row">{children}</span> : null}
    </div>
  )
}

/** One person × course as the DS DueCell: Needed, overdue, due in N days, valid until, done; shaded when the role asks it. */
export function TrainingDue({ cell, today }: { cell: Pick<DueCellValue, 'state' | 'overdue' | 'neededBy' | 'dueOn' | 'record' | 'required'>; today: string }) {
  const ds = useDsWords()
  const day = useDay()
  const t = useTrainingWords()
  const due = <DueCell value={dueValueOf(cell)} today={today} soonDays={LIMITS.soonDays} formatDate={(iso) => day(iso)} labels={ds.dueCell} />
  return isShaded(cell) ? (
    <span className="fw-tr-shaded" title={t('cell.required')}>
      {due}
    </span>
  ) : (
    due
  )
}

/** The law a section rests on, in plain words (`law.<key>`). */
export function Law({ law, plain }: { law: string; plain: string }) {
  const ds = useDsWords()
  const t = useTrainingWords()
  return <LawRef law={law} plain={t(plain)} labels={ds.lawRef} />
}

/** A language in words ("Italiano", "Romanian"): the People catalogue's names, else the code. */
export function useLanguage(): (code: string) => string {
  const people = useT('people')
  return useMemo(() => (code) => {
    const key = `language.${code}`
    const words = people(key)
    return words === key ? code.toUpperCase() : words
  }, [people])
}
