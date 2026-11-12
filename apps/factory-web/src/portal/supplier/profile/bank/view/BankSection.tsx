'use client'

import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Pill } from '@nexus/ui/primitives'
import { Modal, StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { AccountCard, type CardState } from '../../../../shared/account/view/AccountCard'
import type { PortalBank } from '../api'
import '../bank.css'
import { BANK_NS, bankRows, draftProblems, hasWaiting, masked, replacedOf, STATE_TONE, type BankDraft, type Words } from '../model'

export type BankDialog =
  | { readonly kind: 'stepUp'; readonly to: string; readonly busy: boolean; readonly error: string | null }
  | { readonly kind: 'form'; readonly draft: BankDraft; readonly tried: boolean }
  | { readonly kind: 'review'; readonly draft: BankDraft; readonly sending: boolean; readonly failed: string | null }

export interface BankSectionModel {
  readonly state: CardState
  readonly slow: boolean
  readonly bank: PortalBank | null
  /** Why "Change bank details" waits, or null. */
  readonly held: Words | null
  readonly dialog: BankDialog | null
  /** What just happened ("Sent for our check"). */
  readonly receipt: string | null
}

export interface BankSectionActions {
  onChange?: () => void
  onRetry?: () => void
  onStepUpCode?: (code: string) => void
  onDraft?: (draft: BankDraft) => void
  onReview?: () => void
  onBack?: () => void
  onSend?: () => void
  onClose?: () => void
}

/**
 * Profile › Bank details (design portal.supplier.profile sec:bank, SCM-007): the account payments go to, masked
 * (IT** **** **** 1234), its bank and holder, "Last changed …"; a change waiting says "we call you on your registered
 * number before any payment uses the new account; payments go to the old one until then"; a refused change says why.
 * "Change bank details" → a fresh code to the person's e-mail → New bank details (IBAN checked as typed, holder, bank) →
 * the review old → new, both masked → Send for our check. Only the supplier's admin changes them; never a price (C2).
 */
export function BankSection({ model, actions }: { model: BankSectionModel; actions?: BankSectionActions }) {
  const t = useT(BANK_NS)
  const locale = useLocale()
  const rows = model.bank ? bankRows(model.bank) : []
  const say = (words: Words | null) => (words ? t(words.key, words.params) : null)
  return (
    <>
      <AccountCard
        id="bank"
        title={t('portalBank.title')}
        description={t('portalBank.hint')}
        state={model.state}
        slow={model.slow}
        failed={t('portalBank.failedRead')}
        onRetry={actions?.onRetry}
        action={
          <Button size="sm" onClick={() => actions?.onChange?.()} heldReason={model.state === 'ready' ? say(model.held) : t('portalBank.reading')}>
            {t('portalBank.change')}
          </Button>
        }
      >
        <div className="fw-pbk-stack">
          {model.receipt ? <Banner tone="success" title={model.receipt} /> : null}
          {model.bank && hasWaiting(model.bank) ? <Banner tone="warning" title={t('portalBank.waitingWords')} /> : null}
          {rows.length === 0 ? <p className="fw-pbk-hint">{t('portalBank.none')}</p> : null}
          {rows.map((account) => (
            <div key={account.id} className="fw-pbk-account">
              <div className="fw-pbk-account-head">
                <span className="fw-pbk-tags">
                  <span className="fw-pbk-iban">{account.masked}</span>
                  <Pill tone={STATE_TONE[account.state]} dot>
                    {t(`portalBank.state.${account.state}`)}
                  </Pill>
                  <span className="fw-pbk-hint">{account.currency}</span>
                </span>
              </div>
              <KeyValue
                columns={3}
                dense
                labelCase="sentence"
                items={[
                  { label: t('portalBank.bank'), value: account.bankName ?? '—' },
                  { label: t('portalBank.holder'), value: account.holder },
                  account.state === 'USABLE'
                    ? { label: t('portalBank.lastChanged'), value: account.activatedAt ? formatDate(account.activatedAt, { locale }) : '—' }
                    : account.state === 'REFUSED'
                      ? { label: t('portalBank.refusedOn'), value: account.refusedAt ? formatDate(account.refusedAt, { locale }) : '—', hint: account.reason ? t('portalBank.why', { reason: account.reason }) : undefined }
                      : { label: t('portalBank.sentOn'), value: formatDate(account.proposedAt, { locale }) },
                ]}
              />
            </div>
          ))}
        </div>
      </AccountCard>
      <BankDialogs model={model} actions={actions} />
    </>
  )
}

function BankDialogs({ model, actions }: { model: BankSectionModel; actions?: BankSectionActions | undefined }) {
  const t = useT(BANK_NS)
  const account = useT('portal-account')
  const dialog = model.dialog
  if (!dialog) return null
  const close = () => actions?.onClose?.()
  if (dialog.kind === 'stepUp') {
    return <StepUpModal open title={account('stepUp.title')} sentence={account('stepUp.sentence', { email: dialog.to })} busy={dialog.busy} error={dialog.error} confirmLabel={account('stepUp.confirm')} onSubmit={(code) => actions?.onStepUpCode?.(code)} onClose={close} />
  }
  const draft = dialog.draft
  const old = replacedOf(model.bank, draft.currency)
  if (dialog.kind === 'review') {
    return (
      <Modal
        open
        onClose={close}
        title={t('portalBank.reviewTitle')}
        footer={
          <>
            <Button onClick={() => actions?.onBack?.()} heldReason={dialog.sending ? t('portalBank.sending') : null}>
              {t('portalBank.back')}
            </Button>
            <Button variant="primary" onClick={() => actions?.onSend?.()} heldReason={dialog.sending ? t('portalBank.sending') : null}>
              {t('portalBank.send')}
            </Button>
          </>
        }
      >
        <div className="fw-pbk-stack">
          <KeyValue
            columns={2}
            dense
            labelCase="sentence"
            items={[
              { label: t('portalBank.old'), value: old ? old.masked : t('portalBank.noOld') },
              { label: t('portalBank.new'), value: <span className="fw-pbk-iban">{masked(draft.iban)}</span> },
              { label: t('portalBank.holder'), value: draft.holder.trim() },
              { label: t('portalBank.bank'), value: draft.bankName.trim() || '—' },
              { label: t('portalBank.bic'), value: draft.bic.trim().toUpperCase() || '—' },
              { label: t('portalBank.currency'), value: draft.currency.trim().toUpperCase() },
            ]}
          />
          <Banner tone="info" title={t('portalBank.waitingWords')} />
          {dialog.failed ? <Banner tone="danger" title={t(dialog.failed)} /> : null}
        </div>
      </Modal>
    )
  }
  const problems = draftProblems(draft)
  const count = Object.keys(problems).length
  const shown = (field: string) => (problems[field] && (dialog.tried || (field === 'iban' && draft.iban.replace(/\s/g, '').length >= 15)) ? t(problems[field]!.key, problems[field]!.params) : undefined)
  const set = (patch: Partial<BankDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  return (
    <Modal
      open
      onClose={close}
      title={t('portalBank.formTitle')}
      footer={
        <>
          <Button onClick={close}>{t('portalBank.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onReview?.()} heldReason={dialog.tried && count > 0 ? t('portalBank.fix', { count }) : null}>
            {t('portalBank.review')}
          </Button>
        </>
      }
    >
      <div className="fw-pbk-stack">
        <p className="fw-pbk-hint">{t('portalBank.formBody')}</p>
        <Field label={t('portalBank.iban')} required hint={t('portalBank.ibanHint')} error={shown('iban')}>
          <Input value={draft.iban} autoComplete="off" spellCheck={false} onChange={(event) => set({ iban: event.target.value })} />
        </Field>
        <Field label={t('portalBank.holder')} required error={shown('holder')}>
          <Input value={draft.holder} onChange={(event) => set({ holder: event.target.value })} />
        </Field>
        <div className="fw-pbk-grid">
          <Field label={t('portalBank.bank')}>
            <Input value={draft.bankName} onChange={(event) => set({ bankName: event.target.value })} />
          </Field>
          <Field label={t('portalBank.bic')} error={shown('bic')}>
            <Input value={draft.bic} onChange={(event) => set({ bic: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('portalBank.currency')} error={shown('currency')}>
            <Input value={draft.currency} maxLength={3} onChange={(event) => set({ currency: event.target.value.toUpperCase() })} />
          </Field>
        </div>
        <p className="fw-pbk-hint">{t('portalBank.letter')}</p>
      </div>
    </Modal>
  )
}
