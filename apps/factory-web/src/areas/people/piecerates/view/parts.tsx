'use client'

import { useMemo, type ReactNode } from 'react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { Notice } from '../../_shared/parts'
import { NAMESPACE, type Words } from '../model'
import type { Read } from '../view-model'
import '../piecerates.css'

/** The catalogues of the Piece rates pages: their own, People's shared words (the privacy note, the keys list), the list frame's. */
export const PIECE_NAMESPACES = [NAMESPACE, 'people', 'lists'] as const

export function PieceMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={PIECE_NAMESPACES}>{children}</WithMessages>
}

export type PieceWords = (key: string, params?: Readonly<Record<string, string | number>>) => string

export function usePieceWords(): PieceWords {
  const t = useT(NAMESPACE)
  return useMemo<PieceWords>(() => (key, params) => t(key, params), [t])
}

export const said = (t: PieceWords, words: Words | null | undefined): string => (words ? t(words.key, words.params) : '')

/** The page's one notice, in this page's words. */
export function PieceNotice({ notice, onDismiss }: { notice: Notice | null; onDismiss?: (() => void) | undefined }) {
  const t = usePieceWords()
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={said(t, notice.words)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.close')}
          </Button>
        ) : undefined
      }
    >
      {notice.detail ? said(t, notice.detail) : null}
    </Banner>
  )
}

/** A section's frame: its title, what it is for, and its own actions. The id is what a tile and a gate row jump to. */
export function Section({ id, title, hint, actions, children }: { id: string; title: string; hint?: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section id={id} className="fw-pr8-section" aria-labelledby={`${id}-title`}>
      <header className="fw-pr8-section-head">
        <span>
          <h2 id={`${id}-title`} className="fw-pr8-h2">
            {title}
          </h2>
          {hint && <p className="fw-pr8-hint">{hint}</p>}
        </span>
        {actions && <span className="fw-pp-actions">{actions}</span>}
      </header>
      {children}
    </section>
  )
}

/** A section's read: skeleton while it runs, the problem in words with Try again, never drawn as empty. */
export function ReadBlock<T>({ read, onRetry, children, rows = 3 }: { read: Read<T> | null; onRetry?: (() => void) | undefined; children: (value: T) => ReactNode; rows?: number }) {
  const t = usePieceWords()
  if (!read) return null
  if (read.status === 'ready') return <>{children(read.value)}</>
  if (read.status === 'failed') {
    return (
      <EmptyState
        title={t('common.failed')}
        description={said(t, read.problem)}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          ) : undefined
        }
      />
    )
  }
  return (
    <div className="fw-pr8-stack" aria-busy="true">
      <p className="fw-pr8-hint" role="status">
        <Spinner size={14} /> {t('common.reading')}
      </p>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={22} />
      ))}
    </div>
  )
}

/** A figure, or the words that say why there is none (never 0). */
export function Figure({ value, hidden }: { value: string | null; hidden: string }) {
  return value === null ? (
    <span className="fw-pr8-hidden" title={hidden}>
      —
    </span>
  ) : (
    <span className="fw-pr8-num">{value}</span>
  )
}
