'use client'

import { useId, useMemo, useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input } from '@nexus/ui/primitives'
import { ActionConfirm, Combobox, Modal } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { moneyText } from '../../../costing/model'
import type { CustomerOption, LimitRow } from '../api'
import { changeProblems, CREDIT_NAMESPACE, parseLimit, type ChangeDraft } from '../model'

/** The change dialog's state: a row's limit (`row`), or a new one (`row` null: the customer is chosen in it). */
export interface ChangeState {
  readonly row: LimitRow | null
  /** The API's refusal of the last try, as a key of the namespace. */
  readonly problem: string | null
  /** Design cases: the step shown and what was typed. */
  readonly step?: 'edit' | 'review'
  readonly draft?: ChangeDraft & { readonly partyId?: string | null }
}

export interface ChangeInput {
  readonly partyId: string
  readonly companyId: string
  readonly version?: number
  readonly amount: number | null
  readonly currency: string | null
  readonly reason: string
}

/**
 * "Change limit" (design finance.receivables sec:credit "Change limit (logged, ActionConfirm)"): the new limit in the
 * customer's currency (or clear it), the reason (one line, kept in the log), then the DS ActionConfirm review — the limit
 * before → after, what follows (the orders waiting for credit are checked again; clearing it checks nothing more) — and
 * "Change limit". For a new limit the customer is picked first (the DS Combobox over the company's customers).
 */
export function ChangeLimitDialog({
  state,
  customers,
  companyId,
  companyCode,
  busy,
  onClose,
  onSubmit,
}: {
  state: ChangeState
  customers: readonly CustomerOption[] | null
  companyId: string | null
  companyCode: string
  busy: boolean
  onClose: () => void
  onSubmit: (input: ChangeInput) => Promise<boolean>
}) {
  const t = useT(CREDIT_NAMESPACE)
  const locale = useLocale()
  const row = state.row
  const pickId = useId()
  const [partyId, setPartyId] = useState<string | null>(row?.party.id ?? state.draft?.partyId ?? null)
  const [amountText, setAmountText] = useState(state.draft?.amountText ?? '')
  const [clear, setClear] = useState(state.draft?.clear ?? false)
  const [reason, setReason] = useState(state.draft?.reason ?? '')
  const [step, setStep] = useState<'edit' | 'review'>(state.step ?? 'edit')
  const [tried, setTried] = useState(state.step === 'review')
  const customer = row ? null : (customers ?? []).find((entry) => entry.id === partyId) ?? null
  const currency = row?.currency ?? customer?.currency ?? 'EUR'
  const name = row?.party.name ?? (customer ? (customer.tradeName ?? customer.legalName) : '')
  const company = row?.company ?? (companyId ? { id: companyId, code: companyCode } : null)
  const draft: ChangeDraft = { amountText, currency, clear, reason }
  const problems = changeProblems(draft, row ? { limit: row.limit, currency: row.currency } : null, partyId !== null && company !== null)
  const shown = (key: string) => (tried && problems.includes(key as never) ? t(`change.problem.${key}`) : undefined)
  const amount = clear ? null : parseLimit(amountText)
  const options = useMemo(() => (customers ?? []).map((entry) => ({ value: entry.id, label: `${entry.tradeName ?? entry.legalName} (${entry.code})` })), [customers])
  const before = row ? (row.limit === null || row.limit === undefined ? t('change.none') : moneyText(row.limit, row.currency, locale)) : t('change.none')
  const after = amount === null ? t('change.none') : moneyText(amount, currency, locale)

  if (step === 'review' && problems.length === 0 && company && partyId) {
    return (
      <Modal open onClose={onClose} title={row ? t('change.title', { name }) : t('action.add')} subtitle={t('change.company', { company: company.code })} size="md">
        {state.problem && (
          <Banner tone="danger" title={t(state.problem)}>
            {null}
          </Banner>
        )}
        <ActionConfirm
          mode="inline"
          impact={{
            level: 'confirm',
            title: t('change.confirmTitle', { name, company: company.code }),
            confirmLabel: t('change.confirmLabel'),
            review: { title: t('change.item'), rows: [{ label: t('change.item'), before, after }] },
            consequences: [t(amount === null ? 'change.consequence.cleared' : 'change.consequence.rechecked'), t('change.consequence.logged')],
          }}
          onCancel={() => setStep('edit')}
          onConfirm={async () => {
            if (busy) return
            const ok = await onSubmit({ partyId, companyId: company.id, ...(row ? { version: row.version } : {}), amount, currency: amount === null ? null : currency, reason: reason.trim() })
            if (!ok) setStep('review')
          }}
        />
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={row ? t('change.title', { name }) : t('action.add')}
      subtitle={company ? t('change.company', { company: company.code }) : undefined}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            heldReason={busy ? t('held.busy') : null}
            onClick={() => {
              setTried(true)
              if (problems.length === 0) setStep('review')
            }}
          >
            {t('change.review')}
          </Button>
        </>
      }
    >
      <div className="fw-frc-form">
        {state.problem && (
          <Banner tone="danger" title={t(state.problem)}>
            {null}
          </Banner>
        )}
        {!row && (
          <Field label={t('change.customer')} required error={shown('customer')} hint={customers === null ? t('change.customersReading') : customers.length === 0 ? t('change.noCustomers') : undefined}>
            <div id={pickId}>
              <Combobox options={options} value={partyId ?? undefined} onChange={(value) => setPartyId(value || null)} placeholder={t('change.customerSearch')} labelledBy={pickId} />
            </div>
          </Field>
        )}
        <p className="fw-frv-muted">{row ? (row.limit === null || row.limit === undefined ? t('change.nowNone') : t('change.now', { amount: before })) : t('change.nowNone')}</p>
        <Field label={t('change.amount')} required={!clear} hint={t('change.amountHint', { currency })} error={shown('amount') ?? shown('same')}>
          <Input inputMode="decimal" value={amountText} disabled={clear} onChange={(event) => setAmountText(event.target.value)} />
        </Field>
        {row && row.limit !== null && row.limit !== undefined && <Checkbox checked={clear} onChange={(event) => setClear(event.target.checked)} label={t('change.clear')} />}
        <Field label={t('change.reason')} required hint={t('change.reasonHint')} error={shown('reason')}>
          <Input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
