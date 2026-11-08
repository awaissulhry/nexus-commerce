'use client'

/**
 * PaymentPanel — the payment provider's own fields inside a DS frame (B-W2b-155, design part PaymentPanel): the
 * deposit on a quote link, Pay online on a link, an open invoice in the customer's portal.
 *
 *   <PaymentPanel amount="714,00 €" purpose="Deposit for quote Q-2026-0042" providerName="Stripe"
 *                 methods={methods} method={method} onMethod={setMethod} state={state}
 *                 onStart={startIntent} mountFields={(box) => mountStripe(box, clientSecret)} onPay={confirm}
 *                 failure={failure} onRetry={again} labels={ds.paymentPanel} />
 *
 * - Says what is paid and how much (the amount comes written by the app; the panel never formats money).
 * - The method choice (`methods`: card, SEPA …) as DS RadioCards while nothing is under way; none given = no choice.
 * - The provider's fields: `fields` (drawn by the page — the FAKE provider's scenario buttons) and/or `mountFields`, an
 *   empty box handed to the provider's script (Stripe Elements) once it exists, its cleanup run when the box goes. The
 *   panel itself NEVER draws an input for card or bank data, and never sees one: no card data in our app.
 * - Every state in our words: opening, sending, "Waiting for your bank… don't close this page." (one polite live
 *   region, always there), failed (the words + Try again), paid. `aria-busy` while a step runs; the button that waits is
 *   held with the reason, never dead. `heldReason` holds the whole panel with its words on screen.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Lock } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { RadioCard } from '../../primitives/RadioCard'
import { Spinner } from '../../primitives/Spinner'
import { PAYMENT_PANEL_LABELS, type PaymentPanelLabels } from './PaymentPanelLabels'
import { paymentPanelView, paymentStartHeld, type PaymentState } from './paymentPanelModel'
import './paymentPanel.css'

export interface PaymentMethodOption {
  id: string
  /** "Card", "SEPA Direct Debit". */
  label: string
  /** One line more ("Visa, Mastercard, American Express"). */
  description?: string
}

export interface PaymentPanelProps {
  /** The amount, written by the app ("714,00 €"). */
  amount: string
  /** What it pays ("Deposit for quote Q-2026-0042"): the panel's heading. */
  purpose: string
  /** Who takes the payment ("Stripe"): named in the fields' region and the security note. */
  providerName?: string
  methods?: readonly PaymentMethodOption[]
  method?: string | null
  onMethod?: (id: string) => void
  state: PaymentState
  /** The provider's own fields, drawn by the page (shown while ready, paying or waiting). */
  fields?: ReactNode
  /** An empty box for the provider's script to fill (Stripe Elements). Called once the box exists; its cleanup when the box goes. */
  mountFields?: (box: HTMLDivElement) => void | (() => void)
  /** Idle: the first step (the page asks the provider for a payment). */
  onStart?: () => void
  /** Ready: the page submits through the provider. Without it the provider's fields carry their own submit. */
  onPay?: () => void
  /** The whole panel cannot be used now, in words (shown on screen). */
  heldReason?: string | null
  /** Failed: why, in words (the provider's reason in ours). */
  failure?: string | null
  onRetry?: () => void
  /** Paid: what happened and, if any, the receipt line ("Receipt sent to anna@brand.example"). */
  succeeded?: { words?: string; receipt?: string } | null
  /** The level of the heading (default 3). */
  headingLevel?: 2 | 3 | 4
  labels?: Partial<PaymentPanelLabels>
  className?: string
}

