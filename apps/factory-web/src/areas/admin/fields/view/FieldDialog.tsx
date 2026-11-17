'use client'

import { useState, type ComponentType } from 'react'
import { Archive, Calendar, CircleDollarSign, FileText, Hash, Link2, ListChecks, ListTodo, Paperclip, Plus, RotateCcw, ToggleRight, Type, UserRound } from 'lucide-react'
import { GRAINS, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import type { FieldType } from '@nexus/factory-domain/fields/rules'
import { Banner, Card, Field as DsField } from '@nexus/ui/components'
import { Button, Input, RadioCard, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { Listbox, Modal } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { RECORD_KEYS, type EditorField, type Picklist, type RecordType } from '../api'
import { draftHeld, FIELDS_NS, GALLERY, labelIn, portalHeld, previewField, sectionText, typedCode, withDraft, type FieldDraft } from '../model'
import { portalLineOf, whereLineOf } from '../model' // B-TH-242
import { PreviewControl } from './FormPreview'

/** The picture of each field type in the gallery (lucide glyphs: the design system has no type pictures). */
export const TYPE_ICONS: Readonly<Record<FieldType, ComponentType<{ size?: number; 'aria-hidden'?: boolean }>>> = {
  TEXT: Type,
  NUMBER: Hash,
  MONEY: CircleDollarSign,
  DATE: Calendar,
  SELECT: ListChecks,
  MULTI_SELECT: ListTodo,
  PERSON: UserRound,
  LINK: Link2,
  FILE: Paperclip,
  YES_NO: ToggleRight,
}

export interface FieldDialogModel {
  mode: 'new' | 'edit'
  /** The field being changed (edit). */
  field: EditorField | null
  draft: FieldDraft
  /** The last refusal, a `fault.*` key. */
  fault: string | null
  recordType: RecordType
  picklists: readonly Picklist[]
  sections: readonly string[]
  /** The record type's keys already taken. */
  codes: readonly string[]
  grains: readonly Grain[]
  companies: readonly { id: string; name: string }[]
  portalRecord: boolean
  busy: boolean
  canManage: boolean
  // ── B-TH-242: "For: every customer · one customer" (customers, quotes and orders), and the customer picker's search ──
  /** The record type takes a field for one customer. */
  customerChoice?: boolean
  /** The picker: what was typed, the customers found (null while read), the read's refusal (a `fault.*` key). */
  customers?: { query: string; results: ReadonlyArray<{ id: string; code: string; legalName: string }> | null; problem: string | null } | null
}

export interface FieldDialogActions {
  onDraft?: (draft: FieldDraft) => void
  onSave?: () => void
  onClose?: () => void
  /** Archive (keeps its values) or restore the field being changed. */
  onState?: (status: 'ACTIVE' | 'ARCHIVED') => void
  /** No list to pick from yet: go to Picklists. */
  onPicklists?: () => void
  /** B-TH-242: the customer picker's search. */
  onCustomerSearch?: (query: string) => void
}

/**
 * "Add field to Orders" (design admin.fields pop:field; opens from the band's Add field and from a row): the type gallery
 * (a RadioCard with a picture each), labels in Italian and English, the key, what the type needs (a unit, the money's
 * grain, the list, the record type it links to), section, required, who sees it, where it shows, whose field — and its
 * preview. A field keeps its type, key, list, link and company: changing one shows them fixed. ⌘Enter saves, Esc closes.
 */
export function FieldDialog({ model, actions }: { model: FieldDialogModel; actions?: FieldDialogActions }) {
  const t = useT(FIELDS_NS)
  const locale = useLocale()
  const { draft } = model
  const editing = model.mode === 'edit' ? model.field : null
  const grains = new Set(model.grains)
  const [typingSection, setTypingSection] = useState(() => !model.sections.includes(draft.section))
  const set = (patch: Partial<FieldDraft>) => actions?.onDraft?.(withDraft(draft, patch, grains))
  const held = model.canManage ? draftHeld(draft, { editing, codes: model.codes, grains, picklists: model.picklists, busy: model.busy }) : 'wait.noManage'
  const save = () => {
    if (!held) actions?.onSave?.()
  }
  const recordWord = labelIn(model.recordType, locale)
  const portal = portalHeld(draft, model.portalRecord)
  const activeLists = model.picklists.filter((list) => list.status === 'ACTIVE' || list.id === draft.picklistId)
  const title = editing ? t('fieldDialog.titleEdit', { field: labelIn(editing, locale) }) : t('fieldDialog.title', { record: recordWord })
  // B-TH-242: the line under the portal switch (a field for every customer puts its name in every customer's portal), where it shows.
  const portalLine = model.customerChoice ? portalLineOf(draft, model.portalRecord) : null
  const whereLine = model.customerChoice ? whereLineOf(draft) : null
  const TypeIcon = draft.type ? TYPE_ICONS[draft.type] : null

  return (
    <Modal
      open
      size="xl"
      onClose={() => actions?.onClose?.()}
      title={title}
      footer={
        <>
          {editing && model.canManage && (
            <span className="fw-flds-footer-start">
              {editing.status === 'ACTIVE' ? (
                <Button variant="danger-outline" heldReason={model.busy ? t('wait.busy') : null} onClick={() => actions?.onState?.('ARCHIVED')}>
                  <Archive size={14} aria-hidden /> {t('fieldDialog.archive')}
                </Button>
              ) : (
                <Button heldReason={model.busy ? t('wait.busy') : null} onClick={() => actions?.onState?.('ACTIVE')}>
                  <RotateCcw size={14} aria-hidden /> {t('fieldDialog.restore')}
                </Button>
              )}
            </span>
          )}
          <Button onClick={() => actions?.onClose?.()}>{t('fieldDialog.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held, { record: recordWord }) : null} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {editing ? t('fieldDialog.save') : t('fieldDialog.add')}
          </Button>
        </>
      }
    >
      <div
        className="fw-flds-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        <div className="fw-flds-dialog-form">
          {model.fault && <Banner tone="danger" title={t(model.fault)} />}
          {editing ? (
            <div className="fw-flds-fixed">
              <span className="fw-flds-type">
                {TypeIcon && <TypeIcon size={16} aria-hidden />} {t(`type.${editing.type}`)}
              </span>
              <span className="fw-flds-code">{editing.code}</span>
              <span className="fw-flds-muted">{t('fieldDialog.fixed')}</span>
              {editing.valueCount > 0 && <span className="fw-flds-muted">{t('fieldDialog.used', { count: editing.valueCount })}</span>}
            </div>
          ) : (
            <fieldset className="fw-flds-gallery" aria-label={t('fieldDialog.type')}>
              <legend>{t('fieldDialog.type')}</legend>
              <div className="fw-flds-gallery-grid">
                {GALLERY.map((type) => {
                  const Icon = TYPE_ICONS[type]
                  return (
                    <RadioCard
                      key={type}
                      name="fw-flds-type"
                      value={type}
                      checked={draft.type === type}
                      selected={draft.type === type}
                      onChange={() => set({ type })}
                      title={
                        <span className="fw-flds-type">
                          <span className="fw-flds-type-picture">
                            <Icon size={20} aria-hidden />
                          </span>
                          {t(`type.${type}`)}
                        </span>
                      }
                      description={t(`typeHint.${type}`)}
                    />
                  )
                })}
              </div>
            </fieldset>
          )}

          <div className="fw-flds-form-grid">
            <DsField label={t('fieldDialog.labelIt')} required>
              <Input value={draft.labelIt} maxLength={80} lang="it" onChange={(event) => set({ labelIt: event.target.value })} />
            </DsField>
            <DsField label={t('fieldDialog.labelEn')} required>
              <Input value={draft.labelEn} maxLength={80} lang="en" onChange={(event) => set({ labelEn: event.target.value })} />
            </DsField>
            {!editing && (
              <DsField label={t('fieldDialog.code')} required hint={t('fieldDialog.codeHint')} error={draft.code && model.codes.includes(draft.code) ? t('wait.codeTaken') : undefined}>
                <Input value={draft.code} maxLength={40} spellCheck={false} onChange={(event) => set({ code: typedCode(event.target.value) })} />
              </DsField>
            )}
            {draft.type === 'NUMBER' && (
              <DsField label={t('fieldDialog.unit')} hint={t('fieldDialog.unitHint')}>
                <Input value={draft.unit} maxLength={20} onChange={(event) => set({ unit: event.target.value })} />
              </DsField>
            )}
            {!editing && (draft.type === 'SELECT' || draft.type === 'MULTI_SELECT') && (
              <DsField label={t('fieldDialog.list')} required hint={activeLists.length === 0 ? t('wait.noList') : t('fieldDialog.listHint')}>
                {activeLists.length === 0 ? (
                  <Button size="sm" onClick={() => actions?.onPicklists?.()}>
                    <Plus size={13} aria-hidden /> {t('fieldDialog.makeList')}
                  </Button>
                ) : (
                  <Listbox
                    options={activeLists.map((list) => ({ value: list.id, label: labelIn(list, locale), note: t('lists.valueCount', { count: list.values.filter((value) => value.active).length }) }))}
                    value={draft.picklistId ?? ''}
                    emptyLabel={t('fieldDialog.pickList')}
                    emptyIsPlaceholder
                    onChange={(value) => set({ picklistId: value || null })}
                  />
                )}
              </DsField>
            )}
            {editing && editing.picklist && (
              <DsField label={t('fieldDialog.list')}>
                <span className="fw-flds-fixed-value">{labelIn(editing.picklist, locale)}</span>
              </DsField>
            )}
            {!editing && draft.type === 'LINK' && (
              <DsField label={t('fieldDialog.linkTo')} required>
                <Listbox options={RECORD_KEYS.map((key) => ({ value: key, label: t(`recordType.${key}`) }))} value={draft.linkTo ?? ''} emptyLabel={t('fieldDialog.pickRecord')} emptyIsPlaceholder onChange={(value) => set({ linkTo: (value || null) as FieldDraft['linkTo'] })} />
              </DsField>
            )}
            {editing && editing.linkRecordType && (
              <DsField label={t('fieldDialog.linkTo')}>
                <span className="fw-flds-fixed-value">{t(`recordType.${editing.linkRecordType}`)}</span>
              </DsField>
            )}
            <DsField label={t('fieldDialog.section')} hint={typingSection ? t('fieldDialog.sectionHint') : undefined}>
              {typingSection ? (
                <span className="fw-flds-inline">
                  <Input value={draft.section} maxLength={40} spellCheck={false} onChange={(event) => set({ section: typedCode(event.target.value) })} />
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      setTypingSection(false)
                      if (!model.sections.includes(draft.section)) set({ section: model.sections[0] ?? 'custom' })
                    }}
                  >
                    {t('fieldDialog.sectionPick')}
                  </Button>
                </span>
              ) : (
                <Listbox
                  options={model.sections.map((section) => ({ value: section, label: sectionText(section) ?? t('section.custom') }))}
                  value={draft.section}
                  onChange={(value) => set({ section: value })}
                  actions={[{ id: 'new', label: t('fieldDialog.sectionNew'), icon: <Plus size={13} aria-hidden />, onSelect: () => (setTypingSection(true), set({ section: '' })) }]}
                />
              )}
            </DsField>
            <label className="fw-flds-switch">
              <Toggle checked={draft.required} onChange={(required) => set({ required })} aria-label={t('fieldDialog.required')} />
              <span>
                <span>{t('fieldDialog.required')}</span>
                <span className="fw-flds-muted">{t('fieldDialog.requiredHint', { record: recordWord })}</span>
              </span>
            </label>
          </div>

          <fieldset className="fw-flds-choices">
            <legend>{t('fieldDialog.audience')}</legend>
            {draft.type === 'MONEY' ? (
              <p className="fw-flds-muted">{t('fieldDialog.moneyAudience')}</p>
            ) : (
              <div className="fw-flds-choice-row">
                {(['INTERNAL', 'MONEY', 'PERSONAL'] as const).map((audience) => (
                  <RadioCard
                    key={audience}
                    variant="row"
                    name="fw-flds-audience"
                    value={audience}
                    checked={draft.audience === audience}
                    selected={draft.audience === audience}
                    onChange={() => set({ audience })}
                    title={t(`audience.${audience}`)}
                    description={t(`audienceHint.${audience}`, { record: recordWord })}
                  />
                ))}
              </div>
            )}
            {draft.audience === 'MONEY' && (
              <DsField label={t('fieldDialog.grain')} hint={grains.size === 0 ? t('wait.noGrain') : t('fieldDialog.grainHint')}>
                <Listbox
                  options={GRAINS.map((grain) => ({ value: grain, label: t(`grain.${grain}`), ...(grains.has(grain) ? {} : { heldReason: t('wait.grainNotHeld') }) }))}
                  value={draft.grain ?? ''}
                  emptyLabel={t('fieldDialog.pickGrain')}
                  emptyIsPlaceholder
                  onChange={(value) => set({ grain: (value || null) as Grain | null })}
                />
              </DsField>
            )}
          </fieldset>

          <fieldset className="fw-flds-choices">
            <legend>{t('fieldDialog.where')}</legend>
            <p className="fw-flds-muted">{t('fieldDialog.whereAlways')}</p>
            {portal ? (
              <p className="fw-flds-muted">{t('fieldDialog.portalHeld', { reason: t(portal) })}</p>
            ) : (
              <label className="fw-flds-switch">
                <Toggle checked={draft.shownInPortal} onChange={(shownInPortal) => set({ shownInPortal })} aria-label={t('fieldDialog.portal')} />
                <span>
                  <span>{t('fieldDialog.portal')}</span>
                  <span className="fw-flds-muted">{t('fieldDialog.portalHint', { record: recordWord })}</span>
                </span>
              </label>
            )}
            {portalLine && <Banner tone="warning" title={t(portalLine)} />}
          </fieldset>

          {!editing && model.companies.length > 0 && (
            <fieldset className="fw-flds-choices">
              <legend>{t('fieldDialog.whose')}</legend>
              <div className="fw-flds-choice-row">
                <RadioCard variant="row" name="fw-flds-company" value="" checked={draft.companyId === null} selected={draft.companyId === null} onChange={() => set({ companyId: null })} title={t('whose.every')} description={t('whose.everyHint')} />
                {model.companies.map((company) => (
                  <RadioCard key={company.id} variant="row" name="fw-flds-company" value={company.id} checked={draft.companyId === company.id} selected={draft.companyId === company.id} onChange={() => set({ companyId: company.id })} title={t('whose.one', { company: company.name })} description={t('whose.oneHint')} />
                ))}
              </div>
            </fieldset>
          )}
          {editing && <p className="fw-flds-muted">{editing.companyId === null ? t('whose.everyFixed') : t('whose.oneFixed', { company: model.companies.find((company) => company.id === editing.companyId)?.name ?? t('whose.another') })}</p>}

          {/* B-TH-242 (SHEET-G06, X-ADM-FIELDS.dialog-F01): For every customer or one customer only — set once, never changed. */}
          {model.customerChoice && !editing && (
            <fieldset className="fw-flds-choices">
              <legend>{t('customer.legend')}</legend>
              <div className="fw-flds-choice-row">
                <RadioCard variant="row" name="fw-flds-customer" value="every" checked={draft.forCustomer === 'every'} selected={draft.forCustomer === 'every'} onChange={() => set({ forCustomer: 'every' })} title={t('customer.every')} description={t('customer.everyHint', { record: recordWord })} />
                <RadioCard variant="row" name="fw-flds-customer" value="one" checked={draft.forCustomer === 'one'} selected={draft.forCustomer === 'one'} onChange={() => set({ forCustomer: 'one' })} title={t('customer.one')} description={t('customer.oneHint', { record: recordWord })} />
              </div>
              {draft.forCustomer === 'one' &&
                (draft.partyId ? (
                  <span className="fw-flds-inline">
                    <Tag tone="info">{draft.partyName ?? '…'}</Tag>
                    <Button size="sm" variant="quiet" onClick={() => set({ partyId: null, partyName: null })}>
                      {t('customer.change')}
                    </Button>
                  </span>
                ) : (
                  <>
                    <DsField label={t('customer.search')} hint={t('customer.searchHint')}>
                      <Input type="search" autoComplete="off" value={model.customers?.query ?? ''} placeholder={t('customer.searchPlaceholder')} onChange={(event) => actions?.onCustomerSearch?.(event.target.value)} />
                    </DsField>
                    {model.customers?.problem ? (
                      <Banner tone="danger" title={t(model.customers.problem)} />
                    ) : !model.customers || model.customers.results === null ? (
                      <p className="fw-flds-muted" role="status">
                        <Spinner size={12} /> {t('customer.searching')}
                      </p>
                    ) : model.customers.results.length === 0 ? (
                      <p className="fw-flds-muted">{t('customer.none')}</p>
                    ) : (
                      <div className="fw-flds-choice-row">
                        {model.customers.results.map((row) => (
                          <RadioCard key={row.id} variant="row" name="fw-flds-party" value={row.id} checked={false} onChange={() => set({ partyId: row.id, partyName: row.legalName })} title={row.legalName} description={row.code} />
                        ))}
                      </div>
                    )}
                  </>
                ))}
            </fieldset>
          )}
          {model.customerChoice && editing && <p className="fw-flds-muted">{editing.partyId ? t('customer.oneFixed', { customer: draft.partyName ?? '—' }) : t('customer.everyFixed')}</p>}
        </div>

        <aside className="fw-flds-dialog-preview" aria-label={t('fieldDialog.preview')}>
          <Card header={t('fieldDialog.preview')} description={t('fieldDialog.previewHint', { record: recordWord, section: sectionText(draft.section) ?? t('section.custom') })}>
            {/* B-TH-242: where the column will appear (every customer's records, or one customer's only). */}
            {whereLine && <p className="fw-flds-muted">{t(whereLine.key, { record: recordWord, ...(whereLine.params ?? {}) })}</p>}
            {draft.type ? (
              <PreviewControl field={previewField(draft, model.picklists, editing)} recordLabel={recordWord} />
            ) : (
              <p className="fw-flds-muted">
                <FileText size={14} aria-hidden /> {t('fieldDialog.previewEmpty')}
              </p>
            )}
          </Card>
        </aside>
      </div>
    </Modal>
  )
}
