'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Kbd, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { nameIn, newTemplateHeld, PRODUCT_TYPES, type NewTemplateDraft, type ProductType, type TemplateCan } from '../model'
import { useWords } from '../parts'
import type { NewTemplateModel, TemplatesListActions } from './TemplatesListView'

/**
 * New measurement template (design pop:sizes.newTemplate): the garment type code (fixed once a rider is measured for it), its
 * name and product type, which company keeps it (several companies: every company's by default), and where its points start —
 * blank (the first point: code, name, unit) or a copy of another template's points (codes, names, units, ranges, how to).
 * Create is held with its reason before the click; ⌘↵ creates, Esc closes. Made-to-measure starts OFF on a new template.
 */
export function NewTemplateDialog({ model, can, actions }: { model: NewTemplateModel; can: TemplateCan; actions?: TemplatesListActions }) {
  const { t, say, locale } = useWords()
  const draft = model.draft
  const set = (patch: Partial<NewTemplateDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  const held = newTemplateHeld(draft, { can, busy: model.busy, taken: model.templates.map((row) => row.code), copy: draft.start === 'copy' ? model.copy : [] })
  const refused = (field: string) => (model.refused.some((path) => path === field || path.startsWith(`${field}/`)) ? t('new.refused') : undefined)
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  const copyCount = draft.start === 'copy' && Array.isArray(model.copy) ? model.copy.length : null
  return (
    <Modal
      open
      onClose={() => actions?.onNew?.(false)}
      title={t('new.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onNew?.(false)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={say(held)} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('new.create')} <Kbd>⌘↵</Kbd>
          </Button>
        </>
      }
    >
      <div
        className="fw-lib-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <p className="fw-lib-hint">{t('new.intro')}</p>
        <div className="fw-lib-form-grid">
          {model.companies.length > 1 && (
            <Field label={t('new.company')} hint={t('new.companyHint')}>
              <Select value={draft.companyId ?? ''} onChange={(event) => set({ companyId: event.target.value || null })}>
                <option value="">{t('new.everyCompany')}</option>
                {model.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('new.code')} required hint={t('new.codeHint')} error={refused('code')}>
            <Input value={draft.code} maxLength={40} autoFocus onChange={(event) => set({ code: event.target.value.toUpperCase().replace(/\s+/g, '_') })} />
          </Field>
          <Field label={t('new.name')} required error={refused('name')}>
            <Input value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label={t('new.type')} required hint={t('new.typeHint')} error={refused('productType')}>
            <Select value={draft.productType} onChange={(event) => set({ productType: event.target.value as ProductType | '' })}>
              <option value="">{t('new.typePick')}</option>
              {PRODUCT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`type.${type}`)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="fw-lib-span">
            <Field label={t('new.start')}>
              <SegmentedControl
                ariaLabel={t('new.start')}
                size="sm"
                value={draft.start}
                onChange={(value) => set({ start: value as NewTemplateDraft['start'] })}
                options={[
                  { value: 'blank', label: t('new.startBlank') },
                  { value: 'copy', label: t('new.startCopy') },
                ]}
              />
            </Field>
          </div>
          {draft.start === 'copy' ? (
            <div className="fw-lib-span">
              <Field label={t('new.copyFrom')} hint={copyCount !== null ? t('new.copyCount', { count: copyCount }) : model.copy === 'failed' ? t('new.held.copyFailed') : draft.copyFromId ? t('new.held.copyReading') : t('new.copyHint')}>
                <Select value={draft.copyFromId} onChange={(event) => set({ copyFromId: event.target.value })}>
                  <option value="">{t('new.copyPick')}</option>
                  {model.templates.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.code} · {nameIn(row, locale)} — {t('list.points', { count: row.points })}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : (
            <>
              <Field label={t('new.firstCode')} required hint={t('new.firstCodeHint')} error={refused('points/0/code')}>
                <Input value={draft.firstCode} maxLength={60} onChange={(event) => set({ firstCode: event.target.value.replace(/\s+/g, '_') })} />
              </Field>
              <Field label={t('new.firstName')} required error={refused('points/0/name')}>
                <Input value={draft.firstName} maxLength={200} onChange={(event) => set({ firstName: event.target.value })} />
              </Field>
              <Field label={t('point.unit')}>
                <Select value={draft.firstUom} onChange={(event) => set({ firstUom: event.target.value === 'MM' ? 'MM' : 'CM' })}>
                  <option value="CM">{t('unit.CM')}</option>
                  <option value="MM">{t('unit.MM')}</option>
                </Select>
              </Field>
            </>
          )}
        </div>
        <p className="fw-lib-hint">{t('new.after')}</p>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}
