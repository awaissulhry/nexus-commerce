'use client'

import type { KeyboardEvent } from 'react'
import { Info, Lock } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { CURRENCY_CHOICES } from '../../../../../parties/_shared/model'
import { LanguageSelect } from '../../../../../parties/_shared/view/dialogs'
import { INCOTERMS_2020, INVOICE_TIMINGS, type PaymentTermsRow } from '../../../terms/api'
import { listChoices, termsChoices, type TermsDraft } from '../../../terms/model'
import { said, type Said, type Say } from '../../terms/model'
import type { TermsTabActions, TermsWindowsModel } from '../../terms/tab'
import { termsWindowProblems, type TermsWindow } from '../../terms/windows'
import { useTermsSay } from './say'

/**
 * F-CT-305 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §6.2; 18-lead-settles Z8, Z24, Z25) — NEW window "Change the
 * terms of {customer}" (a centred DS Modal, lg): the customer's own terms — what a new quote or order takes. Today's in-place form
 * MOVED here with its rules unchanged (cu/terms/model.ts), minus the carrier (Change delivery… is its one editor); the currency is the
 * record window's Select of CURRENCY_CHOICES, the document language its LanguageSelect (Z8: ONE editor of currency, language and
 * payment terms). The price list only with pricelists.manage (else ONE line says who gives it), the minimum only with the price grain.
 * Cancel · Save terms (⌘/Ctrl + Enter) — PATCH /parties/:id/commercial-terms at the party's version. Draws its model.
 */

export interface ChangeTermsProps {
  readonly window: TermsWindow
  readonly windows: TermsWindowsModel
  readonly actions?: TermsTabActions | undefined
}

export function ChangeTermsDialog(props: ChangeTermsProps) {
  const say = useTermsSay()
  const { window, windows, actions } = props
  const problems = termsWindowProblems(window)
  const count = Object.keys(problems).length
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      actions?.onWindowConfirm?.()
    }
  }
  return (
    <Modal
      open
      size="lg"
      busy={window.busy}
      onClose={() => actions?.onWindowClose?.()}
      title={say(said('ct.win.terms.title', { params: { customer: windows.customer } }))}
      subtitle={say(said('ct.win.terms.sub'))}
      footer={
        <>
          <span className="fw-ctr-fnote">{say(said('ct.com.answer'))}</span>
          <span className="grow" />
          <Button onClick={() => actions?.onWindowClose?.()}>{say(said('parties:common.cancel'))}</Button>
          <Button variant="primary" heldReason={window.busy ? say(said('parties:common.saving')) : window.tried && count > 0 ? say(said('terms.fixFirst', { params: { count } })) : null} onClick={() => actions?.onWindowConfirm?.()}>
            {say(said('terms.save'))}
          </Button>
        </>
      }
    >
      <div onKeyDown={onKey}>
        <ChangeTermsBody {...props} />
      </div>
    </Modal>
  )
}

/** The page language's name of a library row (P0-B8), else its name. */
const nameOf = (row: Pick<PaymentTermsRow, 'name' | 'nameI18n'>, locale: 'en' | 'it'): string => row.nameI18n?.[locale] ?? row.name

