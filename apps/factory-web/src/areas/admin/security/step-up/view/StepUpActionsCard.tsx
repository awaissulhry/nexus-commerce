'use client'

import { Banner, Card, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, NumberStepper, Skeleton, Tag, Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { permissionKey } from '../../../shared/view/PermissionMatrix'
import type { Read } from '../../model'
import type { SecuritySettings } from '../../sessions/api'
import { durationWords } from '../../sessions/model'
import type { CardState } from '../../sessions/use-security-settings'
import { actionKey, fixedKey, stepUpChanges, stepUpOf, stepUpWider, switched, type StepUpDraft } from '../model'
import '../../sessions/security-depth.css'

export interface StepUpActionsModel {
  read: Read<SecuritySettings>
  card: CardState<StepUpDraft>
}

export interface StepUpActionsActions {
  onRetry?: () => void
  onChange?: (draft: StepUpDraft) => void
  onDiscard?: () => void
  onSave?: () => void
  onDismiss?: () => void
}

/**
 * Admin › Security › Actions that ask for a fresh code (SCR-166 section `step-up`, B-W2b-413; PLT-063): each risky action in
 * words with the permissions behind it, whether it asks now — a Toggle only where the company may switch it off, else why it
 * always asks — and how many wrong codes lock the fresh code, for how long. Switching off, more tries or a shorter lock is
 * wider: a fresh code first. Words `admin-security-depth` (page provider) and `admin` (the permissions). Fetches nothing.
 */
export function StepUpActionsCard({ model, actions }: { model: StepUpActionsModel; actions?: StepUpActionsActions }) {
  const t = useT('admin-security-depth')
  const read = model.read
  return (
    <section id="step-up" aria-labelledby="sec-step-up" className="fw-sec-section">
      <Card header={<span id="sec-step-up">{t('fresh.title')}</span>} description={t('fresh.hint')} headingLevel={2} padded>
        {read.state === 'ok' ? (
          <Actions settings={read.value} model={model} actions={actions} />
        ) : read.state === 'failed' ? (
          <EmptyState title={t('settings.failed.title')} description={t('settings.failed.body')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('session.retry')}</Button>} />
        ) : (
          <div className="fw-sec-depth-stack" aria-busy="true">
            <Skeleton height={20} />
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        )}
      </Card>
    </section>
  )
}

function Actions({ settings, model, actions }: { settings: SecuritySettings; model: StepUpActionsModel; actions?: StepUpActionsActions }) {
  const t = useT('admin-security-depth')
  const ta = useT('admin')
  const card = model.card
  const draft = card.draft ?? stepUpOf(settings)
  const changes = stepUpChanges(settings, draft)
  const wider = stepUpWider(settings, draft)
  const permission = (name: string) => {
    const key = permissionKey(name)
    const words = ta(key)
    return words === key ? name : words
  }
  const bounds = settings.bounds
  return (
    <div className="fw-sec-depth-stack">
      {card.notice && <Banner tone={card.notice.tone} title={t(card.notice.key)} onDismiss={actions?.onDismiss} />}
      {card.problem && <Banner tone={card.problem === 'settings.problem.stale' ? 'warning' : 'danger'} title={t(card.problem)} onDismiss={actions?.onDismiss} />}
      <SummaryTable
        label={t('fresh.title')}
        density="roomy"
        stackOnPhone
        columns={[t('fresh.col.action'), t('fresh.col.permissions'), t('fresh.col.asks')]}
        widths={['30%', '44%', '26%']}
        align={['left', 'left', 'left']}
        rows={settings.stepUp.actions.map((action) => {
          const on = !draft.off.includes(action.key)
          const name = t(actionKey(action.key))
          return {
            id: action.key,
            cells: [
              <span key="action" className="fw-adm-name">
                {name}
              </span>,
              <span key="permissions" className="fw-sec-depth-perms">
                {action.permissions.map(permission).join(' · ')}
              </span>,
              action.fixed ? (
                <span key="asks" className="fw-sec-depth-row">
                  <Tag tone="info">{t('fresh.always')}</Tag>
                  <span className="fw-adm-hint">{t(fixedKey(action.fixed))}</span>
                </span>
              ) : settings.canChange ? (
                <span key="asks" className="fw-sec-depth-row">
                  <Toggle size="sm" checked={on} aria-label={t('fresh.toggle', { action: name })} onChange={(next) => actions?.onChange?.(switched(draft, action, next))} />
                  <span>{t(on ? 'fresh.on' : 'fresh.off')}</span>
                </span>
              ) : (
                <Tag key="asks" tone={on ? 'success' : 'warning'}>
                  {t(on ? 'fresh.on' : 'fresh.off')}
                </Tag>
              ),
            ],
          }
        })}
      />
      <h3 className="fw-sec-sub">{t('fresh.lock.title')}</h3>
      {settings.canChange ? (
        <div className="fw-sec-depth-numbers">
          <Field label={t('fresh.lock.failures')} hint={t('fresh.lock.failuresHint', { min: bounds.stepUpMaxFailures.min, max: bounds.stepUpMaxFailures.max })}>
            <NumberStepper size="sm" value={draft.maxFailures} min={bounds.stepUpMaxFailures.min} max={bounds.stepUpMaxFailures.max} decrementLabel={t('lengths.less')} incrementLabel={t('lengths.more')} onChange={(next) => actions?.onChange?.({ ...draft, maxFailures: next })} />
          </Field>
          <Field label={t('fresh.lock.minutes')} hint={t('fresh.lock.minutesHint', { now: durationWords(draft.lockMinutes, t), min: durationWords(bounds.stepUpLockMinutes.min, t), max: durationWords(bounds.stepUpLockMinutes.max, t) })}>
            <NumberStepper size="sm" value={draft.lockMinutes} min={bounds.stepUpLockMinutes.min} max={bounds.stepUpLockMinutes.max} step={5} suffix={t('lengths.unit.minutes')} decrementLabel={t('lengths.less')} incrementLabel={t('lengths.more')} onChange={(next) => actions?.onChange?.({ ...draft, lockMinutes: next })} />
          </Field>
        </div>
      ) : (
        <KeyValue
          labelCase="sentence"
          columns={2}
          items={[
            { label: t('fresh.lock.failures'), value: String(draft.maxFailures) },
            { label: t('fresh.lock.minutes'), value: durationWords(draft.lockMinutes, t) },
          ]}
        />
      )}
      <p className="fw-adm-hint">{t('fresh.valid', { minutes: settings.stepUp.validMinutes })}</p>
      {settings.canChange ? (
        changes > 0 ? (
          <>
            {wider && <Banner tone="info" title={t('fresh.wider')} />}
            <EditModeBar count={changes} onDiscard={() => actions?.onDiscard?.()} onApply={() => actions?.onSave?.()} applyLabel={t(wider ? 'fresh.saveWider' : 'fresh.save')} busy={card.busy} saveShortcut />
          </>
        ) : (
          <p className="fw-adm-hint">{t('fresh.rule')}</p>
        )
      ) : (
        <p className="fw-adm-hint">{t('lengths.viewOnly')}</p>
      )}
    </div>
  )
}
