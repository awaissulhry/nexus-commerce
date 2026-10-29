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

/**
 * Documents (design `order.docs.acceptance` + `order.docs.files`): the accepted quote version and its acceptance
 * evidence (who signed, when, whether the signed PDF matches the one sent, the terms version), carried from the quote,
 * with a way to the quote's own documents; the order's files are in Activity › Files (the record panels). The order
 * confirmation PDF is W2b.
 */
export function DocumentsTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const quote = order.chain.quote
  const version = quote && model.versions?.value ? (model.versions.value.versions.find((entry) => entry.id === quote.versionId) ?? null) : null
  const acceptance = version?.acceptance ?? null

  return (
    <div className="fw-so-cards">
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
          <EmptyState title={t('docs.noQuote.title')} description={t('docs.noQuote.body')} />
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
      <Card padded>
        <h2 className="fw-so-h2">{t('docs.filesTitle')}</h2>
        <p className="fw-so-hint">{t('docs.filesBody')}</p>
        <div>
          <Button size="sm" asChild>
            <Link href={`${model.prefix}/sales/orders/${order.id}?tab=activity`}>{t('docs.openFiles')}</Link>
          </Button>
        </div>
      </Card>
    </div>
  )
}
