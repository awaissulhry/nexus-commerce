'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import { PRICE_LIST_KINDS, type PriceListKind } from '../../api'
import { baseChoices, EVERY_COMPANY, newListProblems, romeToday, type NewListDraft } from '../../model'
import { say, useWords } from '../../parts'
import type { NewListModel, PriceListsActions } from '../list-model'

/**
 * New price list (design pop:pricelists.new: name, kind, currency, validity, the base list it falls back to → Create
 * draft, ⌘↵): makes the list with its version 1 as a DRAFT (nothing is in force until a version is activated). The
 * company is asked only when the person works in several (default: the one the page works in; "Every company" for a list
 * every company may use). A field the API will refuse says so before the click; the API's refusal is said in our words.
 */
export function NewPriceListDialog({ model, actions }: { model: NewListModel; actions?: PriceListsActions }) {
  const t = useWords()
  const locale = useLocale()
  const draft = model.draft
  const today = romeToday()
  const problems = newListProblems(draft, today)
  const count = Object.keys(problems).length
  const set = <K extends keyof NewListDraft>(key: K, value: NewListDraft[K]) => actions?.onNewDraft?.({ ...draft, [key]: value })
  const company = draft.companyId === EVERY_COMPANY || draft.companyId === '' ? null : draft.companyId
  const bases = baseChoices(model.lists, company, draft.currency)
  const held = count > 0 ? t('new.fixFirst', { count }) : model.busy ? t('held.busy') : null
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  const error = (field: keyof NewListDraft) => (problems[field] ? t(problems[field]!) : undefined)
  return (
    <Modal
      open
      onClose={() => actions?.onNew?.(false)}
      title={t('new.title')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onNew?.(false)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('new.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-pl-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <p className="fw-pl-hint">{t('new.body')}</p>
        <div className="fw-pl-fields">
          <Field label={t('new.name')} required error={draft.name ? error('name') : undefined}>
            <Input autoFocus value={draft.name} maxLength={200} onChange={(event) => set('name', event.target.value)} />
          </Field>
          <Field label={t('new.code')} hint={t('new.codeHint')} required error={draft.code ? error('code') : undefined}>
            <Input value={draft.code} maxLength={40} onChange={(event) => set('code', event.target.value.toUpperCase())} />
          </Field>
          <Field label={t('new.kind')} hint={t(`kindHint.${draft.kind}`)}>
            <Select value={draft.kind} onChange={(event) => set('kind', event.target.value as PriceListKind)}>
              {PRICE_LIST_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('new.currency')} hint={t('new.currencyHint')} error={error('currency')}>
            <Input value={draft.currency} maxLength={3} onChange={(event) => set('currency', event.target.value.toUpperCase())} />
          </Field>
          {model.companies.length > 1 && (
            <Field label={t('new.company')} hint={t('new.companyHint')}>
              <Select value={draft.companyId} onChange={(event) => set('companyId', event.target.value)}>
                <option value={EVERY_COMPANY}>{t('new.everyCompany')}</option>
                {model.companies.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {draft.kind !== 'BASE' && (
            <Field label={t('new.base')} hint={t('new.baseHint')} error={error('baseListId')}>
              <Select value={draft.baseListId} onChange={(event) => set('baseListId', event.target.value)}>
                <option value="">{t('new.noBase')}</option>
                {bases.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.code} · {list.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('new.validFrom')} hint={t('new.validFromHint')} error={error('validFrom')}>
            <DateField value={draft.validFrom} onChange={(value) => set('validFrom', value)} locale={INTL_LOCALE[locale]} min={today} clearable />
          </Field>
          <Field label={t('new.validTo')} error={error('validTo')}>
            <DateField value={draft.validTo} onChange={(value) => set('validTo', value)} locale={INTL_LOCALE[locale]} min={draft.validFrom || today} clearable />
          </Field>
        </div>
        <Field label={t('new.note')} error={error('note')}>
          <Textarea value={draft.note} rows={2} maxLength={2000} onChange={(event) => set('note', event.target.value)} />
        </Field>
        {model.problem && <Banner tone="danger" title={say(t, model.problem) ?? ''} />}
      </div>
    </Modal>
  )
}
