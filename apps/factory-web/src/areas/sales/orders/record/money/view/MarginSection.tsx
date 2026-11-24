'use client'

import { useState, type ReactNode } from 'react'
import { Hand, Scale, TrendingDown } from 'lucide-react'
import { MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { MarginMeter } from '@nexus/ui/charts/margin-meter/index'
import { useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { OrderMargin } from '../../../../../finance/margins/api'
import { MARGINS_NAMESPACE, orderProfitabilityHref } from '../../../../../finance/margins/model'
import { MarginLines, WorkOrderShares } from '../../../../../finance/margins/view/parts'
import { money } from '../../../../quotes/model'
import type { Order } from '../../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton } from '../../view/LineMenu'
import { PartFailed, PartReading, Section } from '../../view/production/Kit' // F-OM-101 (L6): the Production kit, in place
import { marginOf, type MarginView } from '../margin'
import { Fold } from './parts' // F-CM-k1: the shared fold
import { lineOf, pctOf, useSay, type Say } from './say'

type FoldId = 'lines' | 'workOrders' | 'why' // F-CM-k1: was `Fold` (the shared part's name now)

/**
 * F-OM-302 (order MONEY tab, 10-design §8) — section 5, Margin (#margin), in the kit (replaces margin/view/MarginTab.tsx): ONE card —
 * "Based on: cost at quote {day} · rev {r}"; four tiles (At quote · Now · Actual so far · Difference); the meter against the target,
 * else the floor; the cost lines set by hand (+ Put back); the pair Where it went | From the price to the margin (freight counted);
 * the folds By line · Work orders behind the cost · Why these figures; the doors Set a cost by hand… · Set target… · ⋯ Open in Finance ›
 * Margins ›. HIDDEN without the margin grain (or costing.view); amounts and the bridge also need the cost grain. Finance's own parts
 * (by line, the work orders) are drawn in place, in Finance's words; F-OM-fx3 (W-10): Where it went is the page's own, in points. Draws
 * its model; the container (use-margin) reads.
 */
export function MarginSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const margin = model.margin
  if (!model.can.margin || !margin?.can.view || !margin.can.margin) return null
  const part = margin.part
  const title = t('moneyTab.margin.title')
  const info = (
    <>
      <p>{t('moneyTab.margin.info')}</p>
      <p>{t('moneyTab.margin.keys')}</p>
    </>
  )
  const finance = (
    <LineMenuButton label={t('moneyTab.margin.more')} items={[{ id: 'finance', label: t('moneyTab.margin.finance'), href: orderProfitabilityHref(model.prefix, order.id) }]} />
  )
  if (!part || (!part.value && !part.problem)) {
    return (
      <Section id="margin" title={title} answer={t('moneyTab.margin.reading')} more={finance} info={info}>
        <PartReading rows={2} height={46} />
      </Section>
    )
  }
  if (!part.value) {
    return (
      <Section id="margin" title={title} more={finance} info={info}>
        <PartFailed part={t('moneyTab.margin.part')} problem={part.problem ?? 'problem.read.unavailable'} onRetry={() => actions?.onRetryMargin?.()} />
      </Section>
    )
  }
  return <Filled order={order} model={model} actions={actions} detail={part.value} title={title} info={info} />
}

function Filled({ order, model, actions, detail, title, info }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; detail: OrderMargin; title: string; info: ReactNode }) {
  const t = useT('orders')
  const locale = useLocale()
  const ds = useDsWords()
  const say = useSay(detail.currency)
  const [fold, setFold] = useState<FoldId | null>(null)
  const marginCan = model.margin!.can
  const view = marginOf({ detail, order, can: model.can, marginCan, prefix: model.prefix })

  const buttons = [
    view.setCost ? (
      <Button key="cost" size="sm" heldReason={view.setCost.held ? say(view.setCost.held) : null} onClick={() => actions?.onDialog?.({ kind: 'costLine' })}>
        <Hand size={13} aria-hidden /> {t('moneyTab.margin.setCost.door')}
      </Button>
    ) : null,
    view.setTarget ? (
      <Button key="target" size="sm" heldReason={view.setTarget.held ? say(view.setTarget.held) : null} onClick={() => actions?.onDialog?.({ kind: 'marginTarget' })}>
        {t('moneyTab.margin.target.door')}
      </Button>
    ) : null,
  ].filter((button) => button !== null)
  const items: MenuItemDef[] = [{ id: 'finance', label: t('moneyTab.margin.finance'), href: view.finance }]
  const pct = (value: number) => pctOf(value, locale) // F-OM-fx3 (W-19): the page's one percent format

  return (
    <Section id="margin" title={title} answer={lineOf(view.answer.map(say))} buttons={buttons} more={<LineMenuButton label={t('moneyTab.margin.more')} items={items} />} info={info}>
      <div className="fw-om-mg">
        <MetricStrip minTileWidth={150} metrics={view.tiles.map((tile) => ({ label: say(tile.label), value: <span className={tile.tone ? `fw-om-mg-v is-${tile.tone}` : undefined}>{say(tile.value)}</span>, hint: tile.points !== undefined ? t('moneyTab.margin.tile.points', { points: signedPoints(tile.points, locale) }) : tile.hint ? say(tile.hint) : undefined }))} />
        <div className="fw-om-mg-m">
          {/* F-OM-fx3 (W-09): the bar and the margin now (its sentence is its name); the ONE line under it says the rest, once. */}
          <MarginMeter size="mini" value={view.meter.now} floor={view.meter.floor} target={view.meter.target} allowed={marginCan.margin} format={pct} labels={ds.marginMeter} label={t('moneyTab.margin.meter.label')} />
          {view.meter.words.length > 0 ? <p className="fw-om-mg-ml">{lineOf(view.meter.words.map(say))}</p> : null}
        </div>
        {view.hand && view.hand.length > 0 ? <HandList view={view} currency={detail.currency} say={say} actions={actions} /> : null}
        <div className="fw-om-mg2">
          <div className="fw-om-mg-h">
            <h3 className="fw-pt-h3">
              <TrendingDown size={14} aria-hidden /> {t('moneyTab.margin.where')}
            </h3>
            {/* F-OM-fx3 (W-10): in points and the page's words (At quote → Materials · Making (CMT) · … → Now). */}
            {view.where ? view.where.length > 0 ? <Where rows={view.where} say={say} /> : <p className="fw-pt-quiet">{t('moneyTab.margin.whereNone')}</p> : <p className="fw-pt-quiet">{t('moneyTab.margin.bridge.noCost')}</p>}
          </div>
          <div className="fw-om-mg-h">
            <h3 className="fw-pt-h3">
              <Scale size={14} aria-hidden /> {t('moneyTab.margin.bridge.title')}
            </h3>
            {view.bridge ? <Bridge rows={view.bridge} detail={detail} say={say} /> : <p className="fw-pt-quiet">{t('moneyTab.margin.bridge.noCost')}</p>}
          </div>
        </div>
        <div className="fw-om-mg-folds">
          {(
            [
              ['lines', t('moneyTab.margin.fold.lines', { count: view.folds.lines })],
              ['workOrders', t('moneyTab.margin.fold.workOrders', { count: view.folds.workOrders })],
              ['why', t('moneyTab.margin.fold.why')],
            ] as const
          ).map(([id, label]) => (
            <Fold key={id} open={fold === id} onToggle={() => setFold((now) => (now === id ? null : id))} label={label} />
          ))}
        </div>
        {fold === 'lines' || fold === 'workOrders' ? (
          <div className="fw-om-mg-fold">
            <WithMessages namespaces={[MARGINS_NAMESPACE]}>{fold === 'lines' ? <MarginLines detail={detail} can={marginCan} /> : <WorkOrderShares detail={detail} can={marginCan} prefix={model.prefix} />}</WithMessages>
          </div>
        ) : fold === 'why' ? (
          <ul className="fw-om-mg-fold fw-om-dlg-list">
            {view.why.map((line) => (
              <li key={line.key}>{say(line)}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </Section>
  )
}

/** "−2.8" / "+1.2" points (a true minus sign), one decimal, in the page's language. */
function signedPoints(points: number, locale: Parameters<typeof formatNumber>[1]): string {
  const text = formatNumber(Math.abs(points), locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return points > 0 ? `+${text}` : points < 0 ? `−${text}` : text
}

/** The cost lines set by hand: what, how much (the cost grain), why, who and when — and Put back (the line's own remove, with a reason). */
function HandList({ view, currency, say, actions }: { view: MarginView; currency: string; say: Say; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const rows = view.hand ?? []
  return (
    <div className="fw-om-mg-bh">
      <h3 className="fw-pt-h3">
        <Hand size={14} aria-hidden /> {t('moneyTab.margin.hand.title', { count: rows.length })}
      </h3>
      {rows.map((row) => (
        <div key={row.id} className="fw-om-mg-bhr">
          <span>
            <b>{say(row.label)}</b>
            {row.amount !== null ? ` · ${money(row.amount, currency, locale)}` : ''} · {t('moneyTab.margin.hand.adds')}
          </span>
          <span className="fw-om-mg-bha">
            {row.putBack ? (
              <Button size="sm" variant="quiet" heldReason={row.putBack.held ? say(row.putBack.held) : null} onClick={() => actions?.onDialog?.({ kind: 'costLineRemove', lineId: row.id })}>
                {t('moneyTab.margin.putBack.door')}
              </Button>
            ) : null}
          </span>
          <span className="fw-pt-sub fw-om-mg-bhx">{lineOf([...(row.reason ? [t('priceCheck.card.note', { note: row.reason })] : []), say(row.who)])}</span>
        </div>
      ))}
    </div>
  )
}

/** F-OM-fx3 (W-10): Where it went — At quote, each part that moved in points (signed), Now. */
function Where({ rows, say }: { rows: NonNullable<MarginView['where']>; say: Say }) {
  const t = useT('orders')
  const locale = useLocale()
  return (
    <table className="fw-om-adds fw-om-mg-br">
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className={row.kind === 'end' ? 'is-sum' : undefined}>
            <td>{say(row.label)}</td>
            <td className="fw-om-r">{row.pct !== undefined ? pctOf(row.pct, locale) : row.points !== undefined ? t('moneyTab.margin.whereRow.points', { points: signedPoints(row.points, locale) }) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** From the price to the margin: price − each part − freight − the lines set by hand = margin (each amount the cost grain). */
function Bridge({ rows, detail, say }: { rows: NonNullable<MarginView['bridge']>; detail: OrderMargin; say: Say }) {
  const locale = useLocale()
  const amount = (value: number | null) => (value === null ? '' : money(Math.abs(value), detail.currency, locale))
  return (
    <table className="fw-om-adds fw-om-mg-br">
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className={row.kind === 'margin' ? 'is-sum' : row.kind === 'note' ? 'is-aside' : undefined}>
            <td>
              {row.kind === 'cost' || row.kind === 'freight' || row.kind === 'hand' ? '− ' : row.kind === 'margin' ? '= ' : ''}
              {say(row.label)}
              {row.tag ? (
                <>
                  {' '}
                  <Tag tone={row.kind === 'hand' ? 'info' : 'neutral'}>{say(row.tag)}</Tag>
                </>
              ) : null}
            </td>
            <td className="fw-om-r">
              {row.kind === 'margin' && detail.estimateMarginPct ? `${amount(row.amount)} · ${pctOf(detail.estimateMarginPct, locale)}` : amount(row.amount)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
