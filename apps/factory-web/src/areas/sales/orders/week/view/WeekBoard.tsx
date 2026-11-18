'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { MoreHorizontal } from 'lucide-react'
import { Card, EmptyState, Menu } from '@nexus/ui/components'
import { Button, Pill, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant } from '../../model'
import { NAMESPACE, PRIORITY_TONE, RISK_TONE, isPriorityLevel } from '../../depth/model'
import { pictureOf, type WeekColumn, type WeekCard } from '../model'
import type { WeekModel } from '../use-promise-week'
import '../../depth/depth.css'
// F-SA-215 (sales page plan N8, pick P13): the cards' photos — the ONE picture part, read by the cards' orders.
import type { ReadPictures } from '../../../../../lib/record-picture/cache'
import { RecordPicture } from '../../../../../lib/record-picture/view/RecordPicture'
import { PictureViewer } from '../../../../../lib/record-picture/view/PictureViewer'

/** F-SA-215: the batch read and the design cases' photos (the board fetches nothing itself). */
interface Pictures {
  readonly read?: ReadPictures | null
  readonly demo?: Readonly<Record<string, string>>
}

/**
 * By promise week (design sales.orders sec:orders.week; Board view, D19): one column per ISO week — the weeks already passed in
 * Late first, this week marked, then No promise — each with its open pieces and one card per order (number as a real link,
 * customer, pieces and lines, priority, the worst risk). Cards never drag: "Change promise date…" opens the order's Dates tab,
 * where the change is made with its reason. The search of the list narrows it; the site is chosen when the person has several.
 * Fetches nothing.
 * F-SA-215: each card shows its order's photo on the left (the ONE picture part at its board size, fit; the batch read names the
 * style and the file by the cards' orders, ≤ 200 a call) and "Priority · <level>" as the Sales board says it; the columns are as
 * wide as the Sales board's lanes (260 px, a week with nothing 160 px), scrolling sideways inside the card.
 */
export function WeekBoard({ model, prefix, search, onSite, onRetry, pictures }: { model: WeekModel; prefix: string; search?: ReactNode; onSite?: (siteId: string) => void; onRetry?: () => void; pictures?: Pictures }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'orders' /* F-SA-215: "Priority · <level>", the Sales board's words */]}>
      <Board model={model} prefix={prefix} search={search} onSite={onSite} onRetry={onRetry} pictures={pictures ?? {}} />
    </WithMessages>
  )
}

function Board({ model, prefix, search, onSite, onRetry, pictures }: { model: WeekModel; prefix: string; search?: ReactNode; onSite?: (siteId: string) => void; onRetry?: () => void; pictures: Pictures }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const state = model.state
  // F-SA-215: the photo large of the card whose photo was opened (Esc gives the focus back to it).
  const [viewer, setViewer] = useState<{ orderId: string; number: string } | null>(null)
  const tools = (
    <div className="fw-sod-tools">
      {search}
      {model.sites.length > 1 && (
        <Select size="sm" aria-label={d('week.site')} value={model.siteId ?? ''} onChange={(event) => onSite?.(event.target.value)}>
          {model.sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.code ? `${site.code} · ${site.name}` : site.name}
            </option>
          ))}
        </Select>
      )}
      {state.status === 'ready' && <span className="fw-sod-hint">{d('week.asOf', { time: formatTime(state.asOf, { locale }) })}</span>}
    </div>
  )
  if (state.status === 'forbidden') {
    return (
      <Card padded>
        <EmptyState title={d('week.forbidden.title')} description={d('week.forbidden.body')} />
      </Card>
    )
  }
  if (state.status === 'noSite') {
    return (
      <Card padded>
        <EmptyState title={d('week.noSite.title')} description={d('week.noSite.body')} />
      </Card>
    )
  }
  return (
    <Card padded>
      {tools}
      {state.status === 'loading' ? (
        <div className="fw-sod-weeks" aria-busy="true">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="fw-sod-week">
              <Skeleton height={18} width={120} />
              <Skeleton height={64} />
              <Skeleton height={64} />
            </div>
          ))}
        </div>
      ) : state.status === 'error' ? (
        <EmptyState
          title={d('week.failed')}
          description={d(state.problem)}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {d('common.retry')}
            </Button>
          }
        />
      ) : state.columns.every((column) => column.cards.length === 0) ? (
        <EmptyState title={d('week.empty.title')} description={d('week.empty.body')} />
      ) : (
        <>
          <div className="fw-sod-weeks" role="list" aria-label={d('week.label')}>
            {state.columns.map((column) => (
              <Column key={column.key} column={column} prefix={prefix} pictures={pictures} onPicture={setViewer} />
            ))}
          </div>
          {!state.complete && <p className="fw-sod-hint">{d('week.incomplete')}</p>}
          <p className="fw-sod-hint">{d('week.how')}</p>
        </>
      )}
      {viewer && (
        <PictureViewer
          source="order"
          recordId={viewer.orderId}
          number={viewer.number}
          read={pictures.read}
          demo={pictures.demo?.[viewer.orderId]}
          prefix={prefix}
          recordHref={`${prefix}/sales/orders/${viewer.orderId}`}
          linesHref={`${prefix}/sales/orders/${encodeURIComponent(viewer.orderId)}?tab=lines`}
          onClose={() => setViewer(null)}
        />
      )}
    </Card>
  )
}

