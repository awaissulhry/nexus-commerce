'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { FileCheck2 } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { ConfirmationCard } from '../../../confirmation/view/ConfirmationCard'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { revisionToAskOf } from '../../revised-order-ask'
import { PartFailed, PartReading, Section } from '../../../../../../lib/record-sections/Kit' // F-OC-101 (L6): the Production kit, in place
import { AGREEMENT_TONE, agreementOf, SIGNED_TONE, signedCheckOf, type AgreementState } from '../agreement'
import './changes.css'

/**
 * F-OC-203 (order CHANGES tab, 10-design §6; 18-lead-settles L5, L9, L10) — section 4, Customer's agreement (#confirmation: the band's,
 * the list's and the document links land here): ONE tag and ONE sentence — how the customer said yes and whether our confirmation
 * prints the order as it is now — then two halves, side by side when the section has the room:
 *
 *   Their yes          the quote version they accepted, who, when, how, whether their e-mail was checked, the signed PDF's check in
 *                      true words (B-OC-015: "differs" never stands for "missing"), no right of withdrawal; or the portal order it was
 *                      placed as (B-OC-016); the latest revision's yes, and "Ask {customer}…" when it was never asked or expired (L5)
 *   Our confirmation   ConfirmationCard: Open · Send version N… · ⋯, hidden with one line of words without the price grain (L10), in
 *                      the order's language (L9)
 *
 * Money only with the price grain (the reads drop it); the customer's yes rows name no amount. Fetches nothing.
 */
export function AgreementSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const title = t('changesTab.agreement.title')
  const customer = order.party?.legalName ?? ''
  const changes = model.depth?.changes?.value ?? null
  const state = agreementOf({ status: order.status, changes, confirmation: model.depth?.confirmation?.value ?? null })
  const sentence = (s: AgreementState): string | null => {
    switch (s.kind) {
      case 'unknown':
        return null
      case 'saidNo':
        return s.at ? t('changesTab.agreement.answer.saidNo', { customer, revision: s.revision, date: formatDate(s.at, { locale }) }) : t('changesTab.agreement.answer.saidNoNoDate', { customer, revision: s.revision })
      case 'waiting':
        return t('changesTab.agreement.answer.waiting', { customer, revision: s.revision, date: formatDate(s.since, { locale }) })
      case 'notAsked':
        return t(s.expired ? 'changesTab.agreement.answer.expired' : 'changesTab.agreement.answer.notAsked', { customer, revision: s.revision })
      case 'sendNew':
        return t('changesTab.agreement.answer.sendNew', { version: s.version })
      case 'agreed':
        return t('changesTab.agreement.answer.agreed', { version: s.version, date: formatDate(s.at, { locale }) })
      case 'notSent':
        // fx8 (N1, L10): a reader without the price grain can neither make nor send it — said so, never told to.
        return t(model.can.price ? 'changesTab.agreement.answer.notSent' : 'changesTab.agreement.answer.notSentNoPrice')
      default:
        return t(`changesTab.agreement.answer.${s.kind}`)
    }
  }
  const said = sentence(state)
  const answer =
    state.kind === 'unknown' ? null : (
      <>
        <Tag tone={AGREEMENT_TONE[state.kind]}>{t(`changesTab.agreement.tag.${state.kind}`)}</Tag> {said}
        {state.kind === 'saidNo' || state.kind === 'waiting' ? (
          <>
            {' '}
            <a className="fw-pt-link" href="#waiting">
              {t('changesTab.agreement.toWaiting')}
            </a>
          </>
        ) : null}
      </>
    )
  const info = (
    <>
      <p>{t('changesTab.agreement.info')}</p>
    </>
  )
  return (
    <Section id="confirmation" title={title} answer={answer} info={info}>
      <div className="fw-oc-ag">
        <TheirYes order={order} model={model} actions={actions} />
        <ConfirmationCard order={order} model={model.depth} actions={actions?.depth} prefix={model.prefix} />
      </div>
    </Section>
  )
}

