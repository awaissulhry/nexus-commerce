'use client'

import { Card } from '@nexus/ui/components'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartState } from '../OrderRecordView'
// F-SA-243: "Still to do: N" with its top 3 rows. F-OP-103: the ONE waiting list — each row with its one door.
import { WithMessages } from '../../../../../../record-panels/i18n'
import { StillRow, WaitingRowItem } from '../RequestsSection'
import type { WaitingState } from '../../overview/model' // F-OP-301 (walk #1–#3): the ONE call of the waiting list (made by OverviewTab)
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'

/**
 * F-OO-100 (order overview lane: one file per card) — moved out of OverviewTab.tsx unchanged.
 *
 * O5 Requests & changes — F-OP-103 (10-order-page §3.2): the ONE waiting list's rows, Waiting on us N and Waiting on <Customer> N, each
 * row with its one door in place; "Still to do: N" with its top 3 rows (each a door); the latest change. "Nothing waits" only when
 * all three are empty.
 */
export function RequestsCard({ order, model, actions, waiting }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; waiting: WaitingState }) {
  const t = useT('orders')
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-210: the tab links keep the dock's scope
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const customer = order.party?.legalName ?? ''
  // F-OP-301 (walk #3): while the production read is out the card says it reads (never "Nothing waits" before it); failed: so said.
  if (waiting.status !== 'ready') return <PartState problem={waiting.status === 'failed' ? waiting.problem : null} label={t('overview.requests.title')} onRetry={() => actions?.onRetryProduction?.()} />
  const card = waiting.card
  return (
    <Card padded>
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.requests.title')}</h2>
        <TabLink className="fw-so-link fw-so-hint" href={tabHref(recordHref, 'changes', search)}>
          {t('overview.requests.changes')}
        </TabLink>
      </div>
      <ul className="fw-so-datelist">
        {card.onUs.length > 0 && (
          <li>
            <span>{t('waiting.onUs', { count: card.onUs.length })}</span>
            <ul className="fw-so-datelist">
              {card.onUs.map((row) => (
                <WaitingRowItem key={row.key} row={row} order={order} model={model} actions={actions} />
              ))}
            </ul>
          </li>
        )}
        {card.onCustomer.length > 0 && (
          <li>
            <span>{t('waiting.onCustomer', { count: card.onCustomer.length, customer })}</span>
            <ul className="fw-so-datelist">
              {card.onCustomer.map((row) => (
                <WaitingRowItem key={row.key} row={row} order={order} model={model} actions={actions} />
              ))}
            </ul>
          </li>
        )}
        {card.still.length > 0 && (
          <li>
            <TabLink className="fw-so-link" href={`${tabHref(recordHref, 'changes', search)}#still-to-do`}>
              {t('overview.requests.still', { count: card.still.length })}
            </TabLink>
            <WithMessages namespaces={['approvals']}>
              <ul className="fw-so-datelist">
                {card.still.slice(0, 3).map((row, index) => (
                  <StillRow key={`${row.kind}:${row.ref?.id ?? index}`} row={row} order={order} model={model} actions={actions /* F-OP-116 */} />
                ))}
              </ul>
            </WithMessages>
          </li>
        )}
        {card.nothing && <li className="fw-so-hint">{t('overview.requests.nothing')}</li>}
        {card.latest && <li className="fw-so-hint">{t('overview.requests.latest', { revision: card.latest.revision, date: card.latest.at ? formatDate(card.latest.at, { locale }) : '—' })}</li>}
      </ul>
    </Card>
  )
}
