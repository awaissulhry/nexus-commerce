'use client'

import Link from 'next/link'
import { FileCheck2 } from 'lucide-react'
import { Card, EmptyState, KeyValue } from '@nexus/ui/components'
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

  return (
    <div className="fw-so-cards">
      {/* B-W2b-323: the order confirmation (its PDF, sent to, when; Make, Send…, Open in new tab), full width. */}
      {model.depth?.confirmation && (
        <div className="fw-sod-span">
          <ConfirmationCard order={order} model={model.depth} actions={actions?.depth} prefix={model.prefix} />
        </div>
      )}
      <Card padded>
        <div className="fw-so-card-head">
          <h2 className="fw-so-h2">
            <FileCheck2 size={16} aria-hidden /> {t('docs.acceptedTitle')}
          </h2>
          {quote && model.can.viewQuotes && (
            <Button size="sm" asChild>
              <Link href={`${model.prefix}/sales/quotes/${quote.id}?tab=documents`}>{t('docs.openQuote', { number: quote.number })}</Link>
            </Button>
          )}
        </div>
        {!quote ? (
          // B-TH-228: an order made straight from a request says so (never "Typed by the office").
          <EmptyState title={model.madeFrom ? t('docs.fromRequest.title', { number: model.madeFrom.number }) : t('docs.noQuote.title')} description={t('docs.noQuote.body')} />
        ) : !model.versions ? (
          <p className="fw-so-hint">{t('docs.noQuoteRight', { number: quote.number, revision: quote.revision })}</p>
        ) : model.versions.value === null ? (
          <PartState problem={model.versions.problem} label={t('docs.acceptedTitle')} onRetry={() => actions?.onRetryPart?.('versions')} />
        ) : !acceptance ? (
          <p className="fw-so-hint">{t('docs.noEvidence', { number: quote.number, revision: quote.revision })}</p>
        ) : (
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('docs.version'), value: version?.documentNumber ?? t('docs.versionValue', { number: quote.number, revision: quote.revision }) },
              { label: t('docs.signer'), value: acceptance.signerName },
              { label: t('docs.acceptedAt'), value: formatDateTime(acceptance.acceptedAt, { locale }) },
              { label: t('docs.channel'), value: t(`docs.channelValue.${acceptance.channel}`) },
              { label: t('docs.document'), value: acceptance.documentMatches ? <Tag tone="success">{t('docs.matches')}</Tag> : <Tag tone="danger">{t('docs.differs')}</Tag>, hint: <span className="fw-so-code">{acceptance.documentSha256}</span> },
              { label: t('docs.terms'), value: acceptance.termsVersion ?? '—' },
            ]}
          />
        )}
      </Card>
    </div>
  )
}