// ---- Their yes: how the customer said yes, and the latest revision's ---------------------------------------------------------------
function TheirYes({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const customer = order.party?.legalName ?? ''
  const quote = order.chain.quote
  const versions = model.versions ?? null
  const version = quote && versions?.value ? (versions.value.versions.find((entry) => entry.id === quote.versionId) ?? null) : null
  const acceptance = version?.acceptance ?? null
  const portal = order.chain.portalOrder ?? null
  const changes = model.depth?.changes?.value ?? null
  const state = agreementOf({ status: order.status, changes, confirmation: model.depth?.confirmation?.value ?? null })
  // L5: "Ask {customer}…" on the latest revision that waits and was never asked (or whose ask expired) — who may ask the customer.
  const toAsk = state.kind === 'notAsked' && model.can.manage && model.can.askCustomer ? revisionToAskOf(changes) : null
  let body: ReactNode
  if (!quote) {
    // An order without a quote: the portal order it was placed as (B-OC-016), a request it was made from, or typed by the office.
    body = <p className="fw-pt-quiet">{portal ? t(portal.sentBy ? 'changesTab.agreement.portalBy' : 'changesTab.agreement.portal', { number: portal.number ?? '', name: portal.sentBy ?? '', date: portal.sentAt ? formatDate(portal.sentAt, { locale }) : '' }) : model.madeFrom ? t('docs.fromRequest.title', { number: model.madeFrom.number }) : t('docs.noQuote.title')}</p>
  } else if (!versions) {
    body = <p className="fw-pt-quiet">{t('docs.noQuoteRight', { number: quote.number, revision: quote.revision })}</p>
  } else if (versions.value === null) {
    body = versions.problem ? <PartFailed part={t('docs.acceptedTitle')} problem={versions.problem} onRetry={() => actions?.onRetryPart?.('versions')} /> : <PartReading rows={2} />
  } else if (!acceptance) {
    body = <p className="fw-pt-quiet">{t('docs.noEvidence', { number: quote.number, revision: quote.revision })}</p>
  } else {
    const check = signedCheckOf(acceptance)
    body = (
      <div className="fw-oc-ag-txt">
        <strong>{t('changesTab.agreement.accepted', { quote: version?.documentNumber ?? t('docs.versionValue', { number: quote.number, revision: quote.revision }) })}</strong>
        <span className="fw-pt-sub">
          {[acceptance.signerName, formatDateTime(acceptance.acceptedAt, { locale }), t(`docs.channelValue.${acceptance.channel}`), acceptance.emailCheck === 'MATCHED' ? t('changesTab.agreement.emailChecked') : null, acceptance.termsVersion ? `${t('docs.terms')} ${acceptance.termsVersion}` : null].filter(Boolean).join(' · ')}
        </span>
        <span className="fw-pt-inline">
          <Tag tone={SIGNED_TONE[check]}>{t(`changesTab.agreement.signed.${check}`)}</Tag>
        </span>
        {acceptance.noWithdrawalAccepted && <span className="fw-pt-sub">{t('changesTab.agreement.noWithdrawal')}</span>}
        {/* fx6 (walk 12, L10): the signed PDF shows prices — said to a reader without them. */}
        {!model.can.price && <span className="fw-pt-sub">{t('changesTab.agreement.signedPriced')}</span>}
      </div>
    )
  }
  // The latest revision's yes, in words (no amount): asked and waiting, said no, never asked.
  const revisionLine =
    state.kind === 'waiting'
      ? t('changesTab.agreement.revision.waiting', { revision: state.revision, date: formatDate(state.since, { locale }) })
      : state.kind === 'saidNo'
        ? t('changesTab.agreement.revision.saidNo', { revision: state.revision })
        : state.kind === 'notAsked'
          ? t(state.expired ? 'changesTab.agreement.revision.expired' : 'changesTab.agreement.revision.notAsked', { revision: state.revision })
          : null
  return (
    <div className="fw-pt-blk fw-oc-ag-half">
      {/* F-OC-204: the heading holds words only; the quote's door sits beside it (never inside an h3). */}
      <div className="fw-oc-ag-row">
        <h3 className="fw-pt-h3">
          <FileCheck2 size={15} aria-hidden /> {t('changesTab.agreement.theirs')}
        </h3>
        {quote && model.can.viewQuotes && (
          <Button size="sm" variant="quiet" asChild>
            <Link href={`${model.prefix}/sales/quotes/${quote.id}?tab=approval`}>{/* TH-6 part B: the quote's Documents live in Approval & sending (B-TH-257) */}{t('changesTab.agreement.quote', { number: quote.number })}</Link>
          </Button>
        )}
      </div>
      {body}
      {revisionLine && (
        <div className="fw-oc-ag-row">
          <span className="fw-pt-sub">{revisionLine}</span>
          {toAsk && (
            <Button size="sm" variant="primary" heldReason={model.depth?.busy ? t('held.busy') : null} onClick={() => actions?.depth?.onDialog?.({ kind: 'askRevision', amendmentId: toAsk.amendmentId, revision: toAsk.revision })}>
              {t('changesTab.agreement.ask', { customer })}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
