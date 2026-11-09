'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input } from '@nexus/ui/primitives'
import { ActionConfirm, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { isPeopleDialog, PeopleDialogs, type PeopleDialog, type PeopleDialogActions } from '../../../shared/account/view/PeopleDialogs'
import type { AddressDraft } from '../model'

/**
 * SCR-188's pop-ups (design portal.customer.account pop:invite, pop:deactivate, pop:role-raise, pop:address, and the
 * security card's "Sign out the others → confirm"): Esc closes and gives the focus back to the opener, Tab stays inside
 * (the DS Modal). The people pop-ups and the step-up are the shared account ones (../../../shared/account/view/
 * PeopleDialogs.tsx, lifted by B-W2b-193); the delivery address and its removal are the customer's own.
 */

export type AccountDialog =
  | PeopleDialog
  | { kind: 'address'; draft: AddressDraft; problems: Partial<Record<keyof AddressDraft, string>>; showProblems: boolean; busy: boolean; failed: string | null }
  | { kind: 'remove'; lines: readonly string[]; busy: boolean; failed: string | null }

export interface AccountDialogActions extends PeopleDialogActions {
  onAddressField?: (field: keyof AddressDraft, value: string) => void
  onAddressSave?: () => void
  onRemoveConfirm?: () => void
}

export function AccountDialogs({ dialog, actions }: { dialog: AccountDialog | null; actions?: AccountDialogActions | undefined }) {
  const t = useT('portal-account')
  const close = () => actions?.onClose?.()
  if (!dialog) return null
  if (isPeopleDialog(dialog)) return <PeopleDialogs dialog={dialog} actions={actions} />

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

  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        reach: 'local',
        title: t('remove.title', { count: dialog.lines.length }),
        confirmLabel: dialog.busy ? t('state.saving') : t('remove.confirm', { count: dialog.lines.length }),
        consequences: [...dialog.lines, t('remove.sent')],
        reversal: { verb: t('remove.back'), fidelity: 'none' },
        // B-W2b-203: a local change that cannot be undone asks an acknowledgement (the DS holds Confirm without one).
        acknowledge: t('remove.acknowledge', { count: dialog.lines.length }),
        ...(dialog.failed ? { refusal: { reason: dialog.failed } } : {}),
      }}
      onConfirm={() => actions?.onRemoveConfirm?.()}
      onCancel={close}
    />
  )
}
