'use client'

import Link from 'next/link'
import { Banner, Card, EmptyState, Field, OrderedList } from '@nexus/ui/components'
import { Button, NumberStepper, Pill, Select, Toggle } from '@nexus/ui/primitives'
import { EditModeBar, Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ReadState } from '../../_shared/parts'
import type { EventInfo } from '../api'
import { recordKindOf, TRIGGER_EVENTS, type ChipKind, type Frequency, type TriggerEvent } from '../constants'
import { chipPickable, DUE_HOURS_MAX, frequencyWords, planHref, ruleProblems, rulesChanges, rulesPlan, type EventFacts, type RuleDraft, type RulePlanFacts } from '../model'
import { AddIcon, ChipEditor, ChipsLine, problemAt, SectionHead, useSay } from './parts'
import type { PlansModel } from './PlansView'

export interface TriggersActions {
  onRules?: (drafts: RuleDraft[]) => void
  onDiscardRules?: () => void
  onApplyRules?: () => void
  onRetryRules?: () => void
  onRuleOpen?: (key: string | 'new') => void
  onRuleDraft?: (draft: RuleDraft) => void
  onRuleDone?: () => void
  onRuleClose?: () => void
  onRulePreview?: () => void
  onChipSearch?: (kind: ChipKind, q: string) => void
}

/** The plans a rule may name, from the Plans grid (stage, approved or not). */
export function rulePlans(model: Pick<PlansModel, 'plans' | 'rules'>): (RulePlanFacts & { code: string; name: string; approvedNumber: number | null })[] {
  const grid = (model.plans.value?.plans ?? []).filter((row) => row.status !== 'RETIRED').map((row) => ({ id: row.id, stage: row.stage, approved: !!row.approved, code: row.code, name: row.name, approvedNumber: row.approved?.number ?? null }))
  // The plans the saved rules name, as the rules read them (a reader of the rules without the Plans grid still sees them).
  const named = (model.rules.value?.rules ?? []).map((rule) => ({ id: rule.plan.id, stage: rule.plan.stage, approved: !!rule.plan.approved, code: rule.plan.code, name: rule.plan.name, approvedNumber: rule.plan.approved?.number ?? null }))
  const seen = new Set(grid.map((entry) => entry.id))
  return [...grid, ...named.filter((entry) => !seen.has(entry.id) && seen.add(entry.id))]
}

const eventFacts = (events: readonly EventInfo[]): EventFacts[] => events.map((entry) => ({ event: entry.event, available: entry.available, stages: entry.stages, frequencies: entry.frequencies.map((item) => item.frequency), chipKinds: entry.chipKinds }))

/**
 * When inspections are created (design pl-triggers, QHS-010, QHS-011): the rules in order — when (goods received, an
 * operation finished, a bundle scanned; packing and a return received held, in words), for which chips, which plan, how
 * often — as an ordered list (drag or the grip's arrow keys) with ONE EditModeBar for the whole list; each rule says what
 * it really opened in the last 30 days and why it last opened nothing. A rule's dialog previews what the unsaved rule would
 * have created last month.
 */
