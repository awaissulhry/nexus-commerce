'use client'

import { useEffect, useState } from 'react'
import { Banner, Card } from '@nexus/ui/components'
import { Button, Skeleton, Tag, Toggle } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { TwoFactorRole } from '../api'
import { canTake, withoutTwoFactor, type Dialog, type Read } from '../model'
import { SecurityMessages, sinceWords } from './SecurityView'
import { TwoFactorDialog, type TwoFactorActions } from './SecurityDialogs'

export interface RoleTwoFactorModel {
  /** This role's two-factor rule with its holders (GET /admin/security/two-factor). */
  role: Read<TwoFactorRole>
  canChange: boolean
  dialog: Dialog
  /** The toggle's state at first (design fixtures). */
  draft?: boolean
}

export interface RoleTwoFactorActions extends TwoFactorActions {
  /** Save: opens the dialog with who it affects (then a fresh code). */
  onSave?: (requireMfa: boolean) => void
  onRetry?: () => void
}

/**
 * Role › Scope rules › Two-factor (design admin.roles rec:Role/scope/mfa; PLT-045): the toggle, the people who hold the
 * role without two-factor, Save — who it affects first, then a fresh code. A rule that cannot change says why (a floor
 * role, a role that sees costs or margins, a ready-made role that always asks, a role you hold).
 */
export function RoleTwoFactor({ model, actions }: { model: RoleTwoFactorModel; actions?: RoleTwoFactorActions }) {
  return (
    <SecurityMessages>
      <TwoFactorCard model={model} actions={actions} />
    </SecurityMessages>
  )
}

function TwoFactorCard({ model, actions }: { model: RoleTwoFactorModel; actions?: RoleTwoFactorActions }) {
  const t = useT('admin-security')
  const locale = useLocale()
  const read = model.role
  const role = read.state === 'ok' ? read.value : null
  const [draft, setDraft] = useState<boolean>(model.draft ?? role?.requireMfa ?? false)
  useEffect(() => setDraft(model.draft ?? role?.requireMfa ?? false), [model.draft, role?.requireMfa, role?.version])
  if (read.state === 'no-right') return null
  const without = role ? withoutTwoFactor(role) : []
  const named = without.filter((holder) => holder.name !== null)
  const lock = role?.lock ?? null
  const fixed = role ? (role.heldByMe ? t('sec.tf.held.mine') : !model.canChange ? t('sec.role.changeHeld') : lock && role.requireMfa ? t(`sec.tf.lock.${lock}`) : null) : null
  const changed = role ? draft !== role.requireMfa : false
  const saveHeld = !role ? t('sec.stillLoading') : fixed ?? (!changed ? t('sec.role.noChange') : !canTake(role, draft) ? t('sec.tf.lock.none') : null)
  return (
    <Card header={t('sec.role.title')} description={t('sec.role.hint')} headingLevel={2} padded headerAction={role?.requireMfa ? <Tag tone="success">{t('sec.tf.asks.yes')}</Tag> : null}>
      {read.state === 'loading' ? (
        <Skeleton height={60} />
      ) : read.state === 'failed' ? (
        <Banner tone="warning" title={t('sec.role.readFailed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('sec.retry')}</Button>} />
      ) : (
        <div className="fw-adm-stack">
          <label className="fw-sec-fact">
            <Toggle checked={draft} onChange={setDraft} disabled={fixed !== null} aria-label={t('sec.role.toggle')} />
            <span>{t('sec.role.toggle')}</span>
          </label>
          {/* B-W2b-24: since when it asks (Role.requireMfaSince). */}
          {role?.requireMfa && <p className="fw-adm-hint">{sinceWords(role, t, locale)}</p>}
          {fixed && <p className="fw-adm-hint">{fixed}</p>}
          <div>
            <h3 className="fw-sec-sub">{t('sec.role.members')}</h3>
            {without.length === 0 ? (
              <p className="fw-adm-hint">{t('sec.role.membersNone')}</p>
            ) : named.length === 0 ? (
              <p className="fw-adm-hint">{t('sec.role.membersHidden', { count: without.length })}</p>
            ) : (
              <ul className="fw-sec-people">
                {named.map((holder) => (
                  <li key={holder.userId}>
                    <span>{holder.name}</span>
                    <Tag tone="warning">{t('sec.tf.dialog.notSetUp')}</Tag>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="fw-adm-hint">{t('sec.tf.nextSignIn')}</p>
          <div className="fw-adm-actions">
            <Button variant="primary" size="sm" heldReason={saveHeld} onClick={() => actions?.onSave?.(draft)}>
              {t('sec.role.save')}
            </Button>
          </div>
        </div>
      )}
      {model.dialog.kind === 'twoFactor' && role && <TwoFactorDialog dialog={model.dialog} roles={[role]} actions={actions} />}
    </Card>
  )
}
