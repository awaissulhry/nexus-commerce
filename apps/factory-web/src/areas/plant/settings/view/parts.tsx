'use client'

import type { ReactNode } from 'react'
import { XCircle } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import type { Said } from '../depth-model'
import type { Section } from '../depth-view-model'

export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** This page's words (`plant-settings`). */
export const useSettingsWords = (): Translate => useT('plant-settings') as Translate

/** A message key and its params in this page's words, or null. */
export const say = (t: Translate, said: Said | null | undefined): string | null => (said ? t(said.key, said.params) : null)

/**
 * A section's frame: its loading (a skeleton and "still loading" words at once: the design's "a 'still loading' note after
 * about 1 s" without a timer) and its failure in our words with Try again; a failed read is never drawn as empty.
 */
export function SectionState<T>({ read, title, onRetry, lines = 4, children }: { read: Section<T>; title: string; onRetry?: () => void; lines?: number; children: (value: T) => ReactNode }) {
  const t = useSettingsWords()
  if (read.status === 'ready') return <>{children(read.value)}</>
  if (read.status === 'loading') {
    return (
      <div className="fw-pls-stack" aria-busy="true">
        <p className="fw-pls-hint" role="status">
          <Spinner size={14} /> {t('section.loading', { section: title })}
        </p>
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} height={22} />
        ))}
      </div>
    )
  }
  return (
    <EmptyState
      icon={<XCircle size={20} aria-hidden />}
      title={t('section.failed', { section: title })}
      description={t(read.problem)}
      action={
        read.problem === 'problem.readForbiddenSection' ? undefined : (
          <Button size="sm" onClick={onRetry}>
            {t('state.retry')}
          </Button>
        )
      }
    />
  )
}

/** A card's head: its title as a heading, what it is for, and a side slot (the site it is for, a law). */
export function CardHead({ id, title, purpose, side }: { id: string; title: string; purpose: string; side?: ReactNode }) {
  return (
    <div className="fw-pls-cardhead">
      <div className="fw-pls-cardtitle">
        <h2 id={id}>{title}</h2>
        <p className="fw-pls-hint">{purpose}</p>
      </div>
      {side ? <div className="fw-pls-cardside">{side}</div> : null}
    </div>
  )
}

/** Sentences in this page's words, one per line (the worked example of a rule). */
export function Sentences({ lines, live = false }: { lines: readonly Said[]; live?: boolean }) {
  const t = useSettingsWords()
  return (
    <ul className="fw-pls-example" {...(live ? { 'aria-live': 'polite' as const } : {})}>
      {lines.map((line, index) => (
        <li key={`${line.key}-${index}`}>{t(line.key, line.params)}</li>
      ))}
    </ul>
  )
}
