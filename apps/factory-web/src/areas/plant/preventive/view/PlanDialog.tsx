'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Spinner } from '@nexus/ui/primitives'
import { INTERVAL_MAX } from '@nexus/factory-domain/plant/statutory/rules'
import { Combobox, DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { CheckType } from '../api'
import { atField, CHECK_INTERVAL_UNITS, machineText, planHeld, reminderFrom, typeLabel, withType, type PlanDraft } from '../model'
import type { PlanNewState, PreventivePageActions, PreventivePageModel, Read } from '../view-model'
import { CheckLaw, intervalText, problemText, useDay, useWords } from './parts'

/** A picker's read in words: reading, failed (our words), or the choices. */
const readHint = (t: (key: string) => string, read: Read<unknown> | null, ready: string): string => (!read || read.status === 'loading' ? t('common.reading') : read.status === 'error' ? t(read.problem) : ready)

/**
 * New plan (design pop:plan; band secondary, `n`): machine · check type (from Plant settings, of the machine's class or
 * for any machine) · interval (the type's default) · outside body · owner · first due · reminder lead time · note. A
 * machine that has a plan for this check already: the API's PLAN_EXISTS is said, and "Replace it" ends that plan in the
 * same step with a reason. Esc closes and the focus goes back to the opener (the DS Modal).
 */
export function PlanDialog({ model, state, actions }: { model: PreventivePageModel; state: PlanNewState; actions?: PreventivePageActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const day = useDay()
  const { draft, problem } = state
  const held = !model.can.manage ? 'held.manage' : planHeld(draft, state.busy)
  const machines = state.machines.status === 'ready' ? state.machines.value : []
  const machine = machines.find((entry) => entry.id === draft.machineId) ?? null
  const types = state.types?.status === 'ready' ? state.types.value : []
  const type: CheckType | null = types.find((entry) => entry.id === draft.checkTypeId) ?? null
  const set = (change: Partial<PlanDraft>) => actions?.onPlanDraft?.({ ...draft, ...change })
  const error = (...fields: string[]) => {
    const key = atField(problem, ...fields)
    return key ? t(key) : undefined
  }
  const exists = problem?.key === 'refusal.PLAN_EXISTS'
  const remindOn = reminderFrom(draft.firstDueOn, draft.reminderDays)
  const close = () => actions?.onAddress?.({ newPlan: false })

  return (
    <Modal
      open
      onClose={close}
      title={t('plan.newTitle')}
      subtitle={model.scope.site ? t('plan.atSite', { site: model.scope.site.name }) : t('plan.anySite')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onCreatePlan?.()}>
            {state.busy ? <Spinner size={14} /> : null} {draft.replace ? t('plan.replaceAndCreate') : t('plan.create')}
          </Button>
        </>
      }
    >
      <div className="fw-pv-form">
        <div className="fw-pv-form-row">
          <Field label={t('plan.machine')} required hint={readHint(t, state.machines, t('plan.machineHint'))} error={error('machineId')}>
            <Combobox
              value={draft.machineId}
              placeholder={t('plan.machinePlaceholder')}
              options={machines.map((entry) => ({ value: entry.id, label: `${machineText(entry)} · ${locale === 'it' ? entry.class.labelIt : entry.class.labelEn}${model.scope.allSites ? ` · ${entry.siteCode}` : ''}` }))}
              onChange={(machineId) => actions?.onPickMachine?.(machineId)}
            />
          </Field>
          <Field label={t('plan.type')} required hint={!machine ? t('plan.typeFirst') : readHint(t, state.types, types.length === 0 ? t('plan.typeNone') : t('plan.typeHint'))} error={error('checkTypeId')}>
            <Select value={draft.checkTypeId} disabled={!machine || state.types?.status !== 'ready'} onChange={(event) => actions?.onPlanDraft?.(withType(draft, types.find((entry) => entry.id === event.target.value) ?? null))}>
              <option value="">{t('plan.typePick')}</option>
              {types.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {typeLabel(entry, locale)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {type && (
          <div className="fw-pv-row">
            <CheckLaw type={type} say={t} />
            <span className="fw-pv-muted">{t('plan.typeFacts', { interval: intervalText(t, type.defaultInterval, type.defaultIntervalUnit), years: type.keptYears })}</span>
            {type.outsideBody ? <span className="fw-pv-muted">{t('plan.typeOutside')}</span> : null}
          </div>
        )}
        <div className="fw-pv-form-row">
          <Field label={t('plan.interval')} required hint={t('plan.intervalHint', { max: INTERVAL_MAX[draft.intervalUnit] })} error={error('interval', 'intervalUnit')}>
            <span className="fw-pv-row">
              <Input type="number" inputMode="numeric" min={1} max={INTERVAL_MAX[draft.intervalUnit]} value={draft.interval} aria-label={t('plan.interval')} onChange={(event) => set({ interval: event.target.value })} />
              <Select value={draft.intervalUnit} aria-label={t('plan.unit')} onChange={(event) => set({ intervalUnit: event.target.value as PlanDraft['intervalUnit'] })}>
                {CHECK_INTERVAL_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {t(`unit.${unit}`)}
                  </option>
                ))}
              </Select>
            </span>
          </Field>
          <Field label={t('plan.firstDue')} required hint={t('plan.firstDueHint')} error={error('firstDueOn')}>
            <DateField value={draft.firstDueOn} onChange={(firstDueOn) => set({ firstDueOn })} ariaLabel={t('plan.firstDue')} />
          </Field>
          <Field label={t('plan.reminder')} hint={remindOn ? t('plan.reminderOn', { date: day(remindOn) }) : t('plan.reminderHint')} error={error('reminderDays')}>
            <Input type="number" inputMode="numeric" min={0} max={365} value={draft.reminderDays} onChange={(event) => set({ reminderDays: event.target.value })} />
          </Field>
        </div>
        <div className="fw-pv-form-row">
          <Field label={t('plan.body')} hint={!model.can.parties ? t('held.parties') : !machine ? t('plan.bodyFirst') : readHint(t, state.bodies, t('plan.bodyHint'))} error={error('outsideBodyPartyId')}>
            <Combobox
              value={draft.outsideBodyPartyId}
              placeholder={t('plan.bodyPlaceholder')}
              options={[{ value: '', label: t('body.inHouse') }, ...(state.bodies?.status === 'ready' ? state.bodies.value.map((entry) => ({ value: entry.id, label: entry.tradeName ? `${entry.legalName} (${entry.tradeName})` : entry.legalName })) : [])]}
              onChange={(outsideBodyPartyId) => set({ outsideBodyPartyId })}
            />
          </Field>
          <Field label={t('plan.owner')} hint={!machine ? t('plan.ownerFirst') : readHint(t, state.owners, t('plan.ownerHint'))} error={error('ownerId')}>
            <Select value={draft.ownerId} disabled={!machine || state.owners?.status === 'loading'} onChange={(event) => set({ ownerId: event.target.value })}>
              <option value="">{t('owner.none')}</option>
              {state.owners?.status === 'ready' &&
                state.owners.value.map((owner) => (
                  <option key={owner.id} value={owner.id}>
                    {owner.me ? t('plan.ownerMe', { name: owner.name }) : owner.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <Field label={t('plan.note')} error={error('note')}>
          <Textarea value={draft.note} rows={2} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        {exists && (
          <div className="fw-pv-fieldset" role="group" aria-label={t('plan.replaceTitle')}>
            <Banner tone="warning" title={t('refusal.PLAN_EXISTS')}>
              {t('plan.replaceBody')}
            </Banner>
            <Checkbox checked={draft.replace} onChange={(event) => set({ replace: event.target.checked })} label={t('plan.replace')} />
            {draft.replace && (
              <Field label={t('plan.replaceReason')} required error={error('replaceReason')}>
                <Textarea value={draft.replaceReason} rows={2} onChange={(event) => set({ replaceReason: event.target.value })} />
              </Field>
            )}
          </div>
        )}
        {problem && !exists && !problem.field && <Banner tone="danger" title={problemText(t, problem)} />}
      </div>
    </Modal>
  )
}
