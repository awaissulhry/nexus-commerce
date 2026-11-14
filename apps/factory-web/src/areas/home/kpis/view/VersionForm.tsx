'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { KPI_LIMITS } from '@nexus/factory-domain/insights/kpis/checks'
import { Modal, TagInput, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { KpiRecord, OfficeRole } from '../api'
import { calculationFields, differsFromCalculation, isKnownMeasure, OFFICE_ROLE_KEYS, ownerText, SOURCE_RECORDS, wordsOf, type FormField, type KpisAbilities, type VersionDraft } from '../model'
import type { KpiActions, KpiForm } from './KpiView'

/**
 * The owner's version form (SCR-470 case `form-*`; B-W2b-428's draft and edit): a new version starts from the version in
 * force (its words, records and owner copied), or the draft waiting is edited at the version read. The name, the meaning
 * and the formula in Italian and in English, the records it is computed from, the owner role and — for a new version — what
 * changed. The facts it reads, its unit and its rights are its calculation's (in code): shown, never typed; a version that
 * named other facts gets its calculation's ones. Saving writes a DRAFT: putting it in force is its own step.
 */
export function VersionForm({ form, record, can, roles, actions }: { form: KpiForm; record: KpiRecord; can: KpisAbilities; roles: { readonly value: readonly OfficeRole[] | null; readonly problem: string | null }; actions?: KpiActions }) {
  const t = useT('home-kpis')
  const locale = useLocale()
  const draft = form.draft
  const set = (change: Partial<VersionDraft>) => actions?.onForm?.({ ...draft, ...change })
  const problem = (field: FormField) => (form.shown && form.problems[field] ? t(form.problems[field]!, { name: KPI_LIMITS.name, definition: KPI_LIMITS.definition, formula: KPI_LIMITS.formula, records: KPI_LIMITS.records, note: KPI_LIMITS.changeNote }) : undefined)
  const fixed = calculationFields(form.base, record.calculation)
  const fixes = differsFromCalculation(form.base, record.calculation)
  const ownerHeld = !can.roles ? t('form.ownerHeld') : roles.problem ? t(roles.problem) : null
  const roleName = (role: OfficeRole) => (role.system && (OFFICE_ROLE_KEYS as readonly string[]).includes(role.key) ? t(`role.${role.key}`) : role.name)
  const title = form.mode === 'new' ? t('form.newTitle', { version: form.base.kpiVersion }) : t('form.editTitle', { version: form.base.kpiVersion })

  return (
    <Modal
      open
      size="xl"
      onClose={() => actions?.onFormCancel?.()}
      title={title}
      subtitle={wordsOf(record, locale).name}
      footer={
        <>
          <Button variant="secondary" onClick={() => actions?.onFormCancel?.()}>
            {t('form.cancel')}
          </Button>
          <Button variant="primary" heldReason={form.busy ? t('held.saving') : undefined} onClick={() => actions?.onFormSave?.()}>
            {form.busy && <Spinner size={14} />} {t('form.save')}
          </Button>
        </>
      }
    >
      <div className="fw-kpi-form">
        <p className="fw-kpi-muted fw-kpi-wide">{t(form.mode === 'new' ? 'form.newIntro' : 'form.editIntro')}</p>
        {form.refusal && (
          <div className="fw-kpi-wide">
            <Banner tone="danger" title={t('form.refused')}>
              {t(form.refusal)}
            </Banner>
          </div>
        )}
        <Field label={t('form.nameIt')} required error={problem('nameIt')}>
          <Input value={draft.nameIt} maxLength={KPI_LIMITS.name + 20} onChange={(event) => set({ nameIt: event.target.value })} />
        </Field>
        <Field label={t('form.nameEn')} required error={problem('nameEn')}>
          <Input value={draft.nameEn} maxLength={KPI_LIMITS.name + 20} onChange={(event) => set({ nameEn: event.target.value })} />
        </Field>
        <Field label={t('form.definitionIt')} required hint={t('form.definitionHint')} error={problem('definitionIt')}>
          <Textarea rows={5} limit={KPI_LIMITS.definition} value={draft.definitionIt} onChange={(event) => set({ definitionIt: event.target.value })} />
        </Field>
        <Field label={t('form.definitionEn')} required error={problem('definitionEn')}>
          <Textarea rows={5} limit={KPI_LIMITS.definition} value={draft.definitionEn} onChange={(event) => set({ definitionEn: event.target.value })} />
        </Field>
        <Field label={t('form.formulaIt')} required error={problem('formulaIt')}>
          <Textarea rows={2} limit={KPI_LIMITS.formula} value={draft.formulaIt} onChange={(event) => set({ formulaIt: event.target.value })} />
        </Field>
        <Field label={t('form.formulaEn')} required error={problem('formulaEn')}>
          <Textarea rows={2} limit={KPI_LIMITS.formula} value={draft.formulaEn} onChange={(event) => set({ formulaEn: event.target.value })} />
        </Field>
        <Field label={t('form.records')} hint={t('form.recordsHint', { count: KPI_LIMITS.records })} error={problem('sourceRecords')}>
          <TagInput value={[...draft.sourceRecords]} suggestions={[...SOURCE_RECORDS]} maxTags={KPI_LIMITS.records} onChange={(tags) => set({ sourceRecords: tags })} />
        </Field>
        <Field label={t('form.owner')} hint={ownerHeld ?? t('form.ownerHint')} error={problem('ownerRoleId')}>
          {ownerHeld || !roles.value ? (
            <Input value={ownerText(form.base.owner, t)} readOnly aria-readonly />
          ) : (
            <Select value={draft.ownerRoleId} onChange={(event) => set({ ownerRoleId: event.target.value })}>
              {!roles.value.some((role) => role.id === draft.ownerRoleId) && <option value={draft.ownerRoleId}>{ownerText(form.base.owner, t)}</option>}
              {roles.value.map((role) => (
                <option key={role.id} value={role.id}>
                  {roleName(role)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="fw-kpi-wide">
          <p className="fw-kpi-muted">
            {t('form.fixed', {
              facts: fixed.measureKeys.map((key) => (isKnownMeasure(key) ? t(`measure.${key}`) : key)).join(' · ') || t('words.none'),
              unit: t(`unit.${fixed.unit}`),
              rights: fixed.grain ? t(`grain.${fixed.grain.toLowerCase()}`) : t('grain.none'),
            })}
          </p>
          {fixes && (
            <Banner tone="warning" title={t('form.fixesTitle')}>
              {t('form.fixesBody')}
            </Banner>
          )}
        </div>
        <div className="fw-kpi-wide">
          <Field label={t('form.changeNote')} required={form.mode === 'new'} hint={t('form.changeNoteHint')} error={problem('changeNote')}>
            <Textarea rows={2} limit={KPI_LIMITS.changeNote} value={draft.changeNote} onChange={(event) => set({ changeNote: event.target.value })} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
