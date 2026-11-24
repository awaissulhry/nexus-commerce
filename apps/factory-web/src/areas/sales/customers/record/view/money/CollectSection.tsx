'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Banknote, Bell, Clock, Coins, Factory, Info, PauseCircle, Truck } from 'lucide-react'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import { lineOf } from '../../../../orders/record/money/view/say'
import { word } from '../../../../orders/record/money/word'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Section } from '../../../../orders/record/view/production/Kit'
import { COLLECT_SHOWN, dayTagOf, IN_PLACE_ACTS, type CollectInPlace, type CollectItem, type CollectModel, type CollectNote, type CollectRow } from '../../money/collect'
import { kitId } from '../../money/sections'
import type { CustomerSay } from '../../money/say'
import type { DockPick } from '../WorkTab'

/**
 * F-CM-105 (customer page › MONEY tab, 10-design §5.2) — section 2, To collect (#collect): every open deposit / before-shipping request
 * and every open invoice of this customer, oldest due first, as THE customer row (what · when · words · amount · ONE act · ⋯), ten at
 * first then "Show n more rows" in place; the foot's one quiet line to Work › All orders. The list is a size container (customer-
 * money.css): its columns join by the list's own room. A request's acts open the ORDER's own windows in place (cm-w2, through the money
 * door: `onAct`); until a host hands `onAct` they are not drawn — never a held button. An invoice's Record payment… is Finance's door.
 * Draws its model (money/collect.ts); reads nothing.
 */

const NOTE_ICON: Record<CollectNote['icon'], ReactNode> = {
  factory: <Factory size={13} aria-hidden />,
  truck: <Truck size={13} aria-hidden />,
  coins: <Coins size={13} aria-hidden />,
  pause: <PauseCircle size={13} aria-hidden />,
  bell: <Bell size={13} aria-hidden />,
  clock: <Clock size={13} aria-hidden />,
  info: <Info size={13} aria-hidden />,
}

const isInPlace = (id: string): id is CollectInPlace => (IN_PLACE_ACTS as readonly string[]).includes(id)

export interface CollectSectionProps {
  readonly model: CollectModel
  readonly sayIn: (currency: string) => CustomerSay
  readonly unit: string
  /** The company the rows are of (a row's order docks with it). */
  readonly companyId: string | null
  /** The head's ⋯ doors (built by the layout from the rights). */
  readonly menu: readonly MenuItemDef[]
  readonly onRetry: () => void
  /** Show in the thread: docks the row's ORDER thread beside the tab (the page's own dock). */
  readonly onPick?: (pick: DockPick) => void
  /** An act in place (cm-w2: the order's own windows through the money door; Finance's stop form). Absent: those acts are not drawn. */
  readonly onAct?: (act: CollectInPlace, row: CollectRow) => void
  /** The foot's door: Work › All orders (what each order has paid and still owes). */
  readonly allOrdersHref: string
}

