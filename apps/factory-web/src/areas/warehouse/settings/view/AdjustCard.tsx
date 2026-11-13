'use client'

import { useMemo, useRef, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { BellRing, ExternalLink, Plus, ShieldCheck } from 'lucide-react'
import { Card, EmptyState, Field } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, NumberStepper, Pill, SegmentedControl, Skeleton, Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ApprovalRule } from '../api'
import {
  adjustmentRulesOf,
  adjustStateOf,
  adminRuleHref,
  alertsAfter,
  amountAfter,
  amountChanged,
  amountLoosens,
  amountProblem,
  amountWords,
  auditHref,
  currencySymbol,
  followedAmount,
  inboxHref,
  maxAmountMajor,
  reasonProblem,
  rulesHeld,
  type AmountDraft,
  type InForce,
  type LimitMode,
} from '../model'
import type { WarehouseSettingsActions, WarehouseSettingsModel } from '../view-model'
// B-W2b-382 (XF7:06): a new adjustment rule opens with its kind chosen.
import { newRuleHref } from '../../../admin/automation/approval-rules/new-kind/new-kind'
import { CardDescription, CardFailed, ChangedLine, Locked, NS, ReasonField, SourceWords, SwitchInForce, ViewOnly } from './parts'

/**
 * sec:ws-adjust — Adjustment approval (SCM-192; B-W2b-314's API): adjustments worth more than a value wait for a yes. The value
 * is a cost (money.cost: shown and changed only with the cost grain; the API leaves it out otherwise); who approves is an
 * approval rule's (Admin › Approvals, automation & AI › Approval rules, kind STOCK_ADJUSTMENT: shown here read-only, opened
 * there — one editor). Nobody approves their own request, the Owner included; no rule is on until the Owner switches one on,
 * and until then an adjustment above the value posts without a yes — said in words. A higher value, or none, asks the reason
 * and a fresh code. The low-stock alerts switch sits beside it (B-W2b-314: no code asked).
 */
export function AdjustCard({ model, actions, shortcut, alertsShortcut }: { model: WarehouseSettingsModel; actions?: WarehouseSettingsActions; shortcut: boolean; alertsShortcut: boolean }) {
  const t = useT(NS)
  const view = model.rules.value
  const isCompany = model.address.scope === 'company'
  const viewOnly = view && !view.mayChange
  const newHeld = !model.can.approvals ? t('held.noApprovalsView') : !model.can.approvalsManage ? t('held.noRulesManage') : null
  const newButton = newHeld ? (
    <Button size="sm" variant="secondary" heldReason={newHeld}>
      <Plus size={14} aria-hidden /> {t('adjust.addRule')}
    </Button>
  ) : (
    <Button size="sm" variant="secondary" asChild>
      <Link href={newRuleHref(model.prefix, 'STOCK_ADJUSTMENT')}>
        <Plus size={14} aria-hidden /> {t('adjust.addRule')}
      </Link>
    </Button>
  )

  const body = (): ReactNode => {
    if (model.rules.problem) return <CardFailed title={t('adjust.failed')} problem={model.rules.problem} onRetry={actions?.onRetryRules} />
    if (!view || !model.amountDraft) return <Skeleton height={360} />
    return (
      <div className="fw-whs-columns">
        <div className="fw-whs-stack">
          <ValueForm model={model} actions={actions} shortcut={shortcut} />
          <LowStock model={model} actions={actions} shortcut={alertsShortcut} />
        </div>
        <Approvers model={model} actions={actions} newButton={newButton} />
      </div>
    )
  }

  return (
    <Card
      header={t('adjust.title')}
      description={<CardDescription text={t('adjust.description')} changed={view ? model.changed.adjust : undefined} href={model.can.audit && model.rowId ? auditHref(model.prefix, 'InventorySettings', model.rowId) : null} />}
      headerAction={viewOnly ? <ViewOnly reason={t(isCompany ? 'held.noRight' : 'held.noRightAll')} /> : newButton}
      headingLevel={2}
      className="fw-whs-card fw-whs-wide"
    >
      {body()}
    </Card>
  )
}

