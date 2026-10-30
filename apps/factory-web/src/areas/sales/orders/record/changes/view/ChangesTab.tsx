'use client'

import { GitCompare } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import type { Amendment, Order } from '../../../api'
import { moneyChange } from '../../../daily-model'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartState } from '../../view/OrderRecordView'

/**
 * SCR-107 — Order changes (design `order.changes.list`, SAL-217): each change to the confirmed order, numbered, with who
 * made it and when, the reason, how its lines moved (lines and pieces before → after), the money change (price grain:
 * absent without it) and whether the customer must accept again; "Before → after" opens the frozen snapshot in a dialog
 * (VersionCompare, composed). The re-acceptance link (SAL-190) and priced change requests (SAL-219) are W2b: the tab says
 * honestly that the customer is told by the office meanwhile.
 */
export function ChangesTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const part = model.amendments
  if (!part || !part.value) return <PartState problem={part?.problem ?? null} label={t('changes.title')} onRetry={() => actions?.onRetryPart?.('amendments')} />
  const answer = part.value
  const list = [...answer.amendments].sort((a, b) => b.revision - a.revision)
  const waiting = answer.reapprovalNeededAt ?? order.reapprovalNeededAt
  const columns = [t('changes.col.revision'), t('changes.col.madeBy'), t('changes.col.reason'), t('changes.col.lines'), ...(model.can.price ? [t('changes.col.money')] : []), t('changes.col.reacceptance'), t('changes.col.open')]
  const rows = list.map((amendment) => ({ id: amendment.id, cells: cellsOf(amendment) }))

  function cellsOf(amendment: Amendment) {
    const counts = { ADDED: 0, REMOVED: 0, CHANGED: 0 }
    for (const line of amendment.diff.lines) counts[line.change] += 1
    const before = amendment.diff.lines.reduce((sum, line) => sum + line.piecesBefore, 0)
    const after = amendment.diff.lines.reduce((sum, line) => sum + line.piecesAfter, 0)
    const change = moneyChange(amendment.diff)
    const parts = (['CHANGED', 'ADDED', 'REMOVED'] as const).filter((kind) => counts[kind] > 0).map((kind) => t(`changes.count.${kind}`, { count: counts[kind] }))
    return [
      <strong key="r">{t('changes.revision', { revision: amendment.revision })}</strong>,
      <span key="b" className="fw-so-cell">
        <span>{amendment.createdBy ?? t('changes.someone')}</span>
        <span className="fw-so-cell-sub">{t('changes.when', { date: formatDate(amendment.createdAt, { locale }), time: formatTime(amendment.createdAt, { locale }) })}</span>
      </span>,
      <span key="w" className="fw-so-cell">
        {amendment.reason}
      </span>,
      <span key="l" className="fw-so-cell">
        <span>{parts.length > 0 ? parts.join(' · ') : t('changes.headerOnly')}</span>
        {amendment.diff.lines.length > 0 && <span className="fw-so-cell-sub">{t('changes.piecesMoved', { before, after })}</span>}
      </span>,
      ...(model.can.price
        ? [
            change && change.delta === 0 ? (
              <span key="m" className="fw-so-hint">
                {t('changes.priceSame')}
              </span>
            ) : change ? (
              <span key="m" className="fw-so-cell">
                <span>{`${change.delta >= 0 ? '+' : '−'}${money(Math.abs(change.delta), order.currency, locale)}`}</span>
                <span className="fw-so-cell-sub">{`${money(change.before, order.currency, locale)} → ${money(change.after, order.currency, locale)}`}</span>
              </span>
            ) : (
              '—'
            ),
          ]
        : []),
      <Pill key="a" tone={amendment.reacceptance === 'NEEDED' ? 'warning' : 'neutral'}>
        {t(`changes.reaccept.${amendment.reacceptance}`)}
      </Pill>,
      <Button key="o" size="sm" variant="secondary" aria-label={t('changes.openOf', { revision: amendment.revision })} onClick={() => actions?.onDialog?.({ kind: 'compare', amendmentId: amendment.id })}>
        <GitCompare size={14} aria-hidden /> {t('changes.open')}
      </Button>,
    ]
  }

  return (
    <div className="fw-so-stack">
      {waiting && <Banner tone="warning" title={t('changes.waiting', { date: formatDate(waiting, { locale }) })} />}
      <Card padded>
        <div className="fw-so-card-head">
          <h2 className="fw-so-h2">{t('changes.title')}</h2>
          <span className="fw-so-hint">{t('changes.subtitle')}</span>
        </div>
        {list.length === 0 ? (
          <EmptyState title={t('changes.empty.title')} description={t(order.status === 'CANCELLED' || order.status === 'CLOSED' ? 'changes.empty.final' : 'changes.empty.body')} />
        ) : (
          <SummaryTable label={t('changes.tableLabel')} columns={columns} rows={rows} density="roomy" stackOnPhone />
        )}
      </Card>
    </div>
  )
}
