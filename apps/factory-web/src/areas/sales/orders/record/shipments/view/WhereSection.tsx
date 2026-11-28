'use client'

import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { CheckCircle2, CornerDownLeft, Factory, FileText, Info, Minus, Package, PackageCheck, Truck } from 'lucide-react'
import type { MenuItemDef } from '@nexus/ui/components'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { sizeGridWords } from '../../../../quotes/record/view/grid-copy'
import type { Order } from '../../../api'
import { dayInstant } from '../../../model'
import { rowAnchor } from '../../dock/discuss'
import { lineMovesOf, lineTargetOf } from '../../line-moves'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton } from '../../view/LineMenu'
import { Section } from '../../../../../../lib/record-sections/Kit' // F-OS-101: the Production kit, in place
import { shownBuckets, sumWord, whereAnswer, type Bucket, type ColourCells, type Fact, type ShipRef, type StyleCard, type WhereModel } from '../where'
import { copyLinkTo, kitId, shipmentTabHref } from './hrefs'
import { useShipSay } from './say'

/**
 * F-OS-102 (order SHIPMENTS tab, 10-design §4) — section 1 "Where every garment is" (#left), drawn: the answer ("34 still to ship · 6 can
 * go today · 36 on shipments not left"); the summary that adds up — one stacked bar, one legend row per bucket with its count and its
 * door, "40 + 24 + … = 114 ordered" — and BESIDE it (from 1200 px of section room) one card per style: the DS size grid of what is still
 * to ship and, beside the grid (from 620 px of card room), what is ready now, which shipment holds the rest, what is still to make and
 * what was closed short. Made to measure in units; fully shipped folds to one line. A card's ⋯ opens the Lines tab's OWN Close remaining
 * lines… / Reopen lines… (in place, one path). Draws its model (shipments/where.ts); reads nothing.
 */

export function WhereSection({ order, model, actions, where }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; where: WhereModel }) {
  const t = useT('order-shipments')
  const say = useShipSay()
  const search = useSearchParams()?.toString() ?? ''
  const [open, setOpen] = useState(false)
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const title = t('where.title')
  const info = <p>{t('where.info')}</p>
  const more = <LineMenuButton label={t('where.more')} items={[{ id: 'lines', label: t('where.openLines'), href: tabHref(recordHref, 'lines', search) }, { id: 'copy', label: t('where.copyLink'), onSelect: () => copyLinkTo('left') }]} />
  const parts = whereAnswer(where, order).map(say)
  if (where.state !== 'goods') {
    return (
      <Section id={kitId('left')} title={title} answer={parts.join(' · ')} info={info} more={more}>
        {null}
      </Section>
    )
  }
  // Fully shipped: one line with its door (fixes the grid of zeros); "Show by size" opens the body, "Fold it" closes it again.
  if (where.allOut && !open) {
    return (
      <Section
        id={kitId('left')}
        title={title}
        answer={
          <>
            {parts.join(' · ')}.{' '}
            <button type="button" className="fw-pt-link" aria-expanded={false} onClick={() => setOpen(true)}>
              {t('where.showBySize')}
            </button>
          </>
        }
        info={info}
        more={more}
      >
        {null}
      </Section>
    )
  }
  const answer = where.allOut ? (
    <>
      {parts.join(' · ')}.{' '}
      <button type="button" className="fw-pt-link" aria-expanded onClick={() => setOpen(false)}>
        {t('where.fold')}
      </button>
    </>
  ) : where.mode === 'counted' ? (
    <>
      <b>{parts[0]}</b>
      {parts.length > 1 ? ` · ${parts.slice(1).join(' · ')}` : ''}
    </>
  ) : (
    parts.join(' · ')
  )
  return (
    <Section id={kitId('left')} title={title} answer={answer} info={info} more={more}>
      <div className="fw-os-wg">
        {where.mode === 'counted' ? <Summary order={order} model={model} where={where} /> : null}
        <div className="fw-os-wcl">
          <div className="fw-os-wcs">
            {where.cards.map((card) => (
              <StyleCardView key={card.styleId} card={card} order={order} model={model} actions={actions} counted={where.mode === 'counted'} />
            ))}
          </div>
        </div>
      </div>
    </Section>
  )
}

