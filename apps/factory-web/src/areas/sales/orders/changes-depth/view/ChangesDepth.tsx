'use client'

import Link from 'next/link'
import { Hourglass, Lock, Undo2 } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money } from '../../../quotes/model'
import type { Order } from '../../api'
import type { FreezeField } from '../../depth/api'
import { changeCounts, DECISION_TONE, FREEZE_TONE, freezeRows, frozenOffer, frozenProblemsOf, NAMESPACE, pricedChanges, putBackHeld, putBackOffered, YES_TONE } from '../../depth/model'
import type { OrderDepthActions, OrderDepthModel } from '../../depth/use-order-depth'
import '../../depth/depth.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** "From cutting: a priced change the customer accepts" / "Still open" / "From finished: it cannot change any more". */
export function verdictText(row: { state: string; frozenFrom: string | null }, d: Translate): string {
  if (row.state === 'OPEN') return d('freeze.open')
  const stage = row.frozenFrom ? d(`stage.${row.frozenFrom}`) : d('stage.none')
  return d(row.state === 'BLOCKED' ? 'freeze.blocked' : 'freeze.priced', { stage })
}

/**
 * Changes › What is frozen (design order.changes.freeze, SAL-218; GET …/freeze): each field of the order — sizes and
 * quantities, colourway, options, delivery date, delivery address, prices — and what a change of it needs at the stage the
 * order reached: still open, a priced change the customer accepts, or nothing any more. A company with no rule: every field
 * open. Then Changes › Priced change requests (order.changes.priced, SAL-219; GET …/changes): Change · Extra cost and price ·
 * Customer decision, with the new yes a change waits for, a change turned down or refused and its Put back. Fetches nothing.
 */
export function ChangesDepth({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel | undefined; actions?: OrderDepthActions; prefix: string }) {
  if (!model) return null
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Depth order={order} model={model} actions={actions} prefix={prefix} />
    </WithMessages>
  )
}

