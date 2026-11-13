'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { BellRing, ExternalLink, Mail } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { alertRuleHref, auditHref, buyerAlertsOf, ownSwitchRow, REMINDERS, switchHeld, switchWordsKey } from '../model'
// B-W2b-382 (B-W2b-377's timing): Confirm by and Remind every as fields, the chase in words.
import { timingDraftOf } from '../timing/model'
import { TimingSection } from '../timing/view/TimingSection'
import type { PurchasingSettingsActions, PurchasingSettingsModel } from '../view-model'
import { CardDescription, CardFailed, NS, ViewOnly } from './parts'

/**
 * sec:confirm — Confirmation (SCM-087; design purchasing.settings "Confirm-by hours and reminders"; follow-up PU2:01): the
 * confirm-by time a send asks by default and how often the daily run reminds and chases (B-W2b-382: fields on the scope's row,
 * ../timing; empty follows every company's, else 48 hours over the supplier's open days and every day), the Owner's switch for automatic reminders to suppliers (B-W2b-14: OFF by default; ON mails real
 * suppliers, so it asks a fresh code — "Confirm it's you" —; OFF never asks; EditModeBar, ⌘S), how the daily run reminds,
 * and the buyer's alert (the PO_NOT_CONFIRMED exception rule of Home › Alerts, shown and opened there). No money.
 */
export function ConfirmationCard({ model, actions, shortcut }: { model: PurchasingSettingsModel; actions?: PurchasingSettingsActions; shortcut: boolean }) {
  const t = useT(NS)
  const settings = model.reminders.value
  const isCompany = model.address.scope === 'company'
  const held = switchHeld(settings, model.address.scope, model.live === 'offline', model.busy !== null)
  const row = settings ? ownSwitchRow(settings, model.address.scope) : null

  const body = (): ReactNode => {
    if (model.reminders.problem) return <CardFailed title={t('confirm.failed')} problem={model.reminders.problem} onRetry={actions?.onRetryReminders} />
    if (!settings || model.reminderDraft === null) return <Skeleton height={300} />
    const draft = model.reminderDraft
    const changed = draft !== settings.on
    const turningOn = changed && draft
    return (
      <div className="fw-pus-columns">
        <div className="fw-pus-stack">
          <TimingSection
            model={{ settings, scope: model.address.scope, draft: model.timingDraft === undefined ? timingDraftOf(settings, model.address.scope) : model.timingDraft, offline: model.live === 'offline', busy: model.busy !== null, shortcut: shortcut && !changed }}
            actions={actions}
          />
          <section className="fw-pus-switch" aria-label={t('confirm.reminders')}>
            <div className="fw-pus-switch-row">
              {settings.mayChange ? (
                <Toggle checked={draft} disabled={model.busy !== null} aria-label={t('confirm.reminders')} onChange={(on) => actions?.onReminder?.(on)} />
              ) : (
                <Pill tone={settings.on ? 'success' : 'neutral'}>{t(settings.on ? 'confirm.on' : 'confirm.off')}</Pill>
              )}
              <span className="fw-pus-cell">
                <strong>{t('confirm.reminders')}</strong>
                <span className="fw-pus-sub">{t(switchWordsKey(settings))}</span>
              </span>
            </div>
            {!settings.mayChange && <p className="fw-pus-held">{t(isCompany ? 'held.noSwitch' : 'held.noSwitchAll')}</p>}
            {settings.mayChange && model.live === 'offline' && <p className="fw-pus-held">{t('held.offline')}</p>}
            <ul className="fw-pus-notes">
              <li>{t('confirm.how', { most: REMINDERS.most })}</li>
              <li>{t('confirm.byHand')}</li>
              <li>
                <Mail size={12} aria-hidden /> {t('confirm.mails')}
              </li>
            </ul>
            {turningOn && <p className="fw-pus-warn" role="note">{t('confirm.turningOn')}</p>}
            {changed && (
              <EditModeBar
                count={1}
                busy={model.busy === 'reminders'}
                applyHeldReason={held && held !== 'held.busy' ? t(held) : null}
                applyLabel={t(draft ? 'confirm.applyOn' : 'confirm.applyOff')}
                onDiscard={() => actions?.onDiscardReminder?.()}
                onApply={() => actions?.onApplyReminder?.()}
                saveShortcut={shortcut}
              />
            )}
          </section>
        </div>
        <BuyerAlert model={model} />
      </div>
    )
  }

  return (
    <Card
      header={t('confirm.title')}
      description={<CardDescription text={t('confirm.description')} changed={settings ? model.changed.confirm : undefined} href={model.can.audit && row ? auditHref(model.prefix, 'PurchasingSettings', row.id) : null} />}
      headerAction={settings && !settings.mayChange ? <ViewOnly reason={t(isCompany ? 'held.noSwitch' : 'held.noSwitchAll')} /> : undefined}
      headingLevel={2}
      className="fw-pus-card"
    >
      {body()}
    </Card>
  )
}

/** The buyer's alert: the PO_NOT_CONFIRMED exception rules (Home › Alerts), each as its sentence, on or off, opened there. */
function BuyerAlert({ model }: { model: PurchasingSettingsModel }) {
  const t = useT(NS)
  const locale = useLocale()
  const content = (): ReactNode => {
    if (!model.alerts) return <p className="fw-pus-held">{t('held.noAlertsView')}</p>
    if (model.alerts.problem) return <p className="fw-pus-held">{t(model.alerts.problem)}</p>
    if (!model.alerts.value) return <Skeleton height={80} />
    const rules = buyerAlertsOf(model.alerts.value.rules, model.address.scope, model.companyId)
    if (rules.length === 0) {
      return (
        <div className="fw-pus-stack">
          <p className="fw-pus-warn">{t('alert.none')}</p>
          {model.alerts.value.canAdd ? (
            <Button size="sm" variant="secondary" asChild>
              <Link href={alertRuleHref(model.prefix, 'new')}>{t('alert.add')}</Link>
            </Button>
          ) : (
            <Button size="sm" variant="secondary" heldReason={t('held.noAlertsManage')}>
              {t('alert.add')}
            </Button>
          )}
        </div>
      )
    }
    return (
      <ul className="fw-pus-alerts">
        {rules.map((rule) => (
          <li key={rule.id} className="fw-pus-alert">
            <span className="fw-pus-switch-row">
              <Pill tone={rule.enabled ? 'success' : 'neutral'}>{t(rule.enabled ? 'alert.on' : 'alert.off')}</Pill>
              <strong>{rule.name}</strong>
            </span>
            <span className="fw-pus-sub">{rule.sentence[locale]}</span>
            <span className="fw-pus-sub">
              {rule.recipient ? t('alert.tells', { role: rule.recipient.name }) : t('alert.tellsNobody')}
              {' · '}
              {rule.place.label ?? t('alert.everywhere')}
            </span>
            <Link className="fw-pus-link" href={alertRuleHref(model.prefix, rule.id)}>
              {t('alert.open')} <ExternalLink size={12} aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <section className="fw-pus-stack" aria-label={t('alert.title')}>
      <h3 className="fw-pus-question">
        <BellRing size={14} aria-hidden /> {t('alert.title')}
      </h3>
      <p className="fw-pus-hint">{t('alert.hint')}</p>
      {content()}
    </section>
  )
}
