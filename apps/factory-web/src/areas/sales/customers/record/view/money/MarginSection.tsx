'use client'

import Link from 'next/link'
import { MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import { GapRow } from '../../../../orders/record/money/view/parts'
import { pctOf } from '../../../../orders/record/money/view/say'
import { word } from '../../../../orders/record/money/word'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Quiet, Section } from '../../../../orders/record/view/production/Kit'
import type { MarginModel } from '../../money/worth'
import { kitId } from '../../money/sections'
import type { CustomerSay } from '../../money/say'

/**
 * F-CM-303 (customer page › MONEY tab, cm-w3 W3.3; 10-design §5.8; D1) — section 8, Margin & cost (#margin; costing.view + the margin
 * grain): read when the section is reached (never on a burst). Value · Estimated cost (the cost grain) · Margin % (danger below the
 * floor), the orders below the floor with their door, the one honest sentence (never a supplier's total here). ⋯ Open in Finance ›
 * Margins ›. Draws its model; reads nothing.
 */
export function MarginSection({ model, sayIn, unit, onRetry }: { model: MarginModel; sayIn: (currency: string) => CustomerSay; unit: string; onRetry: () => void }) {
  const locale = useLocale()
  const say = sayIn(model.tiles?.currency ?? unit)
  const title = say(word('cm.margin.title'))
  const items: MenuItemDef[] = [
    { id: 'finance', label: say(word('cm.door.margins')), href: model.financeHref },
    { id: 'link', label: say(word('cm.linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('margin') },
  ]
  const info = (
    <>
      <p>{say(word('cm.margin.info'))}</p>
      <p>{say(word('cm.keys'))}</p>
    </>
  )
  const head = { id: kitId('margin'), title, info, more: <LineMenuButton label={say(word('cm.margin.more'))} items={items} /> }
  if (model.reading)
    return (
      <Section {...head} answer={say(word('cm.margin.reading'))}>
        <PartReading rows={2} />
      </Section>
    )
  if (model.problem)
    return (
      <Section {...head}>
        <PartFailed part={say(word('cm.margin.part'))} problem={model.problem} onRetry={onRetry} />
      </Section>
    )
  const tiles = model.tiles
  return (
    <Section {...head} answer={model.answer.map(say).join(' · ')}>
      <div className="fw-cm-bal">
        {tiles ? (
          <MetricStrip
            size="sm"
            metrics={[
              { label: say(word('cm.margin.value')), value: money(tiles.value, tiles.currency, locale) },
              ...(tiles.cost !== null ? [{ label: say(word('cm.margin.cost')), value: money(tiles.cost, tiles.currency, locale) }] : []),
              ...(tiles.pct !== null ? [{ label: say(word('cm.margin.pctLabel')), value: pctOf(tiles.pct, locale), ...(tiles.danger ? { accent: 'var(--nds-danger)' } : {}) }] : []),
            ]}
          />
        ) : model.twoCurrencies ? (
          <Quiet>{say(word('cm.margin.twoCurrencies'))}</Quiet>
        ) : null}
        {model.below ? (
          <GapRow
            words={say(word('cm.margin.belowRow', { params: { count: model.below.count } }))}
            door={
              <Link className="fw-pt-link" href={model.below.href}>
                {say(word('cm.margin.seeThem'))}
              </Link>
            }
          />
        ) : null}
        <p className="fw-cm-foot">
          <span>{say(word('cm.margin.honest'))}</span>
        </p>
      </div>
    </Section>
  )
}
