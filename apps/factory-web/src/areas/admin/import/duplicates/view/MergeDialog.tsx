'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { MERGE_REASON, mergeReasonProblem } from '@nexus/factory-domain/imports/duplicates/rules'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { MergePreview, MergeSide } from '../api'
import { mergeHeld, moveLines, NAMESPACE, refusalWords, type MergeDialogModel } from '../model'
import { DupMessages, RecordLink } from './parts'

/**
 * Merge two records (B-W2b-427, SCR-621; a person's decision, never automatic): which one stays and which one is archived,
 * what moves to the one that stays and what stays on the archived one, why it cannot go ahead (each refusal in words,
 * what uses the duplicate by kind of record), "Keep … instead" when the other way works, and the reason (kept in both
 * records' history). Merge is held, with why, until all of it is right.
 */

export interface MergeDialogActions {
  onClose?: () => void
  onSwap?: () => void
  onMerge?: (reason: string) => void
}

export function MergeDialog({ model, actions }: { model: MergeDialogModel | null; actions?: MergeDialogActions }) {
  if (!model) return null
  return (
    <DupMessages>
      <MergeDialogModal model={model} actions={actions} />
    </DupMessages>
  )
}

/** The same dialog drawn in place (the dialog opens only in a browser, after hydration): what the tests read. */
export function MergeDialogInline({ model, actions }: { model: MergeDialogModel; actions?: MergeDialogActions }) {
  return (
    <DupMessages>
      <MergeDialogPlain model={model} actions={actions} />
    </DupMessages>
  )
}

function MergeDialogModal({ model, actions }: { model: MergeDialogModel; actions?: MergeDialogActions }) {
  const parts = useMergeParts(model, actions)
  return (
    <Modal open onClose={() => actions?.onClose?.()} title={parts.title} subtitle={parts.subtitle} size="lg" busy={model.busy} footer={parts.footer}>
      {parts.body}
    </Modal>
  )
}

function MergeDialogPlain({ model, actions }: { model: MergeDialogModel; actions?: MergeDialogActions }) {
  const parts = useMergeParts(model, actions)
  return (
    <section aria-label={parts.title}>
      <h2>{parts.title}</h2>
      <p>{parts.subtitle}</p>
      {parts.body}
      <div>{parts.footer}</div>
    </section>
  )
}

function Side({ label, side, prefix, recordType }: { label: string; side: MergeSide; prefix: string; recordType: MergePreview['recordType'] }) {
  return (
    <div className="fw-dup-side">
      <span className="fw-dup-side-label">{label}</span>
      <RecordLink prefix={prefix} record={{ ...side, recordType }} newTab />
    </div>
  )
}

function useMergeParts(model: MergeDialogModel, actions?: MergeDialogActions): { title: string; subtitle: string; footer: ReactNode; body: ReactNode } {
  const t = useT(NAMESPACE)
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const pair = `${model.ask.kept.id}:${model.ask.dropped.id}`
  useEffect(() => {
    setReason('')
    setTouched(false)
  }, [pair])
  const preview = model.preview
  const held = mergeHeld(model, reason)
  const problem = mergeReasonProblem(reason)
  const close = () => actions?.onClose?.()
  return {
    title: t('dup.merge.title', { dropped: model.ask.dropped.code, kept: model.ask.kept.code }),
    subtitle: t('dup.merge.subtitle'),
    footer: (
      <>
        <Button onClick={close}>{t('dup.merge.cancel')}</Button>
        <Button
          variant="danger"
          heldReason={held ? t(held) : null}
          onClick={() => {
            setTouched(true)
            if (!held) actions?.onMerge?.(reason.trim())
          }}
        >
          {t('dup.merge.go', { kept: model.ask.kept.code })}
        </Button>
      </>
    ),
    body: (
      <div className="fw-dup-body">
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
        {!preview ? (
          <div className="fw-dup-skeleton" aria-busy="true">
            <Skeleton height={64} />
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        ) : (
          <>
            <div className="fw-dup-sides">
              <Side label={t('dup.merge.stays')} side={preview.kept} prefix={model.prefix} recordType={preview.recordType} />
              <Side label={t('dup.merge.archived')} side={preview.dropped} prefix={model.prefix} recordType={preview.recordType} />
            </div>
            {preview.refusals.length > 0 ? (
              <Banner tone="warning" title={t('dup.merge.refusedTitle')}>
                <ul className="fw-dup-list">
                  {preview.refusals.map((refusal) => {
                    const words = refusalWords(refusal, preview)
                    return (
                      <li key={refusal} className="fw-dup-p">
                        {t(words.key, words.params)}
                      </li>
                    )
                  })}
                </ul>
                {preview.uses.length > 0 && (
                  <ul className="fw-dup-list" aria-label={t('dup.merge.usesLabel', { dropped: preview.dropped.code })}>
                    {preview.uses.map((use) => (
                      <li key={use.group} className="fw-dup-p">
                        {t(`dup.use.${use.group}`, { count: use.count })}
                      </li>
                    ))}
                  </ul>
                )}
                {preview.refusals.includes('IN_USE') && <p className="fw-dup-hint">{t('dup.merge.inUseHint')}</p>}
                {preview.reverseWorks && (
                  <div className="fw-dup-actions">
                    <Button size="sm" onClick={() => actions?.onSwap?.()}>
                      {t('dup.merge.swap', { dropped: preview.dropped.code })}
                    </Button>
                  </div>
                )}
              </Banner>
            ) : (
              <>
                <section className="fw-dup-section" aria-label={t('dup.merge.movesTitle', { kept: preview.kept.code })}>
                  <h3 className="fw-dup-h">{t('dup.merge.movesTitle', { kept: preview.kept.code })}</h3>
                  {moveLines(preview, 'moves').length > 0 ? (
                    <ul className="fw-dup-list">
                      {moveLines(preview, 'moves').map((line) => (
                        <li key={line.key} className="fw-dup-p">
                          {t(line.key, { count: line.count })}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="fw-dup-hint">{t('dup.merge.nothingMoves')}</p>
                  )}
                </section>
                <section className="fw-dup-section" aria-label={t('dup.merge.staysTitle', { dropped: preview.dropped.code })}>
                  <h3 className="fw-dup-h">{t('dup.merge.staysTitle', { dropped: preview.dropped.code })}</h3>
                  <ul className="fw-dup-list">
                    {moveLines(preview, 'stays').map((line) => (
                      <li key={line.key} className="fw-dup-p">
                        {t(line.key, { count: line.count })}
                      </li>
                    ))}
                    <li className="fw-dup-p">{t('dup.merge.history')}</li>
                  </ul>
                </section>
                <Field
                  label={t('dup.merge.reason')}
                  hint={t('dup.merge.reasonHint', { min: MERGE_REASON.min, max: MERGE_REASON.max })}
                  error={touched && problem ? t('dup.held.reason') : undefined}
                  required
                >
                  <Textarea value={reason} rows={2} maxLength={MERGE_REASON.max} onChange={(event) => setReason(event.target.value)} onBlur={() => setTouched(true)} />
                </Field>
                <p className="fw-dup-hint">{t('dup.merge.never')}</p>
              </>
            )}
          </>
        )}
      </div>
    ),
  }
}