export function CollectSection({ model, sayIn, unit, companyId, menu, onRetry, onPick, onAct, allOrdersHref }: CollectSectionProps) {
  const say = sayIn(unit)
  const [all, setAll] = useState(false)
  const title = say(word('cm.collect.title'))
  const items: MenuItemDef[] = [...menu, { id: 'link', label: say(word('cm.linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('collect') }]
  const info = (
    <>
      <p>{say(word('cm.collect.info'))}</p>
      <p>{say(word('cm.keys'))}</p>
    </>
  )
  const head = { id: kitId('collect'), title, info, more: <LineMenuButton label={say(word('cm.collect.more'))} items={items} /> }
  if (model.reading)
    return (
      <Section {...head} answer={say(word('cm.collect.reading'))}>
        <PartReading rows={3} height={34} />
      </Section>
    )
  if (model.problem)
    return (
      <Section {...head}>
        <PartFailed part={say(word('cm.collect.part'))} problem={model.problem} onRetry={onRetry} />
      </Section>
    )
  const drawable = (act: CollectItem | null): boolean => !!act && (!!act.href || (isInPlace(act.id) && !!onAct))
  const shown = all ? model.rows : model.rows.slice(0, COLLECT_SHOWN)
  const anyAct = shown.some((row) => drawable(row.act))
  const price = model.rows.some((row) => row.amount !== null)
  const more = model.rows.length - shown.length
  return (
    <Section {...head} answer={lineOf(model.answer.map(say))}>
      <div className={`fw-cm-list${price ? '' : ' is-np'}${anyAct ? '' : ' is-na'}`} role="list" aria-label={title}>
        {shown.map((row) => (
          <CollectRowView key={row.anchor} row={row} say={sayIn(row.currency)} companyId={companyId} onPick={onPick} onAct={onAct} drawable={drawable} />
        ))}
      </div>
      {more > 0 || (all && model.rows.length > COLLECT_SHOWN) ? (
        <Button size="sm" variant="quiet" className="fw-cm-more" onClick={() => setAll((now) => !now)}>
          {all ? say(word('cm.more.fewer')) : say(word('cm.more.rows', { params: { count: more } }))}
        </Button>
      ) : null}
      <p className="fw-cm-foot">
        <span>
          {say(word('cm.collect.foot'))}{' '}
          <Link className="fw-pt-link" href={allOrdersHref}>
            {say(word('cm.collect.footDoor'))}
          </Link>
        </span>
      </p>
    </Section>
  )
}

function CollectRowView({ row, say, companyId, onPick, onAct, drawable }: { row: CollectRow; say: CustomerSay; companyId: string | null; onPick?: (pick: DockPick) => void; onAct?: (act: CollectInPlace, row: CollectRow) => void; drawable: (act: CollectItem | null) => boolean }) {
  const locale = useLocale()
  const tag = dayTagOf(row.late)
  const what = say(row.chip)
  // M-8 (cm-fx4): a request is named by what it is AND its order (a deposit and a balance of one order are two rows).
  // R-2 (cm-fx5): an invoice is named by its kind AND its number, so its ⋯ is not the same name as its row in Invoices & credit notes.
  const name = row.invoice?.number ? `${what} · ${row.invoice.number}` : row.order?.number ? `${what} · ${row.order.number}` : what
  const items: MenuItemDef[] = []
  for (const item of row.more) {
    if (item.held) items.push({ id: item.id, label: say(item.label), disabled: true, description: say(item.held) })
    else if (item.href) items.push({ id: item.id, label: say(item.label), href: item.href })
    else if (item.id === 'show') {
      if (onPick && row.order) {
        const order = row.order
        items.push({ id: 'show', label: say(item.label), onSelect: () => onPick({ type: 'SalesOrder', id: order.id, label: order.number, companyId }) })
      }
    } else if (item.id === 'link') items.push({ id: 'link', label: say(item.label), onSelect: () => copyLinkTo(row.anchor) })
    else if (isInPlace(item.id) && onAct) {
      const act = item.id
      items.push({ id: act, label: say(item.label), onSelect: () => onAct(act, row) })
    }
  }
  const act = row.act && drawable(row.act) ? row.act : null
  const actView = !act ? null : act.href ? (
    <Button size="sm" asChild>
      <Link href={act.href}>
        <Banknote size={13} aria-hidden /> {say(act.label)}
      </Link>
    </Button>
  ) : isInPlace(act.id) && onAct ? (
    <Button size="sm" variant="primary" onClick={() => onAct(act.id as CollectInPlace, row)}>
      <Banknote size={13} aria-hidden /> {say(act.label)}
    </Button>
  ) : null
  return (
    <div className="fw-cm-row" id={row.anchor} role="listitem" tabIndex={-1}>
      <div className="fw-cm-row-g">
        <div className="fw-cm-row-k">
          <span className="fw-cm-row-kt">
            <Tag tone={row.kind === 'INVOICE' ? 'neutral' : 'info'}>{what}</Tag>
            {row.invoice ? (
              <b>
                <Link className="fw-pt-link" href={row.invoice.href}>
                  <span className="fw-om-num">{row.invoice.number}</span> ›
                </Link>
              </b>
            ) : row.order ? (
              <b>
                <Link className="fw-pt-link" href={row.order.href}>
                  <span className="fw-om-num">{row.order.number}</span> ›
                </Link>
              </b>
            ) : null}
            {row.invoice && row.order ? (
              <span className="fw-cm-of">
                {say(word('cm.collect.of'))}{' '}
                <Link className="fw-pt-link" href={row.order.href}>
                  <span className="fw-om-num">{row.order.number}</span> ›
                </Link>
              </span>
            ) : null}
          </span>
        </div>
        <div className="fw-cm-row-d">
          {row.due ? <span>{say(word('orders:moneyTab.plan.due.on', { days: { date: row.due } }))}</span> : null}
          {tag ? <Tag tone={tag.tone}>{say(tag.word)}</Tag> : null}
        </div>
        <div className="fw-cm-row-n">
          {row.notes.map((note) => (
            <span key={note.word.key} className={note.tone === 'neutral' ? undefined : `is-${note.tone}`}>
              {NOTE_ICON[note.icon]}
              <span>{say(note.word)}</span>
            </span>
          ))}
        </div>
        <div className="fw-cm-row-m">
          {row.amount !== null ? <span className="fw-om-amt">{money(row.amount, row.currency, locale)}</span> : null}
          {row.of !== null ? <span className="fw-cm-of">{say(word('cm.collect.ofTotal', { money: { amount: row.of } }))}</span> : null}
        </div>
        <div className="fw-cm-row-a">{actView}</div>
        <div className="fw-cm-row-o">
          <LineMenuButton label={say(word('cm.collect.rowMore', { params: { row: name } }))} items={items} />
        </div>
      </div>
    </div>
  )
}