export function PaymentPanel({
  amount, purpose, providerName, methods, method, onMethod, state, fields, mountFields, onStart, onPay, heldReason, failure, onRetry, succeeded,
  headingLevel = 3, labels, className,
}: PaymentPanelProps) {
  const lw = mergeLabels(PAYMENT_PANEL_LABELS, labels)
  const uid = useId()
  const titleId = `${uid}-title`
  const held = heldReason ? heldReason : null
  const view = paymentPanelView({ state, held: !!held, canStart: !!onStart, canPay: !!onPay })
  const H = `h${headingLevel}` as 'h3'
  const chosen = methods?.find((m) => m.id === method) ?? null

  // The provider's box: handed over once it exists, taken back when it goes (a later state, or the panel leaves).
  const box = useRef<HTMLDivElement>(null)
  const mount = useRef(mountFields)
  mount.current = mountFields
  const wantsBox = view.showFields && !!mountFields
  useEffect(() => {
    if (!wantsBox || !box.current || !mount.current) return
    const cleanup = mount.current(box.current)
    return typeof cleanup === 'function' ? cleanup : undefined
  }, [wantsBox])

  const statusWords = view.status === 'starting' ? lw.starting : view.status === 'paying' ? lw.paying(providerName) : view.status === 'waiting' ? lw.waiting : ''

  return (
    <section
      className={['nds-pay', className].filter(Boolean).join(' ')}
      data-state={held ? 'held' : state}
      aria-labelledby={titleId}
      aria-busy={view.busy || undefined}
    >
      <div className="nds-pay-head">
        <H id={titleId} className="nds-pay-title">
          {purpose}
        </H>
        <span className="nds-pay-amount">
          <span className="nds-vh">{lw.amount}: </span>
          {amount}
        </span>
      </div>

      {held ? (
        <p className="nds-pay-held" role="note">
          <Lock aria-hidden className="nds-pay-icon" />
          <span>{held}</span>
        </p>
      ) : state === 'succeeded' ? (
        <div className="nds-pay-result" data-tone="success" role="status">
          <CheckCircle2 aria-hidden className="nds-pay-icon" />
          <div className="nds-pay-result-text">
            <strong>{succeeded?.words || lw.succeededTitle}</strong>
            {succeeded?.receipt ? <span>{succeeded.receipt}</span> : null}
          </div>
        </div>
      ) : (
        <>
          {methods && methods.length > 0 ? (
            view.chooseMethod ? (
              <fieldset className="nds-pay-methods">
                <legend className="nds-pay-legend">{lw.method}</legend>
                {methods.map((m) => (
                  <RadioCard
                    key={m.id}
                    name={`${uid}-method`}
                    value={m.id}
                    checked={method === m.id}
                    selected={method === m.id}
                    onChange={() => onMethod?.(m.id)}
                    title={m.label}
                    description={m.description}
                  />
                ))}
              </fieldset>
            ) : chosen ? (
              <p className="nds-pay-chosen">
                <span className="nds-pay-legend">{lw.method}</span> <strong>{chosen.label}</strong>
              </p>
            ) : null
          ) : null}

          {view.showFields ? (
            <div className="nds-pay-fields" role="group" aria-label={lw.fields(providerName)}>
              {fields}
              {mountFields ? <div ref={box} className="nds-pay-mount" /> : null}
            </div>
          ) : null}

          {state === 'failed' ? (
            <div className="nds-pay-result" data-tone="danger" role="alert">
              <AlertCircle aria-hidden className="nds-pay-icon" />
              <div className="nds-pay-result-text">
                <strong>{lw.failedTitle}</strong>
                {failure ? <span>{failure}</span> : null}
              </div>
              {onRetry ? <Button onClick={onRetry}>{lw.retry}</Button> : null}
            </div>
          ) : null}

          {view.action ? (
            <div className="nds-pay-actions">
              {view.action === 'start' ? (
                <Button variant="primary" onClick={onStart} heldReason={paymentStartHeld(methods, method, lw.pickMethod)}>
                  {lw.start}
                </Button>
              ) : view.action === 'pay' ? (
                <Button variant="primary" onClick={onPay}>
                  {lw.pay(amount)}
                </Button>
              ) : (
                <Button variant="primary" heldReason={lw.busy}>
                  <Spinner size={14} />
                  {lw.pay(amount)}
                </Button>
              )}
            </div>
          ) : null}
        </>
      )}

      {/* One polite region, always there: opening, sending, waiting for the bank. */}
      <p className="nds-pay-status" aria-live="polite" aria-atomic="true">
        {statusWords ? (
          <>
            {view.status !== 'waiting' ? <Spinner size={14} /> : null}
            <span>{statusWords}</span>
          </>
        ) : null}
      </p>

      {state !== 'succeeded' ? (
        <p className="nds-pay-secure">
          <Lock aria-hidden className="nds-pay-icon" />
          <span>{lw.secure(providerName)}</span>
        </p>
      ) : null}
    </section>
  )
}
