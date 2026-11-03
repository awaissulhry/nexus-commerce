'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { Check, Lock, MoreHorizontal, ShieldAlert, X } from 'lucide-react'
import { Banner, Card, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Checkbox, NumberStepper, Pill, RadioCard, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import { AMENDMENT_LAW, OVERRIDE_REASON_WORDS, SEPARATIONS, SIGNING_RULES, wordsIn, type FourEyesCondition, type Loosening } from '@nexus/factory-domain/quality/rules/duties'
import { EditModeBar, StepUpModal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { Freshness, NoAccess, PageHead, QualityMessages } from '../../_shared/parts'
import type { LiveState, Notice, Read } from '../../_shared/model'
import type { StepUpState } from '../../_shared/hooks'
import type { AlertRules, Customer, Rules } from '../api'
import {
  changeHeld,
  conditionInherited,
  dutiesChanges,
  dutiesLooseningsOf,
  dutiesPreview,
  removedCustomers,
  resultsChanges,
  resultsPreview,
  resultsProblem,
  withCondition,
  type Address,
  type DutiesDraft,
  type ResultsDraft,
  type RuleDraft,
  type Scope,
} from '../model'
import { AlertsList, type AlertsActions } from './AlertsList'
import { KeysDialog, LoosenDialog, RemoveDialog, RuleDialog } from './RuleDialog'
import '../rules.css'

/** The catalogues of this page: its own and the shared quality words (QualityMessages adds `quality`, `lists`, `records`). */
export const RULES_NAMESPACES = ['quality-rules'] as const

export interface RulesModel {
  readonly prefix: string
  readonly address: Address
  /** The company of the address (the "This company" scope). */
  readonly companyName: string
  /** quality.rules.view. */
  readonly canView: boolean
  /** The scope's rules, and every company's (what a company follows). */
  readonly rules: Read<Rules>
  readonly tenant: Read<Rules>
  readonly alerts: Read<AlertRules>
  readonly duties: DutiesDraft | null
  readonly results: ResultsDraft | null
  /** The customers the four-eyes list may name (read when the person adds one; parties.view). */
  readonly customers: Read<Customer[]> | null
  readonly canPickCustomers: boolean
  readonly busy: 'duties' | 'results' | 'alerts' | null
  readonly selected: readonly string[]
  readonly notice: Notice | null
  readonly loosen: { readonly reason: string; readonly codes: readonly Loosening[]; readonly removed: number } | null
  readonly ruleDialog: { readonly draft: RuleDraft; readonly problem: string | null; readonly shown: boolean } | null
  readonly remove: { readonly ids: readonly string[] } | null
  readonly stepUp: StepUpState
  readonly live: LiveState
  readonly asOf: string | null
  /** The rules changed on another screen while this one holds unsaved changes. */
  readonly changedElsewhere: boolean
  /** ⋯ Keyboard shortcuts. */
  readonly keysOpen: boolean
}

export interface RulesActions extends AlertsActions {
  onScope?: (scope: Scope) => void
  onDuties?: (draft: DutiesDraft) => void
  onDiscardDuties?: () => void
  onApplyDuties?: () => void
  onLoosenReason?: (reason: string) => void
  onLoosenConfirm?: () => void
  onLoosenCancel?: () => void
  onResults?: (draft: ResultsDraft) => void
  onDiscardResults?: () => void
  onApplyResults?: () => void
  onPickCustomers?: () => void
  onRuleDraft?: (draft: RuleDraft) => void
  onRuleSave?: () => void
  onRuleClose?: () => void
  onConfirmRemove?: () => void
  onCancelRemove?: () => void
  onStepUp?: (code: string) => void
  onStepUpCancel?: () => void
  onReload?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
  onKeysClose?: () => void
}

/**
 * SCR-260 Quality › Settings › Quality rules (design quality.settings; QHS-154, QHS-300): whose rules (this company, or
 * every company: a company follows every company where it keeps nothing of its own), then three cards — Separation of
 * duties and four-eyes (who may sign what: the settings, the locked and fixed rules with their why, who floor records
 * name per site, the separations every role keeps), Result rules, and Alerts and escalation (the rules in the ONE list
 * frame, the rule dialog, a test sent to me). Each form card saves with its EditModeBar (⌘S); a looser rule asks the
 * confirm in words, the reason, then a fresh code (qs-loosen); tightening never asks. Fetches nothing.
 */
export function RulesView({ model, actions }: { model: RulesModel; actions?: RulesActions }) {
  return (
    <QualityMessages namespaces={RULES_NAMESPACES}>
      <RulesPage model={model} actions={actions} />
    </QualityMessages>
  )
}

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
}

function RulesPage({ model, actions }: { model: RulesModel; actions?: RulesActions }) {
  const t = useT('quality-rules')
  const q = useT('quality')
  const ds = useDsWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  // c: Add rule (outside fields and dialogs), when the person may keep rules.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      if (current.model.ruleDialog || current.model.loosen || current.model.keysOpen || current.model.stepUp.open || !current.model.alerts.value?.mayManage) return
      event.preventDefault()
      current.actions?.onRuleOpen?.('new')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!model.canView) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />
  const rules = model.rules.value
  const dutiesCount = rules && model.duties ? dutiesChanges(rules, model.duties) : 0
  const resultsCount = rules && model.results ? resultsChanges(rules, model.results) : 0
  const moreItems: MenuItemDef[] = [
    { id: 'reload', label: t('head.reload'), onSelect: () => actions?.onReload?.() },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onKeys?.() },
  ]
  return (
    <div className="fw-q fw-qr">
      <PageHead
        intro={t('head.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            <SegmentedControl
              size="sm"
              ariaLabel={t('scope.label')}
              value={model.address.scope}
              onChange={(value) => actions?.onScope?.(value as Scope)}
              options={[
                { value: 'company', label: t('scope.company', { company: model.companyName }) },
                { value: 'all', label: t('scope.all') },
              ]}
            />
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('head.more') }} items={moreItems} />
          </>
        }
      />
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params as Record<string, string | number> | undefined)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {model.changedElsewhere && (
        <Banner
          tone="warning"
          title={t('live.changedTitle')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('live.reload')}
            </Button>
          }
        >
          {t('live.changedBody')}
        </Banner>
      )}
      {model.live === 'offline' && <Banner tone="warning" title={t('held.offline')} />}
      {model.address.scope === 'company' && rules && <p className="fw-qr-hint">{t('scope.companyHint')}</p>}
      {model.address.scope === 'all' && rules && <p className="fw-qr-hint">{t('scope.allHint')}</p>}

      <div className="fw-qr-grid">
        <DutiesCard model={model} actions={actions} count={dutiesCount} shortcut={dutiesCount > 0} />
        <div className="fw-qr-side">
          <ResultsCard model={model} actions={actions} count={resultsCount} shortcut={dutiesCount === 0 && resultsCount > 0} />
          <SignersCard model={model} />
        </div>
      </div>

      <AlertsList model={model} actions={actions} />

      <LoosenDialog open={!!model.loosen} codes={model.loosen?.codes ?? []} removed={model.loosen?.removed ?? 0} reason={model.loosen?.reason ?? ''} busy={model.busy === 'duties'} onReason={(reason) => actions?.onLoosenReason?.(reason)} onConfirm={() => actions?.onLoosenConfirm?.()} onClose={() => actions?.onLoosenCancel?.()} />
      <RuleDialog model={model} actions={actions} />
      <KeysDialog open={model.keysOpen} onClose={() => actions?.onKeysClose?.()} />
      <RemoveDialog open={!!model.remove} count={model.remove?.ids.length ?? 0} busy={model.busy === 'alerts'} onConfirm={() => actions?.onConfirmRemove?.()} onClose={() => actions?.onCancelRemove?.()} />
      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? q(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUp?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('stepUp.confirm')}
        labels={ds.stepUp}
      />
    </div>
  )
}

