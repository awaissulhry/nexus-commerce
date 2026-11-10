'use client'

import { useEffect, type ReactNode } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Kbd, Select } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import type { ProductType } from '../api'
import { inheritedOf, kindHeld, mayKeepTypeOf, parentChoices, PPE_CATEGORIES, PRODUCT_TYPES, REQUIRABLE_ATTRIBUTES, typeChanged, typeProblems, type GarmentKind, type PpeCategory, type RequirableAttribute, type TypeDraft } from '../model'
import type { ProductSettingsActions, ProductSettingsModel } from '../view-model'
import { ChangedLine } from './parts'

/** ⌘↵ inside the dialog saves while Save is not held. */
function useSubmitKey(open: boolean, held: boolean, run: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        run()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

/**
 * A product type (design psettings.types "Per type: required fields, defaults"; PRD-008): its code, name, kind of garment,
 * whose it is and its parent; the style fields a style of it must fill before release (a parent's come on top, ticked and
 * fixed); the defaults a new style takes (size scale, label template, measurement template, PPE category, standard and class),
 * each saying what it inherits when it sets none. Problems at their fields; Save held with the first. A reader, an archived
 * type and offline: the same facts as text. Archive / Restore here too (its styles keep it).
 */
export function TypeDialog({ model, actions }: { model: ProductSettingsModel; actions?: ProductSettingsActions }) {
  const t = useT('products-settings')
  const dialog = model.typeDialog
  const types = model.types.value ?? []
  const draft = dialog?.draft ?? null
  const type = draft?.id ? (types.find((entry) => entry.id === draft.id) ?? null) : null
  const inherited = draft ? inheritedOf(types, draft) : null
  const archived = type?.status === 'ARCHIVED'
  // Offline the form stays (kept on this page); Save is held with why.
  const may = draft ? mayKeepTypeOf(model.address.scope, model.settings.value, model.tenant.value, false, draft.companyId) : false
  const editable = may && !archived
  const problems = draft ? typeProblems(draft, inherited) : {}
  const changed = draft ? typeChanged(type, draft) : []
  const firstProblem = Object.values(problems)[0] ?? null
  const held = !draft
    ? 'held.reading'
    : !editable
      ? archived
        ? 'type.held.archived'
        : draft.companyId === null
          ? 'held.noRightAll'
          : 'held.noRight'
      : model.live === 'offline'
        ? 'held.offline'
        : model.busy !== null
        ? 'held.busy'
        : type && changed.length === 0
          ? 'type.held.nothing'
          : firstProblem
  useSubmitKey(!!dialog, !!held, () => actions?.onTypeSave?.())
  if (!dialog || !draft) return null
  const set = (patch: Partial<TypeDraft>) => actions?.onTypeDraft?.({ ...draft, ...patch })
  const at = (field: string): string | undefined => {
    const server = dialog.problem?.fields[field]
    if (server) return t(server)
    return dialog.shown && problems[field] ? t(problems[field]!) : undefined
  }
  const parent = draft.parentId ? (types.find((entry) => entry.id === draft.parentId) ?? null) : null
  const codeOf = (id: string | null) => (id ? (types.find((entry) => entry.id === id)?.code ?? '…') : '')
  const scaleWords = (id: string | null, from: ProductType | null): string | null => {
    if (!id) return null
    const known = model.scales?.value?.find((scale) => scale.id === id) ?? (from?.refs.sizeScale?.id === id ? from.refs.sizeScale : null) ?? (type?.refs.sizeScale?.id === id ? type.refs.sizeScale : null)
    return known ? `${known.code} · ${known.name}` : t('type.unknownRef')
  }
  const labelWords = (id: string | null, from: ProductType | null): string | null => {
    if (!id) return null
    const known = model.labels?.value?.find((label) => label.id === id) ?? (from?.refs.labelTemplate?.id === id ? from.refs.labelTemplate : null) ?? (type?.refs.labelTemplate?.id === id ? type.refs.labelTemplate : null)
    return known ? `${known.code} · ${known.name}` : t('type.unknownRef')
  }
  const templateWords = (id: string | null, from: ProductType | null): string | null => {
    if (!id) return null
    const known = (from?.refs.measurementTemplate?.id === id ? from.refs.measurementTemplate : null) ?? (type?.refs.measurementTemplate?.id === id ? type.refs.measurementTemplate : null)
    return known ? `${known.code} · ${known.name}` : t('type.unknownRef')
  }
  /** "Inherits EU-JKT · Jackets EU from DEMO-JKT" when the type sets none of its own. */
  const inherits = (field: keyof ProductType['effective']['defaults'], words: string | null): string | undefined => {
    const value = inherited?.defaults[field]
    if (!value || value.value === null) return undefined
    return t('type.inherits', { value: words ?? String(value.value), code: codeOf(value.fromTypeId) })
  }
  const ppeWords = (category: PpeCategory | null) => (category ? t(`ppe.${category}`) : null)
  const inheritedRequired = new Map((inherited?.requiredAttributes ?? []).map((entry) => [entry.name, entry.fromTypeId]))
  const title = type ? t('type.titleOf', { code: type.code, name: type.name }) : t('type.titleNew')

  const facts = (): ReactNode => {
    const own = draft
    const defaults = type?.effective.defaults
    const required = type ? type.effective.requiredAttributes : own.requiredAttributes.map((name) => ({ name, fromTypeId: '' }))
    const valueOr = (value: string | null, field: keyof ProductType['effective']['defaults'], words: string | null) => value ?? inherits(field, words) ?? '—'
    return (
      <KeyValue
        columns={2}
        dense
        labelCase="sentence"
        items={[
          { label: t('type.code'), value: own.code || '—' },
          { label: t('type.name'), value: own.name || '—' },
          { label: t('type.kind'), value: t(`garment.${own.productType}`) },
          { label: t('type.whose'), value: own.companyId === null ? t('types.everyCompany') : t('types.thisCompany') },
          { label: t('type.parent'), value: parent ? `${parent.code} · ${parent.name}` : t('type.noParent') },
          { label: t('type.required'), value: required.length > 0 ? required.map((entry) => t(`attr.${entry.name}`)).join(', ') : t('types.noneRequired') },
          { label: t('type.scale'), value: valueOr(scaleWords(own.defaultSizeScaleId, null), 'defaultSizeScaleId', scaleWords(defaults?.defaultSizeScaleId.value ?? inherited?.defaults.defaultSizeScaleId.value ?? null, parent)) },
          { label: t('type.label'), value: valueOr(labelWords(own.labelTemplateId, null), 'labelTemplateId', labelWords(inherited?.defaults.labelTemplateId.value ?? null, parent)) },
          { label: t('type.template'), value: valueOr(templateWords(own.measurementTemplateId, null), 'measurementTemplateId', templateWords(inherited?.defaults.measurementTemplateId.value ?? null, parent)) },
          { label: t('type.ppeCategory'), value: valueOr(ppeWords(own.defaultPpeCategory), 'defaultPpeCategory', ppeWords(inherited?.defaults.defaultPpeCategory.value ?? null)) },
          { label: t('type.standard'), value: valueOr(own.defaultPpeStandard || null, 'defaultPpeStandard', inherited?.defaults.defaultPpeStandard.value ?? null) },
          { label: t('type.ppeClass'), value: valueOr(own.defaultPpeClass || null, 'defaultPpeClass', inherited?.defaults.defaultPpeClass.value ?? null) },
        ]}
      />
    )
  }

  const whoseOptions = [
    ...(model.address.scope === 'company' && model.companyId && mayKeepTypeOf(model.address.scope, model.settings.value, model.tenant.value, false, model.companyId) ? [{ value: model.companyId, label: t('type.whoseCompany', { company: model.companyName }) }] : []),
    ...(mayKeepTypeOf(model.address.scope, model.settings.value, model.tenant.value, false, null) ? [{ value: '', label: t('types.everyCompany') }] : []),
  ]
  const scales = (model.scales?.value ?? []).filter((scale) => scale.companyId === null || scale.companyId === draft.companyId)
  const labels = (model.labels?.value ?? []).filter((label) => label.companyId === null || label.companyId === draft.companyId)
  const kindLocked = kindHeld(type)

  const form = (): ReactNode => (
    <div className="fw-pst-stack">
      <div className="fw-pst-form-grid">
        <Field label={t('type.code')} hint={t('type.codeHint')} error={at('code')} required>
          <Input size="sm" value={draft.code} maxLength={60} autoComplete="off" onChange={(event) => set({ code: event.target.value })} />
        </Field>
        <Field label={t('type.name')} error={at('name')} required>
          <Input size="sm" value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field label={t('type.kind')} hint={kindLocked ? t(kindLocked) : t('type.kindHint')} error={at('productType')}>
          <Select size="sm" value={draft.productType} disabled={!!kindLocked} title={kindLocked ? t(kindLocked) : undefined} onChange={(event) => set({ productType: event.target.value as GarmentKind, parentId: null })}>
            {PRODUCT_TYPES.map((kind) => (
              <option key={kind} value={kind}>
                {t(`garment.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        {type ? (
          <Field label={t('type.whose')} hint={t('type.whoseFixed')}>
            <span className="fw-pst-text">{draft.companyId === null ? t('types.everyCompany') : t('types.thisCompany')}</span>
          </Field>
        ) : (
          <Field label={t('type.whose')} hint={t('type.whoseHint')}>
            <Select size="sm" value={draft.companyId ?? ''} onChange={(event) => set({ companyId: event.target.value || null, parentId: null })}>
              {whoseOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('type.parent')} hint={t('type.parentHint')} error={at('parentId')}>
          <Select size="sm" value={draft.parentId ?? ''} onChange={(event) => set({ parentId: event.target.value || null })}>
            <option value="">{t('type.noParent')}</option>
            {parentChoices(types, draft).map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.code} · {choice.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset className="fw-pst-choices">
        <legend className="fw-pst-question">{t('type.required')}</legend>
        <p className="fw-pst-hint">{t('type.requiredHint')}</p>
        <div className="fw-pst-ticks">
          {REQUIRABLE_ATTRIBUTES.map((attribute: RequirableAttribute) => {
            const from = inheritedRequired.get(attribute)
            return (
              <Checkbox
                key={attribute}
                label={from ? t('type.requiredFrom', { field: t(`attr.${attribute}`), code: codeOf(from) }) : t(`attr.${attribute}`)}
                checked={!!from || draft.requiredAttributes.includes(attribute)}
                disabled={!!from}
                title={from ? t('type.requiredInherited', { code: codeOf(from) }) : undefined}
                onChange={(event) => set({ requiredAttributes: event.target.checked ? [...draft.requiredAttributes, attribute] : draft.requiredAttributes.filter((entry) => entry !== attribute) })}
              />
            )
          })}
        </div>
        {at('requiredAttributes') && <p className="fw-pst-problem">{at('requiredAttributes')}</p>}
      </fieldset>

      <fieldset className="fw-pst-choices">
        <legend className="fw-pst-question">{t('type.defaults')}</legend>
        <p className="fw-pst-hint">{t('type.defaultsHint')}</p>
        <div className="fw-pst-form-grid">
          <Field label={t('type.scale')} hint={draft.defaultSizeScaleId === null ? (inherits('defaultSizeScaleId', scaleWords(inherited?.defaults.defaultSizeScaleId.value ?? null, parent)) ?? t('type.noneOwn')) : undefined} error={at('defaultSizeScaleId')}>
            <Select size="sm" value={draft.defaultSizeScaleId ?? ''} onChange={(event) => set({ defaultSizeScaleId: event.target.value || null })}>
              <option value="">{t(inherited?.defaults.defaultSizeScaleId.value ? 'type.inheritOption' : 'type.noneOption')}</option>
              {draft.defaultSizeScaleId && !scales.some((scale) => scale.id === draft.defaultSizeScaleId) && <option value={draft.defaultSizeScaleId}>{scaleWords(draft.defaultSizeScaleId, null)}</option>}
              {scales.map((scale) => (
                <option key={scale.id} value={scale.id}>
                  {scale.code} · {scale.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('type.label')} hint={!model.can.labels ? t('type.labelNoRight') : draft.labelTemplateId === null ? (inherits('labelTemplateId', labelWords(inherited?.defaults.labelTemplateId.value ?? null, parent)) ?? t('type.noneOwn')) : undefined} error={at('labelTemplateId')}>
            {model.can.labels ? (
              <Select size="sm" value={draft.labelTemplateId ?? ''} onChange={(event) => set({ labelTemplateId: event.target.value || null })}>
                <option value="">{t(inherited?.defaults.labelTemplateId.value ? 'type.inheritOption' : 'type.noneOption')}</option>
                {draft.labelTemplateId && !labels.some((label) => label.id === draft.labelTemplateId) && <option value={draft.labelTemplateId}>{labelWords(draft.labelTemplateId, null)}</option>}
                {labels.map((label) => (
                  <option key={label.id} value={label.id}>
                    {t('type.labelOption', { code: label.code, name: label.name, revision: label.revision })}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="fw-pst-text">{labelWords(draft.labelTemplateId, null) ?? inherits('labelTemplateId', labelWords(inherited?.defaults.labelTemplateId.value ?? null, parent)) ?? '—'}</span>
            )}
          </Field>
          <Field label={t('type.template')} hint={t('type.templateHint')} error={at('measurementTemplateId')}>
            <span className="fw-pst-text-row">
              <span className="fw-pst-text">{templateWords(draft.measurementTemplateId, null) ?? inherits('measurementTemplateId', templateWords(inherited?.defaults.measurementTemplateId.value ?? null, parent)) ?? '—'}</span>
              {draft.measurementTemplateId && (
                <Button size="sm" variant="quiet" onClick={() => set({ measurementTemplateId: null })}>
                  {t('type.clear')}
                </Button>
              )}
            </span>
          </Field>
          <Field label={t('type.ppeCategory')} hint={draft.defaultPpeCategory === null ? (inherits('defaultPpeCategory', ppeWords(inherited?.defaults.defaultPpeCategory.value ?? null)) ?? t('type.noneOwn')) : undefined} error={at('defaultPpeCategory')}>
            <Select size="sm" value={draft.defaultPpeCategory ?? ''} onChange={(event) => set({ defaultPpeCategory: (event.target.value || null) as PpeCategory | null })}>
              <option value="">{t(inherited?.defaults.defaultPpeCategory.value ? 'type.inheritOption' : 'type.noneOption')}</option>
              {PPE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`ppe.${category}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('type.standard')} hint={draft.defaultPpeStandard.trim() === '' ? (inherits('defaultPpeStandard', null) ?? t('type.standardHint')) : t('type.standardHint')} error={at('defaultPpeStandard')}>
            <Input size="sm" value={draft.defaultPpeStandard} maxLength={60} onChange={(event) => set({ defaultPpeStandard: event.target.value })} />
          </Field>
          <Field label={t('type.ppeClass')} hint={draft.defaultPpeClass.trim() === '' ? (inherits('defaultPpeClass', null) ?? t('type.ppeClassHint')) : t('type.ppeClassHint')} error={at('defaultPpeClass')}>
            <Input size="sm" value={draft.defaultPpeClass} maxLength={10} onChange={(event) => set({ defaultPpeClass: event.target.value })} />
          </Field>
        </div>
      </fieldset>
    </div>
  )

  return (
    <Modal
      open
      onClose={() => actions?.onTypeClose?.()}
      size="lg"
      title={title}
      subtitle={type ? <ChangedLine changed={dialog.changedBy ?? { at: type.updatedAt, by: null }} href={null} /> : undefined}
      footer={
        <>
          {type && may && (
            <Button variant="secondary" heldReason={model.busy !== null ? t('held.busy') : null} onClick={() => actions?.onTypeMove?.(type, archived ? 'restore' : 'archive')}>
              {t(archived ? 'row.restore' : 'row.archive')}
            </Button>
          )}
          <span className="grow" />
          <Button variant="secondary" onClick={() => actions?.onTypeClose?.()}>
            {editable ? t('common.cancel') : t('common.close')}
          </Button>
          {editable && (
            <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onTypeSave?.()}>
              {type ? t('type.save') : t('type.add')} <Kbd>⌘↵</Kbd>
            </Button>
          )}
        </>
      }
    >
      <div className="fw-pst-stack">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem.key)} />}
        {archived && <Banner tone="info" title={t('type.archivedTitle')}>{t('type.archivedBody')}</Banner>}
        {!editable && !archived && <p className="fw-pst-held">{t(held ?? 'held.noRight')}</p>}
        {editable ? form() : facts()}
        {type && (
          <KeyValue
            columns={2}
            dense
            labelCase="sentence"
            items={[
              { label: t('type.styles'), value: t('type.stylesCount', { count: type.styles }) },
              { label: t('type.children'), value: type.children.length > 0 ? type.children.map((child) => child.code).join(', ') : '—' },
            ]}
          />
        )}
      </div>
    </Modal>
  )
}
