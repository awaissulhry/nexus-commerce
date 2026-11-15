'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, Search, Trash2 } from 'lucide-react'
import { Banner, Disclosure, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input } from '@nexus/ui/primitives'
import { DateField, FileDropzone, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { figuresDraftProblems, pastedRows, type FiguresDraft, type OrderDraft, type PaymentDraft, type Phrase } from '../model'
import type { FiguresActions, FiguresEditor, FiguresModel } from './FiguresSection'

/**
 * Record their figures / correct them (FIN-135): the customer (searched; fixed when correcting), the day their statement is
 * as of (not after today), their balance, what they say they owe per order (reference · amount) and the payments they say
 * they made (reference · day · amount) — each a row, or rows pasted from their spreadsheet (tab or semicolon between cells)
 * — a note, and the statement as received (a file kept with them; new figures only). Amounts as they write them, signed
 * (a credit is below 0). The primary says what it does; every field says what is wrong once the person tries.
 */
export function FiguresDialog({ editor, can, today, actions }: { editor: FiguresEditor; can: FiguresModel['can']; today: string; actions?: FiguresActions['editor'] }) {
  const t = useT('finance-bank')
  const locale = useLocale()
  const draft = editor.draft
  const isNew = editor.mode === 'new'
  const [q, setQ] = useState(editor.q)
  const [pasteOrders, setPasteOrders] = useState('')
  const [pastePayments, setPastePayments] = useState('')
  const typedQ = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typedQ.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(q), 300)
    return () => clearTimeout(timer)
  }, [q])
  const problems = figuresDraftProblems(draft, today, isNew)
  const show = (key: string) => (editor.tried && problems[key] ? t(problems[key]!) : undefined)
  const set = (next: Partial<FiguresDraft>) => actions?.onDraft?.({ ...draft, ...next })
  const setOrder = (index: number, next: Partial<OrderDraft>) => set({ orders: draft.orders.map((entry, at) => (at === index ? { ...entry, ...next } : entry)) })
  const setPayment = (index: number, next: Partial<PaymentDraft>) => set({ payments: draft.payments.map((entry, at) => (at === index ? { ...entry, ...next } : entry)) })
  const phrase = (entry: Phrase) => t(entry.key, entry.params)
  const firstProblem = Object.values(problems)[0]
  const held = editor.busy ? t('held.busy') : !can.manage ? t('held.figures') : !can.price ? t('held.figuresPrice') : editor.tried && firstProblem ? t(firstProblem) : null
  const footer = (
    <>
      <span className="grow" />
      <Button size="sm" onClick={() => actions?.onClose?.()}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSubmit?.()}>
        {editor.busy ? t('common.working') : isNew ? t('figures.go') : t('figures.goCorrect')}
      </Button>
    </>
  )
  return (
    <Modal open onClose={() => actions?.onClose?.()} title={isNew ? t('figures.newTitle') : t('figures.correctTitle')} size="lg" footer={footer}>
      <form
        className="fw-bank-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) actions?.onSubmit?.()
        }}
      >
        {editor.problems && editor.problems.length > 0 && <Banner tone="danger" title={editor.problems.map(phrase).join(' ')} />}
        <p className="fw-bank-muted">{isNew ? t('figures.newBody') : t('figures.correctBody')}</p>
        {isNew && !draft.partyId ? (
          <>
            <Field label={t('figures.col.customer')} hint={t('choose.customerHint')} error={show('party')}>
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
              {editor.customersProblem ? (
                <li>{t(editor.customersProblem)}</li>
              ) : editor.customers === null ? (
                <li className="fw-bank-muted">{t('choose.searching')}</li>
              ) : editor.customers.length === 0 ? (
                <li className="fw-bank-muted">{t('choose.noCustomer')}</li>
              ) : (
                editor.customers.slice(0, 6).map((customer) => (
                  <li key={customer.id} className="fw-bank-row">
                    <span className="fw-bank-cell">
                      <span>{customer.legalName}</span>
                      <span className="fw-bank-sub">{[customer.code, customer.vatNumber].filter(Boolean).join(' · ')}</span>
                    </span>
                    <Button size="sm" onClick={() => actions?.onCustomer?.({ id: customer.id, label: `${customer.legalName} (${customer.code})` })}>
                      {t('choose.pick')}
                    </Button>
                  </li>
                ))
              )}
            </ul>
          </>
        ) : (
          <span className="fw-bank-inline">
            <KeyValue dense labelCase="sentence" items={[{ label: t('figures.col.customer'), value: draft.partyLabel }]} />
            {isNew && (
              <Button size="sm" variant="link" onClick={() => actions?.onCustomer?.(null)}>
                {t('choose.otherCustomer')}
              </Button>
            )}
          </span>
        )}
        <div className="fw-bank-two">
          <Field label={t('figures.col.asOf')} hint={t('figures.asOfHint')} error={show('asOf')}>
            <DateField value={draft.asOf} onChange={(value) => set({ asOf: value })} max={today} locale={INTL_LOCALE[locale]} ariaLabel={t('figures.col.asOf')} />
          </Field>
          <Field label={t('figures.theirBalance')} hint={t('figures.balanceTyped')} error={show('balance')}>
            <Input inputMode="decimal" value={draft.balance} onChange={(event) => set({ balance: event.target.value })} autoComplete="off" />
          </Field>
        </div>

        <h3 className="fw-bank-h3">{t('figures.orders')}</h3>
        <ul className="fw-bank-rows" aria-label={t('figures.orders')}>
          {draft.orders.map((entry, index) => (
            <li key={`order-${index}`} className="fw-bank-entry">
              <Field label={t('figures.col.theirReference')} error={show(`orders.${index}.reference`)}>
                <Input value={entry.reference} maxLength={100} onChange={(event) => setOrder(index, { reference: event.target.value })} autoComplete="off" />
              </Field>
              <Field label={t('figures.col.theirs')} error={show(`orders.${index}.amount`)}>
                <Input inputMode="decimal" value={entry.amount} onChange={(event) => setOrder(index, { amount: event.target.value })} autoComplete="off" />
              </Field>
              <Button size="sm" variant="quiet" aria-label={t('figures.removeOrder', { index: index + 1 })} onClick={() => set({ orders: draft.orders.filter((_, at) => at !== index) })}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        <span className="fw-bank-inline">
          <Button size="sm" variant="link" heldReason={draft.orders.length >= 500 ? t('held.figuresMany') : null} onClick={() => set({ orders: [...draft.orders, { reference: '', amount: '' }] })}>
            <Plus size={13} aria-hidden /> {t('figures.addOrder')}
          </Button>
        </span>
        <Disclosure summary={t('figures.pasteOrders')}>
          <div className="fw-bank-stack">
            <Textarea rows={4} value={pasteOrders} onChange={(event) => setPasteOrders(event.target.value)} aria-label={t('figures.pasteOrders')} placeholder={t('figures.pasteOrdersHint')} />
            <span className="fw-bank-inline">
              <Button
                size="sm"
                heldReason={pastedRows(pasteOrders, 'orders').length === 0 ? t('held.pasteNothing') : null}
                onClick={() => {
                  const rows = pastedRows(pasteOrders, 'orders') as OrderDraft[]
                  set({ orders: [...draft.orders.filter((entry) => entry.reference.trim() !== '' || entry.amount.trim() !== ''), ...rows] })
                  setPasteOrders('')
                }}
              >
                {t('figures.pasteAdd', { count: pastedRows(pasteOrders, 'orders').length })}
              </Button>
            </span>
          </div>
        </Disclosure>

        <h3 className="fw-bank-h3">{t('figures.payments')}</h3>
        {draft.payments.length === 0 && <p className="fw-bank-muted">{t('figures.noPaymentsTyped')}</p>}
        <ul className="fw-bank-rows" aria-label={t('figures.payments')}>
          {draft.payments.map((entry, index) => (
            <li key={`payment-${index}`} className="fw-bank-entry is-payment">
              <Field label={t('figures.col.theirReference')} error={show(`payments.${index}.reference`)}>
                <Input value={entry.reference} maxLength={100} onChange={(event) => setPayment(index, { reference: event.target.value })} autoComplete="off" />
              </Field>
              <Field label={t('figures.col.day')} error={show(`payments.${index}.date`)}>
                <DateField value={entry.date} onChange={(value) => setPayment(index, { date: value })} max={draft.asOf || today} locale={INTL_LOCALE[locale]} ariaLabel={t('figures.col.day')} />
              </Field>
              <Field label={t('figures.col.theirs')} error={show(`payments.${index}.amount`)}>
                <Input inputMode="decimal" value={entry.amount} onChange={(event) => setPayment(index, { amount: event.target.value })} autoComplete="off" />
              </Field>
              <Button size="sm" variant="quiet" aria-label={t('figures.removePayment', { index: index + 1 })} onClick={() => set({ payments: draft.payments.filter((_, at) => at !== index) })}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        <span className="fw-bank-inline">
          <Button size="sm" variant="link" heldReason={draft.payments.length >= 500 ? t('held.figuresMany') : null} onClick={() => set({ payments: [...draft.payments, { reference: '', date: '', amount: '' }] })}>
            <Plus size={13} aria-hidden /> {t('figures.addPayment')}
          </Button>
        </span>
        <Disclosure summary={t('figures.pastePayments')}>
          <div className="fw-bank-stack">
            <Textarea rows={4} value={pastePayments} onChange={(event) => setPastePayments(event.target.value)} aria-label={t('figures.pastePayments')} placeholder={t('figures.pastePaymentsHint')} />
            <span className="fw-bank-inline">
              <Button
                size="sm"
                heldReason={pastedRows(pastePayments, 'payments').length === 0 ? t('held.pasteNothing') : null}
                onClick={() => {
                  const rows = pastedRows(pastePayments, 'payments') as PaymentDraft[]
                  set({ payments: [...draft.payments.filter((entry) => entry.reference.trim() !== '' || entry.amount.trim() !== '' || entry.date !== ''), ...rows] })
                  setPastePayments('')
                }}
              >
                {t('figures.pasteAdd', { count: pastedRows(pastePayments, 'payments').length })}
              </Button>
            </span>
          </div>
        </Disclosure>

        <Field label={t('figures.note')} error={show('note')}>
          <Textarea rows={2} value={draft.note} maxLength={2000} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        {isNew ? (
          <Field label={t('figures.col.file')} hint={can.upload ? t('figures.fileHint') : t('held.upload')}>
            {can.upload ? <FileDropzone onFiles={(files) => actions?.onFile?.(files[0] ?? null)} maxBytes={10 * 1_048_576} hint={draft.fileName ?? t('figures.fileDrop')} /> : <span className="fw-bank-muted">—</span>}
          </Field>
        ) : (
          draft.fileName && <KeyValue dense labelCase="sentence" items={[{ label: t('figures.col.file'), value: draft.fileName }]} />
        )}
      </form>
    </Modal>
  )
}