function Column({ column, prefix, pictures, onPicture }: { column: WeekColumn; prefix: string; pictures: Pictures; onPicture: (card: { orderId: string; number: string }) => void }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const title = column.key === 'EARLIER' ? d('week.earlier') : column.key === 'LATER' ? d('week.later') : column.key === 'NONE' ? d('week.none') : d('week.week', { week: column.week ?? 0 })
  return (
    <section className={column.cards.length === 0 ? 'fw-sod-week is-empty' : 'fw-sod-week'} role="listitem" aria-label={title}>
      <div className="fw-sod-week-head">
        <strong>
          {title} {column.current && <Tag tone="info">{d('week.thisWeek')}</Tag>}
          {column.key === 'EARLIER' && column.cards.length > 0 && <Tag tone="danger">{d('week.late')}</Tag>}
        </strong>
        <span className="fw-sod-hint">{d('week.units', { count: column.units })}</span>
      </div>
      {column.from && column.to && <span className="fw-sod-hint">{d('week.range', { from: formatDate(dayInstant(column.from), { locale }), to: formatDate(dayInstant(column.to), { locale }) })}</span>}
      {column.cards.length === 0 ? (
        <p className="fw-sod-hint">{d('week.nothing')}</p>
      ) : (
        <ul className="fw-sod-week-cards">
          {column.cards.map((card) => (
            <WeekCardView key={card.orderId} card={card} prefix={prefix} pictures={pictures} onPicture={() => onPicture({ orderId: card.orderId, number: card.number })} />
          ))}
        </ul>
      )}
    </section>
  )
}

function WeekCardView({ card, prefix, pictures, onPicture }: { card: WeekCard; prefix: string; pictures: Pictures; onPicture: () => void }) {
  const d = useT(NAMESPACE)
  const t = useT('orders')
  const href = `${prefix}/sales/orders/${card.orderId}`
  const picture = pictureOf(card)
  return (
    <li className="fw-sod-card">
      {/* F-SA-215: the order's photo on the left; the card names none of its own, so the batch read names the style and the file. */}
      <RecordPicture source={picture.source} recordId={picture.recordId} number={picture.number} size="board" read={pictures.read} demo={pictures.demo?.[card.orderId]} onOpen={onPicture} />
      <div className="fw-sod-card-text">
        <div className="fw-sod-card-top">
          <Link className="fw-sod-link" href={href}>
            {card.number}
          </Link>
          <Menu
            label={<MoreHorizontal size={15} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': d('week.cardMenu', { number: card.number }) }}
            items={[
              { id: 'open', label: d('week.open'), href },
              { id: 'promise', label: d('week.changePromise'), href: `${href}?tab=dates` },
            ]}
          />
        </div>
        <span className="fw-sod-hint">{card.customer}</span>
        <span className="fw-sod-inline">
          <span>{d('week.cardUnits', { count: card.units })}</span>
          <span className="fw-sod-hint">{d('week.cardLines', { count: card.lines })}</span>
        </span>
        <span className="fw-sod-inline">
          {/* F-SA-215: "Priority · <level>", as the Sales board says it (P15: bare "Urgent" is the factory rush). */}
          {isPriorityLevel(card.priorityLevel) && card.priorityLevel !== 'NORMAL' && <Pill tone={PRIORITY_TONE[card.priorityLevel]}>{t('board.priority', { level: d(`priority.level.${card.priorityLevel}`) })}</Pill>}
          {card.risk && card.risk !== 'ON_TIME' && <Tag tone={RISK_TONE[card.risk]}>{d(`risk.${card.risk}`)}</Tag>}
        </span>
      </div>
    </li>
  )
}
