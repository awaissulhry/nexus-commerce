'use client'

import { useId } from 'react'
import { BellOff, BellRing, Send, Smartphone } from 'lucide-react'
import { Banner, Field, Stepper } from '@nexus/ui/components'
import { Button, Input, Skeleton, Tag } from '@nexus/ui/primitives'
import { PUSH_LIMITS } from '@nexus/factory-domain/notifications/preferences/push'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { pushSteps, turnOnHeld, type PushDevice, type PushModel, type PushStep } from '../model'
import '../push.css'

export interface PushActions {
  onStep?: (step: PushStep) => void
  onLabel?: (label: string) => void
  onTurnOn?: () => void
  onTurnOff?: (device: PushDevice) => void
  onTest?: () => void
  onRetry?: () => void
  /** Notification preferences (what the push column brings). */
  onPreferences?: () => void
  onClose: () => void
}

const OUTCOME_TONE = { SENT: 'success', GONE: 'warning', FAILED: 'danger' } as const

/**
 * Get urgent items on this phone (design home.notifications popup push-enrol, W2b; PLT-140): a DS Stepper — what counts as
 * urgent (the kinds my push column brings now), on an iPhone how to add the app to the home screen first, Turn on push (this
 * device's name; the browser asks its permission), a test push — and my devices with push on, each Turn off. Held buttons say
 * why (push not connected here, this browser cannot, offline, ten devices already). It draws ONE model.
 */
export function PushDialog({ model, actions }: { model: PushModel; actions: PushActions }) {
  return (
    <WithMessages namespaces={['home-mywork']}>
      <Push model={model} actions={actions} />
    </WithMessages>
  )
}

