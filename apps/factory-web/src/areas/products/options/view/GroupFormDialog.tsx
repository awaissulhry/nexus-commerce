'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { refusedField } from '../../library/model'
import { groupDraftProblems, OPTION_GROUP_KINDS, OPTION_LIMITS, withKind, type GroupDraft, type OptionGroupKind } from '../model'
import type { GroupFormModel } from '../view-model'

/**
 * New option group (design pop:options.new: name, kind, min and max picks; Create, ⌘↵) and Edit group (the record's ⋯):
 * the company (or every company, new only: it never changes), the code, the name, a description, the kind (one choice,
 * several, a typed text) and how many options a style asks at least and at most. The rules are factory-domain's, said
 * under each field as typed; Create is held with the count of what to fix.
 */
export function GroupFormDialog({ form, onDraft, onSave, onClose }: { form: GroupFormModel; onDraft?: (draft: GroupDraft) => void; onSave?: () => void; onClose?: () => void }) {
  const t = useT('products-options')
  const tl = useT('library')
  const draft = form.draft
  const set = (patch: Partial<GroupDraft>) => onDraft?.({ ...draft, ...patch })
  const problems = groupDraftProblems(draft)
  const touched = form.mode === 'edit' || draft.code.trim() !== '' || draft.name.trim() !== ''
  const problemAt = (field: string): string | undefined => {
    if (refusedField(form.refused, field)) return t('form.refused')
    if (!touched) return undefined
    const problem = problems.find((entry) => entry.field === field)
    return problem ? t(problem.key, problem.params) : undefined
  }
  const held = problems.length > 0 ? t('form.held', { count: problems.length }) : form.busy ? tl('held.busy') : null
  const save = () => {
    if (!held) onSave?.()
  }
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={form.mode === 'new' ? t('group.newTitle') : t('group.editTitle', { code: draft.code })}
      size="lg"
      footer={
        <>
          <Button onClick={() => onClose?.()}>{tl('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {form.busy ? <Spinner size={12} /> : null} {form.mode === 'new' ? t('group.create') : t('group.save')}
          </Button>
        </>
      }
    >
      <div
        className="fw-lib-dialog"
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
        <div className="fw-lib-form-grid">
          {form.mode === 'new' && (form.companies.length > 1 || form.everyCompany) && (
            <Field label={t('group.company')} hint={draft.companyId ? t('group.companyHint') : t('group.everyCompanyHint')}>
              <Select value={draft.companyId} onChange={(event) => set({ companyId: event.target.value })}>
                {form.everyCompany && <option value="">{t('group.everyCompany')}</option>}
                {form.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('group.code')} hint={t('group.codeHint')} error={problemAt('code')}>
            <Input value={draft.code} maxLength={OPTION_LIMITS.code} onChange={(event) => set({ code: event.target.value })} autoFocus={form.mode === 'new'} />
          </Field>
          <Field label={t('group.name')} error={problemAt('name')}>
            <Input value={draft.name} maxLength={OPTION_LIMITS.name} onChange={(event) => set({ name: event.target.value })} autoFocus={form.mode === 'edit'} />
          </Field>
          <Field label={t('group.kind')} hint={t(`kindHint.${draft.kind}`)} error={problemAt('kind')}>
            <Select value={draft.kind} onChange={(event) => onDraft?.(withKind(draft, event.target.value as OptionGroupKind))}>
              {OPTION_GROUP_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="fw-lib-pair">
            <Field label={t('group.minPicks')} hint={t('group.minHint')} error={problemAt('minPicks')}>
              <Input inputMode="numeric" value={draft.minPicks} maxLength={3} onChange={(event) => set({ minPicks: event.target.value })} />
            </Field>
            <Field label={t('group.maxPicks')} hint={t('group.maxHint')} error={problemAt('maxPicks')}>
              <Input inputMode="numeric" value={draft.maxPicks} maxLength={3} placeholder={t('group.noMax')} onChange={(event) => set({ maxPicks: event.target.value })} />
            </Field>
          </div>
          <div className="fw-lib-span">
            <Field label={t('group.description')} hint={t('group.descriptionHint')} error={problemAt('description')}>
              <Textarea value={draft.description} rows={2} maxLength={OPTION_LIMITS.description} onChange={(event) => set({ description: event.target.value })} />
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  )
}
