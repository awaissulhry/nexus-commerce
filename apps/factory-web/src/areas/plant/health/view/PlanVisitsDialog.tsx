'use client'

import { CalendarPlus, Plus, Trash2 } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Checkbox, Input, Select, Spinner } from '@nexus/ui/primitives'
import { HEALTH_LIMITS } from '@nexus/factory-domain/safety/health/rules'
import { DateField, Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { Proposal } from '../api'
import { BY_HAND_TYPES, byHandHeld, newByHand, planItemsOf, planVisitsHeld, proposalKey, type ByHandDraft, type ByHandType } from '../model'
import type { HealthPageActions, HealthPageModel, PlanVisitsState } from '../view-model'
import { personText, ProtectedLaw, say, useWhen, useWords } from './parts'

/**
 * design pop:plan — Plan visits (band secondary, `p`): "Create due items from the plans for chosen people". The visits nobody
 * planned yet (POST …/visits/proposals, a recorded read: said first) with why each is due and whether its plan's doctor is
 * recorded (a plan without its doctor only proposes); HR may add a visit by hand — on request, or the return after more than 60
 * days of absence with its LENGTH only, never its reason. "Plan N visits" sends them all at once (all or none).
 */
export function PlanVisitsDialog({ model, state, actions }: { model: HealthPageModel; state: PlanVisitsState; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const when = useWhen()
  const proposals: readonly Proposal[] = state.proposals.status === 'ready' ? state.proposals.value.proposals : []
  const chosen = new Set(state.chosen)
  const held = state.proposals.status === 'loading' ? t('common.reading') : say(t, planVisitsHeld(proposals, chosen, state.byHand))
  const count = planItemsOf(proposals, chosen, []).length + state.byHand.length
  const people = state.people?.status === 'ready' ? state.people.value.people : []
  const setItem = (key: string, change: Partial<ByHandDraft>) => actions?.onPlanByHand?.(state.byHand.map((item) => (item.key === key ? { ...item, ...change } : item)))
  // Which entry a refusal names: the items are the chosen proposals, then the visits by hand.
  const chosenList = proposals.filter((proposal) => chosen.has(proposalKey(proposal)))
  const refusedAt = state.problem?.item ?? null
  const refusedKey = refusedAt === null ? null : refusedAt < chosenList.length ? proposalKey(chosenList[refusedAt]!) : (state.byHand[refusedAt - chosenList.length]?.key ?? null)

  return (
    <Modal
      open
      onClose={() => actions?.onPlanClose?.()}
      title={t('planVisits.title')}
      size="xl"
      footer={
        <>
          <Button onClick={() => actions?.onPlanClose?.()}>{t('common.cancel')}</Button>
          <span className="grow" />
          <Button variant="primary" heldReason={state.busy ? t('held.saving') : held} onClick={() => actions?.onPlanSave?.()}>
            {state.busy ? <Spinner size={12} /> : <CalendarPlus size={14} aria-hidden />} {t('planVisits.save', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-hv-form">
        <PrivacyNote level="protected" variant="panel" recorded text={t('planVisits.privacy')} law={<ProtectedLaw />} labels={ds.privacyNote} />
        {state.problem && <Banner tone="danger" title={t('planVisits.refused')}>{t(state.problem.key, state.problem.params)}</Banner>}

        <fieldset className="fw-hv-fieldset">
          <legend>{t('planVisits.proposed')}</legend>
          {state.proposals.status === 'loading' ? (
            <p className="fw-hv-muted" role="status">
              <Spinner size={12} /> {t('common.reading')}
            </p>
          ) : state.proposals.status === 'error' ? (
            <Banner
              tone="warning"
              title={t('planVisits.failed')}
              action={
                <Button size="sm" onClick={() => actions?.onPlanRetry?.()}>
                  {t('common.retry')}
                </Button>
              }
            >
              {t(state.proposals.problem)}
            </Banner>
          ) : proposals.length === 0 ? (
            <EmptyState title={t('planVisits.noneTitle')} description={t('planVisits.none')} />
          ) : (
            <>
              <span className="fw-hv-row">
                <Button size="sm" variant="quiet" onClick={() => actions?.onPlanChosen?.(proposals.map(proposalKey))}>
                  {t('planVisits.all')}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => actions?.onPlanChosen?.([])}>
                  {t('planVisits.noneChosen')}
                </Button>
              </span>
              <ul className="fw-hv-proposals">
                {proposals.map((proposal) => {
                  const key = proposalKey(proposal)
                  return (
                    <li key={key} className="fw-hv-proposal" data-refused={refusedKey === key || undefined}>
                      <Checkbox
                        checked={chosen.has(key)}
                        onChange={(event) => actions?.onPlanChosen?.(event.target.checked ? [...state.chosen, key] : state.chosen.filter((entry) => entry !== key))}
                        label={
                          <span className="fw-hv-cell">
                            <b>{personText(proposal.employee)}</b>
                            <span>
                              {t(`visitType.${proposal.type}`)} · {proposal.role.code} · {proposal.role.name} · {t('planVisits.dueOn', { day: when.day(proposal.dueOn) })}
                            </span>
                            <span className="fw-hv-muted">
                              {t(`why.${proposal.why}`)} · {proposal.doctorSet ? t('planVisits.doctorSet') : t('planVisits.doctorNotSet')}
                            </span>
                          </span>
                        }
                      />
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </fieldset>

        <fieldset className="fw-hv-fieldset">
          <legend>{t('planVisits.byHand')}</legend>
          <p className="fw-hv-muted">{t('planVisits.byHandHint')}</p>
          {state.byHand.map((item, index) => {
            const itemHeld = say(t, byHandHeld(item))
            return (
              <div key={item.key} className="fw-hv-byhand" data-refused={refusedKey === item.key || undefined}>
                <div className="fw-hv-form-row">
                  <Field label={t('planVisits.person')} required>
                    {item.employeeId ? (
                      <span className="fw-hv-row">
                        <b>{item.name}</b>
                        <Button size="sm" variant="quiet" onClick={() => actions?.onPlanPick?.(item.key)}>
                          {t('judge.change')}
                        </Button>
                      </span>
                    ) : (
                      // A span, not the button, takes the Field's id: the button keeps its own name ("Choose a person").
                      <span className="fw-hv-row">
                        <Button size="sm" onClick={() => actions?.onPlanPick?.(item.key)}>
                          {t('planVisits.pick')}
                        </Button>
                      </span>
                    )}
                  </Field>
                  <Field label={t('planVisits.type')} required>
                    <Select value={item.type} onChange={(event) => setItem(item.key, { type: event.target.value as ByHandType })}>
                      {BY_HAND_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(`visitType.${type}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('planVisits.due')} required>
                    <DateField value={item.dueOn} onChange={(value) => setItem(item.key, { dueOn: value })} ariaLabel={t('planVisits.due')} />
                  </Field>
                  {item.type === 'RETURN_AFTER_ABSENCE' && (
                    <Field label={t('planVisits.absence')} required hint={t('planVisits.absenceHint', { least: HEALTH_LIMITS.absenceDaysMin })}>
                      <Input inputMode="numeric" value={item.absenceDays} onChange={(event) => setItem(item.key, { absenceDays: event.target.value })} />
                    </Field>
                  )}
                </div>
                {state.picking === item.key && (
                  <div className="fw-hv-picker">
                    <Input type="search" value={state.peopleQuery} placeholder={t('judge.search')} aria-label={t('judge.search')} onChange={(event) => actions?.onPlanPeopleQuery?.(event.target.value)} />
                    {state.people?.status === 'loading' && <p className="fw-hv-muted">{t('common.reading')}</p>}
                    {state.people?.status === 'error' && <p className="fw-hv-warn">{t(state.people.problem)}</p>}
                    {state.people?.status === 'ready' && people.length === 0 && <p className="fw-hv-muted">{t('judge.nobody')}</p>}
                    <ul className="fw-hv-picks">
                      {people.slice(0, 12).map((person) => (
                        <li key={person.id}>
                          <Button size="sm" variant="quiet" onClick={() => actions?.onPlanPerson?.(item.key, person)}>
                            {personText({ name: person.name, employeeCode: person.employeeCode })} · {person.site.name}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <span className="fw-hv-row">
                  {itemHeld ? <span className="fw-hv-muted">{itemHeld}</span> : null}
                  <Button size="sm" variant="quiet" aria-label={t('planVisits.remove', { n: index + 1 })} onClick={() => actions?.onPlanByHand?.(state.byHand.filter((entry) => entry.key !== item.key))}>
                    <Trash2 size={13} aria-hidden /> {t('planVisits.removeShort')}
                  </Button>
                </span>
              </div>
            )
          })}
          <span>
            <Button size="sm" heldReason={model.can.pickPeople ? null : t('held.pickPeople')} onClick={() => actions?.onPlanByHand?.([...state.byHand, newByHand(`hand-${state.byHand.length + 1}-${Date.now()}`, model.today)])}>
              <Plus size={13} aria-hidden /> {t('planVisits.add')}
            </Button>
          </span>
        </fieldset>
      </div>
    </Modal>
  )
}
