'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button, Skeleton, Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import {
  auditHref,
  followedSwitch,
  reasonProblem,
  rulesHeld,
  ruleWhereHref,
  SEPARATION_RULES,
  separationChanges,
  separationLoosens,
  switchAfter,
  type SeparationDraft,
  type SeparationRule,
} from '../model'
import type { WarehouseSettingsActions, WarehouseSettingsModel } from '../view-model'
import { CardDescription, CardFailed, Locked, NS, ReasonField, SwitchInForce, ViewOnly } from './parts'

/**
 * sec:ws-sod — Separation of duties (SCM-293; B-W2b-299's API): nobody approves their own request (the Owner included; locked),
 * then the two switches with their words — who counted a difference never approves the count; who received the goods never
 * approves their invoice nor accepts its match difference. On by default. Switching one off widens what one person can do:
 * Save asks the reason, then a fresh code ("Confirm it is you"); switching on asks nothing. A company keeps its own value or
 * follows every company's. EditModeBar, ⌘S.
 */
export function SeparationCard({ model, actions, shortcut }: { model: WarehouseSettingsModel; actions?: WarehouseSettingsActions; shortcut: boolean }) {
  const t = useT(NS)
  const view = model.separation.value
  const draft = model.separationDraft
  const scope = model.address.scope
  const isCompany = scope === 'company'
  const held = rulesHeld({ may: view ? view.mayChange : null, scope, offline: model.live === 'offline', busy: model.busy !== null })

  const body = (): ReactNode => {
    if (model.separation.problem) return <CardFailed title={t('sod.failed')} problem={model.separation.problem} onRetry={actions?.onRetrySeparation} />
    if (!view || !draft) return <Skeleton height={300} />
    const changed = separationChanges(view, draft)
    const loosens = separationLoosens(view, draft, scope, model.tenantSeparation)
    const asked = loosens.length > 0 || model.reasonAsked.includes('separation')
    const reason = model.reasons.separation
    const set = (rule: SeparationRule, value: boolean | null) => actions?.onSeparation?.({ ...draft, [rule]: value } as SeparationDraft)
    const problem = asked ? reasonProblem(reason) : null
    return (
      <div className="fw-whs-stack">
        <Locked text={t('sod.locked')} />
        <ul className="fw-whs-switches">
          {SEPARATION_RULES.map((rule) => {
            const after = switchAfter(rule, scope, draft, view, model.tenantSeparation)
            const followed = followedSwitch(rule, scope, view, model.tenantSeparation)
            const on = after?.value ?? true
            const own = draft[rule]
            return (
              <li key={rule} className="fw-whs-switch">
                <div className="fw-whs-switch-row">
                  {view.mayChange ? <Toggle checked={on} disabled={model.busy !== null} aria-label={t(`sod.rule.${rule}.title`)} onChange={(next) => set(rule, next)} /> : null}
                  <span className="fw-whs-cell">
                    <strong>{t(`sod.rule.${rule}.title`)}</strong>
                    <span className="fw-whs-sub">{t(`sod.rule.${rule}.${on ? 'on' : 'off'}`)}</span>
                  </span>
                </div>
                <div className="fw-whs-inforce-row">
                  <SwitchInForce inForce={after} scope={scope} />
                  {view.mayChange && own !== null && (
                    <Button size="sm" variant="quiet" disabled={model.busy !== null} onClick={() => set(rule, null)}>
                      {isCompany ? t('sod.follow', { state: followed ? t(followed.value ? 'common.on' : 'common.off') : t('common.notKnown') }) : t('sod.backToDefault')}
                    </Button>
                  )}
                  <Link className="fw-whs-link" href={ruleWhereHref(model.prefix, rule)}>
                    {t(`sod.rule.${rule}.where`)} <ExternalLink size={12} aria-hidden />
                  </Link>
                </div>
              </li>
            )
          })}
        </ul>
        {view.offReason && !changed.length && <p className="fw-whs-warn">{t('sod.offReason', { reason: view.offReason })}</p>}
        {!view.mayChange && <p className="fw-whs-held">{t(isCompany ? 'held.noRight' : 'held.noRightAll')}</p>}
        {view.mayChange && model.live === 'offline' && <p className="fw-whs-held">{t('held.offline')}</p>}
        {loosens.length > 0 && (
          <p className="fw-whs-warn" role="note">
            {t('sod.loosens', { count: loosens.length })}
          </p>
        )}
        {changed.length > 0 && asked && (
          <ReasonField id="whs-sod-reason" value={reason} label={t('reason.label')} hint={t('sod.reasonHint')} shown={reason.length > 0 || model.reasonAsked.includes('separation')} disabled={model.busy !== null} onChange={(text) => actions?.onReason?.('separation', text)} />
        )}
        <ul className="fw-whs-notes">
          <li>{t('sod.noteDefault')}</li>
          <li>{t('sod.noteWorkers')}</li>
        </ul>
        {changed.length > 0 && (
          <EditModeBar
            count={changed.length}
            busy={model.busy === 'separation'}
            applyHeldReason={problem ? t(problem) : held && held !== 'held.busy' ? t(held) : null}
            applyLabel={t(loosens.length > 0 ? 'sod.applyOff' : 'common.save')}
            onDiscard={() => actions?.onDiscard?.('separation')}
            onApply={() => actions?.onApply?.('separation')}
            saveShortcut={shortcut}
          />
        )}
      </div>
    )
  }

  return (
    <Card
      header={t('sod.title')}
      description={<CardDescription text={t('sod.description')} changed={view ? model.changed.separation : undefined} href={model.can.audit && model.rowId ? auditHref(model.prefix, 'InventorySettings', model.rowId) : null} />}
      headerAction={view && !view.mayChange ? <ViewOnly reason={t(isCompany ? 'held.noRight' : 'held.noRightAll')} /> : undefined}
      headingLevel={2}
      className="fw-whs-card"
    >
      {body()}
    </Card>
  )
}
