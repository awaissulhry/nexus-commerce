'use client'

import type { ReactNode } from 'react'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import type { AttributeKey, LotDepth } from '../api'
import { TANNAGE_CHOICES } from '../model'
import type { AttributesDialog as Dialog, LotDepthActions } from '../view-model'
import '../depth.css'
import { useDepthWords } from './DepthParts'

/**
 * B-W2b-320 — the lot's attributes (design lt-facts "W2b attributes: thickness range, finish, tannage, grade, origin"; SCM-185):
 * the keys of the material's kind only (leather: thickness range, finish, tannage, grade mix, origin; fabrics: width, weight,
 * origin; any other: origin), each checked by the domain's own rule before it is sent (the same as the API's and the
 * database's), sent as ONE change at the version read; an emptied field removes the value. ⌘Enter saves; Esc closes.
 */
export function AttributesDialog({ depth, model, actions }: { depth: LotDepth; model: Dialog; actions?: LotDepthActions }) {
  const { t, say } = useDepthWords()
  const keys = depth.attributes.keys
  const value = (key: AttributeKey) => model.draft[key] ?? ''
  const set = (key: AttributeKey) => (text: string) => actions?.onAttributeDraft?.({ [key]: text })
  const save = () => {
    if (!model.busy) actions?.onSaveAttributes?.()
  }
  const field = (key: AttributeKey, input: ReactNode, hint?: string) => (
    <Field key={key} label={t(`ld.attr.${key}`)} hint={hint}>
      {input}
    </Field>
  )
  const text = (key: AttributeKey, hint?: string, mode: 'decimal' | 'text' = 'text') =>
    field(key, <Input value={value(key)} inputMode={mode} maxLength={100} onChange={(event) => set(key)(event.target.value)} />, hint)
  return (
    <Modal
      open
      onClose={() => actions?.onAttributes?.(false)}
      title={t('ld.attr.dialogTitle', { code: depth.lot.code })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onAttributes?.(false)}>
            {t('ld.common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={model.busy ? t('ld.common.working') : null} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('ld.attr.save')}
          </Button>
        </>
      }
    >
      <form
        className="fw-ld-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={say(model.problem) ?? ''} />}
        <p className="fw-wl-hint">{t(`ld.attr.kindHint.${depth.attributes.kind === 'LEATHER' ? 'LEATHER' : keys.includes('widthCm') ? 'FABRIC' : 'OTHER'}`)}</p>
        <div className="fw-ld-form">
          {keys.includes('thicknessMinMm') && text('thicknessMinMm', t('ld.attr.mmHint'), 'decimal')}
          {keys.includes('thicknessMaxMm') && text('thicknessMaxMm', t('ld.attr.mmHint'), 'decimal')}
          {keys.includes('finish') && text('finish')}
          {keys.includes('tannage') &&
            field(
              'tannage',
              <Select value={value('tannage')} onChange={(event) => set('tannage')(event.target.value)}>
                <option value="">{t('ld.attr.notRecorded')}</option>
                {TANNAGE_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {t(`ld.attr.tannages.${choice}`)}
                  </option>
                ))}
              </Select>,
            )}
          {keys.includes('gradeMix') && text('gradeMix', t('ld.attr.gradeMixHint'))}
          {keys.includes('widthCm') && text('widthCm', t('ld.attr.cmHint'), 'decimal')}
          {keys.includes('weightGsm') && text('weightGsm', t('ld.attr.gsmHint'), 'decimal')}
          {keys.includes('origin') && text('origin', t('ld.attr.originHint'))}
        </div>
        <p className="fw-wl-hint">{t('ld.attr.emptyRemoves')}</p>
      </form>
    </Modal>
  )
}