export function TriggersTab({ model, actions }: { model: PlansModel; actions?: TriggersActions }) {
  const t = useT('quality-plans')
  const say = useSay()
  const locale = useLocale()
  const answer = model.rules.value
  const drafts = model.ruleDrafts
  if (!answer || !drafts) return <ReadState loading={!model.rules.problem} problem={model.rules.problem} onRetry={() => actions?.onRetryRules?.()} failedTitle={t('rules.failed')} rows={4} />
  const mayManage = model.can.triggersManage && answer.canManage
  const plans = rulePlans(model)
  const events = eventFacts(answer.events)
  const plan = rulesPlan(answer.rules, drafts)
  const count = rulesChanges(plan)
  const problemsOf = (draft: RuleDraft) => ruleProblems(draft, events, plans)
  const withProblems = drafts.filter((draft) => problemsOf(draft).length > 0).length
  const held = withProblems > 0 ? t('rules.heldProblems', { count: withProblems }) : model.live === 'offline' ? t('held.offline') : null
  const byKey = new Map(drafts.map((draft) => [draft.key, draft]))
  const saved = new Map(answer.rules.map((rule) => [rule.id, rule]))
  const planOf = (id: string) => plans.find((entry) => entry.id === id) ?? null
  const ruleLabel = (draft: RuleDraft) => t('rules.itemLabel', { position: drafts.indexOf(draft) + 1, event: t(`event.${draft.event}`), plan: planOf(draft.planId)?.code ?? '—' })
  const heldEvents = answer.events.filter((entry) => !entry.available)
  return (
    <section className="fw-qp-tab" aria-labelledby="fw-qp-rules">
      <Card padded>
        <SectionHead
          id="fw-qp-rules"
          title={t('rules.title')}
          sub={t('rules.sub')}
          actions={
            mayManage ? (
              <Button size="sm" onClick={() => actions?.onRuleOpen?.('new')} heldReason={plans.length === 0 ? t('rules.noPlans') : null}>
                <AddIcon /> {t('rules.add')}
              </Button>
            ) : null
          }
        />
        {!mayManage && <Banner tone="info" title={t('rules.readOnly')} />}
        {drafts.length === 0 ? (
          <EmptyState title={t('rules.empty')} description={t('rules.emptyBody')} />
        ) : (
          <OrderedList
            label={t('rules.list')}
            keyboardGrip
            liveDrag
            disabled={!mayManage}
            draggable={mayManage}
            items={drafts.map((draft) => draft.key)}
            itemLabel={(key) => {
              const draft = byKey.get(key)
              return draft ? ruleLabel(draft) : key
            }}
            onChange={(keys) => actions?.onRules?.(keys.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : [])))}
            renderItem={(key) => {
              const draft = byKey.get(key)
              if (!draft) return null
              const rule = draft.id ? (saved.get(draft.id) ?? null) : null
              const target = planOf(draft.planId)
              const kind = target ? recordKindOf(target.stage, draft.frequency) : null
              const problems = problemsOf(draft)
              const index = drafts.indexOf(draft)
              return (
                <div className="fw-qp-rule">
                  <div className="fw-qp-rule-main">
                    <span className="fw-qp-rule-n" aria-hidden>
                      {index + 1}
                    </span>
                    <span className="fw-qp-rule-text">
                      <strong>{t('rules.when', { event: t(`event.${draft.event}`) })}</strong>
                      <span>
                        {t('rules.for')} <ChipsLine chips={draft.chips} prefix={model.prefix} empty={t('rules.everything')} />
                      </span>
                      <span>
                        {t('rules.plan')}{' '}
                        {target ? (
                          <Link className="fw-q-link fw-q-code" href={planHref(model.prefix, target.id)}>
                            {target.approvedNumber ? t('rules.planVersion', { code: target.code, number: target.approvedNumber }) : target.code}
                          </Link>
                        ) : (
                          '—'
                        )}
                        {' · '}
                        {say(frequencyWords(draft.frequency, draft.frequencyValue))}
                        {kind && <> → {t(`recordKind.${kind}`)}</>}
                        {draft.dueHours !== '' && <> · {t('rules.dueWithin', { hours: draft.dueHours })}</>}
                      </span>
                    </span>
                  </div>
                  <div className="fw-qp-rule-side">
                    {!draft.id && <Pill tone="info">{t('rules.new')}</Pill>}
                    {rule && draft.id && plan.edits.some((edit) => edit.draft.key === draft.key) && <Pill tone="warning">{t('rules.changed')}</Pill>}
                    <span className="fw-qp-inline">
                      <Toggle checked={draft.active} size="sm" aria-label={t('rules.activeFor', { label: ruleLabel(draft) })} disabled={!mayManage} onChange={(next) => actions?.onRules?.(drafts.map((entry) => (entry.key === draft.key ? { ...entry, active: next } : entry)))} />
                      {draft.active ? t('rules.on') : t('rules.off')}
                    </span>
                    {mayManage && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => actions?.onRuleOpen?.(draft.key)} aria-label={t('rules.editFor', { label: ruleLabel(draft) })}>
                          {t('rules.edit')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => actions?.onRules?.(drafts.filter((entry) => entry.key !== draft.key))} aria-label={t('rules.removeFor', { label: ruleLabel(draft) })}>
                          {t('rules.remove')}
                        </Button>
                      </>
                    )}
                  </div>
                  {rule && (
                    <p className="fw-qp-rule-did">
                      {rule.opened.last30Days > 0 || rule.opened.lastAt
                        ? t('rules.opened', { count: rule.opened.last30Days, n: formatNumber(rule.opened.last30Days, locale), last: rule.opened.lastAt ? formatDate(rule.opened.lastAt, { locale }) : '—' })
                        : t('rules.openedNone')}
                      {rule.skipped.lastWords && <> · {t('rules.skipped', { count: rule.skipped.last30Days, why: rule.skipped.lastWords[locale] })}</>}
                    </p>
                  )}
                  {problems.length > 0 && (
                    <p className="fw-qp-problem" role="status">
                      {say(problems[0])}
                    </p>
                  )}
                </div>
              )
            }}
          />
        )}
        {heldEvents.length > 0 && (
          <ul className="fw-qp-held-events" aria-label={t('rules.heldEvents')}>
            {heldEvents.map((entry) => (
              <li key={entry.event}>
                <strong>{t(`event.${entry.event}`)}</strong> — {entry.held?.[locale] ?? t('rules.eventHeld')}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {mayManage && count > 0 && (
        <EditModeBar
          count={count}
          onDiscard={() => actions?.onDiscardRules?.()}
          onApply={() => actions?.onApplyRules?.()}
          applyLabel={model.busy === 'triggers' ? t('common.saving') : t('rules.apply', { count })}
          busy={model.busy === 'triggers'}
          applyHeldReason={held}
          saveShortcut
        />
      )}
      {model.ruleDialog && <RuleDialog model={model} events={answer.events} actions={actions} />}
    </section>
  )
}

/** One rule (new or changed): when, for which chips, which plan, how often, on or off; Preview asks what last month would have opened. */
function RuleDialog({ model, events, actions }: { model: PlansModel; events: readonly EventInfo[]; actions?: TriggersActions }) {
  const t = useT('quality-plans')
  const say = useSay()
  const locale = useLocale()
  const dialog = model.ruleDialog!
  const draft = dialog.draft
  const set = (change: Partial<RuleDraft>) => actions?.onRuleDraft?.({ ...draft, ...change })
  const info = events.find((entry) => entry.event === draft.event)
  const plans = rulePlans(model).filter((entry) => !info || info.stages.includes(entry.stage))
  const problems = ruleProblems(draft, eventFacts(events), rulePlans(model))
  const shown = dialog.shown
  const frequencyInfo = info?.frequencies.find((entry) => entry.frequency === draft.frequency)
  const pickEvent = (event: TriggerEvent) => {
    const next = events.find((entry) => entry.event === event)
    const firstPlan = rulePlans(model).find((entry) => next?.stages.includes(entry.stage))
    set({ event, planId: firstPlan?.id ?? '', frequency: next?.frequencies[0]?.frequency ?? 'EVERY_LOT', frequencyValue: '', chips: draft.chips.filter((chip) => next?.chipKinds.includes(chip.kind)) })
  }
  const preview = dialog.preview
  return (
    <Modal
      open
      size="lg"
      title={draft.id ? t('rules.dialogEdit') : t('rules.dialogNew')}
      subtitle={t('rules.dialogSub')}
      onClose={() => actions?.onRuleClose?.()}
      footer={
        <>
          <Button onClick={() => actions?.onRuleClose?.()}>{t('common.cancel')}</Button>
          <Button heldReason={problems.length > 0 ? t('rules.previewHeld') : null} onClick={() => actions?.onRulePreview?.()}>
            {t('rules.preview')}
          </Button>
          <Button variant="primary" heldReason={shown && problems.length > 0 ? t('rules.heldProblems', { count: 1 }) : null} onClick={() => actions?.onRuleDone?.()}>
            {t('rules.done')}
          </Button>
        </>
      }
    >
      <div className="fw-qp-form">
        <div className="fw-qp-two">
          <Field label={t('rules.whenLabel')} error={say(problemAt(problems, 'event', shown)) || undefined}>
            <Select value={draft.event} onChange={(event) => pickEvent(event.target.value as TriggerEvent)}>
              {TRIGGER_EVENTS.map((event) => {
                const entry = events.find((item) => item.event === event)
                return (
                  <option key={event} value={event} disabled={!entry?.available}>
                    {entry?.available ? t(`event.${event}`) : t('rules.eventNotYet', { event: t(`event.${event}`) })}
                  </option>
                )
              })}
            </Select>
          </Field>
          <Field label={t('rules.planLabel')} hint={t('rules.planHint')} error={say(problemAt(problems, 'planId', shown)) || undefined}>
            <Select value={draft.planId} onChange={(event) => set({ planId: event.target.value })}>
              <option value="">{t('newPlan.pick')}</option>
              {plans.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.approvedNumber ? t('rules.planOption', { code: entry.code, name: entry.name, number: entry.approvedNumber }) : t('rules.planOptionNone', { code: entry.code, name: entry.name })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {info && !info.available && info.held && <Banner tone="warning" title={info.held[locale]} />}
        <ChipEditor
          label={t('rules.forLabel')}
          chips={draft.chips}
          kinds={info?.chipKinds ?? []}
          pickable={(kind) => chipPickable(kind, model.can)}
          prefix={model.prefix}
          search={model.chipSearch}
          problems={shown ? problems : []}
          onChange={(chips) => set({ chips })}
          onSearch={(kind, q) => actions?.onChipSearch?.(kind, q)}
        />
        <div className="fw-qp-two">
          <Field label={t('rules.howOften')} error={say(problemAt(problems, 'frequency', shown)) || undefined}>
            <Select value={draft.frequency} onChange={(event) => set({ frequency: event.target.value as Frequency, frequencyValue: '' })}>
              {(info?.frequencies ?? []).map((entry) => (
                <option key={entry.frequency} value={entry.frequency}>
                  {t(`frequencyForm.${entry.frequency}`)}
                </option>
              ))}
            </Select>
          </Field>
          {frequencyInfo?.takesValue && (
            <Field label={t(draft.frequency === 'PERCENT_OF_OPERATIONS' ? 'rules.percent' : 'rules.everyN')} error={say(problemAt(problems, 'frequencyValue', shown)) || undefined}>
              <NumberStepper
                value={draft.frequencyValue}
                min={1}
                max={draft.frequency === 'PERCENT_OF_OPERATIONS' ? 100 : 10_000}
                suffix={draft.frequency === 'PERCENT_OF_OPERATIONS' ? '%' : undefined}
                decrementLabel={t('common.less')}
                incrementLabel={t('common.more')}
                onChange={(value) => set({ frequencyValue: value })}
              />
            </Field>
          )}
        </div>
        {/* B-W2b-213: what the rule opens is due its hours later (empty: no due time); My inspections sorts by it. */}
        <Field label={t('rules.dueHours')} hint={t('rules.dueHoursHint')} error={say(problemAt(problems, 'dueHours', shown)) || undefined}>
          <NumberStepper value={draft.dueHours} min={1} max={DUE_HOURS_MAX} suffix="h" decrementLabel={t('common.less')} incrementLabel={t('common.more')} onChange={(value) => set({ dueHours: value })} />
        </Field>
        <label className="fw-qp-inline">
          <Toggle checked={draft.active} aria-label={t('rules.activeLabel')} onChange={(next) => set({ active: next })} /> {draft.active ? t('rules.activeOn') : t('rules.activeOff')}
        </label>
        <section className="fw-qp-preview" aria-live="polite" aria-label={t('rules.previewTitle')}>
          <h3 className="fw-qp-h3">{t('rules.previewTitle')}</h3>
          {!preview && <p className="fw-qp-muted">{t('rules.previewAsk')}</p>}
          {preview && preview.value === null && !preview.problem && <p className="fw-qp-muted">{t('rules.previewReading')}</p>}
          {preview?.problem && <p className="fw-qp-problem">{t(preview.problem)}</p>}
          {preview?.value && <p>{preview.value.words[locale]}</p>}
        </section>
      </div>
    </Modal>
  )
}
