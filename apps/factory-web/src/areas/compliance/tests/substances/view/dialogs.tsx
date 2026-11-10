'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Toggle } from '@nexus/ui/primitives'
import { SUBSTANCE_TESTS } from '@nexus/factory-domain/compliance/substances/rules'
import { PLAN_ITEM_KINDS, TEST_FREQUENCIES } from '@nexus/factory-domain/compliance/test-plans/rules'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { TestPlan } from '../api'
import { DEPTH_NAMESPACE } from '../frame/parts'
import { offReasonProblem, planChanges, planDraftProblems, versionProblems, type PlanDraft, type VersionDraft } from '../model'
import type { SubstancesViewModel } from '../view-model'

export interface SubstanceDialogActions {
  onSwitchReason?: (reason: string) => void
  onSwitchConfirm?: () => void
  onCloseDialog?: () => void
  onPlanChange?: (draft: PlanDraft) => void
  onPlanSave?: () => void
  onArchivePlan?: (plan: TestPlan) => void
  onVersionChange?: (draft: VersionDraft) => void
  onVersionSave?: () => void
  onStarterConfirm?: () => void
  onStarter?: (open: boolean) => void
}

/**
 * The Substance list's dialogs (B-W2b-267): switch a rule or a test plan rule (off asks the reason the next person reads;
 * on says what it will start to check), a test plan rule (new or edit: a kind of material or one material, the test, how
 * often, the market, the substance rule and the method), a new Candidate List version (the day ECHA published it and how
 * many entries: the declarations against an older list become "to ask again"), and Load the starter list (public law only,
 * nothing overwritten). Each says why it waits. Fetches nothing.
 */
export function SubstanceDialogs({ model, actions }: { model: SubstancesViewModel; actions?: SubstanceDialogActions }) {
  return (
    <>
      <SwitchDialogView model={model} actions={actions} />
      <PlanDialogView model={model} actions={actions} />
      <VersionDialogView model={model} actions={actions} />
      <StarterConfirm model={model} actions={actions} />
    </>
  )
}

