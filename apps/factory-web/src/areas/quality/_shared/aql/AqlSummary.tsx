'use client'

import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { SAFETY_LAW } from '@nexus/factory-domain/quality/defects/severity'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { aqlShown, classLine, derivation, levelText, notesOf, type AqlPlanFacts, type AqlWords } from './aql-words'
import './aql.css'

export type { AqlPlanFacts } from './aql-words'

/** The official text of the PPE Regulation (EUR-Lex), for the critical lock's LawRef. */
const PPE_REGULATION = 'https://eur-lex.europa.eu/eli/reg/2016/425/oj'

export interface AqlSummaryProps {
  /** The plan (the API's planView or factory-domain samplingPlan); null while reading. */
  plan: AqlPlanFacts | null
  /** Where the numbers come from ("Profile AQL-STD · Standard"), said before the sentence. */
  source?: ReactNode
  /** Default "Sample and acceptance". */
  title?: ReactNode
  headingLevel?: 2 | 3 | 4
  /** A failed read in the host's words, with Try again. */
  problem?: string | null
  onRetry?: () => void
  /** Without the class table (a side column): the sentence and one line per class. */
  compact?: boolean
}

/**
 * AqlSummary — the AQL plan of a lot in words (design part "AqlSummary (new)", QHS-020; an area part of Quality: the
 * calculator and the plan's Sampling tab draw it, Inspections' Sample & AQL reads it later). The derivation as one
 * sentence ("Lot 480 · general level II → code letter H → inspect 50."), then per class its AQL, accept-up-to (Ac) and
 * rejects-at (Re) — critical locked at 0 with the law (Reg. (EU) 2016/425) — and the notes Table 2-A gives (an arrow to
 * another letter, a class judged on more units than its plan, the whole lot). Words from facts in the page's language,
 * never the engine's English. Draws only: nothing is fetched or saved.
 */
export function AqlSummary(props: AqlSummaryProps) {
  return (
    <WithMessages namespaces={['quality-aql']}>
      <Summary {...props} />
    </WithMessages>
  )
}

function Summary({ plan, source, title, headingLevel = 3, problem, onRetry, compact = false }: AqlSummaryProps) {
  const t = useT('quality-aql')
  const locale = useLocale()
  const ds = useDsWords()
  const H = `h${headingLevel}` as 'h3'
  const number = (value: number) => formatNumber(value, locale)
  const say = (words: AqlWords) => {
    const params: Record<string, string | number> = {}
    for (const [name, value] of Object.entries(words.params ?? {})) {
      params[name] = typeof value === 'string' && value.startsWith('class.') ? t(value) : typeof value === 'number' ? number(value) : value
    }
    return t(words.key, params)
  }
  const heading = <H className="fw-aql-title">{title ?? t('title')}</H>
  if (problem) {
    return (
      <section className="fw-aql" aria-label={t('title')}>
        {heading}
        <Banner
          tone="danger"
          title={problem}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {t('retry')}
              </Button>
            ) : undefined
          }
        />
      </section>
    )
  }
  if (!plan) {
    return (
      <section className="fw-aql" aria-label={t('title')} aria-busy="true">
        {heading}
        <p className="fw-aql-muted" role="status">
          {t('reading')}
        </p>
        <Skeleton height={18} width="80%" />
        <Skeleton height={72} />
      </section>
    )
  }
  const critical = plan.classes.find((entry) => entry.locked)
  const notes = notesOf(plan)
  return (
    <section className="fw-aql" aria-label={t('title')}>
      {heading}
      {source && <p className="fw-aql-source">{source}</p>}
      <p className="fw-aql-sentence" aria-live="polite">
        {say(derivation(plan))}
      </p>
      <dl className="fw-aql-facts">
        <div>
          <dt>{t('fact.letter')}</dt>
          <dd>{plan.codeLetter ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('fact.sample')}</dt>
          <dd>{number(plan.sampleSize)}</dd>
        </div>
        <div>
          <dt>{t('fact.level')}</dt>
          <dd>{t(plan.level.startsWith('S') ? 'level.special' : 'level.general', { level: levelText(plan.level) })}</dd>
        </div>
      </dl>
      {compact ? (
        <ul className="fw-aql-lines">
          {plan.classes.map((entry) => (
            <li key={entry.defectClass}>{say(classLine(entry))}</li>
          ))}
        </ul>
      ) : (
        <SummaryTable
          label={t('table')}
          columns={[t('col.class'), t('col.aql'), t('col.accept'), t('col.reject')]}
          align={['left', 'right', 'right', 'right']}
          stackOnPhone
          rows={plan.classes.map((entry) => ({
            id: entry.defectClass,
            cells: [
              <span key="class" className="fw-aql-class">
                {entry.locked && <Lock size={12} aria-hidden />} {t(`class.${entry.defectClass}`)}
              </span>,
              aqlShown(entry.aql),
              number(entry.accept),
              number(entry.reject),
            ],
          }))}
        />
      )}
      {critical && (
        <p className="fw-aql-lock">
          <Lock size={12} aria-hidden /> {t('lock')} <LawRef law={SAFETY_LAW} plain={t('lockLaw')} href={PPE_REGULATION} labels={ds.lawRef} />
        </p>
      )}
      {notes.length > 0 && (
        <ul className="fw-aql-notes">
          {notes.map((note, index) => (
            <li key={`${note.key}-${index}`}>{say(note)}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
