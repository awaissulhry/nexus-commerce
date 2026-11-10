'use client'

import { useRef } from 'react'
import { ImagePlus } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { Swatch } from '../../_shared/Swatch'
import { refusedField } from '../../library/model'
import { COLOUR_SYSTEMS, colourDraftProblems, pictureAddress, typedHex, type ColourDraft, type ColoursCan } from '../model'
import { REFERENCE_EXAMPLES, REFERENCE_REQUIRED } from '@nexus/factory-domain/product/colours/rules'
import type { ColourFormModel, ColoursActions } from '../view-model'

/**
 * New colour / Edit colour (SCR-118; `c`, the band's New colour, a row's ⋯ Edit…): the company (or every company), our code
 * (new only: it never changes), the name and its Italian and English names, the system and its reference (the system's
 * own form, an example per system), the family, the hex with its swatch, and — when editing — the photo (a picture file of
 * the colour, sent at once). factory-domain's own rules are said under each field as typed; Save is held with the first
 * reason. ⌘↵ saves.
 */
export function ColourFormDialog({ form, can, actions }: { form: ColourFormModel; can: ColoursCan; actions?: ColoursActions }) {
  const t = useT('products-colours')
  const tl = useT('library')
  const photoInput = useRef<HTMLInputElement>(null)
  const draft = form.draft
  const set = (patch: Partial<ColourDraft>) => actions?.onColourDraft?.({ ...draft, ...patch })
  const problems = colourDraftProblems(draft)
  const touched = draft.code.trim() !== '' || draft.name.trim() !== ''
  const problemAt = (field: string): string | undefined => {
    if (refusedField(form.refused, field)) return t('form.refused')
    if (!touched && form.mode === 'new') return undefined
    const issue = problems.find((entry) => entry.path === field || entry.path.startsWith(`${field}/`))
    return issue ? t(`form.problem.${field.replace('/', '.')}`) : undefined
  }
  const held = problems.length > 0 ? t('form.held.problems', { count: problems.length }) : form.busy ? tl('held.busy') : null
  const save = () => {
    if (!held) actions?.onSaveColour?.()
  }
  const hex = typedHex(draft.hex)
  const photo = form.row?.photo ? pictureAddress(form.row.photo.url) : null
  const system = draft.system || null
  return (
    <Modal
      open
      onClose={() => actions?.onColourForm?.(null)}
      title={form.mode === 'new' ? t('form.newTitle') : t('form.editTitle', { code: form.row?.code ?? '' })}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onColourForm?.(null)}>{tl('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {form.busy ? <Spinner size={12} /> : null} {form.mode === 'new' ? t('form.create') : t('form.save')}
          </Button>
        </>
      }
    >
      <div
        className="fw-lib-dialog fw-col-form"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        {form.problem && (
          <Banner tone="danger" title={tl(form.problem)}>
            {form.messages.length > 0 ? form.messages.join(' ') : null}
          </Banner>
        )}
        <div className="fw-col-form-grid">
          {form.mode === 'new' && (form.companies.length > 1 || form.everyCompany) && (
            <Field label={t('form.company')} hint={draft.companyId ? t('form.companyHint') : t('form.everyCompanyHint')}>
              <Select value={draft.companyId} onChange={(event) => set({ companyId: event.target.value })}>
                {form.everyCompany && <option value="">{t('form.everyCompany')}</option>}
                {form.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('form.code')} hint={form.mode === 'new' ? t('form.codeHint') : t('form.codeFixed')} error={form.mode === 'new' ? problemAt('code') : undefined}>
            <Input value={draft.code} maxLength={40} readOnly={form.mode === 'edit'} onChange={(event) => set({ code: event.target.value })} autoFocus={form.mode === 'new'} />
          </Field>
          <Field label={t('form.name')} error={problemAt('name')}>
            <Input value={draft.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} autoFocus={form.mode === 'edit'} />
          </Field>
          <Field label={t('form.nameIt')} error={problemAt('names/it')}>
            <Input value={draft.it} maxLength={120} lang="it" onChange={(event) => set({ it: event.target.value })} />
          </Field>
          <Field label={t('form.nameEn')} error={problemAt('names/en')}>
            <Input value={draft.en} maxLength={120} lang="en" onChange={(event) => set({ en: event.target.value })} />
          </Field>
          <Field label={t('form.system')} hint={t('form.systemHint')}>
            <Select value={draft.system} onChange={(event) => set({ system: event.target.value as ColourDraft['system'], ...(event.target.value === '' ? { reference: '' } : {}) })}>
              <option value="">{t('form.noSystem')}</option>
              {COLOUR_SYSTEMS.map((code) => (
                <option key={code} value={code}>
                  {t(`system.${code}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('form.reference')}
            hint={system ? t(REFERENCE_REQUIRED.includes(system) ? 'form.referenceNeeded' : 'form.referenceOwn', { example: REFERENCE_EXAMPLES[system] }) : t('form.referenceNoSystem')}
            error={problemAt('reference')}
          >
            <Input value={draft.reference} maxLength={40} disabled={!system} onChange={(event) => set({ reference: event.target.value })} />
          </Field>
          <Field label={t('form.family')} hint={t('form.familyHint')} error={problemAt('family')}>
            <Input value={draft.family} maxLength={40} onChange={(event) => set({ family: event.target.value })} />
          </Field>
          <span className="fw-col-hex">
            <Swatch hex={hex} name={draft.name || draft.code || t('form.thisColour')} size="lg" noHex={t('swatch.noHex')} />
            <Field label={t('form.hex')} hint={t('form.hexHint')} error={problemAt('hex')}>
              <Input value={draft.hex} maxLength={20} className="fw-col-mono" onChange={(event) => set({ hex: event.target.value })} />
            </Field>
          </span>
        </div>
        {form.mode === 'edit' && form.row && (
          <div className="fw-col-photo-edit">
            <h3 className="fw-lib-h3">{t('form.photo')}</h3>
            <div className="fw-col-photo-row">
              {photo ? <img className="fw-col-photo-lg" src={photo} alt={t('list.photoOf', { code: form.row.code })} /> : <span className="fw-lib-hint">{t('form.noPhoto')}</span>}
              <input
                ref={photoInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) actions?.onPhoto?.(file)
                  event.target.value = ''
                }}
              />
              <Button size="sm" heldReason={!can.upload ? t('held.noUpload') : form.photo.busy ? tl('held.busy') : null} onClick={() => photoInput.current?.click()}>
                {form.photo.busy ? <Spinner size={12} /> : <ImagePlus size={13} aria-hidden />} {photo ? t('form.replacePhoto') : t('form.addPhoto')}
              </Button>
            </div>
            <p className="fw-lib-hint">{t('form.photoHint')}</p>
            {form.photo.problem && <Banner tone="danger" title={tl(form.photo.problem)} />}
          </div>
        )}
      </div>
    </Modal>
  )
}
