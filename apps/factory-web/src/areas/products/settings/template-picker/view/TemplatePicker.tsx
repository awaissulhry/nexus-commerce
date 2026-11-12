'use client'

import { Field } from '@nexus/ui/components'
import { Select } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { TemplateRef } from '../api'
import { NS, templateChoices, templateName } from '../model'

/**
 * Products › Settings › a product type's measurement template (B-W2b-283, FU1:03): a pick of the active templates of the
 * type's kind of garment and company (it was only shown and cleared, B-W2b-239), the one it names kept as an option when it
 * is no longer offered (archived, another kind), "the parent's" or "none" first. While the list is read or when it cannot
 * be, the value stays as text with why. Draws what it is given; fetches nothing.
 */
export function TemplatePicker({
  label,
  templates,
  draft,
  current,
  inherits,
  emptyOption,
  error,
  onPick,
}: {
  label: string
  /** null: not read yet; `problem`: the read failed. */
  templates: { readonly value: readonly TemplateRef[] | null; readonly problem: string | null } | null
  draft: { readonly productType: string; readonly companyId: string | null; readonly measurementTemplateId: string | null }
  /** "CODE · name" of the template the type names now (null: none). */
  current: string | null
  /** "Inherits … from …" when the type names none, else null. */
  inherits: string | null
  /** The empty option's words ("The parent's", "None"). */
  emptyOption: string
  error?: string | undefined
  onPick: (templateId: string | null) => void
}) {
  // `w`, not `t`: Product settings' own key test reads every w('…') under this folder as a products-settings key.
  const w = useT(NS)
  const locale = useLocale()
  const list = templates?.value ?? null
  const choices = list ? templateChoices(list, draft) : []
  const named = draft.measurementTemplateId ? (list?.find((template) => template.id === draft.measurementTemplateId) ?? null) : null
  const hint = draft.measurementTemplateId === null ? (inherits ?? w('templates.hint')) : w('templates.hint')
  if (!list) {
    return (
      <Field label={label} hint={templates?.problem ? w('templates.failed') : w('templates.reading')} error={error}>
        <span className="fw-pst-text">{current ?? inherits ?? '—'}</span>
      </Field>
    )
  }
  const words = (template: TemplateRef) => w('templates.option', { code: template.code, name: templateName(template, locale), count: template.points })
  return (
    <Field label={label} hint={choices.length === 0 && !draft.measurementTemplateId ? w('templates.none') : hint} error={error}>
      <Select size="sm" value={draft.measurementTemplateId ?? ''} onChange={(event) => onPick(event.target.value || null)}>
        <option value="">{emptyOption}</option>
        {draft.measurementTemplateId && !choices.some((template) => template.id === draft.measurementTemplateId) && (
          <option value={draft.measurementTemplateId}>{named ? w('templates.notOffered', { template: words(named) }) : (current ?? w('templates.unknown'))}</option>
        )}
        {choices.map((template) => (
          <option key={template.id} value={template.id}>
            {template.rulesOn ? w('templates.optionRulesOn', { template: words(template) }) : words(template)}
          </option>
        ))}
      </Select>
    </Field>
  )
}
