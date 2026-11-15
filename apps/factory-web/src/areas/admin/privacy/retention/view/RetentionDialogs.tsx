'use client'

import { Banner, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import type { RetentionAction } from '@nexus/factory-domain/privacy/retention/retention'
import { ActionConfirm, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Rule } from '../api'
import { changeAsksCode, doesKey, monthsOf, ruleDraftHeld, typeKey, type RetentionViewModel, type RuleDraft } from '../model'
import { Period } from './Period'

export interface RetentionDialogActions {
  onDraft?: (change: Partial<RuleDraft>) => void
  onSaveRule?: () => void
  onConfirmApply?: () => void
  onRetrySweeps?: () => void
  onCloseDialog?: () => void
}

/**
 * The retention section's dialogs (SCR-662): Add a rule / Change the rule (record type, whose, keep for, then, legal reason;
 * what the sweep does with it; "Shortening needs the Owner": a shorter period asks a fresh code), "Switch <type> on to apply?"
 * (the DS ActionConfirm: from the next sweep records are changed for real; then the fresh code), and a rule's sweeps.
 */
export function RetentionDialogs({ model, actions }: { model: RetentionViewModel; actions?: RetentionDialogActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  if (dialog.kind === 'rule') return <RuleDialog model={model} actions={actions} />
  if (dialog.kind === 'apply') return <ApplyConfirm model={model} actions={actions} />
  return <SweepsDialog model={model} actions={actions} />
}

const ruleOf = (model: RetentionViewModel, ruleId: string | null): Rule | null => (ruleId ? (model.list.value?.rules.find((rule) => rule.id === ruleId) ?? null) : null)

function RuleDialog({ model, actions }: { model: RetentionViewModel; actions?: RetentionDialogActions }) {
  const t = useT('admin-privacy-depth')
  const dialog = model.dialog
  if (dialog?.kind !== 'rule') return null
  const { draft } = dialog
  const types = model.list.value?.types ?? []
  const rule = ruleOf(model, draft.ruleId)
  const type = types.find((entry) => entry.recordType === draft.recordType) ?? null
  const held = ruleDraftHeld(draft, types, model.can)
  const months = monthsOf(draft)
  const asksCode = rule ? changeAsksCode(rule, draft) : false
  const footer = (
    <>
      <Button variant="secondary" onClick={() => actions?.onCloseDialog?.()} disabled={dialog.busy}>
        {t('dp.common.cancel')}
      </Button>
      <Button variant="primary" onClick={() => actions?.onSaveRule?.()} heldReason={dialog.busy ? t('dp.common.working') : held ? t(held) : null}>
        {dialog.busy && <Spinner size={14} />}
        {t(rule ? 'dp.ret.form.save' : 'dp.ret.form.add')}
      </Button>
    </>
  )
  return (
    <Modal open onClose={() => actions?.onCloseDialog?.()} title={t(rule ? 'dp.ret.form.changeTitle' : 'dp.ret.form.newTitle', { type: t(typeKey(draft.recordType, 'name')) })} size="md" footer={footer}>
      <div className="fw-dpret-form">
        <p className="fw-dpret-muted">{t('dp.ret.form.intro')}</p>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <div className="fw-dpret-grid">
          <Field label={t('dp.ret.col.type')}>
            {rule ? (
              <Input value={t(typeKey(rule.recordType, 'name'))} readOnly />
            ) : (
              <Select value={draft.recordType} onChange={(event) => actions?.onDraft?.({ recordType: event.target.value, thenAction: types.find((entry) => entry.recordType === event.target.value)?.actions[0] ?? '' })}>
                <option value="">{t('dp.new.pick')}</option>
                {types.map((entry) => (
                  <option key={entry.recordType} value={entry.recordType}>
                    {t(typeKey(entry.recordType, 'name'))}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('dp.ret.col.company')} hint={type && !type.companyScoped ? t('dp.ret.form.groupOnly') : undefined}>
            {rule ? (
              <Input value={rule.company?.name ?? t('dp.ret.company.all')} readOnly />
            ) : (
              <Select value={draft.companyId} onChange={(event) => actions?.onDraft?.({ companyId: event.target.value })}>
                <option value="">{t('dp.ret.company.all')}</option>
                {(type?.companyScoped ?? true) &&
                  model.companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label={t('dp.ret.form.months')} hint={months ? <Period months={months} /> : t('dp.ret.form.monthsHint')}>
            <Input inputMode="numeric" value={draft.keepMonths} onChange={(event) => actions?.onDraft?.({ keepMonths: event.target.value })} />
          </Field>
          <Field label={t('dp.ret.col.then')}>
            <Select value={draft.thenAction} disabled={!type || type.actions.length === 0} onChange={(event) => actions?.onDraft?.({ thenAction: event.target.value as RetentionAction })}>
              {!draft.thenAction && <option value="">{t('dp.new.pick')}</option>}
              {(type?.actions ?? []).map((action) => (
                <option key={action} value={action}>
                  {t(`dp.ret.then.${action}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {type && type.actions.length === 0 && <Banner tone="info" title={t('dp.ret.form.held.noAction')} />}
        {type && draft.thenAction && <p className="fw-dpret-muted">{t(doesKey(type.recordType, draft.thenAction))}</p>}
        {type?.holdsAll && <Banner tone="info" title={t(`dp.ret.sweepHeld.${type.holdsAll.code}.long`)} />}
        <Field label={t('dp.ret.col.reason')} hint={t('dp.ret.form.reasonHint')} required>
          <Textarea rows={3} value={draft.legalReason} maxLength={1000} onChange={(event) => actions?.onDraft?.({ legalReason: event.target.value })} />
        </Field>
        <Banner tone="warning" title={t('dp.ret.unverifiedLong')} />
        {asksCode && <Banner tone="warning" title={t('dp.ret.form.asksCode')} />}
      </div>
    </Modal>
  )
}

function ApplyConfirm({ model, actions }: { model: RetentionViewModel; actions?: RetentionDialogActions }) {
  const t = useT('admin-privacy-depth')
  const dialog = model.dialog
  if (dialog?.kind !== 'apply') return null
  const rule = ruleOf(model, dialog.ruleId)
  if (!rule) return null
  const typeName = t(typeKey(rule.recordType, 'name'))
  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        title: t('dp.ret.apply.title', { type: typeName, company: rule.company?.name ?? t('dp.ret.company.all') }),
        confirmLabel: t('dp.ret.apply.confirm'),
        consequences: [t(doesKey(rule.recordType, rule.thenAction)), t('dp.ret.apply.from'), t('dp.ret.apply.unverified')],
        sideEffects: [t('dp.ret.apply.code'), t('dp.ret.apply.back')],
        acknowledge: t('dp.ret.apply.ack'),
        ...(dialog.problem ? { refusal: { reason: t(dialog.problem) } } : {}),
      }}
      onConfirm={() => actions?.onConfirmApply?.()}
      onCancel={() => actions?.onCloseDialog?.()}
    />
  )
}

function SweepsDialog({ model, actions }: { model: RetentionViewModel; actions?: RetentionDialogActions }) {
  const t = useT('admin-privacy-depth')
  const locale = useLocale()
  const dialog = model.dialog
  if (dialog?.kind !== 'sweeps') return null
  const rule = ruleOf(model, dialog.ruleId)
  const place = { locale, timeZone: model.timeZone }
  const sweeps = dialog.sweeps.value
  return (
    <Modal open onClose={() => actions?.onCloseDialog?.()} title={t('dp.ret.sweeps.title', { type: rule ? t(typeKey(rule.recordType, 'name')) : '' })} size="xl" footer={<Button onClick={() => actions?.onCloseDialog?.()}>{t('dp.common.close')}</Button>}>
      <div className="fw-dpret-form">
        {rule && <p className="fw-dpret-muted">{t(doesKey(rule.recordType, rule.thenAction))}</p>}
        {dialog.sweeps.problem ? (
          <EmptyState
            title={t('dp.ret.sweeps.failed')}
            description={t(dialog.sweeps.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetrySweeps?.()}>
                {t('dp.common.retry')}
              </Button>
            }
          />
        ) : !sweeps ? (
          <p className="fw-dpret-muted" role="status">
            <Spinner size={14} /> {t('dp.common.loading')}
          </p>
        ) : sweeps.length === 0 ? (
          <p className="fw-dpret-muted">{t('dp.ret.last.none')}</p>
        ) : (
          <SummaryTable
            label={t('dp.ret.sweeps.title', { type: rule ? t(typeKey(rule.recordType, 'name')) : '' })}
            stackOnPhone
            columns={[t('dp.ret.sweeps.when'), t('dp.ret.sweeps.mode'), t('dp.ret.sweeps.cutoff'), t('dp.ret.sweeps.due'), t('dp.ret.sweeps.applied'), t('dp.ret.sweeps.held'), t('dp.ret.sweeps.status'), t('dp.ret.sweeps.by')]}
            align={['left', 'left', 'left', 'right', 'right', 'right', 'left', 'left']}
            rows={sweeps.map((sweep) => ({
              id: sweep.id,
              cells: [
                formatDateTime(sweep.startedAt, place),
                t(`dp.ret.mode.${sweep.mode}`),
                formatDate(`${sweep.cutoffOn}T12:00:00Z`, place),
                String(sweep.due),
                String(sweep.applied),
                sweep.held > 0 && sweep.heldWhy ? (
                  <span key="h" title={t(`dp.ret.sweepHeld.${sweep.heldWhy.code}.long`)}>
                    {sweep.held} · {t(`dp.ret.sweepHeld.${sweep.heldWhy.code}.short`)}
                  </span>
                ) : (
                  String(sweep.held)
                ),
                <span key="s" className="fw-dpret-inline">
                  <Pill tone={sweep.status === 'FAILED' ? 'danger' : sweep.status === 'RUNNING' ? 'info' : 'success'}>{t(`dp.ret.sweepStatus.${sweep.status}`)}</Pill>
                  {sweep.failures.slice(0, 1).map((failure) => (
                    <span key={failure.code} className="fw-dpret-sub">
                      {t(`dp.ret.failure.${failure.code}`)}
                    </span>
                  ))}
                </span>,
                sweep.requestedBy?.name || t('dp.ret.sweeps.night'),
              ],
            }))}
          />
        )}
      </div>
    </Modal>
  )
}
