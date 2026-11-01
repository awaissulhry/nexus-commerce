'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money, percent } from '../../../quotes/model'
import { INCOTERMS_2020, INVOICE_TIMINGS, type CommercialTerms, type InvoiceTiming, type PaymentTermsRow } from '../api'
import { chainText, listChoices, termsChoices, termsDraftOf, termsPatch, termsProblems, type TermsAbilities, type TermsDraft } from '../model'
import type { PriceListRow } from '../../../pricelists/api'
import '../terms.css'

export interface CommercialTermsModel {
  /** `/w/<company>` */
  prefix: string
  can: TermsAbilities
  /** null while read; `problem` when it could not be. */
  terms: CommercialTerms | null
  problem: string | null
  /** Why the card is text only (a message key), or null when it can be edited. */
  held: string | null
  /** The form while editing (explicit save with the EditModeBar); null: read mode. */
  draft: TermsDraft | null
  /** The choices (read when editing starts); null while read. */
  library: PaymentTermsRow[] | null
  lists: PriceListRow[] | null
  choicesProblem: string | null
  busy: boolean
  /** A save the API refused, in words. */
  saveProblem: string | null
  saved: boolean
}

export interface CommercialTermsActions {
  onRetry?: () => void
  onEdit?: () => void
  onDraft?: (draft: TermsDraft) => void
  onDiscard?: () => void
  onSave?: () => void
}

/**
 * Commercial terms (design customer.tax.terms on the customer's Tax & terms tab; SAL-012 "defaults copied to new quotes
 * and orders"): currency, payment terms from the library (FIN-075, with what they mean in words and the deposit they
 * ask), the price list (SAL-165) and the lists it falls back to, the discount group it gives (read only: a customer joins
 * a group by getting the group's list), Incoterms 2020, the preferred carrier, the default deposit, the minimum order
 * value (price grain), the document language and how its goods are invoiced (TD01 per shipment / TD24 monthly). Read as
 * text; Edit opens the same fields with the EditModeBar (⌘S, Discard, a held Save with its reason). "Customer PO number
 * required" is W2b. It fetches nothing.
 */
export function CommercialTermsCard({ model, actions }: { model: CommercialTermsModel; actions?: CommercialTermsActions }) {
  return (
    <WithMessages namespaces={['customer-terms']}>
      <TermsCard model={model} actions={actions} />
    </WithMessages>
  )
}

