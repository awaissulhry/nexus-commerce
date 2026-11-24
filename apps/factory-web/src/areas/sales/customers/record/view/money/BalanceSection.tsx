'use client'

import { Fragment, type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import { MetricStrip, type MenuItemDef, type Metric } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives' // F-CM-204
import { useLocale } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import { Facts, GapRow } from '../../../../orders/record/money/view/parts'
import { keepNumbers, sentenceOf } from '../../../../orders/record/money/view/say'
import { word } from '../../../../orders/record/money/word'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Section } from '../../../../orders/record/view/production/Kit'
import type { BalanceModel, BalanceTile, Need } from '../../money/balance'
import { kitId } from '../../money/sections'
import type { CustomerSay } from '../../money/say'

/**
 * F-CM-104 (customer page › MONEY tab, 10-design §5.1) — section 1, Balance (#balance), drawn in the Production kit's Section (in place)
 * with the shared parts (GapRow, Facts) and the DS MetricStrip: the figures in two groups per currency (price grain), the open invoices
 * by age (five cells), "What needs you · N" (each need its ONE door: a section of this tab when it is drawn, else its address with this
 * customer chosen), the facts. Draws its model (money/balance.ts); reads nothing.
 */

/** A tile's link: a section of this tab scrolls (`#collect`), another address opens (the workspace's own link). */
function TileLink({ href, className, title, children }: { href: string; className?: string; title?: string; children?: ReactNode }) {
  return href.startsWith('#') ? (
    <a href={href} className={className} title={title}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className} title={title}>
      {children}
    </Link>
  )
}

/** The words of a section a need scrolls to ("To collect ↓"); a section not drawn yet has none (its need takes its address). */
const DOWN_TITLE: Readonly<Record<string, string>> = { collect: 'cm.collect.title', invoices: 'orders:moneyTab.invoices.title' /* F-CM-202 */, received: 'cm.received.title', 'on-account': 'cm.received.title', 'give-back': 'cm.balance.giveBack' /* F-CM-203 */, credit: 'cm.credit.title', statement: 'cm.chase.title', 'price-check': 'orders:moneyTab.price.title' /* F-CM-301…303 (Z31) */ }

export interface BalanceSectionProps {
  readonly model: BalanceModel
  /** The ids of the sections (and boxes) drawn on the tab: a door ↓ only to one of them. */
  readonly present: ReadonlySet<string>
  readonly sayIn: (currency: string) => CustomerSay
  /** The customer's own currency (words without an amount are said in it). */
  readonly unit: string
  /** "Counts as of 10:44" (the ageing read's time). */
  readonly asOf: string | null
  /** The head's ⋯: doors with this customer chosen (built by the layout from the rights). */
  readonly menu: readonly MenuItemDef[]
  /** The page's money read failed (an `orders` problem key) — one line with its own Try again. */
  readonly failed: string | null
  readonly onRetry: () => void
  /** F-CM-204: "Record a payment ›" — Finance's window with this customer chosen (payments.record + price); null: not drawn. */
  readonly recordPaymentHref?: string | null
  /** F-CM-302: Statement… — Finance's statement window, in place (receivables.view + price, something to state); absent: not drawn. */
  readonly onStatement?: () => void
}

