'use client'

import Link from 'next/link'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money } from '../../../quotes/model'
import { useProductionWords } from '../../../../../lib/production/words'
import { RequestCard } from '../../../../../lib/production/view/RequestCard'
import { WithMessages } from '../../../../../record-panels/i18n'
import { cardInputOf } from '../../../../home/approvals/requests/model'
import type { Order } from '../../api'
import { waitingOnCustomerOf, waitingOnUsOf } from '../changes/model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { PartState } from './OrderRecordView'

/** The words the request card's lines are written with (Home › Approvals' own: `approvals` customerRequest.*). */
const APPROVALS_NS = 'approvals'
/** The approvals-out states' words (the record's own approvals panel's). */
const RECORD_APPROVALS_NS = 'record-approvals'

/**
 * F-SA-236 (sales page plan N2, N3, P5; 10-order-page §2.4 C1, C3) — the top of Changes:
 *
 *   Waiting on us        one shared RequestCard (office face) per customer request that waits on us: its kind and how long it waits,
 *                        who asked, old → new, their words, the impact; its door goes to Home › Approvals' ONE review window (the
 *                        answer from this page comes with S4's doors). A request we countered: "Counter-offer sent · waits for the
 *                        customer".
 *   Waiting on the       what we asked them: the changed order's new yes, the approvals we asked (artwork, proof, sample …), each
 *   customer             with its state and its due day.
 *
 * Only this order's requests (the walled `GET /production/brand-requests?orderId=`) and its own approvals (`GET /approvals-out`).
 */
export function RequestsSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[APPROVALS_NS, RECORD_APPROVALS_NS]}>
      <Requests order={order} model={model} actions={actions} />
    </WithMessages>
  )
}

function Requests({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const a = useT(APPROVALS_NS)
  const ra = useT(RECORD_APPROVALS_NS)
  const w = useProductionWords()
  const locale = useLocale()
  const part = model.requests ?? null
  const onUs = waitingOnUsOf(part?.value ?? [])
  const onCustomer = waitingOnCustomerOf(part?.value ?? [], model.askedOfCustomer?.value ?? [], order)
  return (
    <div className="fw-so-cards fw-so-cards--wide">
      <Card padded>
        <div className="fw-so-card-head">
          <h2 className="fw-so-h2">{t('changes.onUs.title')}</h2>
          <Button size="sm" variant="quiet" asChild>
            <Link href={`${model.prefix}/home/approvals`}>{t('changes.onUs.approvals')}</Link>
          </Button>
        </div>
        {/* Not read here (a design case): nothing claimed to wait. */}
        {!part ? (
          <p className="fw-so-hint">{t('changes.onUs.nothing')}</p>
        ) : part.value === null && part.problem === null ? (
          <Skeleton height={64} />
        ) : part.value === null ? (
          <PartState problem={part.problem} label={t('changes.onUs.title')} onRetry={() => actions?.onRetryPart?.('requests')} />
        ) : onUs.length === 0 ? (
          <p className="fw-so-hint">{t('changes.onUs.nothing')}</p>
        ) : (
          <div className="fw-so-stack">
            {onUs.map((request) => (
              <RequestCard
                key={request.id}
                face="office"
                request={cardInputOf(request, null, { say: a, locale, day: w.day, money: (minor, currency) => money(minor, currency, locale) })}
                action={
                  request.status === 'COUNTERED' ? (
                    <span className="fw-so-hint">{t('changes.onUs.countered')}</span>
                  ) : (
                    <Button size="sm" variant="primary" asChild>
                      <Link href={`${model.prefix}/home/approvals`}>{t('changes.onUs.answer')}</Link>
                    </Button>
                  )
                }
              />
            ))}
          </div>
        )}
      </Card>
      <Card padded>
        <h2 className="fw-so-h2">{t('changes.onCustomer.title')}</h2>
        {onCustomer.length === 0 ? (
          <EmptyState title={t('changes.onCustomer.nothing')} />
        ) : (
          <ul className="fw-so-datelist">
            {onCustomer.map((entry) => (
              <li key={entry.id}>
                <span>{entry.kind === 'reaccept' ? t('changes.onCustomer.reaccept') : entry.kind === 'counter' ? t('changes.onUs.countered') : entry.question}</span>
                <span className="fw-so-cell-sub">
                  {entry.since ? t('changes.onCustomer.since', { date: formatDate(entry.since, { locale }) }) : null}
                  {entry.dueAt ? ` · ${t('changes.onCustomer.due', { date: formatDate(entry.dueAt, { locale }) })}` : ''}
                  {entry.status ? (
                    <>
                      {' '}
                      <Pill tone="warning">{ra(`status.${entry.status}`)}</Pill>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
