'use client'

import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { CustomerRow, OpenItem } from '../../_shared/api'
import { allocationsOf, dayInstant, leftToPlace, money, placementProblems } from '../../_shared/model'
import { DialogFrame } from '../../_shared/parts'
import { Placement, planOf } from '../../_shared/placement'
import { WRITE_OFF_REASONS, type BankLine, type WriteOffReason } from '../api'
import { maskIban, type BankCan, type Phrase } from '../model'
import type { WriteOffDraft } from './MatchPanel'

/** "Choose another / Split" (design sec:match "choose another · split"; s): the container keeps it. */
export interface ChooseModel {
  readonly line: BankLine
  /** The customer chosen (null: still searching). */
  readonly customer: { readonly id: string; readonly name: string } | null
  readonly q: string
  readonly customers: readonly CustomerRow[] | null
  readonly customersProblem: string | null
  readonly items: readonly OpenItem[] | null
  readonly itemsProblem: string | null
  /** The amounts typed per open item (text, the person's own way of writing them). */
  readonly typed: Readonly<Record<string, string>>
  readonly writeOff: WriteOffDraft
  readonly busy: boolean
  readonly problems: readonly Phrase[] | null
  readonly lockAsked: boolean
  readonly lockReason: string
}

export interface ChooseActions {
  onSearch?: (q: string) => void
  onCustomer?: (customer: { id: string; name: string } | null) => void
  onTyped?: (typed: Record<string, string>) => void
  onWriteOff?: (next: WriteOffDraft) => void
  onLockReason?: (text: string) => void
  onRetryItems?: () => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * Choose another / Split (design sec:match; the finance area's Placement is the item part): the line in short, the customer
 * (searched by name, code or VAT number, or the suggestion's), its open invoices and deposit requests oldest first with what
 * each still asks; tick an item or type an amount per item (two or more items split the line), "Suggest" fills oldest first,
 * what is left stays on the customer's account. A difference within the write-off tolerance may be written off. The
 * primary says what it does; the API records the payment and places it in ONE command (CHOSEN_BY_PERSON).
 */
export function ChooseDialog({ model, can, actions }: { model: ChooseModel; can: BankCan; actions?: ChooseActions }) {
  const t = useT('finance-bank')
  const locale = useLocale()
  const line = model.line
  const amount = line.amount ?? 0
  const [q, setQ] = useState(model.q)
  const typedQ = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typedQ.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(q), 300)
    return () => clearTimeout(timer)
  }, [q])
  const plan = planOf(model.typed)
  const allocations = model.items ? allocationsOf(model.items, plan) : []
  const placement = model.items ? placementProblems(model.items, plan, amount) : { items: {}, total: null }
  const left = leftToPlace(amount, plan)
  const phrase = (entry: Phrase) => t(entry.key, entry.params)
  const held = model.busy
    ? t('held.busy')
    : !model.customer
      ? t('choose.held.customer')
      : allocations.length === 0
        ? t('choose.held.items')
        : Object.keys(placement.items).length > 0 || placement.total
          ? t('choose.held.amounts')
          : model.writeOff.on && model.writeOff.reason === 'OTHER' && model.writeOff.note.trim() === ''
            ? t('held.writeOffNote')
            : model.lockAsked && model.lockReason.trim() === ''
              ? t('held.lockReason')
              : null
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  return (
    <DialogFrame
      title={t('choose.title')}
      held={held}
      go={() => actions?.onSubmit?.()}
      goLabel={model.busy ? t('common.working') : allocations.length > 1 ? t('choose.goSplit', { count: allocations.length }) : t('choose.go')}
      onClose={() => actions?.onClose?.()}
      problem={model.problems && model.problems.length > 0 ? { key: `finance-bank:${model.problems[0]!.key}`, params: model.problems[0]!.params } : null}
      size="lg"
    >
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('panel.booked'), value: day(line.bookedOn) },
          { label: t('panel.amount'), value: can.price ? money(line.amount === undefined ? null : line.amount, line.currency, locale) : '—' },
          { label: t('panel.reference'), value: line.referenceText ?? '—' },
          { label: t('panel.payer'), value: [line.counterpartyName, maskIban(line.counterpartyIban)].filter(Boolean).join(' · ') || '—' },
        ]}
      />
      {model.customer ? (
        <span className="fw-bank-inline">
          <KeyValue dense labelCase="sentence" items={[{ label: t('choose.customer'), value: model.customer.name }]} />
          <Button size="sm" variant="link" onClick={() => actions?.onCustomer?.(null)}>
            {t('choose.otherCustomer')}
          </Button>
        </span>
      ) : (
        <>
          <Field label={t('choose.customer')} hint={t('choose.customerHint')}>
            <Input
              type="search"
              leadingIcon={<Search size={13} aria-hidden />}
              value={q}
              onChange={(event) => {
                typedQ.current = true
                setQ(event.target.value)
              }}
              autoComplete="off"
            />
          </Field>
          <ul className="fw-bank-rows" aria-label={t('choose.customers')}>
            {model.customersProblem ? (
              <li>{t(model.customersProblem)}</li>
            ) : model.customers === null ? (
              <li className="fw-bank-muted">{t('choose.searching')}</li>
            ) : model.customers.length === 0 ? (
              <li className="fw-bank-muted">{t('choose.noCustomer')}</li>
            ) : (
              model.customers.slice(0, 8).map((customer) => (
                <li key={customer.id} className="fw-bank-row">
                  <span className="fw-bank-cell">
                    <span>{customer.legalName}</span>
                    <span className="fw-bank-sub">{[customer.code, customer.vatNumber].filter(Boolean).join(' · ')}</span>
                  </span>
                  <Button size="sm" onClick={() => actions?.onCustomer?.({ id: customer.id, name: customer.legalName })}>
                    {t('choose.pick')}
                  </Button>
                </li>
              ))
            )}
          </ul>
        </>
      )}
      {model.customer && (
        <>
          <h3 className="fw-bank-h3">{t('choose.where')}</h3>
          <Placement items={model.items} problem={model.itemsProblem} amount={amount} currency={line.currency} typed={model.typed} setTyped={(next) => actions?.onTyped?.(next)} onRetry={() => actions?.onRetryItems?.()} price={can.price} />
          {left > 0 && allocations.length > 0 && <p className="fw-bank-muted">{t('choose.rest', { amount: money(left, line.currency, locale) })}</p>}
          {left > 0 && allocations.length > 0 && can.writeOff && (
            <div className="fw-bank-stack">
              <Checkbox checked={model.writeOff.on} onChange={(event) => actions?.onWriteOff?.({ ...model.writeOff, on: event.target.checked })} label={t('choose.writeOff')} />
              {model.writeOff.on && (
                <span className="fw-bank-inline">
                  <Select size="sm" aria-label={t('writeOff.reason')} value={model.writeOff.reason} onChange={(event) => actions?.onWriteOff?.({ ...model.writeOff, reason: event.target.value as WriteOffReason })}>
                    {WRITE_OFF_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {t(`writeOff.reasons.${reason}`)}
                      </option>
                    ))}
                  </Select>
                  {model.writeOff.reason === 'OTHER' && <Input size="sm" aria-label={t('writeOff.note')} placeholder={t('writeOff.note')} value={model.writeOff.note} maxLength={500} onChange={(event) => actions?.onWriteOff?.({ ...model.writeOff, note: event.target.value })} />}
                </span>
              )}
              <p className="fw-bank-muted">{t('choose.writeOffHint')}</p>
            </div>
          )}
          {model.lockAsked && (
            <div className="fw-bank-stack">
              <p className="fw-bank-muted">{t('period.softAsk')}</p>
              <Input size="sm" aria-label={t('period.reason')} placeholder={t('period.reason')} value={model.lockReason} maxLength={500} onChange={(event) => actions?.onLockReason?.(event.target.value)} />
            </div>
          )}
        </>
      )}
      {model.problems && model.problems.length > 1 && <p className="fw-bank-muted">{model.problems.slice(1).map(phrase).join(' ')}</p>}
    </DialogFrame>
  )
}
