'use client'

import { useEffect } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Kbd, RadioCard, Skeleton } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { decideDraftHeld, SAMPLE_DECISIONS, type DecideDraft, type Notice, type Phrase, type SampleDecision } from '../model'
import { NoticeLine, useWords } from '../parts'

/**
 * "Decide on the sample" (design pop:samples.decide; card "Decide…", `d`, the Approval tab): Approved · Approved with
 * comments · Rejected, the comments (why, for the last two), on the round's pinned revision. The same dialog decides a
 * leather or colour swatch (`subject: 'swatch'`, no revision). The container reads what holds it first (the API's own
 * rules: nothing made yet, the brand asked, decided already) and passes it as `blocked`.
 */
export interface DecideModel {
  subject: 'round' | 'swatch'
  /** The round's or the swatch's id. */
  id: string
  /** "SR-2026-0003 · Fit · round 2", or the swatch's material and colour. */
  name: Phrase
  /** The revision the decision is on ("On revision N"); null for a swatch, or while read. */
  revision: number | null
  /** What holds the decision (the right, the round's state, the brand asked), in our words; null: it may be recorded. */
  blocked: Phrase | null
  /** The round is being read (its Approval). */
  reading: boolean
  /** The read failed (its words' key). */
  problem: string | null
  draft: DecideDraft
  busy: boolean
  notice: Notice | null
  offline: boolean
}

export interface DecideActions {
  onDraft?: (patch: Partial<DecideDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
  onRetry?: () => void
}

const DESCRIPTION: Readonly<Record<SampleDecision, string>> = {
  APPROVED: 'decide.approvedHint',
  APPROVED_WITH_COMMENTS: 'decide.commentsHint',
  REJECTED: 'decide.rejectedHint',
}

/** Why "Record decision" is held now (null: it may be pressed). */
export function decideHeld(model: Pick<DecideModel, 'reading' | 'problem' | 'blocked' | 'draft' | 'offline'>): Phrase | null {
  if (model.reading) return { key: 'common.reading' }
  if (model.problem) return { key: model.problem }
  if (model.blocked) return model.blocked
  if (model.offline) return { key: 'held.offline' }
  return decideDraftHeld(model.draft)
}

export function DecideDialog({ model, actions }: { model: DecideModel; actions?: DecideActions }) {
  const { t, say } = useWords()
  const held = decideHeld(model)
  const heldText = model.busy ? t('common.working') : say(held)

  // ⌘↵ records the decision (design kb), only while it is not held.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held && !model.busy) {
        event.preventDefault()
        actions?.onSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, model.busy, actions])

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t(model.subject === 'swatch' ? 'decide.swatchTitle' : 'decide.title')}
      subtitle={say(model.name)}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldText} onClick={() => actions?.onSubmit?.()} aria-keyshortcuts="Meta+Enter">
            {t('decide.submit')}
            <span className="fw-smp-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
          </Button>
        </>
      }
    >
      <div className="fw-smp-form">
        {model.reading && (
          <div className="fw-smp-stack" aria-busy="true">
            <Skeleton height={20} width="40%" />
            <Skeleton height={64} />
          </div>
        )}
        {model.problem && (
          <Banner
            tone="danger"
            title={t('decide.readFailed')}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(model.problem)}
          </Banner>
        )}
        {!model.reading && !model.problem && (
          <>
            {model.revision !== null && <p className="fw-smp-hint">{t('decide.onRevision', { revision: model.revision })}</p>}
            {model.blocked && <Banner tone="info" title={say(model.blocked)} />}
            <fieldset className="fw-smp-radios" disabled={!!model.blocked}>
              <legend className="fw-smp-legend">{t('decide.legend')}</legend>
              {SAMPLE_DECISIONS.map((decision) => (
                <RadioCard
                  key={decision}
                  name={`decision-${model.id}`}
                  value={decision}
                  title={t(`decision.${decision}`)}
                  description={t(DESCRIPTION[decision])}
                  checked={model.draft.decision === decision}
                  selected={model.draft.decision === decision}
                  onChange={() => actions?.onDraft?.({ decision })}
                />
              ))}
            </fieldset>
            <Field label={t('decide.comments')} required={!!model.draft.decision && model.draft.decision !== 'APPROVED'} hint={t('decide.commentsFieldHint')}>
              <Textarea value={model.draft.comments} rows={4} honourRows maxLength={4000} disabled={!!model.blocked} onChange={(event) => actions?.onDraft?.({ comments: event.target.value })} />
            </Field>
          </>
        )}
        <NoticeLine notice={model.notice} />
      </div>
    </Modal>
  )
}
