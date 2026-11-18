'use client'

import Link from 'next/link'
import { Hourglass, Lock } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import type { FreezeField } from '../../depth/api'
import { FREEZE_TONE, freezeRows, frozenOffer, frozenProblemsOf, NAMESPACE } from '../../depth/model'
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
 * open (F-SA-236: "What can still change"). The new yes a change waits for stays above it; the priced changes (SAL-219) are rows of
 * Changes › History with their Put back. Fetches nothing.
 */
export function ChangesDepth({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel | undefined; actions?: OrderDepthActions; prefix: string }) {
  if (!model) return null
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Depth order={order} model={model} actions={actions} prefix={prefix} />
    </WithMessages>
  )
}

function Depth({ model, actions, prefix }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  return (
    <>
      <YesBanner model={model} prefix={prefix} />
      {/* F-SA-236: What can still change; the priced changes are rows of Changes › History (with Put back). */}
      <FreezePanel model={model} actions={actions} />
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