/** The window's inside (a design case draws it on a plain card: never a Modal open on the server render). */
export function ChangeTermsBody({ window, windows, actions }: ChangeTermsProps) {
  const say = useTermsSay()
  const locale = useLocale()
  const own = windows.own
  if (!own) return null
  const can = windows.can
  const draft = window.draft
  const problems: Partial<Record<keyof TermsDraft, string>> = window.tried ? termsWindowProblems(window) : {}
  const set = <K extends keyof TermsDraft>(key: K, value: TermsDraft[K]) => actions?.onWindowDraft?.({ ...window, draft: { ...draft, [key]: value } })
  const library = windows.library?.status === 'ready' ? windows.library.value : null
  const lists = windows.lists?.status === 'ready' ? windows.lists.value : null
  const choicesFailed = windows.library?.status === 'error' || windows.lists?.status === 'error'
  const reading = (can.paymentTerms && (windows.library === null || windows.library.status === 'loading')) || (can.listsManage && can.lists && (windows.lists === null || windows.lists.status === 'loading'))
  const terms = termsChoices(library, own)
  const chosen = library?.find((row) => row.id === draft.paymentTermsId) ?? null
  const listRows = listChoices(lists, own, draft.currency)
  const currencies = (CURRENCY_CHOICES as readonly string[]).includes(draft.currency) ? CURRENCY_CHOICES : [draft.currency, ...CURRENCY_CHOICES]
  const error = (field: keyof TermsDraft) => (problems[field] ? say(said(problems[field]!)) : undefined)
  return (
    <fieldset className="fw-ctr-win" disabled={window.busy}>
      {windows.ownTermsWith.length > 0 ? (
        <Banner tone="info" icon={<Info size={16} aria-hidden />} title={say(said('ct.win.terms.note', { lists: { companies: windows.ownTermsWith }, params: { company: windows.ownTermsWith[0]! } }))} />
      ) : null}
      {choicesFailed ? (
        <Banner
          tone="warning"
          title={say(said('terms.choicesFailed'))}
          action={
            <Button size="sm" onClick={() => actions?.onRetryChoices?.()}>
              {say(said('common.retry'))}
            </Button>
          }
        />
      ) : null}
      <div className="fw-ctr-fgrid">
        {can.paymentTerms ? (
          <Field label={say(said('termsField.paymentTerms'))} hint={chosen ? chosen.summary[locale] : say(said('ct.win.terms.ptHint'))}>
            <Select value={draft.paymentTermsId} disabled={reading} onChange={(event) => set('paymentTermsId', event.target.value)}>
              <option value="">{own.paymentTermsText ? say(said('terms.useTyped', { params: { text: own.paymentTermsText } })) : say(said('ct.win.terms.ptNone'))}</option>
              {terms.map((row) => {
                const named = library?.find((entry) => entry.id === row.id)
                return (
                  <option key={row.id} value={row.id}>
                    {`${row.code} · ${named ? nameOf(named, locale) : row.name}${row.archived ? ` (${say(said('terms.archivedTerms'))})` : ''}`}
                  </option>
                )
              })}
            </Select>
          </Field>
        ) : (
          <WhoLine say={say} words={said('terms.held.noTerms')} />
        )}
        <Field label={say(said('termsField.deposit'))} hint={say(said('terms.depositHint'))} error={error('defaultDepositPct')}>
          <Input value={draft.defaultDepositPct} inputMode="decimal" onChange={(event) => set('defaultDepositPct', event.target.value)} />
        </Field>
        {can.listsManage && can.lists ? (
          <Field label={say(said('termsField.priceList'))} hint={say(said('terms.listHint', { params: { currency: draft.currency } }))}>
            <Select value={draft.priceListId} disabled={reading} onChange={(event) => set('priceListId', event.target.value)}>
              <option value="">{say(said('terms.baseList'))}</option>
              {listRows.map((row) => (
                <option key={row.id} value={row.id}>
                  {`${row.code} · ${row.name} (${say(said(`kind.${row.kind}`))})`}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label={say(said('termsField.currency'))} hint={say(said('ct.win.terms.currencyHint'))} error={error('currency')}>
          <Select value={draft.currency} onChange={(event) => set('currency', event.target.value)}>
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        </Field>
        {can.price ? (
          <Field label={say(said('termsField.minimum'))} hint={say(said('terms.minimumHint', { params: { currency: draft.currency } }))} error={error('minimumOrder')}>
            <Input value={draft.minimumOrder} inputMode="decimal" onChange={(event) => set('minimumOrder', event.target.value)} />
          </Field>
        ) : null}
        <Field label={say(said('termsField.language'))} hint={say(said('ct.com.languageSub'))} error={error('language')}>
          <LanguageSelect value={draft.language} onChange={(value) => set('language', value)} />
        </Field>
        <Field label={say(said('ct.com.incoterm'))} hint={say(said('ct.com.incotermSub'))} error={error('incoterm')}>
          <Select value={draft.incoterm} onChange={(event) => set('incoterm', event.target.value)}>
            <option value="">{say(said('terms.none'))}</option>
            {INCOTERMS_2020.map((rule) => (
              <option key={rule} value={rule}>
                {say(said(`incoterm.${rule}`))}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset className="fw-ctr-fs">
        <legend className="fw-ctr-legend">{say(said('termsField.invoicing'))}</legend>
        {INVOICE_TIMINGS.map((timing) => (
          <RadioCard key={timing} name="ct-invoicing" value={timing} checked={draft.invoiceTiming === timing} selected={draft.invoiceTiming === timing} onChange={() => set('invoiceTiming', timing)} title={say(said(`invoicing.${timing}`))} description={say(said(`ct.win.terms.timing.${timing}`))} />
        ))}
      </fieldset>
      {own.discountGroup ? <WhoLine say={say} words={said('ct.win.terms.group', { params: { group: `${own.discountGroup.code} · ${own.discountGroup.name}` } })} info /> : null}
      {can.listsManage ? null : <WhoLine say={say} words={said('ct.win.listByColleague')} />}
      <WhoLine say={say} words={said('ct.win.terms.oneCommand')} info />
      {window.problem ? <Banner tone="danger" title={say(said(window.problem))} /> : null}
    </fieldset>
  )
}

/** One quiet line in a window: who gives a field the reader may not (a lock), or what the save does (an ⓘ). */
export function WhoLine({ say, words, info }: { say: Say; words: Said; info?: boolean }) {
  return (
    <p className="fw-ctr-who-line">
      {info ? <Info size={13} aria-hidden /> : <Lock size={13} aria-hidden />}
      <span>{say(words)}</span>
    </p>
  )
}
