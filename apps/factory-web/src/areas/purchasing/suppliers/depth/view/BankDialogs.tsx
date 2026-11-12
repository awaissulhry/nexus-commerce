'use client'

import type { ReactNode } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Radio } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { BankAccount, OnFile } from '../api'
import { maskedTyped, phoneMatches, proposalProblems, refuseProblem, type ProposalDraft } from '../model'
import { useSay } from './parts'

interface Busy {
  readonly busy: boolean
  readonly failed: string | null
  readonly tried: boolean
}

export type BankDialog =
  | ({ readonly kind: 'propose'; readonly draft: ProposalDraft; readonly review: boolean } & Busy)
  | ({ readonly kind: 'callBack'; readonly account: BankAccount; readonly pick: string | null; readonly phone: string } & Busy)
  | ({ readonly kind: 'verify'; readonly account: BankAccount } & Busy)
  | ({ readonly kind: 'refuse'; readonly account: BankAccount; readonly reason: string } & Busy)
  | ({ readonly kind: 'retire'; readonly account: BankAccount; readonly reason: string } & Busy)
  /** The whole IBAN, once: it lives in this dialog only and leaves with it. */
  | ({ readonly kind: 'reveal'; readonly account: BankAccount; readonly grouped: string | null } & Busy)

export interface BankDialogActions {
  onDraft?: (draft: ProposalDraft) => void
  onReview?: (review: boolean) => void
  onPick?: (onFileId: string, phone: string | null) => void
  onPhone?: (phone: string) => void
  onReason?: (reason: string) => void
  onConfirm?: () => void
  onClose?: () => void
}

