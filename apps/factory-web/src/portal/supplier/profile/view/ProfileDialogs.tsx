'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, SegmentedControl } from '@nexus/ui/primitives'
import { ActionConfirm, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { isPeopleDialog, PeopleDialogs, type PeopleDialog, type PeopleDialogActions } from '../../../shared/account/view/PeopleDialogs'
import { NS, OWN_KINDS, ROLES, type AddressDraft, type AddressText, type ContactDraft, type ContactText } from '../model'

/**
 * SCR-191's pop-ups (design portal.supplier.profile pop:invite, pop:step-up — the shared account ones, prices never said
 * (C2) — and the page's own): an address and a contact, added or changed. Neither sends anything: the change joins the
 * ones typed on the page ("Send changes for our check" sends them together). Withdraw a request before our check asks
 * first. Esc closes and gives the focus back to the opener; Tab stays inside (the DS Modal).
 */

export type ProfileDialog =
  | PeopleDialog
  | { kind: 'address'; id: string | null; draft: AddressDraft; adding: boolean; problems: Partial<Record<keyof AddressDraft, string>>; showProblems: boolean }
  | { kind: 'contact'; id: string | null; draft: ContactDraft; adding: boolean; problems: Partial<Record<keyof ContactDraft, string>>; showProblems: boolean }
  | { kind: 'withdraw'; requestId: string; lines: readonly string[]; busy: boolean; failed: string | null }

export interface ProfileDialogActions extends PeopleDialogActions {
  onAddressText?: (field: AddressText, value: string) => void
  onAddressKind?: (kind: string, on: boolean) => void
  onAddressKeep?: () => void
  onContactText?: (field: ContactText, value: string) => void
  onContactRole?: (role: string, on: boolean) => void
  onContactKeep?: () => void
  onWithdrawConfirm?: () => void
}

export function ProfileDialogs({ dialog, actions }: { dialog: ProfileDialog | null; actions?: ProfileDialogActions | undefined }) {
  const t = useT(NS)
  const close = () => actions?.onClose?.()
  if (!dialog) return null
  if (isPeopleDialog(dialog)) return <PeopleDialogs dialog={dialog} actions={actions} prices={false} />

  if (dialog.kind === 'address') {
    const problem = (field: keyof AddressDraft) => (dialog.showProblems && dialog.problems[field] ? t(dialog.problems[field]!) : undefined)
    const input = (field: AddressText, extra: { autoComplete?: string; maxLength?: number; autoFocus?: boolean } = {}) => (
      <Input value={dialog.draft[field]} autoComplete={extra.autoComplete ?? 'off'} maxLength={extra.maxLength} {...(extra.autoFocus ? { 'data-autofocus': true } : {})} onChange={(event) => actions?.onAddressText?.(field, event.target.value)} />
    )
    return (
      <Modal
        open
        onClose={close}
        sheet
        size="lg"
        title={dialog.adding ? t('profile.address.addTitle') : t('profile.address.editTitle')}
        subtitle={t('profile.address.subtitle')}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {t('profile.cancel')}
            </Button>
            <Button variant="primary" onClick={() => actions?.onAddressKeep?.()}>
              {t('profile.keep')}
            </Button>
          </>
        }
      >
        <form
          className="fw-psprof-dialog"
          onSubmit={(event) => {
            event.preventDefault()
            actions?.onAddressKeep?.()
          }}
        >
          {dialog.adding ? (
            <fieldset className="fw-psprof-choices">
              <legend className="fw-psprof-strong">{t('profile.address.kinds')}</legend>
              {OWN_KINDS.map((kind) => (
                <CheckboxCard key={kind} checked={dialog.draft.kinds.includes(kind)} selected={dialog.draft.kinds.includes(kind)} onChange={(event) => actions?.onAddressKind?.(kind, event.target.checked)} title={t(`profile.kind.${kind}`)} description={t(`profile.kindHint.${kind}`)} />
              ))}
              {problem('kinds') ? <p className="fw-psprof-problem">{problem('kinds')}</p> : null}
            </fieldset>
          ) : (
            <p className="fw-psprof-muted">{t('profile.address.kindsStay', { kinds: dialog.draft.kinds.map((kind) => t(`profile.kind.${kind}`)).join(', ') })}</p>
          )}
          <Field label={t('profile.field.name')} hint={t('profile.address.nameHint')} error={problem('name')}>
            {input('name', { maxLength: 80, autoFocus: true })}
          </Field>
          <Field label={t('profile.field.line1')} required error={problem('line1')}>
            {input('line1', { autoComplete: 'address-line1', maxLength: 60 })}
          </Field>
          <Field label={t('profile.field.line2')} error={problem('line2')}>
            {input('line2', { autoComplete: 'address-line2', maxLength: 60 })}
          </Field>
          <div className="fw-psprof-grid4">
            <Field label={t('profile.field.postalCode')} required error={problem('postalCode')}>
              {input('postalCode', { autoComplete: 'postal-code', maxLength: 12 })}
            </Field>
            <Field label={t('profile.field.city')} required error={problem('city')}>
              {input('city', { autoComplete: 'address-level2', maxLength: 60 })}
            </Field>
            <Field label={t('profile.field.province')} hint={t('profile.address.provinceHint')} error={problem('province')}>
              {input('province', { autoComplete: 'address-level1', maxLength: 40 })}
            </Field>
            <Field label={t('profile.field.country')} required hint={t('profile.address.countryHint')} error={problem('country')}>
              {input('country', { autoComplete: 'country', maxLength: 2 })}
            </Field>
          </div>
          <div className="fw-psprof-pair">
            <Field label={t('profile.field.contactName')} error={problem('contactName')}>
              {input('contactName', { maxLength: 100 })}
            </Field>
            <Field label={t('profile.field.phone')} error={problem('phone')}>
              {input('phone', { autoComplete: 'tel', maxLength: 30 })}
            </Field>
          </div>
          <Field label={t('profile.field.deliveryNotes')} hint={t('profile.address.notesHint')} error={problem('deliveryNotes')}>
            <Textarea value={dialog.draft.deliveryNotes} rows={2} maxLength={500} onChange={(event) => actions?.onAddressText?.('deliveryNotes', event.target.value)} />
          </Field>
          <Banner tone="info">{t('profile.notSentYet')}</Banner>
        </form>
      </Modal>
    )
  }

  if (dialog.kind === 'contact') {
    const problem = (field: keyof ContactDraft) => (dialog.showProblems && dialog.problems[field] ? t(dialog.problems[field]!) : undefined)
    return (
      <Modal
        open
        onClose={close}
        sheet
        size="md"
        title={dialog.adding ? t('profile.contact.addTitle') : t('profile.contact.editTitle')}
        subtitle={t('profile.contact.subtitle')}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {t('profile.cancel')}
            </Button>
            <Button variant="primary" onClick={() => actions?.onContactKeep?.()}>
              {t('profile.keep')}
            </Button>
          </>
        }
      >
        <form
          className="fw-psprof-dialog"
          onSubmit={(event) => {
            event.preventDefault()
            actions?.onContactKeep?.()
          }}
        >
          <Field label={t('profile.field.contact')} required error={problem('name')}>
            <Input value={dialog.draft.name} maxLength={120} autoComplete="off" data-autofocus onChange={(event) => actions?.onContactText?.('name', event.target.value)} />
          </Field>
          <div className="fw-psprof-pair">
            <Field label={t('profile.field.email')} hint={t('profile.contact.emailHint')} error={problem('email')}>
              <Input type="email" value={dialog.draft.email} maxLength={254} autoComplete="off" onChange={(event) => actions?.onContactText?.('email', event.target.value)} />
            </Field>
            <Field label={t('profile.field.phone')} error={problem('phone')}>
              <Input value={dialog.draft.phone} maxLength={30} autoComplete="off" onChange={(event) => actions?.onContactText?.('phone', event.target.value)} />
            </Field>
          </div>
          <fieldset className="fw-psprof-choices fw-psprof-roles">
            <legend className="fw-psprof-strong">{t('profile.contact.roles')}</legend>
            {ROLES.map((role) => (
              <CheckboxCard key={role} checked={dialog.draft.roles.includes(role)} selected={dialog.draft.roles.includes(role)} onChange={(event) => actions?.onContactRole?.(role, event.target.checked)} title={t(`profile.role.${role}`)} description={t(`profile.roleHint.${role}`)} />
            ))}
            {problem('roles') ? <p className="fw-psprof-problem">{problem('roles')}</p> : null}
          </fieldset>
          <Field label={t('profile.field.language')} hint={t('profile.contact.languageHint')} error={problem('language')}>
            <SegmentedControl
              ariaLabel={t('profile.field.language')}
              options={[
                { value: '', label: t('profile.contact.languageCompany') },
                { value: 'it', label: 'Italiano' },
                { value: 'en', label: 'English' },
              ]}
              value={dialog.draft.language}
              onChange={(value) => actions?.onContactText?.('language', value)}
            />
          </Field>
          <Banner tone="info">{t('profile.notSentYet')}</Banner>
        </form>
      </Modal>
    )
  }

  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        reach: 'local',
        title: t('profile.withdraw.title'),
        confirmLabel: dialog.busy ? t('profile.sending') : t('profile.withdraw.confirm'),
        consequences: [...dialog.lines, t('profile.withdraw.what')],
        reversal: { verb: t('profile.withdraw.back'), fidelity: 'exact' },
        ...(dialog.failed ? { refusal: { reason: dialog.failed } } : {}),
      }}
      onConfirm={() => actions?.onWithdrawConfirm?.()}
      onCancel={close}
    />
  )
}