/** The value above which an adjustment waits: the scope's own, as every company, or none. */
function ValueForm({ model, actions, shortcut }: { model: WarehouseSettingsModel; actions?: WarehouseSettingsActions; shortcut: boolean }) {
  const t = useT(NS)
  const locale = useLocale()
  const view = model.rules.value!
  const draft = model.amountDraft!
  const scope = model.address.scope
  const isCompany = scope === 'company'
  const adjust = view.adjustmentApproval
  const currency = adjust.currency
  const costHeld = adjust.held !== null
  const may = view.mayChange && !costHeld
  const held = rulesHeld({ may: view.mayChange, scope, offline: model.live === 'offline', busy: model.busy !== null })
  const changed = !costHeld && amountChanged(view, draft)
  const loosens = !costHeld && amountLoosens(view, draft, scope, model.tenantRules)
  const asked = loosens || model.reasonAsked.includes('adjust')
  const reason = model.reasons.adjust
  const problem = changed ? (amountProblem(draft, currency) ?? (asked ? reasonProblem(reason) : null)) : null
  const disabled = model.busy !== null
  const set = (next: Partial<AmountDraft>) => actions?.onAmount?.({ ...draft, ...next })
  const state = adjustStateOf(view)
  const words = (minor: number | null) => (minor === null ? t('adjust.noValue') : amountWords(minor, currency, locale))
  const applies = (inForce: InForce<number | null> | undefined): ReactNode => {
    if (inForce === undefined) return <span className="fw-whs-sub">{t('common.notKnown')}</span>
    return (
      <span className="fw-whs-inforce">
        <Pill tone="info">{words(inForce.value)}</Pill>
        <SourceWords source={inForce.source} scope={scope} />
      </span>
    )
  }
  const followed = followedAmount(scope, view, model.tenantRules)

  return (
    <section className="fw-whs-section" aria-label={t('adjust.valueTitle')}>
      <h3 className="fw-whs-question">{t('adjust.valueTitle')}</h3>
      {costHeld ? (
        <p className="fw-whs-held">{t('held.noCost')}</p>
      ) : may ? (
        <>
          <SegmentedControl
            size="sm"
            ariaLabel={t('adjust.modeLabel')}
            value={draft.mode}
            disabled={disabled}
            onChange={(value) => set({ mode: value as LimitMode })}
            options={
              isCompany
                ? [
                    { value: 'OWN', label: t('adjust.mode.OWN') },
                    { value: 'FOLLOW', label: t('adjust.mode.FOLLOW') },
                  ]
                : [
                    { value: 'OWN', label: t('adjust.mode.LIMIT') },
                    { value: 'NONE', label: t('adjust.mode.NONE') },
                  ]
            }
          />
          {draft.mode === 'OWN' ? (
            <Field label={t('adjust.valueLabel')} hint={currency ? t('adjust.valueHint', { currency }) : t('adjust.valueHintAll')} required error={changed && amountProblem(draft, currency) ? t(amountProblem(draft, currency)!) : undefined}>
              <span className="fw-whs-stepper wide">
                <NumberStepper value={draft.amount} min={0} max={maxAmountMajor(currency)} step={50} size="sm" suffix={currencySymbol(currency, locale) ?? undefined} disabled={disabled} placeholder={t('adjust.valuePlaceholder')} decrementLabel={t('common.less')} incrementLabel={t('common.more')} aria-label={t('adjust.valueLabel')} onChange={(amount) => set({ amount })} />
              </span>
            </Field>
          ) : (
            <p className="fw-whs-hint">{isCompany ? t('adjust.followHint', { value: followed ? words(followed.value) : t('common.notKnown') }) : t('adjust.noneHint')}</p>
          )}
        </>
      ) : (
        <p className="fw-whs-held">{t(isCompany ? 'held.noRight' : 'held.noRightAll')}</p>
      )}
      {!costHeld && (
        <div className="fw-whs-inforce-row">
          <span className="fw-whs-sub">{t(changed ? 'common.appliesOnceSaved' : 'common.appliesNow')}</span>
          {applies(changed ? amountAfter(draft, scope, view, model.tenantRules) : { value: adjust.inForce.amount ?? null, source: adjust.inForce.source })}
        </div>
      )}
      <p className={state === 'WAITS' ? 'fw-whs-hint' : 'fw-whs-warn'} role="note">
        <ShieldCheck size={14} aria-hidden /> {t(`adjust.state.${state}`, { count: adjust.approvalRules.active })}
      </p>
      {may && model.live === 'offline' && <p className="fw-whs-held">{t('held.offline')}</p>}
      {loosens && (
        <p className="fw-whs-warn" role="note">
          {t('adjust.loosens')}
        </p>
      )}
      {changed && asked && <ReasonField id="whs-adjust-reason" value={reason} label={t('reason.label')} hint={t('reason.hint')} shown={reason.length > 0 || model.reasonAsked.includes('adjust')} disabled={model.busy !== null} onChange={(text) => actions?.onReason?.('adjust', text)} />}
      <ul className="fw-whs-notes">
        <li>{t('adjust.onlyAdjust')}</li>
        <li>{t('adjust.unknownValue')}</li>
      </ul>
      {changed && (
        <EditModeBar
          count={1}
          busy={model.busy === 'adjust'}
          applyHeldReason={problem ? t(problem) : held && held !== 'held.busy' ? t(held) : null}
          applyLabel={t(loosens ? 'common.saveWithCode' : 'common.save')}
          onDiscard={() => actions?.onDiscard?.('adjust')}
          onApply={() => actions?.onApply?.('adjust')}
          saveShortcut={shortcut}
        />
      )}
    </section>
  )
}

