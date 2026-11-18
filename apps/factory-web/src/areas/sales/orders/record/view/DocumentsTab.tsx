'use client'

import Link from 'next/link'
import { FileCheck2 } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Order } from '../../api'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { PartState } from './OrderRecordView'
// ---- B-W2b-323 (orders in depth on screen) ----
import { ConfirmationCard } from '../../confirmation/view/ConfirmationCard'

/**
 * The confirmation half of "Confirmation & changes" (B-TH-214; design `order.docs.acceptance`; tree O-SAL-ORD-REC.body-F09): the
 * order confirmation (B-W2b-323) and the accepted quote version with its acceptance evidence (who signed, when, whether the signed
 * PDF matches the one sent, the terms version), carried from the quote, with a way to the quote's own documents. The order's files
 * are the docked thread's Files view (one place per thing); the brand tech pack in force is on Production & dates.
 */
export function DocumentsTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const quote = order.chain.quote
  const version = quote && model.versions?.value ? (model.versions.value.versions.find((entry) => entry.id === quote.versionId) ?? null) : null
  const acceptance = version?.acceptance ?? null

  // F-SA-236: "Confirmation & the customer's yes" — the confirmation as a row (it opens in the thread's viewer), then how the customer
  // said yes as one row (the quote version, who signed, when, how, whether the signed document matches the one sent, the terms).
  return (
    <div className="fw-so-stack">
      <h2 className="fw-so-h2" id="fw-so-confirmation-title">
        {t('changes.confirmation.title')}
      </h2>
      {/* B-W2b-323: the order confirmation (Open in the viewer, Make, Send…, Open in new tab). */}
      {model.depth?.confirmation && <ConfirmationCard order={order} model={model.depth} actions={actions?.depth} prefix={model.prefix} />}
      <Card padded>
        <div className="fw-so-card-head">
          <h3 className="fw-so-h3">
            <FileCheck2 size={16} aria-hidden /> {t('changes.confirmation.yes')}
          </h3>
          {quote && model.can.viewQuotes && (
            <Button size="sm" variant="quiet" asChild>
              <Link href={`${model.prefix}/sales/quotes/${quote.id}?tab=approval`}>{/* TH-6 part B: the quote's Documents live in Approval & sending (B-TH-257) */}{t('docs.openQuote', { number: quote.number })}</Link>
            </Button>
          )}
        </div>
        {!quote ? (
          // B-TH-228: an order made straight from a request says so (never "Typed by the office").
          <p className="fw-so-hint">{model.madeFrom ? t('docs.fromRequest.title', { number: model.madeFrom.number }) : t('docs.noQuote.title')}</p>
        ) : !model.versions ? (
          <p className="fw-so-hint">{t('docs.noQuoteRight', { number: quote.number, revision: quote.revision })}</p>
        ) : model.versions.value === null ? (
          <PartState problem={model.versions.problem} label={t('docs.acceptedTitle')} onRetry={() => actions?.onRetryPart?.('versions')} />
        ) : !acceptance ? (
          <p className="fw-so-hint">{t('docs.noEvidence', { number: quote.number, revision: quote.revision })}</p>
        ) : (
          <p className="fw-so-inline">
            <span>
              {[
                version?.documentNumber ?? t('docs.versionValue', { number: quote.number, revision: quote.revision }),
                acceptance.signerName,
                formatDateTime(acceptance.acceptedAt, { locale }),
                t(`docs.channelValue.${acceptance.channel}`),
                acceptance.termsVersion ? `${t('docs.terms')} ${acceptance.termsVersion}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {acceptance.documentMatches ? <Tag tone="success">{t('docs.matches')}</Tag> : <Tag tone="danger">{t('docs.differs')}</Tag>}
            <span className="fw-so-code" title={t('docs.document')}>
              {acceptance.documentSha256.slice(0, 12)}…
            </span>
          </p>
        )}
      </Card>
    </div>
  )
}