function TermsCard({ model, actions }: { model: CommercialTermsModel; actions?: CommercialTermsActions }) {
  const t = useT('customer-terms')
  const locale = useLocale()
  const terms = model.terms
  const head = (action?: ReactNode) => (
    <div className="fw-ct-head">
      <div className="fw-ct-head-text">
        <h2 className="fw-ct-h2">{t('terms.title')}</h2>
        <p className="fw-ct-hint">{t('terms.intro')}</p>
      </div>
      {action}
    </div>
  )

  if (model.problem && !terms) {
    return (
      <Card padded>
        {head()}
        <Banner
          tone="danger"
          title={t('terms.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.problem)}
        </Banner>
      </Card>
    )
  }
  if (!terms) {
    return (
      <Card padded aria-busy="true">
        {head()}
        <div className="fw-ct-stack">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} height={20} />
          ))}
        </div>
      </Card>
    )
  }

  const draft = model.draft
  if (!draft) {
    const paymentTerms = terms.paymentTerms
    return (
      <Card padded>
        {head(
          model.held ? (
            <span className="fw-ct-hint">{t(model.held === 'terms.held.noManage' ? 'terms.viewOnly' : model.held)}</span>
          ) : (
            <Button size="sm" onClick={() => actions?.onEdit?.()}>
              {t('terms.edit')}
            </Button>
          ),
        )}
        {model.saved && <Banner tone="success" title={t('terms.saved')} />}
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('termsField.currency'), value: terms.currency },
            {
              label: t('termsField.paymentTerms'),
              value: paymentTerms ? (
                <span className="fw-ct-cell">
                  <span>
                    {paymentTerms.code} · {paymentTerms.name} {paymentTerms.status !== 'ACTIVE' && <Tag tone="warning">{t('terms.archivedTerms')}</Tag>}
                  </span>
                  <span className="fw-ct-hint">{locale === 'en' ? paymentTerms.summary.en : paymentTerms.summary.it}</span>
                </span>
              ) : terms.paymentTermsText ? (
                <span className="fw-ct-cell">
                  <span>{terms.paymentTermsText}</span>
                  <span className="fw-ct-hint">{t('terms.typedOnly')}</span>
                </span>
              ) : (
                t('terms.none')
              ),
            },
            {
              label: t('termsField.priceList'),
              value: terms.priceList ? (
                <span className="fw-ct-cell">
                  <Link href={`${model.prefix}/sales/price-lists/${encodeURIComponent(terms.priceList.id)}`}>
                    {terms.priceList.code} · {terms.priceList.name}
                  </Link>
                  {terms.priceChain.length > 1 && <span className="fw-ct-hint">{t('terms.chain', { chain: chainText(terms) })}</span>}
                </span>
              ) : (
                t('terms.noList')
              ),
            },
            { label: t('termsField.discountGroup'), value: terms.discountGroup ? `${terms.discountGroup.code} · ${terms.discountGroup.name}` : t('terms.noGroup') },
            { label: t('termsField.incoterm'), value: terms.incoterm ? t(`incoterm.${terms.incoterm}`) : t('terms.none') },
            { label: t('termsField.carrier'), value: terms.preferredCarrierCode ?? t('terms.none') },
            { label: t('termsField.deposit'), value: terms.defaultDepositPct ? percent(terms.defaultDepositPct, locale) : paymentTerms?.deposit ? t('terms.depositFromTerms', { pct: percent(paymentTerms.deposit.sharePct, locale) }) : t('terms.depositSettings') },
            ...(model.can.price ? [{ label: t('termsField.minimum'), value: terms.minimumOrderAmount === null || terms.minimumOrderAmount === undefined ? t('terms.none') : money(terms.minimumOrderAmount, terms.currency, locale) }] : []),
            { label: t('termsField.language'), value: t(`language.${terms.language === 'en' ? 'en' : terms.language === 'it' ? 'it' : 'other'}`, { code: terms.language }) },
            { label: t('termsField.invoicing'), value: t(`invoicing.${terms.invoiceTiming}`) },
          ]}
        />
        {!model.can.price && <p className="fw-ct-hint">{t('terms.noPrice')}</p>}
      </Card>
    )
  }

  const before = termsDraftOf(terms)
  const patch = termsPatch(before, draft, model.can)
  const count = Object.keys(patch).length
  const problems = termsProblems(draft)
  const problemCount = Object.keys(problems).length
  const set = <K extends keyof TermsDraft>(key: K, value: TermsDraft[K]) => actions?.onDraft?.({ ...draft, [key]: value })
  const error = (field: keyof TermsDraft) => (problems[field] ? t(problems[field]!) : undefined)
  const library = termsChoices(model.library, terms)
  const lists = listChoices(model.lists, terms, draft.currency)
  const chosenTerms = model.library?.find((row) => row.id === draft.paymentTermsId) ?? null
  const loadingChoices = model.library === null && model.lists === null && !model.choicesProblem
  return (
    <Card padded>
      {head()}
      {model.choicesProblem && <Banner tone="warning" title={t(model.choicesProblem)} />}
      <div className="fw-ct-fields">
        <Field label={t('termsField.currency')} hint={t('terms.currencyHint')} error={error('currency')}>
          <Input value={draft.currency} maxLength={3} onChange={(event) => set('currency', event.target.value.toUpperCase())} />
        </Field>
        <Field label={t('termsField.paymentTerms')} hint={chosenTerms ? (locale === 'en' ? chosenTerms.summary.en : chosenTerms.summary.it) : model.can.terms ? t('terms.paymentHint') : t('terms.held.noTerms')}>
          <Select value={draft.paymentTermsId} disabled={!model.can.terms || loadingChoices} onChange={(event) => set('paymentTermsId', event.target.value)}>
            <option value="">{terms.paymentTermsText ? t('terms.useTyped', { text: terms.paymentTermsText }) : t('terms.none')}</option>
            {library.map((row) => (
              <option key={row.id} value={row.id}>
                {row.code} · {row.name}
                {row.archived ? ` (${t('terms.archivedTerms')})` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('termsField.priceList')} hint={!model.can.listsManage ? t('terms.held.noListsManage') : t('terms.listHint', { currency: draft.currency })}>
          <Select value={draft.priceListId} disabled={!model.can.listsManage || !model.can.lists || loadingChoices} onChange={(event) => set('priceListId', event.target.value)}>
            <option value="">{t('terms.baseList')}</option>
            {lists.map((row) => (
              <option key={row.id} value={row.id}>
                {row.code} · {row.name} ({t(`kind.${row.kind}`)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('termsField.discountGroup')} hint={t('terms.groupHint')}>
          <Input value={terms.discountGroup ? `${terms.discountGroup.code} · ${terms.discountGroup.name}` : t('terms.noGroup')} readOnly />
        </Field>
        <Field label={t('termsField.incoterm')} error={error('incoterm')}>
          <Select value={draft.incoterm} onChange={(event) => set('incoterm', event.target.value)}>
            <option value="">{t('terms.none')}</option>
            {INCOTERMS_2020.map((rule) => (
              <option key={rule} value={rule}>
                {t(`incoterm.${rule}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('termsField.carrier')} hint={t('terms.carrierHint')} error={error('preferredCarrierCode')}>
          <Input value={draft.preferredCarrierCode} maxLength={50} onChange={(event) => set('preferredCarrierCode', event.target.value.toUpperCase())} />
        </Field>
        <Field label={t('termsField.deposit')} hint={t('terms.depositHint')} error={error('defaultDepositPct')}>
          <Input value={draft.defaultDepositPct} inputMode="decimal" onChange={(event) => set('defaultDepositPct', event.target.value)} />
        </Field>
        {model.can.price && (
          <Field label={t('termsField.minimum')} hint={t('terms.minimumHint', { currency: draft.currency })} error={error('minimumOrder')}>
            <Input value={draft.minimumOrder} inputMode="decimal" onChange={(event) => set('minimumOrder', event.target.value)} />
          </Field>
        )}
        <Field label={t('termsField.language')} hint={t('terms.languageHint')} error={error('language')}>
          <Select value={draft.language} onChange={(event) => set('language', event.target.value)}>
            <option value="it">{t('language.it')}</option>
            <option value="en">{t('language.en')}</option>
            {draft.language !== 'it' && draft.language !== 'en' && <option value={draft.language}>{t('language.other', { code: draft.language })}</option>}
          </Select>
        </Field>
        <Field label={t('termsField.invoicing')} hint={t('terms.invoicingHint')}>
          <Select value={draft.invoiceTiming} onChange={(event) => set('invoiceTiming', event.target.value as InvoiceTiming)}>
            {INVOICE_TIMINGS.map((timing) => (
              <option key={timing} value={timing}>
                {t(`invoicing.${timing}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {model.saveProblem && <Banner tone="danger" title={t(model.saveProblem)} />}
      {count === 0 && (
        <div className="fw-ct-row">
          <Button size="sm" onClick={() => actions?.onDiscard?.()}>
            {t('terms.close')}
          </Button>
        </div>
      )}
      {count > 0 && (
        <EditModeBar
          count={count}
          message={t('terms.unsaved', { count })}
          applyLabel={t('terms.save')}
          busy={model.busy}
          applyHeldReason={problemCount > 0 ? t('terms.fixFirst', { count: problemCount }) : null}
          onDiscard={() => actions?.onDiscard?.()}
          onApply={() => actions?.onSave?.()}
          saveShortcut
        />
      )}
    </Card>
  )
}