/** Low-stock alerts (SCM-281): on unless switched off; a company's own or as every company. No code asked. */
function LowStock({ model, actions, shortcut }: { model: WarehouseSettingsModel; actions?: WarehouseSettingsActions; shortcut: boolean }) {
  const t = useT(NS)
  const view = model.rules.value!
  const draft = model.alertsDraft
  const scope = model.address.scope
  const isCompany = scope === 'company'
  if (draft === undefined) return null
  const held = rulesHeld({ may: view.mayChange, scope, offline: model.live === 'offline', busy: model.busy !== null })
  const after = alertsAfter(draft, scope, view, model.tenantRules)
  const followed = alertsAfter(null, scope, view, model.tenantRules)
  const changed = draft !== view.lowStockAlerts.own
  const on = after?.value ?? true
  return (
    <section className="fw-whs-section" aria-label={t('alerts.title')}>
      <h3 className="fw-whs-question">
        <BellRing size={14} aria-hidden /> {t('alerts.title')}
      </h3>
      <ChangedLine changed={model.changed.alerts} href={null} />
      <div className="fw-whs-switch-row">
        {view.mayChange && <Toggle checked={on} disabled={model.busy !== null} aria-label={t('alerts.title')} onChange={(next) => actions?.onAlerts?.(next)} />}
        <span className="fw-whs-cell">
          <span>{t(on ? 'alerts.on' : 'alerts.off')}</span>
        </span>
      </div>
      <div className="fw-whs-inforce-row">
        <SwitchInForce inForce={after} scope={scope} />
        {view.mayChange && draft !== null && (
          <Button size="sm" variant="quiet" disabled={model.busy !== null} onClick={() => actions?.onAlerts?.(null)}>
            {isCompany ? t('sod.follow', { state: followed ? t(followed.value ? 'common.on' : 'common.off') : t('common.notKnown') }) : t('sod.backToDefault')}
          </Button>
        )}
      </div>
      {changed && (
        <EditModeBar
          count={1}
          busy={model.busy === 'alerts'}
          applyHeldReason={held && held !== 'held.busy' ? t(held) : null}
          applyLabel={t('common.save')}
          onDiscard={() => actions?.onDiscard?.('alerts')}
          onApply={() => actions?.onApply?.('alerts')}
          saveShortcut={shortcut}
        />
      )}
    </section>
  )
}