/** The pop-ups of Bank details: Change IBAN (typed, checked as typed, reviewed old → new masked), the call-back record, the second check, refuse, retire, reveal. */
export function BankDialogs({ dialog, active, actions }: { dialog: BankDialog | null; active: readonly BankAccount[]; actions?: BankDialogActions | undefined }) {
  const { t, say } = useSay()
  if (!dialog) return null
  const close = () => actions?.onClose?.()
  const failed = dialog.failed ? <Banner tone={dialog.failed === 'problem.conflict' ? 'warning' : 'danger'} title={t(dialog.failed)} /> : null
  const footer = (label: string, held: string | null, variant: 'primary' | 'danger' = 'primary', extra?: ReactNode) => (
    <>
      {extra ?? <Button onClick={close}>{t('dialog.cancel')}</Button>}
      <Button variant={variant} onClick={() => actions?.onConfirm?.()} heldReason={dialog.busy ? t('dialog.saving') : held}>
        {label}
      </Button>
    </>
  )

  if (dialog.kind === 'propose') {
    const problems = proposalProblems(dialog.draft)
    const count = Object.keys(problems).length
    const shown = (field: string) => (problems[field] && (dialog.tried || (field === 'iban' && dialog.draft.iban.replace(/\s/g, '').length >= 15)) ? say(problems[field]) : undefined)
    const set = (patch: Partial<ProposalDraft>) => actions?.onDraft?.({ ...dialog.draft, ...patch })
    const old = active.find((account) => account.currency === dialog.draft.currency.trim().toUpperCase()) ?? null
    if (dialog.review) {
      return (
        <Modal open onClose={close} title={t('bank.propose.reviewTitle')} footer={footer(t('bank.propose.send'), null, 'primary', <Button onClick={() => actions?.onReview?.(false)}>{t('bank.propose.back')}</Button>)}>
          <div className="fw-spd-stack">
            <KeyValue
              columns={2}
              dense
              labelCase="sentence"
              items={[
                { label: t('bank.propose.old'), value: old ? old.masked : t('bank.propose.noOld') },
                { label: t('bank.propose.new'), value: <span className="fw-spd-iban">{maskedTyped(dialog.draft.iban)}</span> },
                { label: t('bank.holder'), value: dialog.draft.holder.trim() },
                { label: t('bank.bankName'), value: dialog.draft.bankName.trim() || '—' },
                { label: t('bank.bic'), value: dialog.draft.bic.trim().toUpperCase() || '—' },
                { label: t('bank.currency'), value: dialog.draft.currency.trim().toUpperCase() },
              ]}
            />
            <Banner tone="info" title={t('bank.propose.waits')} />
            {failed}
          </div>
        </Modal>
      )
    }
    return (
      <Modal open onClose={close} title={t('bank.propose.title')} footer={footer(t('bank.propose.review'), dialog.tried && count > 0 ? t('bank.propose.fix', { count }) : null)}>
        <div className="fw-spd-stack">
          <p className="fw-spd-hint">{t('bank.propose.body')}</p>
          <Field label={t('bank.iban')} required hint={t('bank.ibanHint')} error={shown('iban')}>
            <Input value={dialog.draft.iban} autoComplete="off" spellCheck={false} onChange={(event) => set({ iban: event.target.value })} />
          </Field>
          <Field label={t('bank.holder')} required error={shown('holder')}>
            <Input value={dialog.draft.holder} onChange={(event) => set({ holder: event.target.value })} />
          </Field>
          <div className="fw-spd-grid">
            <Field label={t('bank.bankName')}>
              <Input value={dialog.draft.bankName} onChange={(event) => set({ bankName: event.target.value })} />
            </Field>
            <Field label={t('bank.bic')} error={shown('bic')}>
              <Input value={dialog.draft.bic} onChange={(event) => set({ bic: event.target.value.toUpperCase() })} />
            </Field>
            <Field label={t('bank.currency')} error={shown('currency')}>
              <Input value={dialog.draft.currency} maxLength={3} onChange={(event) => set({ currency: event.target.value.toUpperCase() })} />
            </Field>
          </div>
          <p className="fw-spd-hint">{t('bank.propose.letter')}</p>
          {failed}
        </div>
      </Modal>
    )
  }

  if (dialog.kind === 'callBack') {
    const usable = dialog.account.callBackCandidates?.usable ?? []
    const held = dialog.account.callBackCandidates?.held ?? []
    const picked: OnFile | undefined = usable.find((entry) => entry.id === dialog.pick)
    const problem = !picked ? t('bank.callBackDialog.pick') : !phoneMatches(dialog.phone, picked.phone) ? t('bank.callBackDialog.phoneDiffers') : null
    return (
      <Modal open onClose={close} title={t('bank.callBackDialog.title', { iban: dialog.account.masked })} footer={footer(t('bank.callBackDialog.confirm'), dialog.tried ? problem : null)}>
        <div className="fw-spd-stack">
          <p className="fw-spd-hint">{t('bank.callBackDialog.body')}</p>
          {usable.length === 0 ? (
            <Banner tone="warning" title={t('bank.held.noNumber')} />
          ) : (
            <fieldset className="fw-spd-checks">
              <legend className="fw-spd-legend">{t('bank.callBackDialog.onFile')}</legend>
              {usable.map((entry) => (
                <Radio key={entry.id} name="call-back" checked={dialog.pick === entry.id} onChange={() => actions?.onPick?.(entry.id, entry.phone)} label={`${t(`bank.onFile.${entry.kind}`)} · ${entry.label} · ${entry.phone ?? '—'}`} />
              ))}
            </fieldset>
          )}
          {picked ? (
            <Field label={t('bank.callBackDialog.dialled')} hint={t('bank.callBackDialog.dialledHint')} error={dialog.tried && problem ? problem : undefined}>
              <Input value={dialog.phone} onChange={(event) => actions?.onPhone?.(event.target.value)} />
            </Field>
          ) : null}
          {held.length > 0 ? (
            <div>
              <p className="fw-spd-legend">{t('bank.callBackDialog.leftOut')}</p>
              <ul className="fw-spd-list">
                {held.map((entry) => (
                  <li key={entry.id}>
                    {entry.label} · {entry.phone ?? '—'} <span className="fw-spd-hint">{t(`bank.hold.${entry.hold}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {failed}
        </div>
      </Modal>
    )
  }

  if (dialog.kind === 'verify') {
    return (
      <Modal open onClose={close} title={t('bank.verifyDialog.title', { iban: dialog.account.masked })} footer={footer(t('bank.verifyDialog.confirm'), null)}>
        <div className="fw-spd-stack">
          <KeyValue
            columns={2}
            dense
            labelCase="sentence"
            items={[
              { label: t('bank.holder'), value: dialog.account.holder },
              { label: t('bank.callBackLabel'), value: dialog.account.callBack ? `${dialog.account.callBack.by?.name ?? '—'} · ${dialog.account.callBack.phone ?? '—'}` : '—' },
            ]}
          />
          <p>{t('bank.verifyDialog.body')}</p>
          <p className="fw-spd-hint">{t('bank.verifyDialog.rule')}</p>
          {failed}
        </div>
      </Modal>
    )
  }

  if (dialog.kind === 'refuse' || dialog.kind === 'retire') {
    const problem = refuseProblem(dialog.reason, dialog.kind === 'refuse' ? 2000 : 500)
    return (
      <Modal open onClose={close} title={t(`bank.${dialog.kind}Dialog.title`, { iban: dialog.account.masked })} footer={footer(t(`bank.${dialog.kind}Dialog.confirm`), dialog.tried && problem ? say(problem) : null, 'danger')}>
        <div className="fw-spd-stack">
          <p className="fw-spd-hint">{t(`bank.${dialog.kind}Dialog.body`)}</p>
          <Field label={t('bank.reason')} required error={dialog.tried && problem ? say(problem) : undefined}>
            <Textarea rows={3} value={dialog.reason} onChange={(event) => actions?.onReason?.(event.target.value)} />
          </Field>
          {failed}
        </div>
      </Modal>
    )
  }

  // reveal
  return (
    <Modal
      open
      onClose={close}
      title={t('bank.revealDialog.title', { iban: dialog.account.masked })}
      footer={
        dialog.grouped ? (
          <Button variant="primary" onClick={close}>
            {t('bank.revealDialog.done')}
          </Button>
        ) : (
          footer(t('bank.revealDialog.confirm'), null)
        )
      }
    >
      <div className="fw-spd-stack">
        {dialog.grouped ? (
          <>
            <p className="fw-spd-iban fw-spd-iban-full" aria-live="polite">
              {dialog.grouped}
            </p>
            <p className="fw-spd-hint">{t('bank.revealDialog.recorded')}</p>
          </>
        ) : (
          <p>{t('bank.revealDialog.body')}</p>
        )}
        {failed}
      </div>
    </Modal>
  )
}