function Push({ model, actions }: { model: PushModel; actions: PushActions }) {
  const t = useT('home-mywork')
  const locale = useLocale()
  const labelId = useId()
  const steps = pushSteps(model.browser)
  const at = Math.max(0, steps.indexOf(model.step))
  const push = model.push.status === 'ready' ? model.push.data : null
  const held = turnOnHeld({ push, browser: model.browser, busy: model.busy, offline: model.offline, label: model.label, thisDevice: model.thisDevice !== null })
  const changeHeld = model.offline ? t('held.offline') : model.busy ? t('held.busy') : null
  const next = steps[at + 1]
  const back = steps[at - 1]

  return (
    <Modal
      open
      onClose={actions.onClose}
      size="md"
      title={t('push.title')}
      footer={
        <span className="fw-push-footer">
          {back && (
            <Button variant="secondary" onClick={() => actions.onStep?.(back)}>
              {t('push.back')}
            </Button>
          )}
          {model.step === 'turnOn' ? (
            <Button variant="primary" heldReason={held ? t(held, { count: push?.maxDevices ?? PUSH_LIMITS.devicesPerPerson }) : null} onClick={() => actions.onTurnOn?.()}>
              <BellRing size={14} aria-hidden /> {t('push.turnOn')}
            </Button>
          ) : next ? (
            <Button variant="primary" onClick={() => actions.onStep?.(next)}>
              {t('push.next')}
            </Button>
          ) : (
            <Button variant="primary" onClick={actions.onClose}>
              {t('push.done')}
            </Button>
          )}
        </span>
      }
    >
      <div className="fw-push">
        <Stepper steps={steps.map((step) => ({ key: step, label: t(`push.step.${step}`) }))} current={at} onSelect={(index) => actions.onStep?.(steps[index]!)} canSelect={() => true} />
        {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} />}
        {model.push.status === 'loading' ? (
          <div aria-busy="true" className="fw-push-section">
            <p className="fw-push-muted" role="status">
              {t('loading')}
            </p>
            <Skeleton height={24} />
          </div>
        ) : model.push.status === 'error' ? (
          <Banner tone="danger" title={t('push.error')} action={<Button size="sm" onClick={() => actions.onRetry?.()}>{t('retry')}</Button>}>
            {t(model.push.problem)}
          </Banner>
        ) : push ? (
          <>
            {!push.available && <Banner tone="warning" title={t('push.held.unavailable')}>{t('push.unavailableBody')}</Banner>}
            {model.step === 'urgent' && (
              <section className="fw-push-section" aria-label={t('push.step.urgent')}>
                <p>{t('push.urgent.body')}</p>
                {push.urgent.length === 0 ? (
                  <p className="fw-push-muted">{t('push.urgent.none')}</p>
                ) : (
                  <ul className="fw-push-kinds">
                    {push.urgent.map((kind) => (
                      <li key={kind}>
                        <Tag tone="info">{t(`prefs.event.${kind}.label`)}</Tag> <span className="fw-push-muted">{t(`prefs.event.${kind}.hint`)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {actions.onPreferences && (
                  <Button size="sm" variant="link" onClick={actions.onPreferences}>
                    {t('push.urgent.change')}
                  </Button>
                )}
              </section>
            )}
            {model.step === 'install' && (
              <section className="fw-push-section" aria-label={t('push.step.install')}>
                <p>{t('push.install.body')}</p>
                <ol className="fw-push-howto">
                  <li>{t('push.install.one')}</li>
                  <li>{t('push.install.two')}</li>
                  <li>{t('push.install.three')}</li>
                </ol>
                <p className="fw-push-muted">{t('push.install.note')}</p>
              </section>
            )}
            {model.step === 'turnOn' && (
              <section className="fw-push-section" aria-label={t('push.step.turnOn')}>
                {model.browser !== 'ready' && <Banner tone="warning" title={t(`push.held.${model.browser}`)} />}
                {model.thisDevice ? (
                  <p>
                    <BellRing size={14} aria-hidden /> {t('push.on')}
                  </p>
                ) : (
                  <Field label={t('push.label')} hint={t('push.labelHint', { count: PUSH_LIMITS.label })} htmlFor={labelId}>
                    <Input id={labelId} value={model.label} maxLength={PUSH_LIMITS.label} onChange={(event) => actions.onLabel?.(event.target.value)} />
                  </Field>
                )}
                <p className="fw-push-muted">{t('push.permission')}</p>
              </section>
            )}
            {model.step === 'test' && (
              <section className="fw-push-section" aria-label={t('push.step.test')}>
                <p>{t('push.test.body')}</p>
                <Button variant="secondary" heldReason={changeHeld ?? (push.devices.length === 0 ? t('push.problem.none') : null)} onClick={() => actions.onTest?.()}>
                  <Send size={14} aria-hidden /> {t('push.test.send')}
                </Button>
              </section>
            )}
            <section className="fw-push-section" aria-label={t('push.devices.title')}>
              <h3 className="fw-push-h">{t('push.devices.title', { count: push.devices.length, max: push.maxDevices })}</h3>
              {push.devices.length === 0 ? (
                <p className="fw-push-muted">{t('push.devices.none')}</p>
              ) : (
                <ul className="fw-push-devices">
                  {push.devices.map((device) => (
                    <li key={device.id} className="fw-push-device">
                      <Smartphone size={16} aria-hidden />
                      <span className="fw-push-device-text">
                        <span>
                          {device.label} {device.id === model.thisDevice && <Tag tone="info">{t('push.devices.this')}</Tag>}
                          {model.tested[device.id] && <Tag tone={OUTCOME_TONE[model.tested[device.id]!]}>{t(`push.test.${model.tested[device.id]}`)}</Tag>}
                        </span>
                        <span className="fw-push-muted">{device.lastUsedAt ? t('push.devices.used', { at: formatDateTime(device.lastUsedAt, { locale }) }) : t('push.devices.since', { at: formatDateTime(device.createdAt, { locale }) })}</span>
                      </span>
                      <Button size="sm" variant="quiet" heldReason={changeHeld} aria-label={t('push.devices.off', { name: device.label })} onClick={() => actions.onTurnOff?.(device)}>
                        <BellOff size={13} aria-hidden /> {t('push.devices.offShort')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </div>
    </Modal>
  )
}
