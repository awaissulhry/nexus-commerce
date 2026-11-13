'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import { percent } from '../../../quotes/model'
import type { Words } from '../../../quotes/record/lines-depth/model'
import { useDepthWords } from '../../../quotes/record/lines-depth/words'
import type { SizeScaleRow } from '../api'
import { curveProblems, totalOf, type CurveDraft } from '../model'

export interface CurveDialogModel {
  mode: 'new' | 'edit'
  draft: CurveDraft
  /** The scales a new curve may use (its sizes are the fields); an edited curve keeps its own. */
  scales: { status: 'loading' | 'ready' | 'error'; items: ReadonlyArray<Pick<SizeScaleRow, 'id' | 'code' | 'name' | 'codes'>> }
  companies: ReadonlyArray<{ id: string; code: string; name: string }>
  archived: boolean
  mayKeep: boolean
  saving: boolean
  problem: Words | null
}

export interface CurveDialogActions {
  onDraft?: (patch: Partial<CurveDraft>) => void
  onSave?: () => void
  onClose?: () => void
}

/**
 * A size curve's dialog (SCR-235 › Size curves): its name, scale and whose (new only), a percent per size of the scale, and
 * the total shown live — Save is held until it is exactly 100 %, with the reason in words.
 */
export function CurveDialog({ model, actions }: { model: CurveDialogModel; actions?: CurveDialogActions }) {
  const { t, sales, say } = useDepthWords()
  const locale = useLocale()
  const { draft } = model
  const scale = model.scales.items.find((entry) => entry.id === draft.scaleId) ?? null
  const total = totalOf(draft)
  const problems = curveProblems(draft)
  const readOnly = !model.mayKeep || model.archived
  const held = readOnly ? t(model.archived ? 'curve.held.archived' : 'curve.held.right') : problems.length > 0 ? say(problems[0]!) : model.saving ? t('common.working') : null
  const exact = total !== null && Math.round(total * 10_000) === 1_000_000
  return (
    <Modal
      open
      size="lg"
      onClose={() => actions?.onClose?.()}
      title={model.mode === 'new' ? t('curve.dialog.new') : t('curve.dialog.edit', { name: draft.name })}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{sales('common.close')}</Button>
          {!readOnly && (
            <Button variant="primary" heldReason={held} onClick={() => actions?.onSave?.()}>
              {model.saving ? <Spinner size={12} /> : null} {t('curve.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-q-stack">
        {readOnly && <Banner tone="info" title={t(model.archived ? 'curve.held.archived' : 'curve.held.right')} />}
        <div className="fw-q-fields">
          <Field label={t('curve.name')}>
            <Input value={draft.name} maxLength={120} disabled={readOnly} onChange={(event) => actions?.onDraft?.({ name: event.target.value })} />
          </Field>
          <Field label={t('curve.scale')} hint={model.mode === 'edit' ? t('curve.scaleKept') : t('curve.scaleHint')}>
            {model.scales.status === 'loading' ? (
              <Spinner size={14} />
            ) : (
              <Select value={draft.scaleId} disabled={readOnly || model.mode === 'edit'} onChange={(event) => actions?.onDraft?.({ scaleId: event.target.value, shares: {} })}>
                <option value="">{t('curve.pickScale')}</option>
                {model.scales.items.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {t('curve.scaleOption', { code: entry.code, name: entry.name })}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('curve.company')}>
            <Select value={draft.companyId} disabled={readOnly || model.mode === 'edit'} onChange={(event) => actions?.onDraft?.({ companyId: event.target.value })}>
              <option value="">{t('tpl.everyCompany')}</option>
              {model.companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.code} · {company.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {model.scales.status === 'error' && <Banner tone="warning" title={t('curve.scalesFailed')} />}
        {scale && (
          <>
            <div className="fw-qd-delivery-sizes" role="group" aria-label={t('curve.shares')}>
              {scale.codes.map((size) => (
                <Field key={size} label={t('curve.shareOf', { size })}>
                  <Input size="sm" inputMode="decimal" placeholder="0" value={draft.shares[size] ?? ''} disabled={readOnly} onChange={(event) => actions?.onDraft?.({ shares: { ...draft.shares, [size]: event.target.value } })} />
                </Field>
              ))}
            </div>
            <p role="status" aria-live="polite">
              <Tag tone={exact ? 'success' : 'warning'}>{total === null ? t('curve.totalUnknown') : t('curve.total', { total: percent(String(total), locale) })}</Tag> {exact ? t('curve.totalOk') : t('curve.totalHint')}
            </p>
          </>
        )}
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
      </div>
    </Modal>
  )
}