/** The summary that adds up: "114 ordered · 34 still to ship", the bar, the legend with each bucket's door, the sum. */
function Summary({ order, model, where }: { order: Order; model: OrderRecordModel; where: WhereModel }) {
  const t = useT('order-shipments')
  const say = useShipSay()
  const search = useSearchParams()?.toString() ?? ''
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const buckets = shownBuckets(where)
  const filled = buckets.filter((bucket) => where.totals[bucket] > 0)
  const refLinks = (refs: readonly ShipRef[]): ReactNode[] =>
    refs.map((ref) => (
      <a key={ref.id} className="fw-pt-link" href={`#${rowAnchor('Shipment', ref.id)}`}>
        {ref.pieces !== null ? t('where.door.ship', { number: ref.number, count: ref.pieces }) : t('where.door.shipBare', { number: ref.number })}
      </a>
    ))
  const doorsOf = (bucket: Bucket): ReactNode => {
    switch (bucket) {
      case 'shipped':
        return where.doors.shipped.length > 0 ? refLinks(where.doors.shipped) : <span>{t('where.door.none')}</span>
      case 'packed':
      case 'draft':
      case 'planned':
        return refLinks(where.doors[bucket])
      case 'back': {
        const first = where.doors.back[0]
        return (
          <>
            {refLinks(where.doors.back)}
            {first && model.can.createShipment ? (
              <a className="fw-pt-link" href={shipmentTabHref(model.prefix, order.companyId, first, 'carrier')}>
                {t('where.door.receive')}
              </a>
            ) : null}
          </>
        )
      }
      case 'ready':
        return model.can.createShipment ? (
          <a className="fw-pt-link" href="#shipments">
            {t('where.door.create')}
          </a>
        ) : (
          <span>{t('where.door.warehouseShips')}</span>
        )
      case 'making':
        return (
          <TabLink className="fw-pt-link" href={tabHref(recordHref, 'production', search)}>
            {t('where.door.production')}
          </TabLink>
        )
      case 'closed':
        return (
          <TabLink className="fw-pt-link" href={tabHref(recordHref, 'lines', search)}>
            {t('where.door.lines')}
          </TabLink>
        )
    }
  }
  return (
    <div className="fw-os-ws">
      <div className="fw-os-ws-top">
        <b>{where.ordered}</b> {t('where.summary.ordered')} · {t('where.summary.toShip', { count: where.stillToShip })}
      </div>
      <div className="fw-os-bar" role="img" aria-label={`${t('where.summary.bar', { count: where.ordered })}: ${filled.map((bucket) => `${t(`where.bucket.${bucket}`)} ${where.totals[bucket]}`).join(', ')}`}>
        {filled.map((bucket) => (
          <i key={bucket} className={`fw-os-b-${bucket}`} style={{ width: `${where.ordered > 0 ? ((where.totals[bucket] / where.ordered) * 100).toFixed(2) : '0'}%` }} title={`${t(`where.bucket.${bucket}`)}: ${where.totals[bucket]}`} />
        ))}
      </div>
      <ul className="fw-os-wl">
        {buckets.map((bucket) => (
          <li key={bucket}>
            <span className={`fw-os-sw fw-os-b-${bucket}`} aria-hidden />
            <b>{t(`where.bucket.${bucket}`)}</b>
            <span className="fw-os-n">{where.totals[bucket]}</span>
            <span className="fw-os-sub">{doorsOf(bucket)}</span>
          </li>
        ))}
      </ul>
      <p className="fw-os-eq">{say(sumWord(where))}</p>
    </div>
  )
}

/** A colour's sizes or units, in words: "Black 52 ×4, 54 ×2 · Red 46 ×2". */
function useCellsText(): (cells: readonly ColourCells[]) => string {
  const t = useT('order-shipments')
  return (cells) => cells.map((cell) => (cell.units !== null ? `${cell.colour} ${t('where.units', { count: cell.units })}` : `${cell.colour} ${cell.sizes.map((size) => `${size.size} ×${size.pieces}`).join(', ')}`)).join(' · ')
}

const FACT_ICON: Readonly<Record<string, ReactNode>> = Object.freeze({
  DRAFT: <FileText size={13} aria-hidden />,
  PACKED: <Package size={13} aria-hidden />,
  SHIPPED: <Truck size={13} aria-hidden />,
  DELIVERED: <PackageCheck size={13} aria-hidden />,
  RETURNED: <CornerDownLeft size={13} aria-hidden />,
})

