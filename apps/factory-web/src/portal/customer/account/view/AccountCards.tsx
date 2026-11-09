'use client'

import { MessageCircle } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, SegmentedControl } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import type { Locale } from '../../../../lib/i18n/locales'
import { useT } from '../../../../lib/i18n/provider'
import type { ThemeMode } from '../../../../lib/theme/theme'
import { AccountCard, type CardState } from '../../../shared/account/view/AccountCard'
import type { CompanyRow, ProfileDraft } from '../model'

/**
 * SCR-188's own cards (design portal.customer.account sec:profile, sec:company): each reads and fails on its own (the shared
 * AccountCard: a skeleton while it loads, the problem in our words with Try again). The e-mail settings and the sessions
 * are the shared account cards (../../../shared/account/view/SettingsCards.tsx, lifted by B-W2b-193). No money anywhere on
 * this page.
 */

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