/** A card's read failed: its words and Try again, the rest of the page works. */
function CardFailed({ problem, onRetry }: { problem: string; onRetry?: () => void }) {
  const t = useT('quality-rules')
  return (
    <Banner
      tone="danger"
      title={t('card.failed')}
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    >
      {t(problem)}
    </Banner>
  )
}

/** "Changed 10:42" under a card (when the scope's row was last saved), or "Never changed: the defaults apply". */
function Changed({ at }: { at: string | null }) {
  const t = useT('quality-rules')
  const locale = useLocale()
  return <p className="fw-qr-changed">{at ? t('card.changedAt', { time: formatTime(at, { locale }) }) : t('card.neverChanged')}</p>
}

/** Where a value in force comes from, in words. */
function Source({ source }: { source: 'COMPANY' | 'TENANT' | 'DEFAULT' }) {
  const t = useT('quality-rules')
  return <span className="fw-qr-source">{t(`source.${source}`)}</span>
}

function DutiesCard({ model, actions, count, shortcut }: { model: RulesModel; actions?: RulesActions; count: number; shortcut: boolean }) {
  const t = useT('quality-rules')
  const rules = model.rules.value
  const tenant = model.address.scope === 'company' ? model.tenant.value : rules
  const draft = model.duties
  const held = changeHeld(rules, model.busy !== null, model.live === 'offline')
  const disabled = held !== null
  const isCompany = model.address.scope === 'company'
  const body = (): ReactNode => {
    if (model.rules.problem) return <CardFailed problem={model.rules.problem} onRetry={actions?.onRetry} />
    if (!rules || !draft) return <Skeleton height={360} />
    const preview = dutiesPreview(rules, tenant ?? null, draft)
    const inherited = tenant?.duties.inForce
    const loosens = dutiesLooseningsOf(rules, tenant ?? null, draft)
    const own = rules.duties.customers.filter((customer) => customer.listedOn === (isCompany ? 'COMPANY' : 'TENANT'))
    const theirs = isCompany ? rules.duties.customers.filter((customer) => customer.listedOn === 'TENANT') : []
    const set = (next: DutiesDraft) => actions?.onDuties?.(next)
    const conditionTick = (condition: FourEyesCondition) => {
      const fromAll = conditionInherited(rules, condition)
      return (
        <Checkbox
          key={condition}
          label={t(`duties.condition.${condition}`)}
          checked={fromAll || draft.conditions.includes(condition)}
          disabled={disabled || fromAll || preview.releaseFourEyes.rule === 'ALWAYS'}
          title={fromAll ? t('duties.conditionFromAll') : preview.releaseFourEyes.rule === 'ALWAYS' ? t('duties.coveredByAlways') : (held ? t(held) : undefined)}
          onChange={(event) => set(withCondition(draft, condition, event.target.checked))}
        />
      )
    }
    return (
      <div className="fw-qr-stack">
        {!rules.mayChange && <p className="fw-qr-held">{t(rules.companyId === null ? 'held.noRightAll' : 'held.noRight')}</p>}
        <fieldset className="fw-qr-choices" disabled={disabled}>
          <legend className="fw-qr-question">{t('duties.release.question')}</legend>
          <RadioCard name="qr-release" checked={draft.releaseFourEyes === 'WHEN_REQUIRED'} selected={draft.releaseFourEyes === 'WHEN_REQUIRED'} onChange={() => set({ ...draft, releaseFourEyes: 'WHEN_REQUIRED' })} title={t('duties.release.alone')} description={t('duties.release.aloneHint')} />
          <RadioCard name="qr-release" checked={draft.releaseFourEyes === 'ALWAYS'} selected={draft.releaseFourEyes === 'ALWAYS'} onChange={() => set({ ...draft, releaseFourEyes: 'ALWAYS' })} title={t('duties.release.always')} description={t('duties.release.alwaysHint')} />
          {isCompany ? (
            <RadioCard
              name="qr-release"
              checked={draft.releaseFourEyes === null}
              selected={draft.releaseFourEyes === null}
              onChange={() => set({ ...draft, releaseFourEyes: null })}
              title={t('duties.follow')}
              description={inherited ? t('duties.followNow', { rule: t(`duties.rule.${inherited.releaseFourEyes.rule}`) }) : undefined}
            />
          ) : (
            draft.releaseFourEyes === null && <p className="fw-qr-hint">{t('duties.release.default')}</p>
          )}
        </fieldset>
        <div className="fw-qr-inforce">
          <Pill tone={preview.releaseFourEyes.rule === 'ALWAYS' ? 'info' : 'neutral'}>{t(`duties.rule.${preview.releaseFourEyes.rule}`)}</Pill>
          <Source source={preview.releaseFourEyes.source} />
        </div>

        <fieldset className="fw-qr-choices" disabled={disabled}>
          <legend className="fw-qr-question">{t('duties.conditions.question')}</legend>
          <div className="fw-qr-ticks">{(['OVERRIDE', 'CUSTOMER'] as const).map(conditionTick)}</div>
          <p className="fw-qr-hint">{t('duties.conditions.oneRecord')}</p>
          <div className="fw-qr-customers" aria-label={t('duties.customers.label')}>
            <span className="fw-qr-sub">{t('duties.customers.label')}</span>
            {own.length === 0 && theirs.length === 0 && draft.customers.length === 0 ? <span className="fw-qr-sub">{t('duties.customers.none')}</span> : null}
            {draft.customers.map((id) => {
              const known = rules.duties.customers.find((customer) => customer.id === id) ?? model.customers?.value?.map((customer) => ({ id: customer.id, code: customer.code, name: customer.tradeName ?? customer.legalName })).find((customer) => customer.id === id)
              return (
                <span key={id} className="fw-qr-chip">
                  {known ? `${known.code} · ${known.name}` : id.slice(0, 8)}
                  <Button size="sm" variant="quiet" aria-label={t('duties.customers.remove', { name: known?.name ?? id })} heldReason={held ? t(held) : null} onClick={() => set({ ...draft, customers: draft.customers.filter((entry) => entry !== id) })}>
                    <X size={12} aria-hidden />
                  </Button>
                </span>
              )
            })}
            {theirs.map((customer) => (
              <span key={`all-${customer.id}`} className="fw-qr-chip is-inherited" title={t('duties.customers.fromAll')}>
                <Lock size={11} aria-hidden /> {customer.code} · {customer.name}
              </span>
            ))}
          </div>
          <CustomerAdder model={model} actions={actions} draft={draft} held={held} />
        </fieldset>

        <fieldset className="fw-qr-choices" disabled={disabled}>
          <legend className="fw-qr-question">{t('duties.hold.question')}</legend>
          <RadioCard name="qr-hold" checked={draft.placerMayRelease === false} selected={draft.placerMayRelease === false} onChange={() => set({ ...draft, placerMayRelease: false })} title={t('duties.hold.someoneElse')} description={t('duties.hold.someoneElseHint')} />
          <RadioCard name="qr-hold" checked={draft.placerMayRelease === true} selected={draft.placerMayRelease === true} onChange={() => set({ ...draft, placerMayRelease: true })} title={t('duties.hold.placer')} description={t('duties.hold.placerHint')} />
          {isCompany && (
            <RadioCard
              name="qr-hold"
              checked={draft.placerMayRelease === null}
              selected={draft.placerMayRelease === null}
              onChange={() => set({ ...draft, placerMayRelease: null })}
              title={t('duties.follow')}
              description={inherited ? t(inherited.placerMayRelease.value ? 'duties.hold.followPlacer' : 'duties.hold.followSomeoneElse') : undefined}
            />
          )}
        </fieldset>
        <div className="fw-qr-inforce">
          <Pill tone={preview.placerMayRelease.value ? 'warning' : 'neutral'}>{t(preview.placerMayRelease.value ? 'duties.hold.placerShort' : 'duties.hold.someoneElseShort')}</Pill>
          <Source source={preview.placerMayRelease.source} />
        </div>
        {count > 0 && loosens.length > 0 && (
          <Banner tone="warning" title={t('duties.loosens', { count: loosens.length })}>
            <ul className="fw-qr-lines">
              {loosens.map((code) => (
                <li key={code}>{t(`loosen.code.${code}`, { count: removedCustomers(rules, draft) })}</li>
              ))}
            </ul>
          </Banner>
        )}
        <Changed at={rules.updatedAt} />
        {count > 0 && (
          <EditModeBar
            count={count}
            busy={model.busy === 'duties'}
            applyHeldReason={held && held !== 'held.busy' ? t(held) : null}
            applyLabel={loosens.length > 0 ? t('duties.applyLoosen') : t('card.apply')}
            onDiscard={() => actions?.onDiscardDuties?.()}
            onApply={() => actions?.onApplyDuties?.()}
            saveShortcut={shortcut}
          />
        )}
      </div>
    )
  }
  return (
    <Card header={t('duties.title')} description={t('duties.description')} headingLevel={2} className="fw-qr-card">
      {body()}
    </Card>
  )
}

