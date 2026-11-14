'use client'

import { useState } from 'react'
import { Search } from 'lucide-react'
import { EmptyState, Field as DsField } from '@nexus/ui/components'
import { Input, Tag, Toggle } from '@nexus/ui/primitives'
import { DateField, Listbox, MultiSelect } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Field } from '../api'
import { FIELDS_NS, labelIn, sectionText, type PreviewSection } from '../model'

/**
 * The live form preview (design admin.fields sec:preview, "How the record's form looks with these fields"; and the "Add
 * field to …" pop-up's own preview): each section with its fields as the record's form shows them — the label in the
 * reader's language, required, the control of the type with what a person types into it (nothing is saved), and what
 * only some people see. Design-system parts only: Field, Input, Listbox, MultiSelect, DateField, Toggle.
 */
export function FormPreview({ sections, recordLabel, emptyKey = 'preview.empty' }: { sections: readonly PreviewSection[]; recordLabel: string; emptyKey?: string }) {
  const t = useT(FIELDS_NS)
  if (sections.length === 0) return <EmptyState title={t(emptyKey, { record: recordLabel })} description={t('preview.emptyBody')} />
  return (
    <div className="fw-flds-preview">
      {sections.map((section) => (
        <fieldset key={section.section} className="fw-flds-preview-section">
          <legend>{sectionText(section.section) ?? t('section.custom')}</legend>
          <div className="fw-flds-preview-grid">
            {section.fields.map((field) => (
              <PreviewControl key={field.id} field={field} recordLabel={recordLabel} />
            ))}
          </div>
        </fieldset>
      ))}
      <p className="fw-flds-muted">{t('preview.note')}</p>
    </div>
  )
}

/** One field as its form draws it: a control the reader may try (kept in this preview only). */
export function PreviewControl({ field, recordLabel }: { field: Field; recordLabel: string }) {
  const t = useT(FIELDS_NS)
  const locale = useLocale()
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [on, setOn] = useState(false)
  const label = labelIn(field, locale).trim() || t('preview.unnamed')
  const hints = [
    field.unit ? t('preview.unit', { unit: field.unit }) : null,
    field.audience === 'MONEY' && field.grain ? t('preview.money', { grain: t(`grain.${field.grain}`) }) : null,
    field.audience === 'PERSONAL' ? t('preview.personal') : null,
    field.shownInPortal ? t('preview.portal') : null,
  ].filter((hint): hint is string => hint !== null)
  const options = (field.picklist?.values ?? []).filter((value) => value.active).map((value) => ({ value: value.code, label: labelIn(value, locale) }))
  const hint = hints.length > 0 ? hints.join(' · ') : undefined

  let control
  switch (field.type) {
    case 'NUMBER':
      control = <Input inputMode="decimal" value={text} suffix={field.unit ?? undefined} onChange={(event) => setText(event.target.value)} />
      break
    case 'MONEY':
      control = <Input inputMode="decimal" value={text} prefix="€" onChange={(event) => setText(event.target.value)} />
      break
    case 'DATE':
      control = <DateField value={text} clearable onChange={setText} />
      break
    case 'SELECT':
      control = <Listbox options={options} value={text} emptyLabel={t('preview.notFilled')} emptyIsPlaceholder onChange={setText} ariaLabel={label} />
      break
    case 'MULTI_SELECT':
      control = <MultiSelect options={options} value={picked} placeholder={t('preview.notFilled')} onChange={setPicked} ariaLabel={label} />
      break
    case 'PERSON':
      control = <Listbox options={[]} value="" emptyLabel={t('preview.person')} emptyIsPlaceholder onChange={() => undefined} ariaLabel={label} />
      break
    case 'LINK':
      control = <Input leadingIcon={<Search size={13} aria-hidden />} value={text} placeholder={field.linkRecordType ? t('preview.link', { record: t(`recordType.${field.linkRecordType}`) }) : t('preview.linkAny')} onChange={(event) => setText(event.target.value)} />
      break
    case 'FILE':
      control = <Listbox options={[]} value="" emptyLabel={t('preview.file', { record: recordLabel })} emptyIsPlaceholder onChange={() => undefined} ariaLabel={label} />
      break
    case 'YES_NO':
      control = (
        <span className="fw-flds-inline">
          <Toggle checked={on} onChange={setOn} aria-label={label} />
          <span>{t(on ? 'preview.yes' : 'preview.no')}</span>
        </span>
      )
      break
    default:
      control = <Input value={text} onChange={(event) => setText(event.target.value)} />
  }
  return (
    <div className="fw-flds-preview-field">
      <DsField label={label} required={field.required} hint={hint}>
        {control}
      </DsField>
      {field.status === 'ARCHIVED' && <Tag tone="neutral">{t('state.ARCHIVED')}</Tag>}
    </div>
  )
}
