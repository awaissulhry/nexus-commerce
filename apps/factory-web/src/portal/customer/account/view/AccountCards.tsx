'use client'

import { useId, type ReactNode } from 'react'
import { AlertCircle, Lock, LogOut, MessageCircle, Monitor, ShieldCheck, Smartphone } from 'lucide-react'
import { Banner, Card, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, SegmentedControl, Skeleton, Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import type { Locale } from '../../../../lib/i18n/locales'
import { useT } from '../../../../lib/i18n/provider'
import type { ThemeMode } from '../../../../lib/theme/theme'
import type { EmailFrequency } from '../../../shell/api'
import type { CompanyRow, ProfileDraft, SessionRow } from '../model'

/**
 * SCR-188's cards (design portal.customer.account sec:profile, sec:emails, sec:company, sec:security): each reads and fails
 * on its own — a skeleton in the card's shape while it loads ("Still loading…" after about a second), the problem in our
 * words with Try again when it failed (a failed read is never drawn as empty). No money anywhere on this page.
 */

export type CardState = 'loading' | 'error' | 'ready'

/** A card's head, its loading and its failure, the same on every card. */
export function AccountCard({ id, title, description, state, slow, failed, onRetry, children, action, footer }: { id: string; title: string; description?: string; state: CardState; slow?: boolean; failed?: string; onRetry?: (() => void) | undefined; children?: ReactNode; action?: ReactNode; footer?: ReactNode }) {
  const t = useT('portal-account')
  return (
    <section id={id} className="fw-pacc-section" aria-labelledby={`${id}-title`}>
      <Card header={<span id={`${id}-title`}>{title}</span>} headingLevel={2} description={description} headerAction={action}>
        {state === 'loading' ? (
          <div className="fw-pacc-loading" role="status" aria-label={t('state.loading')}>
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} height={36} />
            ))}
            {slow ? <span className="fw-pacc-muted">{t('state.slow')}</span> : null}
          </div>
        ) : state === 'error' ? (
          <div className="fw-pacc-failed" role="alert">
            <AlertCircle size={18} aria-hidden />
            <span>{failed ?? t('state.failed')}</span>
            {onRetry ? <Button size="sm" onClick={onRetry}>{t('state.retry')}</Button> : null}
          </div>
        ) : (
          children
        )}
        {state === 'ready' ? footer : null}
      </Card>
    </section>
  )
}

// ── My profile ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ProfileCardModel {
  state: CardState
  email: string
  /** Who changes the e-mail: the organisation's admins (names), or us when the person is the admin. */
  emailBy: { kind: 'admin'; names: readonly string[] } | { kind: 'us' }
  draft: ProfileDraft
  theme: ThemeMode
  changes: number
  problem: string | null
  saving: boolean
  failed: string | null
  /** An office preview: read-only. */
  readOnly: boolean
}

export interface ProfileCardActions {
  onName?: (value: string) => void
  onLocale?: (value: Locale) => void
  onTheme?: (value: ThemeMode) => void
  onSave?: () => void
  onDiscard?: () => void
}

export function ProfileCard({ model, slow, actions }: { model: ProfileCardModel; slow?: boolean; actions?: ProfileCardActions }) {
  const t = useT('portal-account')
  const emailHint = model.emailBy.kind === 'us' ? t('profile.emailByUs') : model.emailBy.names.length > 0 ? t('profile.emailByAdmin', { names: model.emailBy.names.join(', ') }) : t('profile.emailByAdminNone')
  return (
    <AccountCard
      id="profile"
      title={t('profile.title')}
      description={t('profile.subtitle')}
      state={model.state}
      slow={slow}
      footer={
        model.changes > 0 && !model.readOnly ? (
          <EditModeBar count={model.changes} busy={model.saving} applyLabel={t('profile.save')} applyHeldReason={model.saving ? t('state.saving') : model.problem ? t(model.problem) : null} saveShortcut onApply={() => actions?.onSave?.()} onDiscard={() => actions?.onDiscard?.()} />
        ) : null
      }
    >
      <div className="fw-pacc-form">
        <Field label={t('profile.name')} error={model.problem ? t(model.problem) : undefined}>
          <Input value={model.draft.displayName} autoComplete="name" maxLength={160} disabled={model.readOnly} onChange={(event) => actions?.onName?.(event.target.value)} />
        </Field>
        <Field label={t('profile.email')} hint={emailHint}>
          <Input value={model.email} readOnly aria-readonly="true" />
        </Field>
        <Field label={t('profile.language')} hint={t('profile.languageHint')}>
          <SegmentedControl
            ariaLabel={t('profile.language')}
            options={[
              { value: 'it', label: 'Italiano' },
              { value: 'en', label: 'English' },
            ]}
            value={model.draft.locale}
            onChange={(value) => !model.readOnly && actions?.onLocale?.(value as Locale)}
          />
        </Field>
        <Field label={t('profile.theme')} hint={t('profile.themeHint')}>
          <SegmentedControl
            ariaLabel={t('profile.theme')}
            options={(['light', 'dark', 'system'] as const).map((value) => ({ value, label: t(`profile.themeMode.${value}`) }))}
            value={model.theme}
            onChange={(value) => actions?.onTheme?.(value as ThemeMode)}
          />
        </Field>
        {model.failed ? <Banner tone="danger">{model.failed}</Banner> : null}
      </div>
    </AccountCard>
  )
}

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

export function EmailCard({ model, slow, actions }: { model: EmailCardModel; slow?: boolean; actions?: EmailCardActions }) {
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

// ── Company data ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CompanyCardModel {
  /** `none`: the person's role does not open it (never drawn as empty). */
  state: CardState | 'none'
  rows: readonly CompanyRow[]
}

export function CompanyCard({ model, slow, onAsk, onRetry }: { model: CompanyCardModel; slow?: boolean; onAsk?: () => void; onRetry?: () => void }) {
  const t = useT('portal-account')
  if (model.state === 'none') {
    return (
      <AccountCard id="company" title={t('company.title')} state="ready">
        <p className="fw-pacc-muted">{t('company.noAccess')}</p>
      </AccountCard>
    )
  }
  return (
    <AccountCard
      id="company"
      title={t('company.title')}
      description={t('company.subtitle')}
      state={model.state}
      slow={slow}
      failed={t('company.failed')}
      onRetry={onRetry}
      footer={
        <div className="fw-pacc-foot">
          <span className="fw-pacc-muted">{t('company.wrong')}</span>
          <Button size="sm" onClick={() => onAsk?.()}>
            <MessageCircle size={14} aria-hidden /> {t('company.ask')}
          </Button>
        </div>
      }
    >
      <KeyValue labelCase="sentence" columns={2} items={model.rows.map((row) => ({ label: t(row.label), value: <span className="fw-pacc-value">{row.value}</span>, ...(row.hint ? { hint: t(row.hint) } : {}) }))} />
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

export function SecurityCard({ model, slow, onEndOthers, onRetry }: { model: SecurityCardModel; slow?: boolean; onEndOthers?: () => void; onRetry?: () => void }) {
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
