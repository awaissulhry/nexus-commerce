'use client'

import { useEffect, useId } from 'react'
import { Banner, Field, Listbox, Modal } from '@nexus/ui/components'
import { Button, Spinner, Textarea } from '@nexus/ui/primitives'
import { FINISH_REASONS, type FinishReason } from '../model'
import type { CloseActions, CloseModel } from '../view-model'
import { say, useWords } from './parts'

/**
 * Close return (design sales.returns/pop:returns.close; row ⋯ and the record): the finish reason (required; SAL-360's own
 * list is a later row, so the chosen words are kept as the close reason), a note, Close (⌘↵). After the close the API's
 * warnings are said (lines to replace without the replacement order, unchanged goods without their return DDT). "Unused
 * reserved parts returned to stock" is Later.
 */
export function CloseReturnModal({ model, actions }: { model: CloseModel; actions?: CloseActions }) {
  const t = useWords()
  const ids = { reason: useId(), note: useId() }
  const done = model.warnings !== null
  const held = model.busy ? t('quality:common.working') : !model.reason ? t('close.pickReason') : model.reason === 'OTHER' && !model.note.trim() ? t('close.otherNote') : null

  useEffect(() => {
    if (done) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        actions?.onCloseSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, done])

  return (
    <Modal
      open
      onClose={() => actions?.onCloseDismiss?.()}
      title={t('close.title', { number: model.number })}
      size="md"
      footer={
        done ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={() => actions?.onCloseDismiss?.()}>
              {t('quality:common.close')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onCloseDismiss?.()}>
              {t('quality:common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onCloseSubmit?.()} aria-keyshortcuts="Meta+Enter">
              {model.busy ? <Spinner size={12} /> : null} {t('close.submit')}
            </Button>
          </>
        )
      }
    >
      <div className="fw-q-stack">
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
        {done ? (
          <Banner tone={model.warnings! > 0 ? 'warning' : 'success'} title={t(model.warnings! > 0 ? 'close.doneWarnings' : 'close.done', { number: model.number, count: model.warnings! })}>
            {model.warnings! > 0 ? t('close.warningsBody') : null}
          </Banner>
        ) : (
          <>
            <p className="fw-q-hint">{t('close.body')}</p>
            <Field label={t('close.reason')} required htmlFor={ids.reason}>
              <Listbox
                id={ids.reason}
                ariaLabel={t('close.reason')}
                options={FINISH_REASONS.map((reason) => ({ value: reason, label: t(`finish.${reason}`) }))}
                value={model.reason}
                onChange={(value) => actions?.onCloseDraft?.({ reason: value as FinishReason })}
                placeholder={t('close.pickReason')}
              />
            </Field>
            <Field label={t('close.note')} required={model.reason === 'OTHER'} htmlFor={ids.note}>
              <Textarea id={ids.note} rows={3} value={model.note} onChange={(event) => actions?.onCloseDraft?.({ note: event.target.value })} />
            </Field>
            <p className="fw-q-hint">{t('close.later')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}
