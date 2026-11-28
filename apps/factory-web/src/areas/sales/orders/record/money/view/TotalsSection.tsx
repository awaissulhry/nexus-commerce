'use client'

import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { money } from '../../../../quotes/model'
import type { Order } from '../../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton } from '../../view/LineMenu'
import { PartFailed, Section } from '../../../../../../lib/record-sections/Kit' // F-OM-101 (L6): the Production kit, in place
import { totalsOf, type TotalsDoor } from '../totals'
import { Facts, Fold, GapRow } from './parts' // F-CM-k1: the shared parts (a gap, the fold, the facts)
import { useSay } from './say'

/** A hash link: the browser scrolls to the section (and its address names it). */
function HashLink({ href, className, children }: { href: string; className?: string; children?: ReactNode }) {
  return (
    <a href={href} className={className}>
      {children}
    </a>
  )
}

/**
 * F-OM-102 (order MONEY tab, 10-design §4) — section 1, Totals (#totals): four tiles (Order total · VAT incl. · Invoiced › · Paid ›
 * "of which deposits" · Still to pay — the price grain only, the server's figures only), the state line "Settled · nothing left" /
 * "Not settled yet · N things left" with each gap's door (Shipments ›, Invoices ↓, Payments ↓), "How it adds up" folded, the facts
 * (Deposit in paid words, Payment terms, Margin now › with the margin grain, Cost now with the cost grain) and ⋯ Close unsettled…
 * (the band's own dialog; orders.close). A failed settlement read is its own line with Try again; the rest still draws.
 */
export function TotalsSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const say = useSay(order.currency)
  const search = useSearchParams()?.toString() ?? ''
  const [adding, setAdding] = useState(false)
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const settlementPart = model.can.viewInvoices ? model.settlement : null
  const totals = totalsOf({ order, settlement: settlementPart?.value ?? null, can: model.can, marginNow: model.margin?.part?.value?.estimateMarginPct ?? null, today: model.today })
  const title = t('moneyTab.totals.title')
  const doorOf = (door: TotalsDoor): ReactNode =>
    door === 'shipments' ? (
      <TabLink className="fw-pt-link" href={tabHref(recordHref, 'shipments', search)}>
        {t('moneyTab.totals.door.shipments')}
      </TabLink>
    ) : (
      <a className="fw-pt-link" href={`#${door}`}>
        {t(`moneyTab.totals.door.${door}`)}
      </a>
    )
  const items: MenuItemDef[] = [
    ...(totals.close ? [{ id: 'close', label: t('moneyTab.totals.close'), disabled: !!totals.close.held, description: totals.close.held ? say(totals.close.held) : undefined, onSelect: () => actions?.onDialog?.({ kind: 'close' }) }] : []),
    {
      id: 'link',
      label: t('moneyTab.menu.copyLinkTotals'),
      onSelect: () => void navigator.clipboard?.writeText(new URL(`${tabHref(recordHref, 'money', search)}#totals`, window.location.href).toString()),
    },
  ]
  const info = (
    <>
      <p>{t('moneyTab.totals.info')}</p>
      <p>{t('moneyTab.totals.keys')}</p>
    </>
  )
  // F-OM-fx3 (W-05): What is left only when it holds something (a gap, the settled row, How it adds up).
  const left = !!totals.settledRow || totals.gaps.length > 0 || !!totals.adds
  // F-OM-fx5w (N10): no tile and no gap with a door (a reader without invoices.view): nothing reaches the right edge of a half — What is
  // left takes the whole width and the facts spread along it (money.css `is-nd`), never an empty right half.
  const doorless = !totals.tiles && !totals.gaps.some((gap) => !!gap.door)
  // A settlement read that failed (invoices.view): one line with its own Try again, where the tiles would be.
  const failed = settlementPart?.problem ? <PartFailed part={t('moneyTab.totals.part')} problem={settlementPart.problem} onRetry={() => actions?.onRetryPart?.('settlement')} /> : null
  return (
    <Section id="totals" title={title} answer={say(totals.answer)} more={<LineMenuButton label={t('moneyTab.totals.more')} items={items} />} info={info}>
      <div className={`fw-om-tt${totals.tiles ? '' : ' is-np'}${left ? '' : ' is-nr' /* F-OM-fx3 (W-05) */}${doorless ? ' is-nd' /* F-OM-fx5w (N10) */ : ''}`}>
        {failed ? <div className="fw-om-tt-t">{failed}</div> : null}
        {totals.tiles && !failed ? (
          <div className="fw-om-tt-t">
            <MetricStrip
              minTileWidth={140}
              linkAs={HashLink}
              metrics={totals.tiles.map((tile) => ({ label: say(tile.label), value: money(tile.amount, order.currency, locale), hint: tile.hint ? say(tile.hint) : undefined, ...(tile.door ? { href: `#${tile.door}` } : {}) }))}
            />
          </div>
        ) : null}
        {/* F-OM-fx3 (W-05): an empty part is one line (the head's answer), never a heading over nothing. */}
        {left ? (
        <div className="fw-om-tt-r">
          {totals.settledRow || totals.gaps.length > 0 ? <h3 className="fw-pt-h3">{totals.settled ? t('moneyTab.totals.nothingLeft') : t('moneyTab.totals.whatIsLeft', { count: totals.gaps.length })}</h3> : null}
          {totals.settledRow ? (
            <GapRow ok words={say(totals.settledRow)} />
          ) : (
            totals.gaps.map((gap) => <GapRow key={gap.code} words={say(gap.words)} extra={gap.extra ? say(gap.extra) : undefined} door={gap.door ? doorOf(gap.door) : undefined} />)
          )}
          {totals.adds ? (
            <>
              <Fold open={adding} onToggle={() => setAdding((now) => !now)} label={t('moneyTab.totals.adds.title')} hint={t('moneyTab.totals.adds.hint')} />
              {adding ? (
                <table className="fw-om-adds">
                  <tbody>
                    {totals.adds.map((row) => (
                      <tr key={row.words.key} className={row.sign === 'sum' ? 'is-sum' : row.sign === 'aside' ? 'is-aside' : undefined}>
                        <td>
                          {row.sign === 'minus' ? '− ' : row.sign === 'sum' ? '= ' : ''}
                          {say(row.words)}
                        </td>
                        <td className="fw-om-r">{money(row.amount, order.currency, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </>
          ) : null}
        </div>
        ) : null}
        <Facts
          facts={totals.facts.map((fact) => ({
            key: fact.label.key,
            label: say(fact.label),
            // a fact's door stays this page's: Margin now › lands on #margin
            value: fact.door ? (
              <a className="fw-pt-link" href={`#${fact.door}`}>
                {t('moneyTab.totals.fact.door', { value: say(fact.value) })}
              </a>
            ) : (
              say(fact.value)
            ),
          }))}
        />
      </div>
    </Section>
  )
}
