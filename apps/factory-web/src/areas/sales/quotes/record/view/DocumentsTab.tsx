'use client'

import { ExternalLink, Link2 } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, SegmentedControl, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import type { QuoteDetail } from '../../api'
import { linkSummary, money, percent } from '../../model'
import type { QuoteRecordActions, QuoteRecordViewModel } from '../record-model'

const LINK_TONE = { LIVE: 'success', REVOKED: 'neutral', USED_UP: 'info', EXPIRED: 'warning' } as const
const DEPOSIT_TONE = { OPEN: 'warning', PAID: 'success', WAIVED: 'neutral', CANCELLED: 'neutral' } as const

/**
 * Documents (design `quote.docs.*`): the quote's PDF — a draft's live preview in either language, made by the server
 * (also in a new tab), or the frozen PDF of the sent version with its fingerprint —, the accept link and what it did,
 * the acceptance's evidence (append-only) and the deposit request made at acceptance. The record's files are in
 * Activity › Files.
 */
export function DocumentsTab({ quote, model, actions }: { quote: QuoteDetail; model: QuoteRecordViewModel; actions?: QuoteRecordActions }) {
  const t = useT('sales')
  const shell = useT('shell')
  const locale = useLocale()
  const versions = model.versions.items ?? []
  const sent = versions.find((version) => version.sentAt !== null) ?? null
  const link = linkSummary(versions)
  const accepted = versions.find((version) => version.acceptance) ?? null
  const deposit = versions.find((version) => version.deposit)?.deposit ?? null
  const doc = model.document
  const title = t('docs.pdfTitle', { number: quote.number, revision: quote.currentRevision })

  return (
    <div className="fw-q-stack">
      <Card padded>
        <div className="fw-q-docs-head">
          <h2 className="fw-q-h2">{t(doc.frozen ? 'docs.pdf.frozen' : 'docs.pdf.preview')}</h2>
          <span className="fw-q-actions">
            {!doc.frozen && (
              <SegmentedControl
                ariaLabel={t('docs.language')}
                size="sm"
                value={model.previewLanguage}
                onChange={(value) => actions?.onPreviewLanguage?.(value === 'en' ? 'en' : 'it')}
                options={[
                  { value: 'it', label: t('languageName.it') },
                  { value: 'en', label: t('languageName.en') },
                ]}
              />
            )}
            {doc.openHref && (
              <Button size="sm" variant="quiet" asChild>
                <a href={doc.openHref} target="_blank" rel="noopener">
                  <ExternalLink size={14} aria-hidden /> {t('docs.newTab')}
                </a>
              </Button>
            )}
          </span>
        </div>
        {doc.frozen && sent ? (
          <p className="fw-q-hint">
            {t('docs.sentLine', { at: formatDateTime(sent.sentAt!, { locale }), sha: (sent.documentSha256 ?? '').slice(0, 12) })}
          </p>
        ) : (
          <p className="fw-q-hint">{t('docs.previewNote')}</p>
        )}
        {doc.problem ? (
          <Banner tone="warning" title={t(doc.problem)} />
        ) : doc.src ? (
          <PdfViewer src={doc.src} title={title} fileName={`${quote.number}-v${quote.currentRevision}.pdf`} labels={pdfViewerLabels(shell)} height="min(70vh, 760px)" />
        ) : (
          <p className="fw-q-hint" role="status">
            <Spinner size={14} /> {t('docs.loading')}
          </p>
        )}
      </Card>

      <div className="fw-q-cards">
        <Card padded>
          <h2 className="fw-q-h2">
            <Link2 size={16} aria-hidden /> {t('docs.link.title')}
          </h2>
          {!link ? (
            <p className="fw-q-hint">{t('docs.link.none')}</p>
          ) : (
            <>
              <KeyValue
                dense
                labelCase="sentence"
                items={[
                  { label: t('docs.link.state'), value: <Pill tone={LINK_TONE[link.state]}>{t(`link.state.${link.state}`)}</Pill> },
                  { label: t('docs.link.version'), value: t('record.versionChip', { revision: link.revision }) },
                  { label: t('docs.link.to'), value: link.email ?? '—' },
                  { label: t('docs.link.until'), value: formatDateTime(link.expiresAt, { locale }) },
                ]}
              />
              <p className="fw-q-hint">{t('docs.link.never')}</p>
              {quote.current.status === 'SENT' && (
                <div>
                  <Button size="sm" heldReason={model.can.send ? null : t('held.noSend')} onClick={() => actions?.onDialog?.('newLink')}>
                    {t('action.newLink')}
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>

        <Card padded>
          <h2 className="fw-q-h2">{t('docs.evidence.title')}</h2>
          {!accepted?.acceptance ? (
            <p className="fw-q-hint">{t('docs.evidence.none')}</p>
          ) : (
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('docs.evidence.signer'), value: accepted.acceptance.signerName },
                { label: t('docs.evidence.at'), value: formatDateTime(accepted.acceptance.acceptedAt, { locale }) },
                { label: t('docs.evidence.channel'), value: t(`docs.evidence.channelOf.${accepted.acceptance.channel}`) },
                { label: t('docs.evidence.email'), value: t(`docs.evidence.emailCheck.${accepted.acceptance.emailCheck ?? 'NOT_ASKED'}`) },
                {
                  label: t('docs.evidence.document'),
                  value: (
                    <span className="fw-q-inline">
                      <code className="fw-q-code">{accepted.acceptance.documentSha256.slice(0, 16)}…</code>
                      <Tag tone={accepted.acceptance.documentMatches ? 'success' : 'danger'}>{t(accepted.acceptance.documentMatches ? 'docs.evidence.matches' : 'docs.evidence.differs')}</Tag>
                    </span>
                  ),
                },
                { label: t('docs.evidence.terms'), value: accepted.acceptance.termsVersion ?? '—' },
                ...(accepted.acceptance.noWithdrawalAccepted ? [{ label: t('docs.evidence.noWithdrawal'), value: t('docs.evidence.noWithdrawalYes') }] : []),
              ]}
            />
          )}
        </Card>

        <Card padded>
          <h2 className="fw-q-h2">{t('docs.deposit.title')}</h2>
          {!deposit ? (
            <p className="fw-q-hint">{t(quote.current.depositAmount ? 'docs.deposit.atAcceptance' : 'docs.deposit.none')}</p>
          ) : (
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('docs.deposit.status'), value: <Pill tone={DEPOSIT_TONE[deposit.status]}>{t(`docs.deposit.state.${deposit.status}`)}</Pill> },
                { label: t('docs.deposit.amount'), value: model.grains.price ? money(deposit.amount, deposit.currency, locale) : t('summary.noPrice') },
                { label: t('docs.deposit.kind'), value: `${t(`depositKind.${deposit.kind}`)}${deposit.depositPct ? ` · ${percent(deposit.depositPct, locale)}` : ''}` },
                { label: t('docs.deposit.due'), value: formatDate(`${deposit.dueDate}T12:00:00Z`, { locale }) },
                { label: t('docs.deposit.fiscal'), value: t(`docs.deposit.fiscalDoc.${deposit.fiscalDocument}`) },
              ]}
            />
          )}
        </Card>
      </div>
    </div>
  )
}
