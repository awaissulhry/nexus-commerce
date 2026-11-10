'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Banner } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { CheckList, type CheckLine, type CheckState } from '../../../../quality/_shared/parts'
import type { Read } from '../../../../quality/_shared/model'
import type { Law } from '../api'
import '../depth.css'

/**
 * The small parts the W2b views of Labels & marking share (B-W2b-270): the law of a rule as DS LawRef chips (plain words
 * and the official link: the design's "Why this rule" popover, part lb-rule), a rule line in the shared CheckList, and the
 * read states of a panel (a skeleton of its shape; the problem in words with Try again, the rest of the page usable).
 */

/** The laws a rule rests on, each a chip that opens its plain words and the official text. */
export function LawRefs({ law }: { law: readonly Law[] }) {
  const ds = useDsWords()
  if (law.length === 0) return null
  return (
    <span className="fw-lbd-laws">
      {law.map((entry) => (
        <LawRef key={entry.law} law={entry.law} plain={entry.plain} href={entry.href} labels={ds.lawRef} />
      ))}
    </span>
  )
}

export interface RuleLine {
  id: string
  state: CheckState
  /** The rule's name (our words). */
  name: string
  /** The API's sentence (data, English) under our word for the outcome. */
  outcome: string
  words: string
  law: readonly Law[]
  /** The findings beyond the first sentence (the API's, English). */
  findings: readonly string[]
  /** Where to act on it (a link, our words), or null. */
  fix?: ReactNode
}

/** Rule checks as the shared CheckList: each line its outcome in words, the API's sentence, its laws and how to act. */
export function RuleLines({ lines, label }: { lines: readonly RuleLine[]; label: string }) {
  const checks: CheckLine[] = lines.map((line) => ({
    id: line.id,
    state: line.state,
    name: line.name,
    text: (
      <span className="fw-lbd-rule">
        <span>{line.outcome}</span>
        <span className="fw-q-hint" lang="en">
          {line.words}
        </span>
        {line.findings.length > 0 && (
          <ul className="fw-lbd-findings" lang="en">
            {line.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        )}
        <LawRefs law={line.law} />
      </span>
    ),
    fix: line.fix ?? null,
  }))
  return <CheckList label={label} checks={checks} />
}

/** A panel's read: its shape while read, the problem in words with Try again, else the panel. */
export function PanelRead<T>({ read, failedTitle, onRetry, rows = 3, children }: { read: Read<T>; failedTitle: string; onRetry?: () => void; rows?: number; children: (value: T) => ReactNode }) {
  const q = useT('quality')
  const d = useT('compliance-labels-depth')
  if (read.problem)
    return (
      <Banner
        tone="warning"
        title={failedTitle}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {q('common.retry')}
            </Button>
          ) : undefined
        }
      >
        {read.problem.startsWith('depth.') ? d(read.problem) : q(read.problem)}
      </Banner>
    )
  if (read.value === null)
    return (
      <div className="fw-q-stack" aria-busy="true" role="status" aria-label={q('common.loading')}>
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} height={18} width={`${90 - index * 15}%`} />
        ))}
      </div>
    )
  return <>{children(read.value)}</>
}

/** A link to Compliance › Settings › Rules & markets (the gates, a phrase), held as words when the person cannot open it. */
export function RulesLink({ href, can, children }: { href: string; can: boolean; children: ReactNode }) {
  if (!can) return <span className="fw-q-hint">{children}</span>
  return (
    <Link className="fw-q-link" href={href}>
      {children}
    </Link>
  )
}
