'use client'

import { AlertCircle, Check, Loader2 } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { say, type Words } from '../../model'
import type { SaveMark } from '../record-model'

/** The record's own words (`subcontract-order`) with nested `@key` parameters. */
export function useSay() {
  const t = useT('subcontract-order')
  return (value: Words) => say(t, value)
}

/** A part while it loads, or why its read failed (never drawn as empty), with Try again. */
export function PartState({ problem, onRetry, label }: { problem: string | null; onRetry?: () => void; label: string }) {
  const t = useT('subcontract-order')
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={t('part.failed', { part: label })}
          description={t(problem)}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      </Card>
    )
  }
  return (
    <Card padded aria-busy="true">
      <p className="fw-by-hint" role="status">
        <Spinner size={14} /> {t('part.loading', { part: label })}
      </p>
    </Card>
  )
}

/**
 * A cell's save in words beside it ("Saving…", "Saved", "Not saved: why") — composed here: the DS CellSaveMark speaks
 * English only and draws a glyph (named as a missing DS part).
 */
export function SaveMarkText({ mark }: { mark: SaveMark | undefined }) {
  const t = useT('subcontract-order')
  const sayWords = useSay()
  if (!mark) return null
  if (mark.state === 'saving')
    return (
      <span className="fw-sco-mark" data-state="saving" role="status">
        <Loader2 size={12} aria-hidden className="fw-sco-spin" /> {t('mark.saving')}
      </span>
    )
  if (mark.state === 'saved')
    return (
      <span className="fw-sco-mark" data-state="saved" role="status">
        <Check size={12} aria-hidden /> {t('mark.saved')}
      </span>
    )
  return (
    <span className="fw-sco-mark" data-state="failed" role="alert">
      <AlertCircle size={12} aria-hidden /> {t('mark.failed', { why: sayWords(mark.words) })}
    </span>
  )
}

/** A dialog's refusal, in this app's words. */
export function DialogProblem({ problem }: { problem: Words | null }) {
  const sayWords = useSay()
  return problem ? <Banner tone="danger" title={sayWords(problem)} /> : null
}