export function BalanceSection({ model, present, sayIn, unit, asOf, menu, failed, onRetry, recordPaymentHref, onStatement }: BalanceSectionProps) {
  const locale = useLocale()
  const say = sayIn(unit)
  const title = say(word('cm.balance.title'))
  const tileOf = (tile: BalanceTile, currency: string): Metric => {
    const value = 'amount' in tile.value ? money(tile.value.amount, currency, locale) : say(tile.value.words)
    const href = 'down' in tile.door ? (present.has(tile.door.down) ? `#${tile.door.down}` : null) : tile.door.href
    return { label: say(tile.label), value, hint: tile.hint ? sayIn(currency)(tile.hint) : undefined, ...(href ? { href } : {}) }
  }
  const doorOf = (need: Need): ReactNode => {
    if (need.down && present.has(need.down) && DOWN_TITLE[need.down])
      return (
        <a className="fw-pt-link" href={`#${need.down}`}>
          {say(word('cm.door.down', { words: { section: word(DOWN_TITLE[need.down]!) } }))}
        </a>
      )
    if (need.fallback?.kind === 'href' && need.code !== 'priceDiffer')
      return (
        <Link className="fw-pt-link" href={need.fallback.href}>
          {say(need.fallback.label)}
        </Link>
      )
    return null
  }
  const needWords = (need: Need): ReactNode => {
    const text = sayIn(need.currency ?? unit)(need.words)
    // F-CP-141 → F-CM-303 (Z31): "Prices differ on N orders" points ↓ to Price check; without that section, its own door (Work › Not equal).
    if (need.code === 'priceDiffer' && need.fallback?.kind === 'href' && !(need.down && present.has(need.down)))
      return (
        <Link className="fw-pt-link" href={need.fallback.href}>
          {say(need.fallback.label)}
        </Link>
      )
    return keepNumbers(sentenceOf([text]))
  }
  const items: MenuItemDef[] = [...menu, { id: 'link', label: say(word('cm.linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('balance') }]
  const info = (
    <>
      <p>{say(word('cm.balance.info'))}</p>
      <p>{say(word('cm.keys'))}</p>
    </>
  )
  return (
    <Section
      id={kitId('balance')}
      title={title}
      answer={model.answer.map(say).join(' · ')}
      asOf={asOf}
      buttons={[
        ...(recordPaymentHref
          ? [
              <Button key="record" size="sm" asChild>
                <Link href={recordPaymentHref}>{`${say(word('finance:recordPay.title'))} ›`}</Link>
              </Button>,
            ]
          : []),
        ...(onStatement
          ? [
              <Button key="statement" size="sm" onClick={onStatement}>
                {say(word('cm.chase.statement'))}
              </Button>,
            ]
          : []),
      ]}
      more={<LineMenuButton label={say(word('cm.balance.more'))} items={items} />}
      info={info}
    >
      <div className="fw-cm-bal">
        {failed ? <PartFailed part={say(word('cm.balance.part'))} problem={failed} onRetry={onRetry} /> : null}
        {model.reading && !failed ? <PartReading rows={3} /> : null}
        {(model.blocks ?? []).map((block, index) => (
          <Fragment key={block.currency ?? `block-${index}`}>
            {block.currency ? <span className="fw-cm-cur">{say(word('finance-receivables:tiles.currency', { params: { currency: block.currency } }))}</span> : null}
            {block.groups.length > 0 ? (
              <div className="fw-cm-figs">
                {block.groups.map((group) => (
                  <div key={group.kind} className="fw-cm-fig" style={{ '--n': group.tiles.length } as CSSProperties}>
                    <span className="fw-pt-label">{say(group.label)}</span>
                    <MetricStrip size="sm" linkAs={TileLink} metrics={group.tiles.map((tile) => tileOf(tile, block.unit))} />
                  </div>
                ))}
              </div>
            ) : null}
            {block.ageing ? (
              <div className="fw-cm-blk">
                <span className="fw-pt-label">{block.currency ? say(word('cm.dot', { words: { first: word('cm.balance.ageing'), second: word('cm.text', { params: { text: block.currency } }) } })) : say(word('cm.balance.ageing'))}</span>
                <dl className="fw-cm-cells" style={{ '--n': block.ageing.length } as CSSProperties}>
                  {block.ageing.map((cell) => (
                    <div key={cell.bucket} className={cell.amount === 0 ? 'is-none' : cell.late ? 'is-danger' : undefined}>
                      <dt>{say(word(`finance-receivables:bucket.${cell.bucket}`))}</dt>
                      <dd>{cell.amount === 0 ? '—' : money(cell.amount, block.unit, locale)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
          </Fragment>
        ))}
        {model.needs.length > 0 ? (
          <div className="fw-cm-blk">
            <h3 className="fw-pt-h3 fw-cm-h3">{say(word('cm.balance.needsTitle', { params: { count: model.needs.length } }))}</h3>
            <div className="fw-cm-needs">
              {model.needs.map((need) => (
                <GapRow key={`${need.code}-${need.currency ?? ''}`} words={needWords(need)} door={doorOf(need)} />
              ))}
            </div>
          </div>
        ) : model.calm ? (
          <GapRow ok words={say(model.calm)} />
        ) : null}
        {model.reading ? null : (
          <Facts
            facts={model.facts.map((fact) => ({
              key: fact.key,
              label: say(fact.label),
              value: fact.href ? (
                <Link className="fw-pt-link" href={fact.href}>
                  {say(fact.value)}
                </Link>
              ) : (
                say(fact.value)
              ),
            }))}
          />
        )}
      </div>
    </Section>
  )
}
