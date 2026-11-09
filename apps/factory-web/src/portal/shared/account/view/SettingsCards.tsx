'use client'

import { useId } from 'react'
import { Lock, LogOut, Monitor, ShieldCheck, Smartphone } from 'lucide-react'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, SegmentedControl, Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import type { EmailFrequency } from '../../../shell/api'
import type { SessionRow } from '../model'
import { AccountCard, type CardState } from './AccountCard'

/**
 * The person's own cards of an account page (lifted from the customer's Account, B-W2b-196, by B-W2b-193 for the supplier's
 * Profile; design sec:emails, sec:security): their e-mail settings (topics × frequency, the transactional ones locked with
 * the reason, one switch for all non-essential mail; EditModeBar with ⌘S) and their sign-in and sessions (Sign out the
 * others; the authenticator held with the reason). Words: `portal-account`.
 */

// ── E-mail settings ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface EmailTopic {
  topic: string
  name: string
  frequency: EmailFrequency
  locked: boolean
  reason: string | null
}

export interface EmailCardModel {
  state: CardState
  topics: readonly EmailTopic[]
  allOff: boolean
  changes: number
  saving: boolean
  failed: string | null
  readOnly: boolean
}

export interface EmailCardActions {
  onChange?: (topic: string, frequency: EmailFrequency) => void
  onAllOff?: (off: boolean) => void
  onSave?: () => void
  onDiscard?: () => void
  onRetry?: () => void
}

const FREQUENCIES: readonly EmailFrequency[] = ['INSTANT', 'DAILY', 'WEEKLY', 'OFF']

export function EmailCard({ model, slow, actions }: { model: EmailCardModel; slow?: boolean; actions?: EmailCardActions | undefined }) {
  const t = useT('portal-account')
  const switchId = useId()
  const options = FREQUENCIES.map((frequency) => ({ value: frequency, label: t(`emails.frequency.${frequency}`) }))
  return (
    <AccountCard
      id="emails"
      title={t('emails.title')}
      description={t('emails.subtitle')}
      state={model.state}
      slow={slow}
      failed={t('emails.failed')}
      onRetry={actions?.onRetry}
      footer={
        model.changes > 0 && !model.readOnly ? (
          <EditModeBar count={model.changes} busy={model.saving} applyLabel={t('emails.save')} applyHeldReason={model.saving ? t('state.saving') : null} saveShortcut onApply={() => actions?.onSave?.()} onDiscard={() => actions?.onDiscard?.()} />
        ) : null
      }
    >
      {model.readOnly ? (
        <p className="fw-pacc-muted">{t('emails.preview')}</p>
      ) : (
        <div className="fw-pacc-emails">
          <div className="fw-pacc-alloff">
            <label htmlFor={switchId} className="fw-pacc-alloff-text">
              <span className="fw-pacc-strong">{t('emails.allOff')}</span>
              <span className="fw-pacc-muted">{t('emails.allOffHint')}</span>
            </label>
            <Toggle id={switchId} checked={model.allOff} onChange={(next) => actions?.onAllOff?.(next)} aria-label={t('emails.allOff')} />
          </div>
          <ul className="fw-pacc-topics">
            {model.topics.map((row) => (
              <li key={row.topic} className="fw-pacc-topic">
                <span className="fw-pacc-topic-name">
                  <span className="fw-pacc-strong">{row.name}</span>
                  {row.locked ? (
                    <span className="fw-pacc-locked">
                      <Lock size={13} aria-hidden /> {row.reason}
                    </span>
                  ) : null}
                </span>
                {row.locked ? (
                  <Pill tone="neutral">{t(`emails.frequency.${row.frequency}`)}</Pill>
                ) : (
                  <SegmentedControl ariaLabel={t('emails.frequencyOf', { topic: row.name })} options={options} value={row.frequency} onChange={(value) => actions?.onChange?.(row.topic, value as EmailFrequency)} size="sm" wrap />
                )}
              </li>
            ))}
          </ul>
          {model.failed ? <Banner tone="danger">{model.failed}</Banner> : null}
        </div>
      )}
    </AccountCard>
  )
}

// ── Sign-in and sessions ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface SecurityCardModel {
  state: CardState
  sessions: readonly (SessionRow & { started: string; lastSeen: string })[]
  /** The other live sessions (Sign out the others needs one). */
  others: number
  readOnly: boolean
}

export function SecurityCard({ model, slow, onEndOthers, onRetry }: { model: SecurityCardModel; slow?: boolean; onEndOthers?: (() => void) | undefined; onRetry?: (() => void) | undefined }) {
  const t = useT('portal-account')
  const twoStepWhy = useId()
  const device = (row: SessionRow) => t('security.device', { browser: t(`security.browser.${row.browser}`), system: t(`security.system.${row.system}`) })
  const held = model.readOnly ? t('held.preview') : model.others === 0 ? t('held.noOthers') : null
  return (
    <AccountCard
      id="security"
      title={t('security.title')}
      description={t('security.subtitle')}
      state={model.state}
      slow={slow}
      failed={t('security.failed')}
      onRetry={onRetry}
      action={
        <Button size="sm" heldReason={held} onClick={() => onEndOthers?.()}>
          <LogOut size={14} aria-hidden /> {t('security.endOthers')}
        </Button>
      }
    >
      <div className="fw-pacc-security">
        {model.readOnly ? (
          <p className="fw-pacc-muted">{t('security.preview')}</p>
        ) : (
          <SummaryTable
            label={t('security.sessions')}
            columns={[t('security.col.device'), t('security.col.started'), t('security.col.lastSeen')]}
            density="roomy"
            stackOnPhone
            widths={['46%', undefined, undefined]}
            align={['left', 'left', 'left']}
            rows={model.sessions.map((row) => ({
              id: row.id,
              cells: [
                <span key="device" className="fw-pacc-device">
                  {row.phone ? <Smartphone size={15} aria-hidden /> : <Monitor size={15} aria-hidden />}
                  <span>{device(row)}</span>
                  {row.current ? <Pill tone="info">{t('security.thisOne')}</Pill> : null}
                </span>,
                row.started,
                row.current ? t('security.now') : row.lastSeen,
              ],
            }))}
          />
        )}
        <p className="fw-pacc-muted">{t('security.timeouts')}</p>
        <div className="fw-pacc-twostep">
          <span className="fw-pacc-twostep-text">
            <span className="fw-pacc-strong">
              <ShieldCheck size={15} aria-hidden /> {t('security.twoStep')}
            </span>
            <span id={twoStepWhy} className="fw-pacc-muted">
              {t('security.twoStepHeld')}
            </span>
          </span>
          <Toggle checked={false} disabled aria-label={t('security.twoStep')} aria-describedby={twoStepWhy} />
        </div>
      </div>
    </AccountCard>
  )
}