function Depth({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  return (
    <>
      <YesBanner model={model} prefix={prefix} />
      <div className="fw-sod-twocards">
        <FreezePanel model={model} actions={actions} />
        <PricedRequests order={order} model={model} actions={actions} />
      </div>
    </>
  )
}

function YesBanner({ model, prefix }: { model: OrderDepthModel; prefix: string }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const waiting = model.changes?.value?.waitingForYes ?? null
  if (!waiting) return null
  return (
    <Banner
      tone="warning"
      icon={<Hourglass size={16} aria-hidden />}
      title={d('changeYes.waiting', { date: formatDate(waiting.since, { locale }) })}
      action={
        <Button size="sm" variant="quiet" asChild>
          <Link href={`${prefix}/home/approvals`}>{d('wait.openApprovals')}</Link>
        </Button>
      }
    >
      {d('changeYes.waitingBody')}
    </Banner>
  )
}

function FreezePanel({ model, actions }: { model: OrderDepthModel; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const part = model.freeze
  if (!part) return null
  return (
    <Card padded>
      <div className="fw-sod-head">
        <h2 className="fw-sod-h2">
          <Lock size={15} aria-hidden /> {d('freeze.title')}
        </h2>
        {part.value?.order.stage && <Tag tone="info">{d(`stage.${part.value.order.stage}`)}</Tag>}
      </div>
      {part.problem ? (
        <Banner
          tone="danger"
          title={d('freeze.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.('freeze')}>
              {d('common.retry')}
            </Button>
          }
        >
          {d(part.problem)}
        </Banner>
      ) : !part.value ? (
        <p className="fw-sod-hint" role="status">
          <Spinner size={14} /> {d('freeze.reading')}
        </p>
      ) : (
        <>
          <p className="fw-sod-hint">{part.value.order.stage ? d('freeze.stage', { stage: d(`stage.${part.value.order.stage}`), date: part.value.order.on ? formatDate(`${part.value.order.on}T12:00:00Z`, { locale }) : '—' }) : d('freeze.notStarted')}</p>
          <KeyValue
            dense
            labelCase="sentence"
            items={freezeRows(part.value).map((row) => ({
              label: d(`field.${row.field}`),
              value: <Tag tone={FREEZE_TONE[row.state]}>{verdictText(row, d)}</Tag>,
            }))}
          />
          {part.value.rules === 0 && <p className="fw-sod-hint">{d('freeze.noRules')}</p>}
        </>
      )}
    </Card>
  )
}

function PricedRequests({ order, model, actions }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const part = model.changes
  if (!part) return null
  const list = part.value ? pricedChanges(part.value.changes) : []
  const columns = [d('pricedList.col.change'), ...(model.can.price ? [d('pricedList.col.money')] : []), d('pricedList.col.decision'), d('pricedList.col.actions')]
  const rows = list.map((change) => {
    const counts = changeCounts(change)
    const lines = (['changed', 'added', 'removed'] as const).filter((kind) => counts[kind] > 0).map((kind) => d(`pricedList.count.${kind}`, { count: counts[kind] }))
    const offered = putBackOffered(change)
    const held = putBackHeld(change, model.can)
    return {
      id: change.id,
      cells: [
        <span key="c" className="fw-sod-cell">
          <strong>{d('pricedList.revision', { revision: change.revision })}</strong>
          <span>{change.reason}</span>
          <span className="fw-sod-hint">{lines.length > 0 ? `${lines.join(' · ')} · ${d('pricedList.pieces', { before: counts.before, after: counts.after })}` : d('pricedList.feeOnly')}</span>
        </span>,
        ...(model.can.price
          ? [
              <span key="m" className="fw-sod-cell">
                <span>{change.changeAmount === undefined ? '—' : `${change.changeAmount >= 0 ? '+' : '−'}${money(Math.abs(change.changeAmount), order.currency, locale)}`}</span>
                {change.feeAmount ? <span className="fw-sod-hint">{d('pricedList.fee', { amount: money(change.feeAmount, order.currency, locale) })}</span> : null}
                {change.deposit && change.deposit.amount !== undefined && (
                  <span className="fw-sod-hint">{d('pricedList.deposit', { amount: money(change.deposit.amount, order.currency, locale), kind: d(`depositKind.${change.deposit.kind}`), status: d(`depositStatus.${change.deposit.status}`) })}</span>
                )}
              </span>,
            ]
          : []),
        <span key="d" className="fw-sod-cell">
          <Pill tone={DECISION_TONE[change.customer.decision]}>{d(`decision.${change.customer.decision}`)}</Pill>
          {change.yes.state !== 'NOT_ASKED' && <Tag tone={YES_TONE[change.yes.state]}>{d(`changeYes.state.${change.yes.state}`)}</Tag>}
          {change.yes.state === 'TURNED_DOWN' && change.yes.reason && <span className="fw-sod-hint">{d('changeYes.because', { reason: change.yes.reason })}</span>}
          {change.customer.answeredAt && <span className="fw-sod-hint">{d('decision.answered', { date: formatDate(change.customer.answeredAt, { locale }) })}</span>}
        </span>,
        offered ? (
          <Button key="p" size="sm" heldReason={held ? d(held.key) : model.busy ? d('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'putBack', changeId: change.id, reason: '' })} aria-label={d('putBack.of', { revision: change.revision })}>
            <Undo2 size={13} aria-hidden /> {d('putBack.go')}
          </Button>
        ) : (
          <span key="p" className="fw-sod-hint">
            —
          </span>
        ),
      ],
    }
  })
  return (
    <Card padded>
      <div className="fw-sod-head">
        <h2 className="fw-sod-h2">{d('pricedList.title')}</h2>
        <span className="fw-sod-hint">{d('pricedList.subtitle')}</span>
      </div>
      {part.problem ? (
        <Banner
          tone="danger"
          title={d('pricedList.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.('changes')}>
              {d('common.retry')}
            </Button>
          }
        >
          {d(part.problem)}
        </Banner>
      ) : !part.value ? (
        <p className="fw-sod-hint" role="status">
          <Spinner size={14} /> {d('pricedList.reading')}
        </p>
      ) : list.length === 0 ? (
        <EmptyState title={d('pricedList.empty')} description={d('pricedList.emptyBody')} />
      ) : (
        <SummaryTable label={d('pricedList.title')} columns={columns} rows={rows} density="roomy" stackOnPhone />
      )}
    </Card>
  )
}

/**
 * Inside Review amendment (B-W2b-309: a frozen change is refused): what froze, in words, and the way on — "Send as a priced
 * change" when a field asks a priced change the customer accepts, or that it cannot change any more. Fetches nothing.
 */
export function FrozenOffer({ order, problems, model, onPriced }: { order: Order; problems: ReadonlyArray<{ path: string }>; model: OrderDepthModel | undefined; onPriced?: () => void }) {
  const frozen = frozenProblemsOf(problems)
  if (frozen.length === 0) return null
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Offer order={order} frozen={frozen} model={model} onPriced={onPriced} />
    </WithMessages>
  )
}

function Offer({ order, frozen, model, onPriced }: { order: Order; frozen: Array<{ seq: number | null; field: FreezeField }>; model: OrderDepthModel | undefined; onPriced?: () => void }) {
  const d = useT(NAMESPACE)
  const offer = frozenOffer(frozen, model?.freeze?.value ?? null)
  const name = (seq: number | null) => {
    const line = seq === null ? null : order.lines.find((row) => row.seq === seq)
    return line ? `${line.style?.code ?? '—'} · ${line.colourway?.code ?? '—'}` : null
  }
  return (
    <Banner
      tone={offer === 'blocked' ? 'danger' : 'warning'}
      icon={<Lock size={16} aria-hidden />}
      title={d(offer === 'blocked' ? 'offer.blocked' : 'offer.priced')}
      action={
        offer === 'priced' && onPriced ? (
          <Button size="sm" variant="primary" heldReason={!model?.can.manage ? d('held.noManage') : null} onClick={onPriced}>
            {d('offer.go')}
          </Button>
        ) : undefined
      }
    >
      <ul className="fw-sod-list">
        {frozen.map((entry) => (
          <li key={`${entry.seq}-${entry.field}`}>{name(entry.seq) ? d('offer.line', { line: name(entry.seq)!, field: d(`field.${entry.field}`) }) : d('offer.order', { field: d(`field.${entry.field}`) })}</li>
        ))}
      </ul>
    </Banner>
  )
}
