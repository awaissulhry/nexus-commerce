'use client'

import { useEffect, useId, useMemo } from 'react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Combobox, DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { newReturnProblems, previewProblemWords } from '../model'
import type { NewReturnActions, NewReturnModel } from '../view-model'
import { say, useDayWords, useWords } from './parts'
import { ReturnLinePicker } from './ReturnLinePicker'

/**
 * New return (design sales.returns/pop:returns.new; band, `c`, `?new=return`): the customer, then what may come back —
 * the customer's invoiced lines (and shipped ones not invoiced yet), each with what was sold and what is left — the pieces
 * (never above what is left: the field says the numbers), the reason from the RETURN reason list, and the deadline for
 * the goods from the return policy. The preview runs while typing; Create RMA (⌘↵) is held with the first thing
 * missing. Esc closes and the focus goes back to the opener.
 */
export function NewReturnModal({ model, actions }: { model: NewReturnModel; actions?: NewReturnActions }) {
  const t = useWords()
  const locale = useLocale()
  const dayWords = useDayWords()
  const draft = model.draft
  const ids = { customer: useId(), order: useId(), due: useId(), ref: useId(), note: useId() }
  const returnable = model.returnable.value
  const lines = useMemo(() => (returnable?.lines ?? []).filter((line) => !draft.salesOrderId || line.order?.id === draft.salesOrderId), [returnable, draft.salesOrderId])
  const orders = useMemo(() => {
    const seen = new Map<string, string>()
    for (const line of returnable?.lines ?? []) if (line.order) seen.set(line.order.id, line.order.number)
    return [...seen.entries()].map(([id, number]) => ({ id, number }))
  }, [returnable])
  const problems = newReturnProblems(draft, returnable?.lines ?? null)
  const apiProblems = model.preview ? previewProblemWords(model.preview.problems, 'return') : []
  const held = model.busy ? t('quality:common.working') : problems[0] ? say(t, problems[0]) : model.showProblems && apiProblems[0] ? say(t, apiProblems[0]) : model.previewing ? t('newReturn.checking') : null

  // ⌘↵ creates the RMA from anywhere in the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        actions?.onNewReturnSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])

  const customers = model.customers.items
  const policy = returnable?.policy ?? null

  return (
    <Modal
      open
      onClose={() => actions?.onNewReturnClose?.()}
      title={t('newReturn.title')}
      subtitle={t('newReturn.sub')}
      size="xl"
      footer={
        <>
          <span className="fw-q-hint">{t('newReturn.foot')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onNewReturnClose?.()}>
            {t('quality:common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onNewReturnSubmit?.()} aria-keyshortcuts="Meta+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('newReturn.submit')}
          </Button>
        </>
      }
    >
      <form
        className="fw-q-stack"
        onSubmit={(event) => {
          event.preventDefault()
          actions?.onNewReturnSubmit?.()
        }}
      >
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
        <div className="fw-q-form-three">
          <Field label={<span id={`${ids.customer}-label`}>{t('newReturn.customer')}</span>} required error={model.showProblems && !draft.partyId ? t('newReturn.problem.customer') : model.customers.problem ? t(model.customers.problem) : undefined} htmlFor={ids.customer}>
            {customers ? (
              <Combobox
                options={customers.map((party) => ({ value: party.id, label: `${party.code} · ${party.tradeName ?? party.legalName}` }))}
                value={draft.partyId}
                onChange={(value) => actions?.onNewReturnDraft?.({ partyId: value, salesOrderId: '', lines: {} })}
                placeholder={t('newReturn.customerSearch')}
                labelledBy={`${ids.customer}-label`}
              />
            ) : (
              <Input id={ids.customer} disabled value="" readOnly placeholder={t('newReturn.customerNoList')} />
            )}
          </Field>
          <Field label={t('newReturn.order')} hint={draft.partyId ? t('newReturn.orderHint') : t('newReturn.customerFirst')} htmlFor={ids.order}>
            <Select id={ids.order} value={draft.salesOrderId} disabled={!draft.partyId || orders.length === 0} onChange={(event) => actions?.onNewReturnDraft?.({ salesOrderId: event.target.value })}>
              <option value="">{t('newReturn.anyOrder')}</option>
              {orders.map((order) => (
                <option key={order.id} value={order.id}>
                  {order.number}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('newReturn.due')} hint={model.preview?.goodsDueBy ? t('newReturn.dueHint', { date: dayWords(model.preview.goodsDueBy) }) : policy?.goodsDueDays ? t('newReturn.duePolicy', { count: policy.goodsDueDays }) : t('newReturn.dueNone')} htmlFor={ids.due}>
            <DateField id={ids.due} value={draft.goodsDueBy} onChange={(value) => actions?.onNewReturnDraft?.({ goodsDueBy: value })} locale={INTL_LOCALE[locale]} min={model.today} ariaLabel={t('newReturn.due')} placeholder={t('newReturn.duePlaceholder')} clearLabel={t('newReturn.duePlaceholder')} />
          </Field>
        </div>

        <section aria-label={t('newReturn.linesLabel')} className="fw-q-stack">
          <h3 className="fw-q-hint">{t('newReturn.linesHead')}</h3>
          {!draft.partyId ? (
            <p className="fw-q-hint">{t('newReturn.pickCustomer')}</p>
          ) : model.returnable.loading ? (
            <p className="fw-q-loading" role="status">
              <Spinner size={14} /> {t('newReturn.reading')}
            </p>
          ) : model.returnable.problem ? (
            <Banner tone="danger" title={t(model.returnable.problem)} />
          ) : lines.length === 0 ? (
            <EmptyState title={t('newReturn.nothing')} description={t('newReturn.nothingBody')} />
          ) : (
            <ReturnLinePicker lines={lines} drafts={draft.lines} reasons={model.reasons} price={model.price} windowDays={policy?.windowDays ?? null} today={model.today} showProblems={model.showProblems} onLine={(key, patch) => actions?.onNewReturnLine?.(key, patch)} />
          )}
        </section>

        {model.previewing && (
          <p className="fw-q-loading" role="status">
            <Spinner size={12} /> {t('newReturn.checking')}
          </p>
        )}
        {model.showProblems && apiProblems.length > 0 && (
          <Banner tone="warning" title={t('newReturn.fix')}>
            <ul className="fw-q-lines">
              {apiProblems.map((words) => (
                <li key={`${words.key}${JSON.stringify(words.params ?? {})}`}>{say(t, words)}</li>
              ))}
            </ul>
          </Banner>
        )}

        <div className="fw-q-form-two">
          <Field label={t('newReturn.ref')} htmlFor={ids.ref}>
            <Input id={ids.ref} value={draft.customerRef} onChange={(event) => actions?.onNewReturnDraft?.({ customerRef: event.target.value })} />
          </Field>
          <Field label={t('newReturn.note')} hint={t('newReturn.noteHint')} htmlFor={ids.note}>
            <Textarea id={ids.note} rows={2} value={draft.internalNote} onChange={(event) => actions?.onNewReturnDraft?.({ internalNote: event.target.value })} />
          </Field>
        </div>
      </form>
    </Modal>
  )
}