/** Add a customer to the scope's list: a select of the customers (read on first use, parties.view). */
function CustomerAdder({ model, actions, draft, held }: { model: RulesModel; actions?: RulesActions; draft: DutiesDraft; held: string | null }) {
  const t = useT('quality-rules')
  if (held) return null
  if (!model.canPickCustomers) return <p className="fw-qr-hint">{t('duties.customers.noPicker')}</p>
  if (!model.customers) {
    return (
      <Button size="sm" variant="secondary" onClick={() => actions?.onPickCustomers?.()}>
        {t('duties.customers.add')}
      </Button>
    )
  }
  if (model.customers.problem) return <p className="fw-qr-held">{t(model.customers.problem)}</p>
  const options = (model.customers.value ?? []).filter((customer) => !draft.customers.includes(customer.id))
  return (
    <Field label={t('duties.customers.add')}>
      <Select size="sm" value="" onChange={(event) => event.target.value && actions?.onDuties?.({ ...draft, customers: [...draft.customers, event.target.value] })} aria-label={t('duties.customers.add')}>
        <option value="">{model.customers.value ? t('duties.customers.pick', { count: options.length }) : t('common.loading')}</option>
        {options.map((customer) => (
          <option key={customer.id} value={customer.id}>
            {customer.code} · {customer.tradeName ?? customer.legalName}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function ResultsCard({ model, actions, count, shortcut }: { model: RulesModel; actions?: RulesActions; count: number; shortcut: boolean }) {
  const t = useT('quality-rules')
  const locale = useLocale()
  const rules = model.rules.value
  const tenant = model.address.scope === 'company' ? model.tenant.value : rules
  const draft = model.results
  const held = changeHeld(rules, model.busy !== null, model.live === 'offline')
  const disabled = held !== null
  const isCompany = model.address.scope === 'company'
  const body = (): ReactNode => {
    if (model.rules.problem) return <CardFailed problem={model.rules.problem} onRetry={actions?.onRetry} />
    if (!rules || !draft) return <Skeleton height={240} />
    const preview = resultsPreview(rules, tenant ?? null, draft)
    const problem = resultsProblem(draft)
    const set = (next: ResultsDraft) => actions?.onResults?.(next)
    const inherited = tenant?.results.inForce
    return (
      <div className="fw-qr-stack">
        <fieldset className="fw-qr-choices" disabled={disabled}>
          <legend className="fw-qr-question">{t('results.stop.question')}</legend>
          <RadioCard name="qr-stop" checked={draft.stopAtRejectNumber === false} selected={draft.stopAtRejectNumber === false} onChange={() => set({ ...draft, stopAtRejectNumber: false })} title={t('results.stop.finish')} description={t('results.stop.finishHint')} />
          <RadioCard name="qr-stop" checked={draft.stopAtRejectNumber === true} selected={draft.stopAtRejectNumber === true} onChange={() => set({ ...draft, stopAtRejectNumber: true })} title={t('results.stop.stop')} description={t('results.stop.stopHint')} />
          {isCompany && (
            <RadioCard
              name="qr-stop"
              checked={draft.stopAtRejectNumber === null}
              selected={draft.stopAtRejectNumber === null}
              onChange={() => set({ ...draft, stopAtRejectNumber: null })}
              title={t('duties.follow')}
              description={inherited ? t(inherited.stopAtRejectNumber.value ? 'results.stop.followStop' : 'results.stop.followFinish') : undefined}
            />
          )}
        </fieldset>
        <p className="fw-qr-hint">
          {t('results.stop.planWins')} <Source source={preview.stopAtRejectNumber.source} />
        </p>
        <Field label={t('results.undo.label')} hint={t('results.undo.hint', { min: rules.results.limits.benchUndoMin, max: rules.results.limits.benchUndoMax })} error={problem ? t(problem) : undefined}>
          <div className="fw-qr-row">
            <NumberStepper
              size="sm"
              value={draft.benchUndoSeconds ?? preview.benchUndoSeconds.value}
              min={rules.results.limits.benchUndoMin}
              max={rules.results.limits.benchUndoMax}
              step={5}
              suffix={t('results.undo.unit')}
              muted={draft.benchUndoSeconds === null}
              disabled={disabled}
              aria-label={t('results.undo.label')}
              onChange={(next) => set({ ...draft, benchUndoSeconds: next })}
            />
            {isCompany || draft.benchUndoSeconds !== null ? (
              <Checkbox
                label={t(isCompany ? 'results.undo.follow' : 'results.undo.default')}
                checked={draft.benchUndoSeconds === null}
                disabled={disabled}
                onChange={(event) => set({ ...draft, benchUndoSeconds: event.target.checked ? null : preview.benchUndoSeconds.value })}
              />
            ) : null}
            <Source source={preview.benchUndoSeconds.source} />
          </div>
        </Field>
        <div className="fw-qr-locked">
          <Lock size={13} aria-hidden />
          <span>{wordsIn(OVERRIDE_REASON_WORDS, locale)}</span>
          <Pill tone="neutral">{t('card.locked')}</Pill>
        </div>
        <Changed at={rules.updatedAt} />
        {count > 0 && (
          <EditModeBar count={count} busy={model.busy === 'results'} applyHeldReason={problem ? t(problem) : held && held !== 'held.busy' ? t(held) : null} applyLabel={t('card.apply')} onDiscard={() => actions?.onDiscardResults?.()} onApply={() => actions?.onApplyResults?.()} saveShortcut={shortcut} />
        )}
      </div>
    )
  }
  return (
    <Card header={t('results.title')} description={t('results.description')} headingLevel={2} className="fw-qr-card">
      {body()}
    </Card>
  )
}

/**
 * Who may sign what that is not a setting: the locked amendment rule with its law, the fixed rules with their why, who
 * floor records name at each site (the maker check), and the separations every role keeps (with any custom role that does
 * not). Read only.
 */
function SignersCard({ model }: { model: RulesModel }) {
  const t = useT('quality-rules')
  const locale = useLocale()
  const ds = useDsWords()
  const rules = model.rules.value
  const body = (): ReactNode => {
    if (model.rules.problem) return null
    if (!rules) return <Skeleton height={240} />
    return (
      <div className="fw-qr-stack">
        <ul className="fw-qr-signing">
          {SIGNING_RULES.filter((rule) => rule.kind !== 'SETTING').map((rule) => (
            <li key={rule.id}>
              <span className="fw-qr-signing-text">{wordsIn(rule.words, locale)}</span>
              {rule.kind === 'LOCKED' && rule.law ? (
                <span className="fw-qr-row">
                  <Pill tone="neutral">{t('card.locked')}</Pill>
                  <LawRef law={AMENDMENT_LAW.name} plain={wordsIn(AMENDMENT_LAW.plain, locale)} labels={ds.lawRef} />
                </span>
              ) : (
                <Pill tone="neutral">{t('card.fixed')}</Pill>
              )}
            </li>
          ))}
        </ul>
        <div>
          <h3 className="fw-qr-question">{t('monitoring.title')}</h3>
          {rules.monitoring.length === 0 ? (
            <p className="fw-qr-hint">{t('monitoring.none')}</p>
          ) : (
            <ul className="fw-qr-sites">
              {rules.monitoring.map((site) => (
                <li key={site.siteId}>
                  <span>
                    {site.code} · {site.name}
                  </span>
                  <span className="fw-qr-sub">{t(`monitoring.${site.scanSubject}`)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="fw-qr-hint">
            {t('monitoring.where')} <Link href={`${model.prefix}/production/settings`}>{t('monitoring.link')}</Link>
          </p>
        </div>
        <div>
          <h3 className="fw-qr-question">{t('separations.title')}</h3>
          <ul className="fw-qr-separations">
            {SEPARATIONS.map((separation) => {
              const state = rules.separations.find((entry) => entry.id === separation.id)
              return (
                <li key={separation.id} className={state && !state.kept ? 'is-broken' : undefined}>
                  {state && !state.kept ? <ShieldAlert size={14} aria-hidden /> : <Check size={14} aria-hidden />}
                  <span>
                    <span className="fw-qr-sub">{t(`separations.who.${separation.who}`)}</span> {wordsIn(separation.words, locale)}
                    {state && !state.kept && (
                      <span className="fw-qr-broken">
                        {t('separations.broken', { roles: state.roles.map((role) => role.name).join(', ') })}
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="fw-qr-hint">{t('separations.how')}</p>
        </div>
      </div>
    )
  }
  return (
    <Card header={t('signers.title')} description={t('signers.description')} headingLevel={2} className="fw-qr-card">
      {body()}
    </Card>
  )
}
