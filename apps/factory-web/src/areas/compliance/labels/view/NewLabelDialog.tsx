'use client'

import { useState } from 'react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Spinner, TokenChip } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { languagesTyped, newLabelHeld, type LabelsCan, type NewLabelDraft } from '../model'
import type { LabelsListActions, NewLabelModel } from '../view-model'

/**
 * New label (design lb-new): a style's own label (its code defaults to LBL-<style code>) or a label shared by several
 * styles (its code typed), the label to start from (any label the person may see: another style's, a company template)
 * or the defaults, the languages it prints and its size. Create makes revision 1, a draft, and opens it; its problems
 * are listed there (a draft saves even incomplete).
 */
export function NewLabelDialog({ model, can, actions }: { model: NewLabelModel; can: LabelsCan; actions?: LabelsListActions }) {
  const t = useT('labels')
  const q = useT('quality')
  const draft = model.draft
  const set = (patch: Partial<NewLabelDraft>) => actions?.onNewDraft?.({ ...draft, ...patch })
  const held = newLabelHeld(draft, can, model.busy)
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  const styles = model.styles
  return (
    <Modal
      open
      onClose={() => actions?.onNewLabel?.(false)}
      title={t('new.title')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onNewLabel?.(false)}>{q('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('new.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-q-form"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <p className="fw-q-hint">{t('new.intro')}</p>
        <SegmentedControl
          ariaLabel={t('new.kind')}
          size="sm"
          value={draft.kind}
          onChange={(value) => set({ kind: value as NewLabelDraft['kind'] })}
          options={[
            { value: 'style', label: t('new.kindStyle') },
            { value: 'shared', label: t('new.kindShared') },
          ]}
        />
        {draft.kind === 'style' && (
          <Field label={t('new.style')} required hint={can.styles ? t('new.styleHint') : t('new.styleNoRight')}>
            {draft.style ? (
              <span className="fw-q-cell-row">
                <span className="fw-q-code">{draft.style.code}</span> <span>{draft.style.name}</span>
                <Button size="sm" variant="link" onClick={() => set({ style: null })}>
                  {t('new.changeStyle')}
                </Button>
              </span>
            ) : (
              <div className="fw-lb-pick">
                <Input size="sm" type="search" aria-label={t('new.styleSearch')} placeholder={t('new.styleSearch')} value={model.styleQuery} disabled={!can.styles} onChange={(event) => actions?.onStyleQuery?.(event.target.value)} autoFocus />
                {styles?.problem && <p className="fw-q-hint">{q(styles.problem)}</p>}
                {styles && !styles.problem && styles.value === null && (
                  <p className="fw-q-loading" role="status">
                    <Spinner size={12} /> {q('common.loading')}
                  </p>
                )}
                {styles?.value && styles.value.length === 0 && <p className="fw-q-hint">{t('new.noStyles')}</p>}
                {styles?.value && styles.value.length > 0 && (
                  <ul className="fw-lb-picklist" aria-label={t('new.styleResults')}>
                    {styles.value.map((style) => (
                      <li key={style.id}>
                        <Button size="sm" variant="quiet" onClick={() => set({ style: { id: style.id, code: style.code, name: style.name } })}>
                          <span className="fw-q-code">{style.code}</span> {style.name}
                          <span className="fw-q-hint">{style.ppeStandard ? `· ${[style.ppeStandard, style.ppeClass].filter(Boolean).join(' ')}` : `· ${t('list.notPpe')}`}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Field>
        )}
        <div className="fw-q-form-two">
          <Field label={t('new.code')} required={draft.kind === 'shared'} hint={draft.kind === 'shared' ? t('new.codeSharedHint') : t('new.codeStyleHint', { code: draft.style ? `LBL-${draft.style.code}` : 'LBL-…' })}>
            <Input value={draft.code} maxLength={32} onChange={(event) => set({ code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('new.from')} hint={t('new.fromHint')}>
            <Select value={draft.fromTemplateId ?? ''} onChange={(event) => set({ fromTemplateId: event.target.value || null })}>
              <option value="">{t('new.fromDefaults')}</option>
              {model.sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {t('new.fromOption', { code: source.code, revision: source.revision, name: source.name })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <LanguagesField value={draft.languages} onChange={(languages) => set({ languages })} />
        <div className="fw-q-form-two">
          <Field label={t('new.width')} hint={t('new.widthHint')}>
            <Input inputMode="decimal" value={draft.widthMm} onChange={(event) => set({ widthMm: event.target.value })} />
          </Field>
          <Field label={t('new.height')} hint={t('new.heightHint')}>
            <Input inputMode="decimal" value={draft.heightMm} onChange={(event) => set({ heightMm: event.target.value })} />
          </Field>
        </div>
        <p className="fw-q-hint">{t('new.after')}</p>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}

/** The languages a label prints: chips with remove, and a field that adds the codes typed (ISO 639-1: it, en, de…). */
export function LanguagesField({ value, onChange, disabled }: { value: readonly string[]; onChange: (languages: string[]) => void; disabled?: boolean }) {
  const t = useT('labels')
  const [typed, setTyped] = useState('')
  const add = () => {
    const next = languagesTyped([...value, typed].join(' '))
    if (next.length !== value.length) onChange(next)
    setTyped('')
  }
  return (
    <Field label={t('field.languages')} required hint={t('field.languagesHint')}>
      <div className="fw-lb-langs">
        {value.map((language) => (
          <TokenChip key={language} onRemove={disabled ? undefined : () => onChange(value.filter((entry) => entry !== language))} removeLabel={t('field.removeLanguage', { language })}>
            <span className="fw-q-code">{language}</span>
          </TokenChip>
        ))}
        {!disabled && value.length < 8 && (
          <span className="fw-lb-langs-add">
            <Input
              size="sm"
              aria-label={t('field.addLanguage')}
              placeholder={t('field.addLanguagePlaceholder')}
              value={typed}
              maxLength={20}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ',') {
                  event.preventDefault()
                  add()
                }
              }}
            />
            <Button size="sm" onClick={add} heldReason={typed.trim() ? null : t('held.typeLanguage')}>
              {t('field.add')}
            </Button>
          </span>
        )}
      </div>
    </Field>
  )
}
