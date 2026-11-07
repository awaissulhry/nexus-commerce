'use client'

import { Pencil, Save } from 'lucide-react'
import { Banner, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Spinner } from '@nexus/ui/primitives'
import { HEALTH_LIMITS } from '@nexus/factory-domain/safety/health/rules'
import { DateField, Modal } from '../../../../lib/i18n/ds-parts'
import type { HealthPlan } from '../api'
import { planHeld } from '../model'
import type { HealthPageActions, HealthPageModel, PlanDialogState } from '../view-model'
import { HealthLaw, SectionFailed, SectionHead, SectionLoading, say, useWhen, useWords } from './parts'

/**
 * design sec:plans — "Plans per role: which roles need visits and how often, as the doctor sets (QHS-252)": role · needed ·
 * frequency · the doctor · end of employment · the risks driving it (from the role sheet) · people (a count). No person in a
 * plan (read with safety.view). "Needed" comes from the role sheet; the frequency, the doctor and the end-of-employment visit are
 * edited here by the safety officer and the doctor (pop "Plan for a role"). A plan without its doctor only proposes visits.
 */
export function PlansSection({ model, actions }: { model: HealthPageModel; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const when = useWhen()
  const plans = model.plans
  const allSites = model.scope.allSites
  const anyEdit = plans?.status === 'ready' && plans.value.some((plan) => plan.canEdit)
  const cells = (plan: HealthPlan) => [
    <span key="role" className="fw-hv-cell">
      <b>{plan.role.code}</b>
      <span className="fw-hv-muted">{plan.role.name}</span>
    </span>,
    ...(allSites ? [plan.site.name] : []),
    t(plan.needed ? 'common.yes' : 'plans.notNeeded'),
    plan.needed && plan.frequencyMonths ? t('plans.every', { count: plan.frequencyMonths }) : '—',
    plan.doctor ? (
      <span key="doctor" className="fw-hv-cell">
        {plan.doctor.name}
        <span className="fw-hv-muted">{t('plans.setOn', { day: when.day(plan.setOn) })}</span>
      </span>
    ) : (
      <span key="doctor" className="fw-hv-warn">{t('plans.noDoctor')}</span>
    ),
    t(plan.endOfEmploymentVisit ? 'common.yes' : 'common.no'),
    plan.risks.length > 0 ? plan.risks.join(', ') : '—',
    String(plan.people),
    ...(anyEdit
      ? [
          plan.canEdit ? (
            <Button key="edit" size="sm" aria-label={t('plans.editOf', { role: plan.role.name })} onClick={() => actions?.onAddress?.({ plan: plan.id })}>
              <Pencil size={13} aria-hidden /> {t('plans.edit')}
            </Button>
          ) : (
            <span key="edit" className="fw-hv-muted">{t('plans.readOnly')}</span>
          ),
        ]
      : []),
  ]
  const columns = [t('col.role'), ...(allSites ? [t('col.site')] : []), t('col.needed'), t('col.frequency'), t('col.doctor'), t('col.endOfEmployment'), t('col.risks'), t('col.people'), ...(anyEdit ? [t('col.edit')] : [])]

  return (
    <section className="fw-hv-section" aria-labelledby="fw-hv-plans">
      <SectionHead id="fw-hv-plans" title={t('plans.title')} note={t('plans.note')}>
        <HealthLaw />
      </SectionHead>
      {plans === null || plans.status === 'loading' ? (
        <SectionLoading rows={3} />
      ) : plans.status === 'error' ? (
        <SectionFailed title={t('plans.failed')} problem={plans.problem} onRetry={actions?.onRetryPlans} />
      ) : plans.value.length === 0 ? (
        <EmptyState title={t('plans.emptyTitle')} description={t('plans.empty')} />
      ) : (
        <div className="fw-hv-plans">
          <SummaryTable label={t('plans.title')} columns={columns} rows={plans.value.map((plan) => ({ id: plan.id, cells: cells(plan) }))} density={anyEdit ? 'roomy' : 'compact'} stackOnPhone />
        </div>
      )}
    </section>
  )
}

/** "Plan for a role" (from a plan's Edit): how often, the doctor, the end-of-employment visit, the day the doctor set it. */
export function PlanDialog({ model, state, actions }: { model: HealthPageModel; state: PlanDialogState; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const { plan, draft } = state
  const held = say(t, planHeld(plan, draft, model.today))
  const set = (change: Partial<typeof draft>) => actions?.onPlanDraft?.({ ...draft, ...change })
  const at = (field: string) => (state.problem?.field === field ? t(state.problem.key) : undefined)
  const doctors = state.doctors?.status === 'ready' ? state.doctors.value : []
  const known = doctors.some((doctor) => doctor.id === draft.doctorId)
  return (
    <Modal
      open
      onClose={() => actions?.onPlanEditClose?.()}
      title={t('planDialog.title', { role: plan.role.name })}
      subtitle={`${plan.role.code} · ${plan.site.name}`}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onPlanEditClose?.()}>{t('common.cancel')}</Button>
          <span className="grow" />
          <Button variant="primary" heldReason={state.busy ? t('held.saving') : held} onClick={() => actions?.onPlanEditSave?.()}>
            {state.busy ? <Spinner size={12} /> : <Save size={14} aria-hidden />} {t('planDialog.save')}
          </Button>
        </>
      }
    >
      <div className="fw-hv-form">
        {state.problem && !state.problem.field && <Banner tone="danger" title={t('planDialog.refused')}>{t(state.problem.key)}</Banner>}
        <p className="fw-hv-muted">{plan.needed ? t('planDialog.needed') : t('planDialog.notNeeded')}</p>
        <div className="fw-hv-form-row">
          <Field label={t('planDialog.frequency')} hint={t('planDialog.frequencyHint', { least: HEALTH_LIMITS.frequencyMin, most: HEALTH_LIMITS.frequencyMax })} error={at('frequencyMonths')}>
            <Input inputMode="numeric" value={draft.frequency} disabled={!plan.needed} onChange={(event) => set({ frequency: event.target.value })} />
          </Field>
          <Field label={t('planDialog.doctor')} hint={state.doctors?.status === 'error' ? t('planDialog.doctorsFailed') : t('planDialog.doctorHint')} error={at('doctorAppointmentId')}>
            <Select value={draft.doctorId} onChange={(event) => set({ doctorId: event.target.value })}>
              <option value="">{state.doctors?.status === 'loading' ? t('common.reading') : t('planDialog.noDoctor')}</option>
              {!known && draft.doctorId && plan.doctor ? <option value={draft.doctorId}>{plan.doctor.name}</option> : null}
              {doctors.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.inForce ? doctor.name : t('planDialog.doctorLater', { name: doctor.name })}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('planDialog.setOn')} hint={t('planDialog.setOnHint')} error={at('setOn')}>
            <DateField value={draft.setOn} max={model.today} onChange={(value) => set({ setOn: value })} ariaLabel={t('planDialog.setOn')} />
          </Field>
        </div>
        <Checkbox checked={draft.endOfEmployment} disabled={!plan.needed} onChange={(event) => set({ endOfEmployment: event.target.checked })} label={t('planDialog.endOfEmployment')} />
        {plan.risks.length > 0 && <p className="fw-hv-muted">{t('planDialog.risks', { risks: plan.risks.join(', ') })}</p>}
      </div>
    </Modal>
  )
}
