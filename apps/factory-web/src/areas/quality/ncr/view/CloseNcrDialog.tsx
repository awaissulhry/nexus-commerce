'use client'

import { Card, Field } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { CheckList } from '../../_shared/parts'
import type { StageCheckKey } from '../api'
import type { Say } from '../model'
import { NoticeLine, useNcrWords, type NcrNotice } from '../parts'

/** The closing dialog's state (design ncr-close): the checklist, the note, what is signed. */
export interface CloseDialogModel {
  readonly ncrId: string
  readonly number: string
  /** Null while the record is read again. */
  readonly checks: readonly { key: StageCheckKey; ok: boolean; say: Say }[] | null
  readonly ready: boolean
  readonly note: string
  readonly busy: boolean
  readonly notice: NcrNotice | null
  /** The read failed: a `quality` problem key. */
  readonly readProblem: string | null
  /** Why the person may not close at all (no quality.ncr.close). */
  readonly held: Say | null
}

export interface CloseDialogActions {
  onNote?: (note: string) => void
  onSubmit?: () => void
  onCancel?: () => void
}

/**
 * Close NCR (design quality.ncr pop:ncr-close; QHS-090): the closing checklist (the design's Checklist, composed from the
 * quality screens' check list: every check with a mark AND a word) and the sign-off (the design's SignOffPanel, composed:
 * what the e-signature signs, the closing note, then the office's fresh authenticator code, asked by the DS step-up at
 * the click). "Close NCR" is held until the checklist is complete and the note says why, with the reason. Esc closes;
 * focus returns to the opener (the DS Modal).
 */
export function CloseNcrDialog({ model, actions }: { model: CloseDialogModel; actions?: CloseDialogActions }) {
  const { t, say } = useNcrWords()
  const noteShort = model.note.trim().length < 3
  const held = model.held ? say(model.held) : model.checks === null ? t('close.heldReading') : !model.ready ? t('close.heldChecks') : noteShort ? t('close.heldNote') : null
  return (
    <Modal
      open
      onClose={() => actions?.onCancel?.()}
      title={t('close.title', { number: model.number })}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={() => actions?.onCancel?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} disabled={model.busy} onClick={() => actions?.onSubmit?.()}>
            {model.busy ? <Spinner size={12} /> : null} {t('close.submit')}
          </Button>
        </>
      }
    >
      <div className="fw-q-stack">
        <NoticeLine notice={model.notice} />
        <section aria-labelledby="ncr-close-checks" className="fw-q-stack">
          <h3 id="ncr-close-checks" className="fw-ncr-h3">
            {t('close.checklist')}
          </h3>
          {model.readProblem ? (
            <p className="fw-q-hint">{t('close.readFailed')}</p>
          ) : model.checks === null ? (
            <p className="fw-q-loading" role="status">
              <Spinner size={14} /> {t('close.reading')}
            </p>
          ) : (
            <CheckList label={t('close.checklist')} checks={model.checks.map((check) => ({ id: check.key, state: check.ok ? 'OK' : 'OPEN', text: say(check.say), name: t(`checkName.${check.key}`) }))} />
          )}
        </section>
        <Card padded>
          <section aria-labelledby="ncr-close-sign" className="fw-q-stack">
            <h3 id="ncr-close-sign" className="fw-ncr-h3">
              {t('close.signTitle')}
            </h3>
            <p className="fw-q-hint">{t('close.signBody', { number: model.number })}</p>
            <Field label={t('close.note')} hint={t('close.noteHint')} required>
              <Textarea value={model.note} rows={3} maxLength={1000} onChange={(event) => actions?.onNote?.(event.target.value)} />
            </Field>
            <p className="fw-q-hint">{t('close.stepUpNext')}</p>
          </section>
        </Card>
      </div>
    </Modal>
  )
}
