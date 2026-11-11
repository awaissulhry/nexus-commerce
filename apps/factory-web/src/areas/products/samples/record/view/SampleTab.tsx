'use client'

import Link from 'next/link'
import { Factory } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import type { RoundView } from '../../api'
import { refusalPhrase, type Phrase } from '../../model'
import { DayText, useWords } from '../../parts'
import type { SampleRecordActions, SampleRecordModel } from '../view-model'

/** Why "Make sample work order" is held (null: it may open). */
export function makeHeld(round: RoundView, model: Pick<SampleRecordModel, 'can' | 'live'>): Phrase | null {
  if (!model.can.manage) return { key: 'held.noManage' }
  if (!round.actions.makeWorkOrder.allowed) return refusalPhrase(round.actions.makeWorkOrder.refusal?.code)
  if (!model.can.workOrders) return { key: 'held.needs', params: { right: 'right.workorders.manage' } }
  if (model.live === 'offline') return { key: 'held.offline' }
  return null
}

/**
 * Sample (design rec tab sample.sample, MES-018 "What was made"): the round's sample work orders — number (its page when
 * the reader holds workorders.view), plant, pieces, its state and when it was released, started and completed; never a
 * worker. "Make sample work order" opens the dialog on the API's options. Materials and minutes used and where the sample
 * is are Later in the design.
 */
export function SampleTab({ model, round, actions }: { model: SampleRecordModel; round: RoundView; actions?: SampleRecordActions }) {
  const { t, say, day } = useWords()
  const held = makeHeld(round, model)
  const rows = round.workOrdersList.map((order) => ({
    id: order.id,
    cells: [
      <span key="n" className="fw-smp-row">
        {model.can.workOrdersView ? (
          <Link className="fw-smp-link fw-smp-code" href={`${model.prefix}/production/work-orders/${encodeURIComponent(order.id)}`}>
            {order.number}
          </Link>
        ) : (
          <span className="fw-smp-code">{order.number}</span>
        )}
        {/* B-W2b-284: made for no order line (an internal or uncharged round's): it ships, invoices and returns on no order. */}
        {order.withoutOrderLine && <Tag tone="neutral">{t('sample.noOrderLine')}</Tag>}
      </span>,
      order.site.code,
      t('sample.pieces', { count: order.pieces }),
      t(`wo.status.${order.status}`),
      <DayText key="d" value={order.dueDate} />,
      order.completedAt ? t('sample.completedOn', { date: day(order.completedAt) }) : order.startedAt ? t('sample.startedOn', { date: day(order.startedAt) }) : order.releasedAt ? t('sample.releasedOn', { date: day(order.releasedAt) }) : t('sample.notReleased'),
    ],
  }))
  return (
    <div className="fw-smp-stack">
      <Card padded>
        <div className="fw-smp-cardhead">
          <h2 className="fw-smp-h2">{t('sample.made')}</h2>
          {round.stage !== 'CANCELLED' && round.stage !== 'DECIDED' && (
            <Button size="sm" variant={round.workOrdersList.length === 0 ? 'primary' : 'secondary'} heldReason={say(held)} onClick={() => actions?.onMakeWorkOrder?.()}>
              <Factory size={14} aria-hidden /> {t('sample.make')}
            </Button>
          )}
        </div>
        {rows.length === 0 && round.workOrdersHeld === 0 ? (
          <EmptyState title={t('sample.none')} description={t('sample.noneBody')} />
        ) : (
          <SummaryTable label={t('sample.made')} columns={[t('sample.col.number'), t('sample.col.site'), t('sample.col.pieces'), t('sample.col.status'), t('sample.col.due'), t('sample.col.progress')]} rows={rows} stackOnPhone density="roomy" />
        )}
        {round.workOrdersHeld > 0 && <p className="fw-smp-hint">{t('sample.held', { count: round.workOrdersHeld })}</p>}
      </Card>
      <Banner tone="info" title={t('sample.laterTitle')}>
        {t('sample.laterBody')}
      </Banner>
    </div>
  )
}
