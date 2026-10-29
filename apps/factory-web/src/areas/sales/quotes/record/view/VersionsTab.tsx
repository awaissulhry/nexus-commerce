'use client'

import { Download } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { QuoteDetail } from '../../api'
import { money, STATUS_TONE } from '../../model'
import type { QuoteRecordActions, QuoteRecordViewModel } from '../record-model'

/**
 * Versions (design `quote.versions.list`): every version the customer saw or could see — its state, who made and sent it
 * and when, its totals (price grain), what changed, the decision, its PDF. "Make version N" from a sent quote copies the
 * lines into a new draft; the sent one stays valid until the new one is sent.
 */
export function VersionsTab({ quote, model, actions }: { quote: QuoteDetail; model: QuoteRecordViewModel; actions?: QuoteRecordActions }) {
  const t = useT('sales')
  const locale = useLocale()
  const { versions } = model
  const who = (id: string | null) => (id === null ? null : id === model.me ? t('common.you') : (versions.people[id] ?? t('common.colleague')))
  if (versions.problem) {
    return <Banner tone="danger" title={t(versions.problem)} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('common.retry')}</Button>} />
  }
  if (!versions.items) {
    return (
      <p className="fw-q-hint" role="status">
        <Spinner size={14} /> {t('versions.loading')}
      </p>
    )
  }
  if (versions.items.length === 0) {
    return (
      <Card padded>
        <EmptyState title={t('versions.empty')} />
      </Card>
    )
  }
  const columns = [t('versions.col.version'), t('versions.col.status'), t('versions.col.made'), t('versions.col.sent'), ...(model.grains.price ? [t('versions.col.total')] : []), t('versions.col.changed'), t('versions.col.decision'), t('versions.col.pdf')]
  const rows = versions.items.map((version) => ({
    id: version.id,
    cells: [
      <strong key="v">{t('record.versionChip', { revision: version.revision })}</strong>,
      <Pill key="s" tone={STATUS_TONE[version.status]}>
        {t(`status.${version.status}`)}
      </Pill>,
      t('versions.byAt', { who: who(version.createdById) ?? '—', at: formatDateTime(version.createdAt, { locale }) }),
      version.sentAt ? t('versions.byAt', { who: who(version.sentById) ?? '—', at: formatDateTime(version.sentAt, { locale }) }) : '—',
      ...(model.grains.price ? [`${money(version.netAmount, version.currency, locale)} / ${money(version.grossAmount, version.currency, locale)}`] : []),
      version.changeNote ?? '—',
      version.acceptance
        ? t('versions.acceptedBy', { name: version.acceptance.signerName, at: formatDateTime(version.acceptance.acceptedAt, { locale }) })
        : version.status === 'DECLINED'
          ? t('versions.declined', { note: version.decisionNote ?? '—' })
          : version.status === 'SUPERSEDED'
            ? t('versions.superseded')
            : version.validUntil && version.status === 'SENT'
              ? t('versions.openUntil', { date: formatDate(`${version.validUntil}T12:00:00Z`, { locale }) })
              : '—',
      version.document ? (
        <Button key="d" size="sm" variant="quiet" onClick={() => actions?.onDownload?.(version.document!.fileId)}>
          <Download size={14} aria-hidden /> {t('versions.download')}
        </Button>
      ) : (
        '—'
      ),
    ],
  }))
  return (
    <div className="fw-q-stack">
      <Card>
        <div className="fw-q-table">
          <SummaryTable label={t('versions.tableLabel')} columns={columns} rows={rows} density="roomy" stackOnPhone />
        </div>
      </Card>
      {quote.current.status === 'SENT' && (
        <Card padded>
          <p className="fw-q-hint">{t('versions.reviseNote', { revision: quote.currentRevision, next: quote.currentRevision + 1 })}</p>
          <div>
            <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onDialog?.('revise')}>
              {t('action.revise', { next: quote.currentRevision + 1 })}
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}
