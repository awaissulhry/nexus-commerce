'use client'

import Link from 'next/link'
import { EmptyState, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { formatDate, formatNumber } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { ClaimRow, ReceiptRow } from '../api'
import type { Read } from '../model'
import { DepthCard, ReadOr, useSay } from './parts'

export interface QualityTabModel {
  /** The supplier's receipts (null: the person has no inventory.stock.view). */
  readonly receipts: Read<readonly ReceiptRow[]> | null
  /** Its claims and returns (null: no purchasing.view). */
  readonly claims: Read<readonly ClaimRow[]> | null
  /** The company prefix (`/w/<code>`) the links open under. */
  readonly prefix: string
}

const OPEN_CLAIMS = new Set(['DRAFT', 'SENT', 'ACCEPTED'])
const CLAIM_TONE: Readonly<Record<string, 'info' | 'warning' | 'success' | 'danger' | 'neutral'>> = { DRAFT: 'neutral', SENT: 'warning', ACCEPTED: 'info', REJECTED: 'danger', CLOSED: 'success', CANCELLED: 'neutral' }

/**
 * Quality & rating (design rec:Supplier/quality › Receipts and claims): what came in from this supplier and what we
 * accepted (the lots released of those received, the discrepancies found at receipt), and the claims and returns that
 * followed, each a link to its record. Figures only, no money; the scorecard is Later. Each part needs its own right and
 * says so when the person has not got it.
 */
export function QualityTab({ model }: { model: QualityTabModel }) {
  const { t } = useSay()
  const receipts = model.receipts?.status === 'ready' ? model.receipts.value : null
  const claims = model.claims?.status === 'ready' ? model.claims.value : null
  const posted = receipts?.filter((row) => row.status === 'POSTED') ?? null
  const figure = (value: number | null, read: Read<unknown> | null) => (read === null ? t('quality.noRight') : value === null ? (read.status === 'loading' ? '…' : '—') : String(value))
  const metrics = [
    { label: t('quality.tile.receipts'), value: figure(posted ? posted.length : null, model.receipts), hint: t('quality.tile.recent') },
    { label: t('quality.tile.lots'), value: figure(posted ? posted.reduce((total, row) => total + row.lots, 0) : null, model.receipts), hint: posted ? t('quality.tile.released', { count: posted.reduce((total, row) => total + row.lotsReleased, 0) }) : undefined },
    { label: t('quality.tile.discrepancies'), value: figure(posted ? posted.reduce((total, row) => total + row.discrepancies.count, 0) : null, model.receipts), hint: posted ? t('quality.tile.open', { count: posted.reduce((total, row) => total + row.discrepancies.open, 0) }) : undefined },
    { label: t('quality.tile.claims'), value: figure(claims ? claims.filter((row) => OPEN_CLAIMS.has(row.status)).length : null, model.claims), hint: claims ? t('quality.tile.claimsAll', { count: claims.length }) : undefined },
  ]
  return (
    <div className="fw-spd-stack">
      <MetricStrip metrics={metrics} />
      <ReceiptsCard model={model} />
      <ClaimsCard model={model} />
      <p className="fw-spd-hint">{t('quality.scoreLater')}</p>
    </div>
  )
}

function ReceiptsCard({ model }: { model: QualityTabModel }) {
  const { t } = useSay()
  const locale = useLocale()
  const title = t('quality.receipts')
  if (model.receipts === null) {
    return (
      <DepthCard title={title}>
        <p className="fw-spd-hint">{t('held.receipts')}</p>
      </DepthCard>
    )
  }
  const read = model.receipts
  return (
    <DepthCard title={title} hint={t('quality.receiptsHint')}>
      <ReadOr status={read.status} problem={read.status === 'error' ? read.problem : undefined} title={title}>
        {read.status === 'ready' && read.value.length === 0 ? <EmptyState title={t('quality.noReceipts')} /> : null}
        {read.status === 'ready' && read.value.length > 0 ? (
          <SummaryTable
            label={title}
            columns={[t('quality.col.receipt'), t('quality.col.received'), t('quality.col.order'), t('quality.col.lots'), t('quality.col.discrepancies'), t('quality.col.status')]}
            align={[undefined, undefined, undefined, 'right', 'right', undefined]}
            stackOnPhone
            rows={read.value.map((row) => ({
              id: row.id,
              cells: [
                <Link key="r" href={`${model.prefix}/warehouse/receipts/${encodeURIComponent(row.id)}`}>
                  {row.number}
                </Link>,
                formatDate(row.receivedAt, { locale }),
                row.purchaseOrder ? (
                  <Link key="o" href={`${model.prefix}/purchasing/orders/${encodeURIComponent(row.purchaseOrder.id)}`}>
                    {row.purchaseOrder.number}
                  </Link>
                ) : (
                  '—'
                ),
                row.lots === 0 ? '—' : t('quality.lotsOf', { released: row.lotsReleased, count: row.lots }),
                row.discrepancies.count === 0 ? '0' : t('quality.discOf', { count: row.discrepancies.count, open: row.discrepancies.open }),
                t(`receipt.${row.status}`),
              ],
            }))}
          />
        ) : null}
      </ReadOr>
    </DepthCard>
  )
}

function ClaimsCard({ model }: { model: QualityTabModel }) {
  const { t } = useSay()
  const locale = useLocale()
  const title = t('quality.claims')
  if (model.claims === null) {
    return (
      <DepthCard title={title}>
        <p className="fw-spd-hint">{t('held.claims')}</p>
      </DepthCard>
    )
  }
  const read = model.claims
  return (
    <DepthCard title={title} hint={t('quality.claimsHint')}>
      <ReadOr status={read.status} problem={read.status === 'error' ? read.problem : undefined} title={title}>
        {read.status === 'ready' && read.value.length === 0 ? <EmptyState title={t('quality.noClaims')} /> : null}
        {read.status === 'ready' && read.value.length > 0 ? (
          <SummaryTable
            label={title}
            columns={[t('quality.col.claim'), t('quality.col.kind'), t('quality.col.materials'), t('quality.col.lotsClaimed'), t('quality.col.quantity'), t('quality.col.age'), t('quality.col.status')]}
            align={[undefined, undefined, undefined, undefined, 'right', 'right', undefined]}
            stackOnPhone
            rows={read.value.map((row) => ({
              id: row.id,
              cells: [
                <Link key="c" href={`${model.prefix}/purchasing/claims/${encodeURIComponent(row.id)}`}>
                  {row.number}
                </Link>,
                t(`claim.kind.${row.kind}`),
                row.materials.map((material) => material.code).join(', ') || '—',
                row.lots.map((lot) => lot.code).join(', ') || '—',
                row.quantity ? `${formatNumber(Number(row.quantity.quantity), locale, { maximumFractionDigits: 3 })} ${t(`uom.${row.quantity.uom}`)}` : '—',
                t('quality.days', { count: row.ageDays }),
                <Pill key="s" tone={CLAIM_TONE[row.status] ?? 'neutral'}>
                  {t(`claim.status.${row.status}`)}
                </Pill>,
              ],
            }))}
          />
        ) : null}
      </ReadOr>
    </DepthCard>
  )
}
