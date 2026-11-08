'use client'

import { Lock } from 'lucide-react'
import { GateExplainer, gateHeldReason, type GateCheck } from '@nexus/ui/components/GateExplainer/index'
import { Field } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { CAPA_LIMITS } from '@nexus/factory-domain/quality/capa/rules'
import { Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { CapaType } from '../api'
import type { CloseLine } from '../model'
import { NoticeLine, useCapaWords, type CapaNotice } from '../parts'

export interface CloseDialogModel {
  readonly capaId: string
  readonly number: string
  readonly type: CapaType
  readonly version: number
  readonly lines: readonly CloseLine[]
  readonly note: string
  readonly busy: boolean
  readonly notice: CapaNotice | null
  readonly offline: boolean
  /** quality.capa.manage (else the dialog says why and closes nothing). */
  readonly canClose: boolean
}

export interface CloseDialogActions {
  onNote?: (note: string) => void
  onCancel?: () => void
  onSubmit?: () => void
}

/**
 * Close the CAPA (the board's Closed lane, the record's primary at the last stage): what a close needs as the DS
 * GateExplainer — the last stage, at least one action done, none open — and the closing words (D8: what was done and how
 * you know it worked). Close is held, with the reason, until every check passes and the words are written. The API checks
 * it all again. No step-up: staged approval with a sign-off is W3 (capa-approve).
 */
export function CloseCapaDialog({ model, actions }: { model: CloseDialogModel; actions?: CloseDialogActions }) {
  const { t, say } = useCapaWords()
  const ds = useDsWords()
  const checks: GateCheck[] = model.lines.map((line) => ({
    id: line.key,
    label: t(`close.name.${line.key}`),
    state: line.ok ? 'pass' : 'fail',
    reason: say(line.say) ?? undefined,
  }))
  const gateHeld = gateHeldReason(checks, ds.gateExplainer)
  const held = !model.canClose ? t('held.noManage') : model.offline ? t('held.offline') : model.busy ? t('common.working') : gateHeld ?? (model.note.trim() ? null : t('close.heldNote'))
  return (
    <Modal
      open
      onClose={() => actions?.onCancel?.()}
      title={t('close.title', { number: model.number })}
      size="md"
      footer={
        <span className="fw-capa-foot">
          <Button size="sm" onClick={() => actions?.onCancel?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSubmit?.()}>
            {model.busy ? <Spinner size={12} /> : <Lock size={14} aria-hidden />} {t('close.submit')}
          </Button>
        </span>
      }
    >
      <div className="fw-capa-stack">
        <p className="fw-capa-hint">{t(model.type === 'EIGHT_D' ? 'close.intro8D' : 'close.introCapa')}</p>
        <NoticeLine notice={model.notice} />
        <GateExplainer title={t('close.gate')} checks={checks} form="full" headingLevel={3} labels={ds.gateExplainer} lawLabels={ds.lawRef} />
        <Field label={t('close.note')} hint={t('close.noteHint')} required>
          <Textarea value={model.note} rows={5} maxLength={CAPA_LIMITS.closeNote} onChange={(event) => actions?.onNote?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
