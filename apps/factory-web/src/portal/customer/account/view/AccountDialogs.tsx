'use client'

import { Banner, Field, Listbox } from '@nexus/ui/components'
import { Button, Input, RadioCard, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { ActionConfirm, Modal, StepUpModal, Textarea } from '../../../../lib/i18n/ds-parts'
import type { Locale } from '../../../../lib/i18n/locales'
import { useT } from '../../../../lib/i18n/provider'
import type { AddressDraft, HandoverSummary, InviteDraft } from '../model'

/**
 * SCR-188's pop-ups (design portal.customer.account pop:invite, pop:deactivate, pop:role-raise, pop:address, and the
 * security card's "Sign out the others → confirm"): Esc closes and gives the focus back to the opener, Tab stays inside
 * (the DS Modal). The organisation admin's acts ask for a fresh e-mail code first (the step-up, the DS StepUpModal).
 */

/** One partner role as the invite and the role change offer it: what it sees, before anyone is invited. */
export interface RoleChoice {
  key: string
  /** The role's name in the page's language. */
  name: string
  /** "Orders, prices, documents and approvals". */
  sees: string
  seesPrices: boolean
  admin: boolean
}

export type AccountDialog =
  | { kind: 'invite'; draft: InviteDraft; roles: readonly RoleChoice[]; problems: Partial<Record<keyof InviteDraft, string>>; showProblems: boolean; busy: boolean; failed: string | null }
  | { kind: 'role'; person: { id: string; name: string }; current: string | null; choice: string; roles: readonly RoleChoice[]; busy: boolean; failed: string | null }
  | { kind: 'raise'; person: { id: string; name: string }; busy: boolean; failed: string | null }
  | { kind: 'deactivate'; people: readonly { id: string; name: string }[]; state: 'loading' | 'error' | 'ready'; summary: HandoverSummary | null; choice: string; busy: boolean; failed: string | null }
  | { kind: 'address'; draft: AddressDraft; problems: Partial<Record<keyof AddressDraft, string>>; showProblems: boolean; busy: boolean; failed: string | null }
  | { kind: 'remove'; lines: readonly string[]; busy: boolean; failed: string | null }
  | { kind: 'endOthers'; count: number; busy: boolean; failed: string | null }
  | { kind: 'stepUp'; to: string; busy: boolean; error: string | null }

export interface AccountDialogActions {
  onClose?: () => void
  onInviteField?: (field: keyof InviteDraft, value: string) => void
  onInviteSend?: () => void
  onRoleChoice?: (key: string) => void
  onRoleSave?: () => void
  onRaiseConfirm?: () => void
  onHandoverChoice?: (id: string) => void
  onDeactivateConfirm?: () => void
  onHandoverRetry?: () => void
  onAddressField?: (field: keyof AddressDraft, value: string) => void
  onAddressSave?: () => void
  onRemoveConfirm?: () => void
  onEndOthersConfirm?: () => void
  onStepUpCode?: (code: string) => void
}

export function AccountDialogs({ dialog, actions }: { dialog: AccountDialog | null; actions?: AccountDialogActions }) {
  const t = useT('portal-account')
  const close = () => actions?.onClose?.()
  if (!dialog) return null

  if (dialog.kind === 'invite') {
    const problem = (field: keyof InviteDraft) => (dialog.showProblems && dialog.problems[field] ? t(dialog.problems[field]!) : undefined)
    return (
      <Modal
        open
        onClose={close}
        sheet
        size="lg"
        title={t('invite.title')}
        subtitle={t('invite.subtitle')}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={dialog.busy}>
              {t('dialog.cancel')}
            </Button>
            <Button variant="primary" heldReason={dialog.busy ? t('state.sending') : null} onClick={() => actions?.onInviteSend?.()}>
              {t('invite.send')}
            </Button>
          </>
        }
      >
        <form
          className="fw-pacc-dialog"
          onSubmit={(event) => {
            event.preventDefault()
            actions?.onInviteSend?.()
          }}
        >
          <div className="fw-pacc-pair">
            <Field label={t('invite.name')} required error={problem('displayName')}>
              <Input value={dialog.draft.displayName} autoComplete="off" data-autofocus onChange={(event) => actions?.onInviteField?.('displayName', event.target.value)} />
            </Field>
            <Field label={t('invite.email')} required error={problem('email')} hint={t('invite.emailHint')}>
              <Input type="email" value={dialog.draft.email} autoComplete="off" onChange={(event) => actions?.onInviteField?.('email', event.target.value)} />
            </Field>
          </div>
          <fieldset className="fw-pacc-roles">
            <legend className="fw-pacc-strong">{t('invite.role')}</legend>
            {dialog.roles.map((role) => (
              <RadioCard key={role.key} name="fw-pacc-invite-role" value={role.key} checked={dialog.draft.roleKey === role.key} selected={dialog.draft.roleKey === role.key} onChange={() => actions?.onInviteField?.('roleKey', role.key)} title={role.name} description={`${role.sees} · ${t(role.seesPrices ? 'role.prices.yes' : 'role.prices.no')}`} />
            ))}
            {problem('roleKey') ? <p className="fw-pacc-problem">{problem('roleKey')}</p> : null}
          </fieldset>
          <Field label={t('invite.language')} hint={t('invite.languageHint')}>
            <SegmentedControl
              ariaLabel={t('invite.language')}
              options={[
                { value: 'it', label: 'Italiano' },
                { value: 'en', label: 'English' },
              ]}
              value={dialog.draft.locale}
              onChange={(value) => actions?.onInviteField?.('locale', value as Locale)}
            />
          </Field>
          {dialog.failed ? <Banner tone="danger">{dialog.failed}</Banner> : null}
        </form>
      </Modal>
    )
  }

  if (dialog.kind === 'role') {
    const unchanged = dialog.choice === dialog.current
    return (
      <Modal
        open
        onClose={close}
        sheet
        size="md"
        title={t('roleDialog.title', { name: dialog.person.name })}
        subtitle={t('roleDialog.subtitle')}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={dialog.busy}>
              {t('dialog.cancel')}
            </Button>
            <Button variant="primary" heldReason={dialog.busy ? t('state.saving') : unchanged ? t('held.sameRole') : null} onClick={() => actions?.onRoleSave?.()}>
              {t('roleDialog.save')}
            </Button>
          </>
        }
      >
        <fieldset className="fw-pacc-roles">
          <legend className="fw-pacc-visually-hidden">{t('invite.role')}</legend>
          {dialog.roles.map((role) => (
            <RadioCard key={role.key} name="fw-pacc-change-role" value={role.key} checked={dialog.choice === role.key} selected={dialog.choice === role.key} onChange={() => actions?.onRoleChoice?.(role.key)} title={role.key === dialog.current ? t('roleDialog.current', { role: role.name }) : role.name} description={`${role.sees} · ${t(role.seesPrices ? 'role.prices.yes' : 'role.prices.no')}`} />
          ))}
        </fieldset>
        {dialog.failed ? <Banner tone="danger">{dialog.failed}</Banner> : null}
      </Modal>
    )
  }

  if (dialog.kind === 'raise') {
    return (
      <ActionConfirm
        impact={{
          level: 'confirm',
          reach: 'local',
          title: t('raise.title', { name: dialog.person.name }),
          confirmLabel: dialog.busy ? t('state.saving') : t('raise.confirm'),
          consequences: [t('raise.what'), t('raise.prices'), t('raise.stepUp')],
          reversal: { verb: t('raise.back'), fidelity: 'exact' },
          ...(dialog.failed ? { refusal: { reason: dialog.failed } } : {}),
        }}
        onConfirm={() => actions?.onRaiseConfirm?.()}
        onCancel={close}
      />
    )
  }

  if (dialog.kind === 'deactivate') {
    const one = dialog.people.length === 1 ? dialog.people[0]! : null
    const title = one ? t('deactivate.title', { name: one.name }) : t('deactivate.titleN', { count: dialog.people.length })
    const summary = dialog.summary
    return (
      <Modal
        open
        onClose={close}
        size="md"
        title={title}
        footer={
          <>
            <Button variant="secondary" data-autofocus onClick={close} disabled={dialog.busy}>
              {t('dialog.cancel')}
            </Button>
            <Button variant="danger" heldReason={dialog.busy ? t('state.saving') : dialog.state !== 'ready' ? t('held.handoverFirst') : null} onClick={() => actions?.onDeactivateConfirm?.()}>
              {one ? t('deactivate.confirm') : t('deactivate.confirmN', { count: dialog.people.length })}
            </Button>
          </>
        }
      >
        <div className="fw-pacc-dialog">
          <p>{one ? t('deactivate.noSignIn', { name: one.name }) : t('deactivate.noSignInN', { names: dialog.people.map((person) => person.name).join(', ') })}</p>
          {dialog.state === 'loading' ? (
            <div role="status" aria-label={t('state.loading')}>
              <Skeleton height={40} />
            </div>
          ) : dialog.state === 'error' || !summary ? (
            <div className="fw-pacc-failed" role="alert">
              <span>{t('deactivate.handoverFailed')}</span>
              <Button size="sm" onClick={() => actions?.onHandoverRetry?.()}>
                {t('state.retry')}
              </Button>
            </div>
          ) : (
            <>
              {summary.assigned > 0 ? (
                <Field label={t('deactivate.moveTo', { count: summary.assigned })} hint={t('deactivate.moveHint')}>
                  <Listbox
                    ariaLabel={t('deactivate.moveTo', { count: summary.assigned })}
                    options={[{ value: '', label: t('deactivate.everyone') }, ...summary.options.map((option) => ({ value: option.id, label: option.name }))]}
                    value={dialog.choice}
                    onChange={(value) => actions?.onHandoverChoice?.(value)}
                    width="100%"
                  />
                </Field>
              ) : (
                <p className="fw-pacc-muted">{summary.open > 0 ? t('deactivate.stay', { count: summary.open }) : t('deactivate.nothingOpen')}</p>
              )}
              {summary.alone.length > 0 ? (
                <Banner tone="warning" title={t('deactivate.aloneTitle', { count: summary.alone.length })}>
                  <ul className="fw-pacc-alone">
                    {summary.alone.map((task) => (
                      <li key={`${task.label}-${task.words}`}>
                        <span className="fw-pacc-strong">{task.label}</span> — {task.words}
                      </li>
                    ))}
                  </ul>
                  <span>{t('deactivate.aloneHint')}</span>
                </Banner>
              ) : null}
            </>
          )}
          {dialog.failed ? <Banner tone="danger">{dialog.failed}</Banner> : null}
        </div>
      </Modal>
    )
  }

  if (dialog.kind === 'address') {
    const field = (name: keyof AddressDraft) => (dialog.showProblems && dialog.problems[name] ? t(dialog.problems[name]!) : undefined)
    const input = (name: keyof AddressDraft, extra: { autoComplete?: string; maxLength?: number; autoFocus?: boolean } = {}) => (
      <Input value={dialog.draft[name]} autoComplete={extra.autoComplete ?? 'off'} maxLength={extra.maxLength} {...(extra.autoFocus ? { 'data-autofocus': true } : {})} onChange={(event) => actions?.onAddressField?.(name, event.target.value)} />
    )
    return (
      <Modal
        open
        onClose={close}
        sheet
        size="lg"
        title={t('address.title')}
        subtitle={t('address.subtitle')}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={dialog.busy}>
              {t('dialog.cancel')}
            </Button>
            <Button variant="primary" heldReason={dialog.busy ? t('state.saving') : null} onClick={() => actions?.onAddressSave?.()}>
              {t('address.save')}
            </Button>
          </>
        }
      >
        <form
          className="fw-pacc-dialog"
          onSubmit={(event) => {
            event.preventDefault()
            actions?.onAddressSave?.()
          }}
        >
          <Banner tone="info">{t('address.check')}</Banner>
          <Field label={t('address.name')} hint={t('address.nameHint')} error={field('name')}>
            {input('name', { autoFocus: true })}
          </Field>
          <Field label={t('address.line1')} required error={field('line1')}>
            {input('line1', { autoComplete: 'address-line1' })}
          </Field>
          <Field label={t('address.line2')} error={field('line2')}>
            {input('line2', { autoComplete: 'address-line2' })}
          </Field>
          <div className="fw-pacc-grid4">
            <Field label={t('address.postalCode')} required error={field('postalCode')}>
              {input('postalCode', { autoComplete: 'postal-code', maxLength: 20 })}
            </Field>
            <Field label={t('address.city')} required error={field('city')}>
              {input('city', { autoComplete: 'address-level2' })}
            </Field>
            <Field label={t('address.province')} error={field('province')}>
              {input('province', { autoComplete: 'address-level1', maxLength: 50 })}
            </Field>
            <Field label={t('address.country')} required hint={t('address.countryHint')} error={field('country')}>
              {input('country', { autoComplete: 'country', maxLength: 2 })}
            </Field>
          </div>
          <div className="fw-pacc-pair">
            <Field label={t('address.contactName')} error={field('contactName')}>
              {input('contactName')}
            </Field>
            <Field label={t('address.phone')} error={field('phone')}>
              {input('phone', { autoComplete: 'tel', maxLength: 50 })}
            </Field>
          </div>
          <Field label={t('address.notes')} hint={t('address.notesHint')} error={field('deliveryNotes')}>
            <Textarea value={dialog.draft.deliveryNotes} rows={3} maxLength={1000} onChange={(event) => actions?.onAddressField?.('deliveryNotes', event.target.value)} />
          </Field>
          {dialog.failed ? <Banner tone="danger">{dialog.failed}</Banner> : null}
        </form>
      </Modal>
    )
  }

  if (dialog.kind === 'remove') {
    return (
      <ActionConfirm
        impact={{
          level: 'confirm',
          reach: 'local',
          title: t('remove.title', { count: dialog.lines.length }),
          confirmLabel: dialog.busy ? t('state.saving') : t('remove.confirm', { count: dialog.lines.length }),
          consequences: [...dialog.lines, t('remove.sent')],
          reversal: { verb: t('remove.back'), fidelity: 'none' },
          ...(dialog.failed ? { refusal: { reason: dialog.failed } } : {}),
        }}
        onConfirm={() => actions?.onRemoveConfirm?.()}
        onCancel={close}
      />
    )
  }

  if (dialog.kind === 'endOthers') {
    return (
      <ActionConfirm
        impact={{
          level: 'confirm',
          reach: 'local',
          title: t('endOthers.title', { count: dialog.count }),
          confirmLabel: dialog.busy ? t('state.saving') : t('endOthers.confirm'),
          consequences: [t('endOthers.what', { count: dialog.count }), t('endOthers.stay')],
          reversal: { verb: t('endOthers.back'), fidelity: 'exact' },
          ...(dialog.failed ? { refusal: { reason: dialog.failed } } : {}),
        }}
        onConfirm={() => actions?.onEndOthersConfirm?.()}
        onCancel={close}
      />
    )
  }

  // The step-up: a 6-digit code by e-mail, 5 minutes for the admin's acts.
  return <StepUpModal open title={t('stepUp.title')} sentence={t('stepUp.sentence', { email: dialog.to })} busy={dialog.busy} error={dialog.error} confirmLabel={t('stepUp.confirm')} onSubmit={(code) => actions?.onStepUpCode?.(code)} onClose={close} />
}
