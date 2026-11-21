'use client'

import { Lock } from 'lucide-react'
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
 * open (F-SA-236: "What can still change"). The priced changes (SAL-219) are rows of Changes › History with their Put back. F-OC-102
 * (10-design §3, O4): the approval an old change waits for is a row of Changes › Waiting on us (its Confirm / Refuse… in place) — the
 * banner that said it a second time here went. Fetches nothing.
 */
export function ChangesDepth({ order, model, actions }: { order: Order; model: OrderDepthModel | undefined; actions?: OrderDepthActions }) {
  if (!model) return null
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Depth order={order} model={model} actions={actions} />
    </WithMessages>
  )
}

function Depth({ model, actions }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions }) {
  // F-SA-236: What can still change; the priced changes are rows of Changes › History (with Put back).
  return <FreezePanel model={model} actions={actions} />
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
 * Inside the edit strip (B-W2b-309: a frozen change is refused): what froze, in words, and the way on — a priced change the customer
 * accepts, or that it cannot change any more. F-OP-108: one button — the strip's own Apply becomes "Apply as a priced change" (with its
 * optional fee); this banner only says what froze. Fetches nothing.
 */
export function FrozenOffer({ order, problems, model }: { order: Order; problems: ReadonlyArray<{ path: string }>; model: OrderDepthModel | undefined }) {
  const frozen = frozenProblemsOf(problems)
  if (frozen.length === 0) return null
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Offer order={order} frozen={frozen} model={model} />
    </WithMessages>
  )
}

function Offer({ order, frozen, model }: { order: Order; frozen: Array<{ seq: number | null; field: FreezeField }>; model: OrderDepthModel | undefined }) {
  const d = useT(NAMESPACE)
  const offer = frozenOffer(frozen, model?.freeze?.value ?? null)
  const name = (seq: number | null) => {
    const line = seq === null ? null : order.lines.find((row) => row.seq === seq)
    return line ? `${line.style?.code ?? '—'} · ${line.colourway?.code ?? '—'}` : null
  }
  return (
    <Banner tone={offer === 'blocked' ? 'danger' : 'warning'} icon={<Lock size={16} aria-hidden />} title={d(offer === 'blocked' ? 'offer.blocked' : 'offer.priced')}>
      <ul className="fw-sod-list">
        {frozen.map((entry) => (
          <li key={`${entry.seq}-${entry.field}`}>{name(entry.seq) ? d('offer.line', { line: name(entry.seq)!, field: d(`field.${entry.field}`) }) : d('offer.order', { field: d(`field.${entry.field}`) })}</li>
        ))}
      </ul>
    </Banner>
  )
}
