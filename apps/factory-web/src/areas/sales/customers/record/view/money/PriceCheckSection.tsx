'use client'

import Link from 'next/link'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import { word } from '../../../../orders/record/money/word'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Section } from '../../../../orders/record/view/production/Kit'
import type { PriceCheckModel } from '../../money/worth'
import { kitId } from '../../money/sections'
import type { CustomerSay } from '../../money/say'

/**
 * F-CM-303 (customer page › MONEY tab, cm-w3 W3.3; 10-design §5.7) — section 7, Price check (#price-check; orders.view + the price
 * grain): the answer from the page's own counts — "Prices differ on N orders ›" (Work › Not equal, F-CP-141's door, moved here from
 * Balance) and the orders with no customer price yet — then one row per ORDER whose prices differ (its own Price check is the door), our
 * amount, the customer's, the difference. Head: See them on Work ›. Draws its model; reads nothing.
 */
export function PriceCheckSection({ model, sayIn, unit, onRetry }: { model: PriceCheckModel; sayIn: (currency: string) => CustomerSay; unit: string; onRetry: () => void }) {
  const locale = useLocale()
  const say = sayIn(unit)
  const title = say(word('orders:moneyTab.price.title'))
  const items: MenuItemDef[] = [{ id: 'link', label: say(word('cm.linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('price-check') }]
  const info = (
    <>
      <p>{say(word('cm.price.info'))}</p>
      <p>{say(word('cm.keys'))}</p>
    </>
  )
  const buttons = model.differ
    ? [
        <Button key="work" size="sm" asChild>
          <Link href={model.differ.href}>{say(word('cm.price.seeWork'))}</Link>
        </Button>,
      ]
    : []
  // F-CP-141 → F-CM-303: the count is its own door (Work › Not equal), in the catalogue's own words.
  const answer = (
    <>
      {model.differ ? (
        <Link className="fw-pt-link" href={model.differ.href}>
          {say(word('parties:customers.work.priceDiffer', { params: { count: model.differ.count } }))}
        </Link>
      ) : null}
      {model.differ && model.missing ? ' · ' : null}
      {model.missing ? (
        <Link className="fw-pt-link" href={model.missing.href}>
          {say(word('cm.price.missing', { params: { count: model.missing.count } }))}
        </Link>
      ) : null}
      {model.calm ? say(model.calm) : null}
    </>
  )
  return (
    <Section id={kitId('price-check')} title={title} answer={answer} buttons={buttons} info={info} more={<LineMenuButton label={say(word('cm.price.more'))} items={items} />}>
      {model.reading ? <PartReading rows={2} height={30} /> : null}
      {model.problem ? <PartFailed part={say(word('cm.price.part'))} problem={model.problem} onRetry={onRetry} /> : null}
      {model.rows.length > 0 ? (
        <div className="fw-cm-list is-na" role="list" aria-label={title}>
          {model.rows.map((row) => {
            const rowSay = sayIn(row.currency)
            return (
              <div key={row.anchor} className="fw-cm-row" id={row.anchor} role="listitem" tabIndex={-1}>
                <div className="fw-cm-row-g">
                  <div className="fw-cm-row-k">
                    <span className="fw-cm-row-kt">
                      <b>
                        <Link className="fw-pt-link" href={row.href}>
                          <span className="fw-om-num">{row.number}</span> ›
                        </Link>
                      </b>
                      {row.lines !== null ? <span>{rowSay(word('orders:priceCheck.lines', { params: { count: row.lines } }))}</span> : null}
                      {row.accepted ? <Tag tone="info">{rowSay(word('orders:moneyTab.price.tag.accepted'))}</Tag> : null}
                    </span>
                  </div>
                  <div className="fw-cm-row-d">
                    {row.ours !== null ? <span>{`${rowSay(word('cm.price.ours'))}: ${money(row.ours, row.currency, locale)}`}</span> : null}
                    {row.theirs !== null ? <span>{`${rowSay(word('cm.price.theirs'))}: ${money(row.theirs, row.currency, locale)}`}</span> : null}
                  </div>
                  <div className="fw-cm-row-n" />
                  <div className="fw-cm-row-m">{row.diff !== null ? <span className="fw-om-amt">{`${row.diff > 0 ? '+' : ''}${money(row.diff, row.currency, locale)}`}</span> : null}</div>
                  <div className="fw-cm-row-a" />
                  <div className="fw-cm-row-o">
                    <LineMenuButton label={rowSay(word('cm.collect.rowMore', { params: { row: row.number } }))} items={[{ id: 'open', label: rowSay(word('cm.collect.openOrderMoney')), href: row.href }, { id: 'link', label: rowSay(word('orders:moneyTab.menu.copyLinkRow')), onSelect: () => copyLinkTo(row.anchor) }]} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
      {model.differ ? (
        <p className="fw-cm-foot">
          <span>{say(word('cm.price.foot'))}</span>
        </p>
      ) : null}
    </Section>
  )
}
