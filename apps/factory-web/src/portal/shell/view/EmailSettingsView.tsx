'use client'

import { useId } from 'react'
import { AlertCircle, Lock } from 'lucide-react'
import { Button, SegmentedControl, Skeleton, Toggle } from '@nexus/ui/primitives'
import { EditModeBar, Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import type { EmailFrequency } from '../api'

/**
 * pop:email-settings — E-mail settings (design portal.frame; COL-063, PLT-148): per topic As it happens / Daily summary /
 * Weekly summary / Off; the order, delivery and invoice topics locked on with the reason ("Needed to run your orders");
 * one switch for all non-essential mail (GDPR). Explicit save (the DS EditModeBar: ⌘S saves); closing with changes asks
 * Save / Discard / Stay (the frame's unsaved guard). Also opened by the "Manage e-mails" link of every mail
 * (`?dialog=email-settings`).
 */

export interface EmailTopicRow {
  topic: string
  /** The topic's name in the person's language. */
  name: string
  frequency: EmailFrequency
  locked: boolean
  /** Why it is locked, in words. */
  reason: string | null
}

export interface EmailSettingsViewModel {
  open: boolean
  state: 'loading' | 'error' | 'ready'
  topics: readonly EmailTopicRow[]
  /** Every non-essential topic is off in the draft. */
  allOff: boolean
  /** How many topics the person changed. */
  changes: number
  saving?: boolean
  /** The save was refused or failed, in words. */
  failed?: string | null
}

export interface EmailSettingsViewProps {
  model: EmailSettingsViewModel
  onClose: () => void
  onChange?: (topic: string, frequency: EmailFrequency) => void
  onAllOff?: (off: boolean) => void
  onSave?: () => void
  onDiscard?: () => void
  onRetry?: () => void
}

const FREQUENCIES: readonly EmailFrequency[] = ['INSTANT', 'DAILY', 'WEEKLY', 'OFF']

export function EmailSettingsView({ model, onClose, onChange, onAllOff, onSave, onDiscard, onRetry }: EmailSettingsViewProps) {
  const t = useT('portal')
  const switchId = useId()
  const options = FREQUENCIES.map((frequency) => ({ value: frequency, label: t(`email.frequency.${frequency}`) }))
  return (
    <Modal
      open={model.open}
      onClose={onClose}
      sheet
      size="lg"
      title={t('email.title')}
      subtitle={t('email.subtitle')}
      footer={
        model.state === 'ready' && model.changes > 0 ? (
          <EditModeBar
            count={model.changes}
            busy={model.saving ?? false}
            applyLabel={t('email.save')}
            applyHeldReason={model.saving ? t('email.saving') : null}
            saveShortcut
            onApply={() => onSave?.()}
            onDiscard={() => onDiscard?.()}
          />
        ) : undefined
      }
    >
      {model.state === 'loading' ? (
        <div className="fw-pemail-loading" role="status" aria-label={t('state.loading')}>
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} height={40} />
          ))}
        </div>
      ) : model.state === 'error' ? (
        <div className="fw-pstate" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('email.failed')}</span>
          {onRetry ? <Button onClick={onRetry}>{t('state.retry')}</Button> : null}
        </div>
      ) : (
        <div className="fw-pemail">
          <div className="fw-pemail-all">
            <label htmlFor={switchId} className="fw-pemail-all-text">
              <span className="fw-pemail-all-title">{t('email.allOff')}</span>
              <span className="fw-pemail-all-hint">{t('email.allOffHint')}</span>
            </label>
            <Toggle id={switchId} checked={model.allOff} onChange={(next) => onAllOff?.(next)} aria-label={t('email.allOff')} />
          </div>
          <ul className="fw-pemail-topics">
            {model.topics.map((row) => (
              <li key={row.topic} className="fw-pemail-topic">
                <span className="fw-pemail-name">
                  {row.name}
                  {row.locked ? (
                    <span className="fw-pemail-locked">
                      <Lock size={13} aria-hidden /> {row.reason}
                    </span>
                  ) : null}
                </span>
                {row.locked ? (
                  <span className="fw-pemail-fixed">{t(`email.frequency.${row.frequency}`)}</span>
                ) : (
                  <SegmentedControl ariaLabel={t('email.frequencyOf', { topic: row.name })} options={options} value={row.frequency} onChange={(value) => onChange?.(row.topic, value as EmailFrequency)} size="sm" wrap />
                )}
              </li>
            ))}
          </ul>
          {model.failed ? (
            <p className="fw-pemail-failed" role="alert">
              {model.failed}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  )
}