/** One style: its grid of what is still to ship and, beside it, the facts; made to measure in units. */
function StyleCardView({ card, order, model, actions, counted }: { card: StyleCard; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; counted: boolean }) {
  const t = useT('order-shipments')
  const o = useT('orders')
  const s = useT('shipments')
  const sales = useT('sales')
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? ''
  const cellsText = useCellsText()
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  // The Lines tab's OWN Close remaining lines… / Reopen lines… (orders.manage; their rules and held words), then Open on Lines ›.
  const moves = lineMovesOf(lineTargetOf(card.lineIds, order), order, model.can, { lines: [], thread: false, busy: model.busy }).filter((move) => move.id === 'close' || move.id === 'reopen')
  const items: MenuItemDef[] = [
    ...moves.map((move): MenuItemDef => ({
      id: move.id,
      label: o(move.id === 'close' ? 'action.closeLines' : 'action.reopenLines'),
      disabled: !!move.held,
      description: move.held ? o(move.held.key, move.held.params) : undefined,
      onSelect: move.held ? undefined : () => actions?.onDialog?.(move.id === 'close' ? { kind: 'closeLines', lineIds: move.lineIds } : { kind: 'reopenLines', lineIds: move.lineIds }),
    })),
    { id: 'lines', label: t('where.openLines'), href: tabHref(recordHref, 'lines', search) },
  ]
  const head = (
    <div className="fw-os-wc-h">
      <h3>
        {card.code} <span>· {card.name ? `${card.name} · ` : ''}{t('where.card.lines', { count: card.seqs.length, seqs: card.seqs.join(', ') })}</span>
      </h3>
      {card.closed > 0 ? <Tag tone="neutral">{t('where.card.closedTag', { count: card.closed })}</Tag> : null}
      {card.promise ? <span className="fw-os-mu">{s('backorder.promise', { date: formatDate(dayInstant(card.promise), { locale }) })}</span> : null}
      <span className="fw-os-sp" />
      <LineMenuButton label={t('where.card.more', { style: card.code })} items={items} />
    </div>
  )
  const facts = <Facts facts={card.facts} order={order} model={model} cellsText={cellsText} />
  if (card.mtm) {
    return (
      <div className="fw-os-wc is-mtm">
        {head}
        <p className="fw-pt-hint">
          <Info size={13} aria-hidden />
          <span>
            {t('where.card.mtm')} {t('where.card.mtmCount', { units: t('where.units', { count: card.ordered }), toShip: card.stillToShip })}
          </span>
        </p>
        {facts}
      </div>
    )
  }
  return (
    <div className="fw-os-wc">
      {head}
      <div className={`fw-os-wc-b${card.grid ? '' : ' is-done'}`}>
        {card.grid ? (
          <div className="fw-so-gridbox">
            {/* os-fx7 (W-08): the grid's caption SHOWN above it ("SEED-JKT-02: still to ship by colour and size"); the grid keeps its own
                caption for a screen reader, so this line is not read twice. */}
            <p className="fw-os-gcap" aria-hidden="true">
              {counted ? t('where.card.gridCaption', { style: card.code }) : o('ship.gridCaption', { style: card.code })}
            </p>
            <SizeGridView colours={card.grid.colours} sizes={card.grid.sizes} value={card.grid.value} caption={counted ? t('where.card.gridCaption', { style: card.code }) : o('ship.gridCaption', { style: card.code })} locale={INTL_LOCALE[locale]} copy={sizeGridWords(sales)} />
          </div>
        ) : (
          <p className="fw-pt-quiet">
            <CheckCircle2 size={14} aria-hidden /> {t('where.card.nothingLeft')}
          </p>
        )}
        {facts}
      </div>
    </div>
  )
}

/** The style's facts, in words (each shipment a link to its row). */
function Facts({ facts, order, model, cellsText }: { facts: readonly Fact[]; order: Order; model: OrderRecordModel; cellsText: (cells: readonly ColourCells[]) => string }) {
  const t = useT('order-shipments')
  const o = useT('orders')
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? ''
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  return (
    <ul className="fw-os-wf">
      {facts.map((fact, index) => {
        switch (fact.kind) {
          case 'ready':
            return (
              <li key={`ready-${index}`} className="is-ok">
                <CheckCircle2 size={13} aria-hidden />
                <span>
                  <b>{t('where.fact.ready')}</b> {cellsText(fact.cells)}
                </span>
              </li>
            )
          case 'shipment':
            return (
              <li key={`ship-${fact.ref.id}`} className={fact.received === false ? 'is-warn' : undefined}>
                {FACT_ICON[fact.ref.status] ?? <Truck size={13} aria-hidden />}
                <span>
                  <a className="fw-pt-link" href={`#${rowAnchor('Shipment', fact.ref.id)}`}>
                    {t(`where.fact.on.${fact.ref.status}`, { number: fact.ref.number })}
                  </a>
                  : {fact.colours.map((entry) => `${entry.colour} ${entry.pieces}`).join(' · ')}
                  {fact.received === false ? ` · ${t('where.fact.notReceived')}` : fact.received === true ? ` · ${t('where.fact.received')}` : ''}
                </span>
              </li>
            )
          case 'making':
            return (
              <li key={`making-${index}`}>
                <Factory size={13} aria-hidden />
                <span>
                  <b>{t('where.fact.making')}</b> {fact.pieces} ·{' '}
                  <TabLink className="fw-pt-link" href={tabHref(recordHref, 'production', search)}>
                    {t('where.door.production')}
                  </TabLink>
                </span>
              </li>
            )
          case 'closed':
            return (
              <li key={`closed-${index}`}>
                <Minus size={13} aria-hidden />
                <span>
                  <b>{t('where.fact.closed')}</b> {cellsText(fact.cells)}
                  {fact.reason ? ` · «${fact.reason}»` : ''}
                  {fact.at ? ` · ${formatDate(fact.at, { locale })}` : ''}
                </span>
              </li>
            )
          case 'figures':
            return (
              <li key={`figures-${index}`}>
                <Info size={13} aria-hidden />
                <span>{o('ship.figures', { ordered: fact.ordered, released: fact.released, shipped: fact.shipped, toShip: fact.toShip })}</span>
              </li>
            )
          case 'nothingOn':
            return (
              <li key={`none-${index}`}>
                <Info size={13} aria-hidden />
                <span>{t('where.card.nothingOn')}</span>
              </li>
            )
        }
      })}
    </ul>
  )
}

