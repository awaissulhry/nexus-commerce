'use client'

import { Archive, ArchiveRestore, Save } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner, TagInput } from '@nexus/ui/primitives'
import { PPE_LIMITS } from '@nexus/factory-domain/safety/ppe/rules'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { archiveHeld, atField, categoryMark, codeOf, itemDraftProblems, itemHeld, PPE_CATEGORIES, type ItemDraft } from '../model'
import type { ItemState, PpePageActions, PpePageModel } from '../view-model'
import { problemText, SectionFailed, useWords } from './parts'

/**
 * PPE item (design pop:item; band secondary `c`, a catalogue row): the fields of the catalogue — code (capitals, never changed
 * once made), name and its Italian and English words, category I / II / III (Regulation (EU) 2016/425), the standard it meets,
 * its sizes (none: one size), how many months it lasts (none: replaced when worn), the supplier, the unit cost (the cost grain
 * only) and a note. An existing item lists the role kits naming it (read here, edited in the role sheet) and offers Archive
 * (held while a kit names it) or Restore. Esc closes; the focus returns to the opener.
 */
export function ItemDialog({ model, state, actions }: { model: PpePageModel; state: ItemState; actions?: PpePageActions | undefined }) {
  const t = useWords()
  const close = () => actions?.onAddress?.({ item: null })
  const record = state.read?.status === 'ready' ? state.read.value : null
  const item = record?.item ?? null
  const isNew = state.id === null

  if (!isNew && state.read && state.read.status !== 'ready') {
    return (
      <Modal open onClose={close} title={t('item.title')} size="md">
        {state.read.status === 'loading' ? (
          <p className="fw-ppe-muted" role="status">
            <Spinner size={12} /> {t('common.reading')}
          </p>
        ) : (
          <SectionFailed title={t('item.failed')} problem={state.read.problem} onRetry={() => actions?.onRetryItem?.()} />
        )}
      </Modal>
    )
  }

  const draft = state.draft
  const set = (change: Partial<ItemDraft>) => actions?.onItemDraft?.({ ...draft, ...change })
  const held = itemHeld(draft, { item, can: model.can, companyId: model.companyId, busy: state.busy })
  const problems = itemDraftProblems(draft, isNew, model.can.cost)
  const fieldError = (field: string): string | undefined => {
    const fromApi = atField(state.problem, field)
    if (fromApi) return t(fromApi)
    const local = problems.find((entry) => entry.field === field)
    return local && (draft as unknown as Record<string, unknown>)[field === 'code' ? 'code' : field] !== '' ? t(local.key) : undefined
  }
  const readOnly = !model.can.manage || (item !== null && (!item.canManage || item.status === 'ARCHIVED'))
  const archive = item ? archiveHeld(item, model.can, state.busy) : null
  const suppliers = state.suppliers?.status === 'ready' ? state.suppliers.value : null
  const supplierHeld = !model.can.suppliers ? t('item.supplierNoRight') : state.suppliers?.status === 'error' ? t(state.suppliers.problem) : null

  return (
    <Modal
      open
      onClose={close}
      title={isNew ? t('item.newTitle') : t('item.editTitle', { code: item?.code ?? '' })}
      size="xl"
      footer={
        <>
          {item && item.status === 'ACTIVE' && (
            <Button heldReason={archive === 'refusal.IN_KIT' ? t('item.inKitHeld', { roles: record?.kits.map((kit) => kit.name).join(', ') ?? '' }) : archive ? t(archive) : null} onClick={() => actions?.onItemStatus?.('archive')}>
              <Archive size={13} aria-hidden /> {t('item.archive')}
            </Button>
          )}
          {item && item.status === 'ARCHIVED' && (
            <Button heldReason={!model.can.manage || !item.canManage ? t('held.manage') : state.busy ? t('held.busy') : null} onClick={() => actions?.onItemStatus?.('restore')}>
              <ArchiveRestore size={13} aria-hidden /> {t('item.restore')}
            </Button>
          )}
          <span className="fw-ppe-grow" />
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onSaveItem?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {state.busy ? <Spinner size={12} /> : <Save size={13} aria-hidden />} {t('item.save')}
          </Button>
        </>
      }
    >
      <form
        className="fw-ppe-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) actions?.onSaveItem?.()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
            event.preventDefault()
            actions?.onSaveItem?.()
          }
        }}
      >
        {state.saved && <Banner tone="success" title={t(state.saved.key)} />}
        {state.problem && !state.problem.field && <Banner tone="danger" title={problemText(t, state.problem)} />}
        {item?.status === 'ARCHIVED' && <Banner tone="info" title={t('item.archived')} />}
        <div className="fw-ppe-form-row">
          <Field label={t('item.code')} required={isNew} hint={isNew ? t('item.codeHint', { code: codeOf(draft) || '—' }) : t('item.codeFixed')} error={fieldError('code')}>
            <Input value={draft.code} readOnly={!isNew || readOnly} maxLength={PPE_LIMITS.code} onChange={(event) => set({ code: event.target.value })} />
          </Field>
          <Field label={t('item.name')} required error={fieldError('name')}>
            <Input value={draft.name} readOnly={readOnly} maxLength={PPE_LIMITS.name} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label={t('item.category')} required hint={t('item.categoryHint')} error={fieldError('category')}>
            <Select value={draft.category} disabled={readOnly} onChange={(event) => set({ category: event.target.value as ItemDraft['category'] })}>
              <option value="">{t('item.chooseCategory')}</option>
              {PPE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t('item.categoryOption', { mark: categoryMark(category), words: t(`category.${category}`) })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="fw-ppe-form-row">
          <Field label={t('item.nameIt')} hint={t('item.nameLangHint')}>
            <Input value={draft.nameIt} readOnly={readOnly} maxLength={PPE_LIMITS.name} onChange={(event) => set({ nameIt: event.target.value })} />
          </Field>
          <Field label={t('item.nameEn')} hint={t('item.nameLangHint')}>
            <Input value={draft.nameEn} readOnly={readOnly} maxLength={PPE_LIMITS.name} onChange={(event) => set({ nameEn: event.target.value })} />
          </Field>
          <Field label={t('item.standard')} hint={t('item.standardHint')} error={fieldError('standard')}>
            <Input value={draft.standard} readOnly={readOnly} maxLength={PPE_LIMITS.standard} onChange={(event) => set({ standard: event.target.value })} />
          </Field>
        </div>
        <div className="fw-ppe-form-row">
          <Field label={t('item.sizes')} hint={t('item.sizesHint')} error={fieldError('sizes')}>
            <TagInput value={[...draft.sizes]} disabled={readOnly} maxTags={PPE_LIMITS.sizes} placeholder={t('item.sizesPlaceholder')} aria-label={t('item.sizes')} onChange={(sizes) => set({ sizes })} />
          </Field>
          <Field label={t('item.life')} hint={t('item.lifeHint')} error={fieldError('lifeMonths')}>
            <Input value={draft.lifeMonths} readOnly={readOnly} inputMode="numeric" maxLength={3} onChange={(event) => set({ lifeMonths: event.target.value })} />
          </Field>
          <Field label={t('item.supplier')} hint={supplierHeld ?? t('item.supplierHint')} error={fieldError('supplierPartyId')}>
            {suppliers ? (
              <Select value={draft.supplierPartyId ?? ''} disabled={readOnly} onChange={(event) => set({ supplierPartyId: event.target.value || null })}>
                <option value="">{t('item.noSupplier')}</option>
                {item?.supplier && !suppliers.some((entry) => entry.id === item.supplier?.id) && <option value={item.supplier.id}>{item.supplier.name}</option>}
                {suppliers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            ) : state.suppliers?.status === 'loading' ? (
              <span className="fw-ppe-muted fw-ppe-field-text" role="status">
                <Spinner size={12} /> {t('common.reading')}
              </span>
            ) : (
              <span className="fw-ppe-field-text">{item?.supplier?.name ?? t('item.noSupplier')}</span>
            )}
          </Field>
        </div>
        <div className="fw-ppe-form-row">
          {model.can.cost ? (
            <Field label={t('item.unitCost')} hint={t('item.unitCostHint')} error={fieldError('unitCost')}>
              <Input value={draft.unitCost} readOnly={readOnly} inputMode="decimal" maxLength={12} onChange={(event) => set({ unitCost: event.target.value })} />
            </Field>
          ) : (
            <p className="fw-ppe-muted">{t('catalogue.costHidden')}</p>
          )}
          <Field label={t('item.note')} error={fieldError('note')}>
            <Textarea value={draft.note} readOnly={readOnly} rows={2} maxLength={PPE_LIMITS.note} onChange={(event) => set({ note: event.target.value })} />
          </Field>
        </div>
        {record && (
          <div className="fw-ppe-stack">
            <h3 className="fw-ppe-h3">{t('item.kits')}</h3>
            {record.kits.length === 0 ? (
              <p className="fw-ppe-muted">{t('item.noKits')}</p>
            ) : (
              <ul className="fw-ppe-list">
                {record.kits.map((kit) => (
                  <li key={kit.roleSheetId}>{t('item.kitLine', { role: kit.name, site: kit.site.name, count: kit.quantity, when: kit.whenToWear || t('kits.always') })}</li>
                ))}
              </ul>
            )}
            <p className="fw-ppe-muted">{t('item.issued', { count: record.item.issued })}</p>
          </div>
        )}
      </form>
    </Modal>
  )
}