/** Who approves: the engine's STOCK_ADJUSTMENT rules, shown and opened in Admin (one editor). */
function Approvers({ model, actions, newButton }: { model: WarehouseSettingsModel; actions?: WarehouseSettingsActions; newButton: ReactNode }) {
  const t = useT(NS)
  const locale = useLocale()
  const answer = model.approvalRules?.value ?? null
  const rules = useMemo(() => adjustmentRulesOf(answer, model.address.scope, model.companyId), [answer, model.address.scope, model.companyId])
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  const columns = useMemo<ColDef<ApprovalRule>[]>(() => {
    const open = (event: MouseEvent, id: string) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      latest.current.actions?.onOpenRule?.(id)
    }
    const RuleCell = ({ data }: ICellRendererParams<ApprovalRule>) => {
      if (!data) return null
      return (
        <span className="fw-whs-cell">
          <Link className="fw-whs-rowlink" href={adminRuleHref(latest.current.model.prefix, data.id)} onClick={(event) => open(event, data.id)}>
            <strong>{data.name}</strong>
          </Link>
          <span className="fw-whs-sub">{data.sentence[locale]}</span>
        </span>
      )
    }
    const ApproverCell = ({ data }: ICellRendererParams<ApprovalRule>) => {
      if (!data) return null
      return (
        <span className="fw-whs-cell">
          <span>{data.approver.name}</span>
          <span className="fw-whs-sub">{t(data.approver.kind === 'ROLE' ? 'adjust.byRole' : 'adjust.byPerson')}</span>
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<ApprovalRule>) => {
      if (!data) return null
      return <Pill tone={data.active ? 'success' : 'neutral'}>{t(data.active ? 'common.on' : 'common.off')}</Pill>
    }
    return [
      { colId: 'rule', headerName: t('adjust.col.rule'), minWidth: 220, flex: 2.4, valueGetter: (params) => params.data?.name ?? '', cellRenderer: RuleCell, autoHeight: true, wrapText: true },
      { colId: 'company', headerName: t('adjust.col.company'), minWidth: 120, flex: 1, wrapText: true, autoHeight: true, valueGetter: (params) => (params.data ? (params.data.companyName ?? t('common.everyCompany')) : '') },
      { colId: 'approver', headerName: t('adjust.col.approver'), minWidth: 140, flex: 1.1, valueGetter: (params) => params.data?.approver.name ?? '', cellRenderer: ApproverCell, autoHeight: true, wrapText: true },
      { colId: 'state', headerName: t('adjust.col.state'), minWidth: 90, flex: 0.6, valueGetter: (params) => (params.data ? (params.data.active ? 1 : 0) : null), cellRenderer: StateCell },
    ]
  }, [t, locale])

  const content = (): ReactNode => {
    if (!model.approvalRules) return <p className="fw-whs-held">{t('held.noApprovalsView')}</p>
    if (model.approvalRules.problem) return <CardFailed title={t('adjust.rulesFailed')} problem={model.approvalRules.problem} onRetry={actions?.onRetryApprovals} />
    if (!answer) return <Skeleton height={180} />
    return (
      <ListFrame<ApprovalRule>
        label={t('adjust.table')}
        title={t('adjust.approverTitle')}
        rows={rules}
        rowId={(rule) => rule.id}
        columns={columns}
        count={t('adjust.count', { count: rules.length })}
        keys={[{ keys: ['↵'], does: t('keys.openRule') }]}
        onHelp={() => actions?.onKeys?.()}
        onOpen={(rule) => actions?.onOpenRule?.(rule.id)}
        listKey={null}
        state={rules.length === 0 ? <EmptyState title={t('adjust.empty.title')} description={t('adjust.empty.body')} action={newButton} /> : undefined}
      />
    )
  }
  const fixed = answer?.fixed.find((entry) => entry.code === 'NO_SELF_APPROVAL')
  return (
    <section className="fw-whs-section" aria-label={t('adjust.approverTitle')}>
      <h3 className="fw-whs-question">{t('adjust.approverTitle')}</h3>
      <Locked text={fixed ? fixed.sentence[locale] : t('sod.locked')} />
      {content()}
      <ul className="fw-whs-notes">
        <li>{t('adjust.firstDecides')}</li>
        <li>{t('adjust.noneByDefault')}</li>
        <li>
          {t('adjust.inbox')}{' '}
          <Link className="fw-whs-link" href={inboxHref(model.prefix)}>
            {t('adjust.inboxLink')} <ExternalLink size={12} aria-hidden />
          </Link>
        </li>
      </ul>
    </section>
  )
}
