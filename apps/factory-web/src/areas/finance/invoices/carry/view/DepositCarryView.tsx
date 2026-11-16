'use client'

import { ArrowRightLeft } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money, type Phrase } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { carryHeld, type DepositToCarry } from '../model'
import '../../../_shared/finance.css'

export const CARRY = 'finance-carry'

export interface CarryModel {
  invoiceId: string
  invoiceNumber: string | null
  price: boolean
  mayRecord: boolean
  /** null while read; empty: nothing is drawn. */
  deposits: DepositToCarry[] | null
  /** The read failed (a finance message key). */
  problem: string | null
  confirming: DepositToCarry | null
  busy: boolean
  writeProblem: Phrase | null
  notice: Phrase | null
}

export interface CarryActions {
  onConfirm?: (deposit: DepositToCarry | null) => void
  onCarry?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * B-W2b-GB02 (G088) — "Deposit to carry" on the invoice's Deposits & payments: a deposit paid without a deposit invoice
 * (an EU business with a VIES proof) waits to be placed on its order's invoice; what the carry would do (the preview: the
 * amount, the invoice open before and after), and "Carry onto this invoice" (payments.record) with a confirm; the reason
 * in words when it cannot be carried. Nothing is drawn when no deposit waits.
 */
export function DepositCarryView({ model, actions }: { model: CarryModel; actions?: CarryActions }) {
  if (model.deposits !== null && model.deposits.length === 0 && !model.problem && !model.notice) return null
  return (
    <WithMessages namespaces={['finance', CARRY]}>
      <Carry model={model} actions={actions} />
    </WithMessages>
  )
}

function Carry({ model, actions }: { model: CarryModel; actions?: CarryActions }) {
  const t = useT('finance')
  const c = useT(CARRY)
  const locale = useLocale()
  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{c('title')}</h2>
      </div>
      <p className="fw-fin-hint">{c('explain')}</p>
      {model.notice && (
        <Banner
          tone="success"
          title={c(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {model.problem ? (
        <p className="fw-fin-hint">
          {c('failed', { why: t(model.problem) })}{' '}
          <Button size="sm" variant="link" onClick={() => actions?.onRetry?.()}>
            {t('common.retry')}
          </Button>
        </p>
      ) : model.deposits === null ? (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {c('reading')}
        </p>
      ) : (
        model.deposits.map((deposit) => {
          const held = carryHeld({ mayRecord: model.mayRecord, busy: model.busy, preview: deposit.preview })
          const preview = deposit.preview
          const here = preview?.invoices.find((invoice) => invoice.id === model.invoiceId) ?? null
          return (
            <div key={deposit.depositRequestId} className="fw-fin-stack-tight">
              <h3 className="fw-fin-h3">{preview?.orderNumber ? c('deposit', { order: preview.orderNumber }) : c('depositNoOrder')}</h3>
              {preview === null ? (
                <p className="fw-fin-hint" role="status">
                  <Spinner size={12} /> {c('previewing')}
                </p>
              ) : preview.problem ? (
                <p className="fw-fin-hint">{c('cannot')}</p>
              ) : (
                <KeyValue
                  dense
                  labelCase="sentence"
                  columns={2}
                  items={[
                    { label: c('amount'), value: model.price ? money(preview.amount, preview.currency, locale) : c('noPrice') },
                    { label: c('payments'), value: String(new Set(preview.steps.map((step) => step.paymentId)).size) },
                    ...(here && model.price ? [{ label: c('openBefore'), value: money(here.openAmount, preview.currency, locale) }, { label: c('openAfter'), value: money(here.openAfter, preview.currency, locale) }] : []),
                  ]}
                />
              )}
              <span className="fw-fin-inline">
                <Button size="sm" heldReason={held ? c(held.key) : null} onClick={() => actions?.onConfirm?.(deposit)}>
                  <ArrowRightLeft size={13} aria-hidden /> {c('go')}
                </Button>
              </span>
            </div>
          )
        })
      )}
      {model.confirming && <ConfirmDialog model={model} deposit={model.confirming} actions={actions} />}
    </Card>
  )
}

function ConfirmDialog({ model, deposit, actions }: { model: CarryModel; deposit: DepositToCarry; actions?: CarryActions }) {
  const t = useT('finance')
  const c = useT(CARRY)
  const locale = useLocale()
  const preview = deposit.preview
  const held = carryHeld({ mayRecord: model.mayRecord, busy: model.busy, preview })
  return (
    <DialogFrame
      title={c('confirmTitle', { invoice: model.invoiceNumber ?? '—' })}
      held={held ? c(held.key) : null}
      go={() => actions?.onCarry?.()}
      goLabel={model.busy ? t('common.working') : c('confirmGo')}
      onClose={() => actions?.onConfirm?.(null)}
      problem={model.writeProblem}
    >
      <p className="fw-fin-hint">{c('confirmExplain')}</p>
      {preview && !preview.problem && model.price && <p className="fw-fin-hint">{c('confirmAmount', { amount: money(preview.amount, preview.currency, locale) })}</p>}
    </DialogFrame>
  )
}