function SwitchDialogView({ model, actions }: { model: SubstancesViewModel; actions?: SubstanceDialogActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const dialog = model.switchDialog
  if (!dialog) return null
  const rule = dialog.kind === 'rule' ? (model.rules.value?.rules.find((row) => row.id === dialog.id) ?? null) : null
  const plan = dialog.kind === 'plan' ? (model.plans.value?.plans.find((row) => row.id === dialog.id) ?? null) : null
  const subject = rule ?? plan
  if (!subject) return null
  const on = !subject.switchedOn
  const problem = offReasonProblem(rule ? { key: rule.key, switchedOn: rule.switchedOn, status: rule.status } : { switchedOn: subject.switchedOn, status: subject.status }, on, dialog.reason)
  const name = rule ? rule.key : t(`test.${plan!.test}`)
  return (
    <Modal
      open
      size="sm"
      title={t(on ? 'switch.titleOn' : 'switch.titleOff', { name })}
      onClose={() => actions?.onCloseDialog?.()}
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{q('common.close')}</Button>
          <Button variant={on ? 'primary' : 'danger'} heldReason={problem ? t(problem) : model.busy ? q('common.loading') : null} onClick={() => actions?.onSwitchConfirm?.()}>
            {t(on ? 'switch.turnOn' : 'switch.turnOff')}
          </Button>
        </>
      }
    >
      {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
      <p>{t(on ? (rule ? 'switch.onRule' : 'switch.onPlan') : rule ? 'switch.offRule' : 'switch.offPlan')}</p>
      {!on && (
        <Field label={t('switch.reason')} hint={t('switch.reasonHint')}>
          <Textarea rows={3} value={dialog.reason} maxLength={500} onChange={(event) => actions?.onSwitchReason?.(event.target.value)} />
        </Field>
      )}
      {on && subject.offReason && <p className="fw-q-hint">{t('switch.wasOff', { reason: subject.offReason })}</p>}
    </Modal>
  )
}

function PlanDialogView({ model, actions }: { model: SubstancesViewModel; actions?: SubstanceDialogActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const dialog = model.planDialog
  if (!dialog) return null
  const creating = dialog.id === 'new'
  const plan = creating ? null : (model.plans.value?.plans.find((row) => row.id === dialog.id) ?? null)
  if (!creating && !plan) return null
  const draft = dialog.draft
  const change = (patch: Partial<PlanDraft>) => actions?.onPlanChange?.({ ...draft, ...patch })
  const problems = planDraftProblems(draft, creating)
  const first = Object.values(problems)[0] ?? null
  const unchanged = plan ? Object.keys(planChanges(plan, draft)).length === 0 : false
  const rules = (model.rules.value?.rules ?? []).filter((rule) => rule.status === 'ACTIVE' && (rule.test === draft.test || rule.test === null))
  const materials = model.materials.value ?? []
  return (
    <Modal
      open
      size="md"
      title={t(creating ? 'plan.titleNew' : 'plan.titleEdit')}
      onClose={() => actions?.onCloseDialog?.()}
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{q('common.close')}</Button>
          <Button variant="primary" heldReason={first ? t(first) : unchanged ? t('card.nothingChanged') : model.busy ? q('common.loading') : null} onClick={() => actions?.onPlanSave?.()}>
            {t(creating ? 'plan.create' : 'plan.save')}
          </Button>
        </>
      }
    >
      {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
      <div className="fw-q-stack">
        <Field label={t('plan.scope')}>
          <SegmentedControl ariaLabel={t('plan.scope')} options={[{ value: 'KIND', label: t('plan.scopeKind') }, { value: 'MATERIAL', label: t('plan.scopeMaterial') }]} value={draft.scope} onChange={(value) => change({ scope: value as PlanDraft['scope'] })} />
        </Field>
        {draft.scope === 'KIND' ? (
          <Field label={t('plan.kind')} error={problems.itemKind ? t(problems.itemKind) : undefined}>
            <Select value={draft.itemKind} onChange={(event) => change({ itemKind: event.target.value })} aria-label={t('plan.kind')}>
              {PLAN_ITEM_KINDS.map((kind) => (
                <option key={kind} value={kind}>{t(`materialKind.${kind}`)}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={t('plan.material')} error={problems.itemId ? t(problems.itemId) : undefined} hint={model.materials.problem ? q(model.materials.problem) : undefined}>
            <Select value={draft.itemId} onChange={(event) => change({ itemId: event.target.value })} aria-label={t('plan.material')}>
              <option value="">{model.materials.value === null ? q('common.loading') : t('plan.materialPick')}</option>
              {materials.map((material) => (
                <option key={material.id} value={material.id}>{`${material.code} · ${material.name}`}</option>
              ))}
            </Select>
          </Field>
        )}
        <div className="fw-mt-form">
          <Field label={t('plan.test')}>
            <Select value={draft.test} onChange={(event) => change({ test: event.target.value as PlanDraft['test'], substanceRuleId: '' })} aria-label={t('plan.test')}>
              {SUBSTANCE_TESTS.map((test) => (
                <option key={test} value={test}>{t(`test.${test}`)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('plan.frequency')}>
            <Select value={draft.frequency} onChange={(event) => change({ frequency: event.target.value as PlanDraft['frequency'] })} aria-label={t('plan.frequency')}>
              {TEST_FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>{t(`frequency.${frequency}`)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('plan.market')} hint={t('plan.marketHint')} error={problems.marketCode ? t(problems.marketCode) : undefined}>
            <Input size="sm" value={draft.marketCode} maxLength={40} onChange={(event) => change({ marketCode: event.target.value.toUpperCase() })} aria-label={t('plan.market')} />
          </Field>
          <Field label={t('plan.rule')} hint={t('plan.ruleHint')}>
            <Select value={draft.substanceRuleId} onChange={(event) => change({ substanceRuleId: event.target.value })} aria-label={t('plan.rule')}>
              <option value="">{t('plan.anyRule')}</option>
              {rules.map((rule) => (
                <option key={rule.id} value={rule.id}>{`${rule.key} · ${t(`ruleCode.${rule.code}`)}${rule.switchedOn ? '' : ` (${t('switch.off')})`}`}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('plan.method')} hint={t('plan.methodHint')} error={problems.method ? t(problems.method) : undefined}>
          <Input size="sm" value={draft.method} maxLength={200} onChange={(event) => change({ method: event.target.value })} aria-label={t('plan.method')} />
        </Field>
        <Field label={t('plan.note')} error={problems.note ? t(problems.note) : undefined}>
          <Textarea rows={2} value={draft.note} maxLength={1000} onChange={(event) => change({ note: event.target.value })} />
        </Field>
        {creating && (
          <>
            <Field label={t('plan.startOn')}>
              <span className="fw-q-cell-row">
                <Toggle checked={draft.switchedOn} onChange={(next) => change({ switchedOn: next, offReason: next ? '' : draft.offReason })} aria-label={t('plan.startOn')} />
                <span>{t(draft.switchedOn ? 'switch.on' : 'switch.off')}</span>
              </span>
            </Field>
            {!draft.switchedOn && (
              <Field label={t('switch.reason')} hint={t('switch.reasonHint')} error={problems.offReason ? t(problems.offReason) : undefined}>
                <Textarea rows={2} value={draft.offReason} maxLength={500} onChange={(event) => change({ offReason: event.target.value })} />
              </Field>
            )}
          </>
        )}
        <p className="fw-q-hint">{t('plan.costHint')}</p>
      </div>
    </Modal>
  )
}

function VersionDialogView({ model, actions }: { model: SubstancesViewModel; actions?: SubstanceDialogActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const draft = model.versionDraft
  if (!draft) return null
  const problems = versionProblems(draft, model.today, model.versions.value?.versions ?? [])
  const first = Object.values(problems)[0] ?? null
  const change = (patch: Partial<VersionDraft>) => actions?.onVersionChange?.({ ...draft, ...patch })
  return (
    <Modal
      open
      size="md"
      title={t('version.title')}
      onClose={() => actions?.onCloseDialog?.()}
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{q('common.close')}</Button>
          <Button variant="primary" heldReason={first ? t(first) : model.busy ? q('common.loading') : null} onClick={() => actions?.onVersionSave?.()}>
            {t('version.save')}
          </Button>
        </>
      }
    >
      {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
      <p className="fw-q-hint">{t('version.lead')}</p>
      <div className="fw-mt-form">
        <Field label={t('version.publishedOn')} error={problems.publishedOn ? t(problems.publishedOn) : undefined}>
          <DateField value={draft.publishedOn} max={model.today} onChange={(value) => change({ publishedOn: value })} ariaLabel={t('version.publishedOn')} />
        </Field>
        <Field label={t('version.entryCount')} error={problems.entryCount ? t(problems.entryCount) : undefined}>
          <Input size="sm" inputMode="numeric" value={draft.entryCount} onChange={(event) => change({ entryCount: event.target.value })} aria-label={t('version.entryCount')} />
        </Field>
      </div>
      <Field label={t('version.source')} error={problems.source ? t(problems.source) : undefined}>
        <Input size="sm" value={draft.source} maxLength={300} onChange={(event) => change({ source: event.target.value })} aria-label={t('version.source')} />
      </Field>
      <Field label={t('version.sourceUrl')} error={problems.sourceUrl ? t(problems.sourceUrl) : undefined}>
        <Input size="sm" value={draft.sourceUrl} onChange={(event) => change({ sourceUrl: event.target.value })} aria-label={t('version.sourceUrl')} />
      </Field>
      <Field label={t('version.note')}>
        <Textarea rows={2} value={draft.note} maxLength={1000} onChange={(event) => change({ note: event.target.value })} />
      </Field>
    </Modal>
  )
}

function StarterConfirm({ model, actions }: { model: SubstancesViewModel; actions?: SubstanceDialogActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  if (!model.starterConfirm) return null
  return (
    <Modal
      open
      size="sm"
      title={t('rsl.starterTitle')}
      onClose={() => actions?.onStarter?.(false)}
      footer={
        <>
          <Button onClick={() => actions?.onStarter?.(false)}>{q('common.close')}</Button>
          <Button variant="primary" heldReason={model.busy ? q('common.loading') : null} onClick={() => actions?.onStarterConfirm?.()}>
            {t('rsl.starterConfirm')}
          </Button>
        </>
      }
    >
      {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
      <p>{t('rsl.starterBody')}</p>
      <p className="fw-q-hint">{t('rsl.starterOff')}</p>
    </Modal>
  )
}
