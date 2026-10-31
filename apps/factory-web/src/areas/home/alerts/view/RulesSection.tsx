'use client'

import { useT } from '../../../../lib/i18n/provider'
import { RulesList } from '../../../_shared/rules/view/RulesList'
import type { AlertsViewModel } from '../model'
import type { AlertsActions } from './AlertsView'

/**
 * Home › Alerts "Rules" (design home.alerts sec:rules, ANA-036): every exception rule the reader sees — the built-in ones
 * (order at risk, hold longer than 24 h, material short, approval overdue, purchase order not confirmed, certificate
 * expiring, invoice deadline) and any added for a company or site — in the shared rules list. Absent without alerts.view
 * (the page is then refused). "Threshold alerts on any KPI tile" is W3; the noise report (ANA-040) is W3.
 */
export function RulesSection({ model, actions, headingId }: { model: AlertsViewModel; actions?: AlertsActions; headingId: string }) {
  const t = useT('home-alerts')
  return (
    <>
      <h2 id={headingId} className="fw-alerts-h">
        {t('rules.title')}
      </h2>
      <p className="fw-alerts-muted">{t('rules.body')}</p>
      <RulesList
        rules={model.rules}
        words={{ label: t('rules.label'), title: t('rules.title'), empty: t('rules.empty'), emptyBody: t('rules.emptyBody') }}
        listKey="home.alerts.rules"
        ruleHref={(rule) => `${model.prefix}/home/alerts?rule=${encodeURIComponent(rule.id)}`}
        offline={model.live === 'offline'}
        busy={model.busy}
        saving={model.savingRules}
        onOpen={(rule) => actions?.onRule?.(rule.id)}
        onNew={model.can.manageRules ? () => actions?.onRule?.('new') : undefined}
        onSwitch={actions?.onRuleSwitch}
        onNumber={actions?.onRuleNumber}
        onRetry={actions?.onRetryRules}
      />
    </>
  )
}
