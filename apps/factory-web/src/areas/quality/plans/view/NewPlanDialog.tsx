'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { PLAN_STAGES, type PlanStage } from '../constants'
import { codeOf, copyChoices, newPlanProblems, type NewPlanDraft } from '../model'
import { problemAt, useSay } from './parts'
import type { PlansModel } from './PlansView'

export interface NewPlanActions {
  onNewPlanDraft?: (draft: NewPlanDraft) => void
  onNewPlanCreate?: () => void
  onNewPlanClose?: () => void
}

/**
 * New plan (design pop:pl-new, opened by the band's primary, `c` or `?new=1`; `?copy=<version>` from a row's Copy):
 * stage, code, name, where it starts from (blank, a plan of the leather-apparel starter set of this stage, or a copy of
 * another plan's version), owner. Create draft plan makes version 1 as a draft by this person and opens its record.
 */
export function NewPlanDialog({ model, actions }: { model: PlansModel; actions?: NewPlanActions }) {
  const t = useT('quality-plans')
  const say = useSay()
  const locale = useLocale()
  const dialog = model.newPlan
  if (!dialog) return null
  const draft = dialog.draft
  const set = (change: Partial<NewPlanDraft>) => actions?.onNewPlanDraft?.({ ...draft, ...change })
  const rows = model.plans.value?.plans ?? []
  const taken = new Set(rows.map((row) => row.code))
  const problems = newPlanProblems(draft, taken)
  const shown = dialog.shown
  const starters = (model.starter?.value ?? []).filter((plan) => plan.stage === draft.stage)
  const copies = copyChoices(rows, draft.stage)
  const busy = model.busy === 'newPlan'
  const held = problems.length > 0 && shown ? t('newPlan.heldProblems', { count: problems.length }) : model.live === 'offline' ? t('held.offline') : null
  const pickStarter = (code: string) => {
    const plan = starters.find((entry) => entry.code === code)
    set({ starterCode: code, ...(plan ? { code: plan.code, name: plan.name[locale] } : {}) })
  }
  return (
    <Modal
      open
      size="md"
      title={t('newPlan.title')}
      subtitle={t('newPlan.subtitle')}
      onClose={() => actions?.onNewPlanClose?.()}
      footer={
        <>
          <Button onClick={() => actions?.onNewPlanClose?.()}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy} heldReason={held} onClick={() => actions?.onNewPlanCreate?.()}>
            {busy ? t('common.working') : t('newPlan.create')}
          </Button>
        </>
      }
    >
      <div className="fw-qp-form">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <Field label={t('newPlan.stage')} hint={t('newPlan.stageHint')}>
          <Select value={draft.stage} onChange={(event) => set({ stage: event.target.value as PlanStage, starterCode: '', copyVersionId: '' })}>
            {PLAN_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {t(`stage.${stage}`)}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="fw-qp-radios">
          <legend className="fw-qp-legend">{t('newPlan.startFrom')}</legend>
          <RadioCard name="start" title={t('newPlan.blank')} description={t('newPlan.blankHint')} checked={draft.start === 'BLANK'} selected={draft.start === 'BLANK'} onChange={() => set({ start: 'BLANK' })} />
          <RadioCard
            name="start"
            title={t('newPlan.starter')}
            description={starters.length === 0 ? t('newPlan.starterNoneForStage') : t('newPlan.starterHint')}
            checked={draft.start === 'STARTER'}
            selected={draft.start === 'STARTER'}
            disabled={starters.length === 0 || starters.every((plan) => !plan.missing)}
            onChange={() => set({ start: 'STARTER' })}
          />
          <RadioCard name="start" title={t('newPlan.copy')} description={t('newPlan.copyHint')} checked={draft.start === 'COPY'} selected={draft.start === 'COPY'} disabled={copies.length === 0} onChange={() => set({ start: 'COPY' })} />
        </fieldset>
        {draft.start === 'STARTER' && (
          <Field label={t('newPlan.starterPick')} error={say(problemAt(problems, 'startFrom', shown)) || undefined}>
            <Select value={draft.starterCode} onChange={(event) => pickStarter(event.target.value)}>
              <option value="">{t('newPlan.pick')}</option>
              {starters.map((plan) => (
                <option key={plan.code} value={plan.code} disabled={!plan.missing}>
                  {plan.missing ? t('newPlan.starterOption', { code: plan.code, name: plan.name[locale], count: plan.checks }) : t('newPlan.starterTaken', { code: plan.code })}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {draft.start === 'COPY' && (
          <Field label={t('newPlan.copyPick')} hint={t('newPlan.copyNote')} error={say(problemAt(problems, 'startFrom', shown)) || undefined}>
            <Select value={draft.copyVersionId} onChange={(event) => set({ copyVersionId: event.target.value })}>
              <option value="">{t('newPlan.pick')}</option>
              {copies.map((choice) => (
                <option key={choice.versionId} value={choice.versionId}>
                  {t(choice.status === 'APPROVED' ? 'newPlan.copyOption' : 'newPlan.copyOptionDraft', { code: choice.planCode, name: choice.planName, number: choice.number, stage: t(`stage.${choice.stage}`) })}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="fw-qp-two">
          <Field label={t('newPlan.code')} hint={t('newPlan.codeHint')} error={say(problemAt(problems, 'code', shown)) || undefined} required>
            <Input value={draft.code} maxLength={40} autoComplete="off" onChange={(event) => set({ code: codeOf(event.target.value) })} />
          </Field>
          <Field label={t('newPlan.name')} error={say(problemAt(problems, 'name', shown)) || undefined} required>
            <Input value={draft.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} />
          </Field>
        </div>
        <fieldset className="fw-qp-radios fw-qp-radios-row">
          <legend className="fw-qp-legend">{t('newPlan.owner')}</legend>
          <RadioCard variant="row" name="owner" title={t('newPlan.ownerMe')} checked={draft.owner === 'ME'} selected={draft.owner === 'ME'} onChange={() => set({ owner: 'ME' })} />
          <RadioCard variant="row" name="owner" title={t('newPlan.ownerNobody')} checked={draft.owner === 'NOBODY'} selected={draft.owner === 'NOBODY'} onChange={() => set({ owner: 'NOBODY' })} />
        </fieldset>
        <p className="fw-qp-muted">{t('newPlan.after')}</p>
      </div>
    </Modal>
  )
}
