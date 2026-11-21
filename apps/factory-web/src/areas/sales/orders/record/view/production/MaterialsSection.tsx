'use client'

import Link from 'next/link'
import { PackagePlus, Reply, ShoppingCart } from 'lucide-react'
import { Disclosure, ProgressBar, type MenuItemDef } from '@nexus/ui/components'
import { Button, Tag, ToolbarButton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../../lib/records/record-links'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../../../../shell/nav/office-nav'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { ReadinessPill } from '../../../../../production/work-orders/daily/view/DailyParts'
import type { Order } from '../../../api'
import { dayInstant, isFinal } from '../../../model'
import { NAMESPACE as DEPTH, planHeld, quantityText } from '../../../depth/model'
import { readOf } from '../../overview/model'
import { askOf, boughtOf, customerGoodsOf, isThere, materialsAnswerOf } from '../../production/materials'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton } from '../LineMenu'
import { PartFailed, PartReading, Quiet, Section } from './Kit'
import { ReceiptDialog } from './ReceiptDialog' // F-PT-304

const WORK_ORDERS_NS = 'production-work-orders'

/**
 * F-PT-303 (order PRODUCTION tab, 10-design §8; S9; L4) — "Materials" (#materials): ONE answer ("Everything is here for the work orders
 * made so far" / "2 things are missing"), the missing things first (the customer's goods still to come — "Waits on the customer", Ask
 * the customer (the thread's Reply box: the customer's own words, never a work-order or PO number) — and what we buy not there yet —
 * "Waits on the supplier", Open PO-… with purchasing.view), then "From the customer" (Arrived, used, left, still to come; its lots) and
 * "What we buy" (by material, the ready ones folded). Quantities only, never money. "Arrived" is this tab's word for the customer's
 * goods (L4: the shared readiness words stay as they are). ⋯ Update from the BOM (orders.manage, the depth's own act).
 */
export function MaterialsSection(props: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[DEPTH]}>
      <Materials {...props} />
    </WithMessages>
  )
}

function Materials({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const r = useT(WORK_ORDERS_NS)
  const locale = useLocale()
  const frame = useRecordFrame()
  const read = readOf(model.production)
  const part = model.depth?.materials ?? null
  const goods = customerGoodsOf(part?.value)
  const numberOf = (id: string) => read?.work?.workOrders.find((row) => row.id === id)?.number ?? order.chain.workOrders.find((row) => row.id === id)?.number ?? null
  const bought = boughtOf(model.readiness?.value, numberOf)
  // What we buy is planned on the work orders made from stock lines (made-to-measure units read their own materials on their page).
  const workOrders = read?.work?.workOrders.length ?? order.chain.workOrders.length
  const answer = materialsAnswerOf(goods, bought, workOrders)
  const q = (value: number, uom: string | null) => `${quantityText(String(value), locale)}${uom ? ` ${uom}` : ''}`
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const poHref = (id: string, number: string) => `${model.prefix}${recordAddress({ type: 'PurchaseOrder', id, label: number, companyId: order.companyId }, OFFICE_PAGES)}`
  const mayAsk = !!model.people?.mayNote && !!frame?.compose
  const held = model.depth ? planHeld(model.depth.can, order.status) : null
  const items: MenuItemDef[] = model.depth?.can.manage ? [{ id: 'plan', label: d('materials.plan'), disabled: !!held || model.busy, description: held ? d(held.key) : model.busy ? t('held.busy') : undefined, onSelect: () => actions?.depth?.onPlan?.() }] : []
  const missingGoods = (goods ?? []).filter((good) => good.toCome > 0)
  const missingBought = (bought ?? []).filter((material) => !isThere(material))
  const readyBought = (bought ?? []).filter((material) => isThere(material))
  // F-PT-304: Record what the customer sent… (inventory.receive; hidden without it, L9; held in words on a finished order or a write).
  const receiveHeld = model.busy ? t('held.busy') : isFinal(order) ? d('held.final') : null
  const record = (only: string | null, label: string) =>
    model.receipt ? (
      <Button key={`record-${only ?? 'all'}`} size="sm" variant={only ? 'quiet' : undefined} heldReason={receiveHeld} onClick={() => actions?.receipt?.onOpen(only)}>
        <PackagePlus size={14} aria-hidden /> {label}
      </Button>
    ) : null
  const workOrderSites = order.chain.workOrders.map((row) => ({ id: row.id, siteId: row.siteId }))
  const answerWords = answer.kind === 'missing' ? t('productionTab.materials.missing', { count: answer.count }) : answer.kind === 'allHere' ? t('productionTab.materials.allHere') : answer.kind === 'noWork' ? t('productionTab.materials.noWork') : null

  return (
    <Section id="materials" title={t('productionTab.materials.title')} answer={answerWords} buttons={model.receipt && goods && goods.length > 0 ? [record(null, t('productionTab.receipt.open'))] : undefined} more={items.length > 0 ? <LineMenuButton label={t('productionTab.more', { section: t('productionTab.materials.title') })} items={items} /> : null} info={<p>{t('productionTab.materials.infoBody')}</p>}>
      {missingGoods.length + missingBought.length > 0 ? (
        <ul className="fw-pt-moves" aria-label={t('productionTab.materials.missingTitle')}>
          {missingGoods.map((good) => (
            <li key={good.id} className="fw-pt-move" id={`about-CustomerMaterial-${good.id}`}>
              <b>{[good.item, good.colour].filter(Boolean).join(' · ')}</b>
              <span className="fw-pt-sub">{t('productionTab.materials.stillToCome', { quantity: q(good.toCome, good.uom), arrived: q(good.arrived, null), expected: q(good.expected, good.uom) })}</span>
              <span className="fw-pt-inline">
                <Tag tone="warning">{t('productionTab.materials.waitsCustomer')}</Tag>
                {mayAsk ? <ToolbarButton icon={<Reply size={14} aria-hidden />} label={t('productionTab.materials.askCustomer')} onClick={() => frame?.compose?.({ messageId: null, mode: 'reply' })} /> : null}
                {record(good.id, t('productionTab.receipt.openRow'))}
              </span>
            </li>
          ))}
          {missingBought.map((material) => (
            <li key={material.key} className="fw-pt-move">
              <b>{material.label ?? '—'}</b>
              <span className="fw-pt-inline">
                <ReadinessPill word={material.word} date={material.date} />
                {material.short !== null && material.short > 0 ? <span className="fw-pt-sub">{r('readiness.short', { quantity: quantityText(String(material.short), locale), uom: material.uom ?? '' })}</span> : null}
                {material.workOrders.length > 0 ? <span className="fw-pt-sub">{material.workOrders.join(', ')}</span> : null}
              </span>
              <span className="fw-pt-inline">
                <Tag tone="neutral">{t('productionTab.materials.waitsSupplier')}</Tag>
                {material.purchaseOrders.map((po) => (
                  <Link key={po.id} className="fw-pt-link" href={poHref(po.id, po.number)}>
                    {t('productionTab.materials.openPo', { number: po.number })}
                    {po.dueDate ? ` · ${day(po.dueDate)}` : ''}
                  </Link>
                ))}
                {(() => {
                  // F-PT-304: Ask the buyers… (the Material plan's own dialog, per work order short of it); once asked "Asked 20 Nov".
                  if (!model.askBuyers) return null
                  const ask = askOf(material, workOrderSites, model.askBuyers.asked, model.today)
                  if (!ask) return null
                  if (ask.kind === 'asked') return <span className="fw-pt-sub">{t('productionTab.materials.asked', { date: formatDate(ask.at, { locale }) })}</span>
                  return (
                    <Button size="sm" variant="quiet" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onAskBuyers?.(ask.line)}>
                      <ShoppingCart size={14} aria-hidden /> {t('productionTab.materials.askBuyers')}
                    </Button>
                  )
                })()}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="fw-pt-mat">
        <div className="fw-pt-now-blk">
          <h3 className="fw-pt-h3">{t('productionTab.materials.customerTitle')}</h3>
          {part && !part.value && !part.problem ? <PartReading rows={2} height={22} /> : null}
          {part?.problem ? <PartFailed part={t('productionTab.materials.customerTitle')} problem={part.problem} onRetry={() => actions?.depth?.onRetry?.('materials')} /> : null}
          {goods && goods.length === 0 ? <Quiet>{t('productionTab.materials.nothingFromCustomer')}</Quiet> : null}
          {goods && goods.length > 0 ? (
            <table className="fw-pt-table">
              <thead>
                <tr>
                  <th scope="col">{t('productionTab.materials.col.material')}</th>
                  <th scope="col">{t('productionTab.materials.col.arrived')}</th>
                  <th scope="col">{t('productionTab.materials.col.used')}</th>
                  <th scope="col">{t('productionTab.materials.col.left')}</th>
                  <th scope="col">{t('productionTab.materials.col.state')}</th>
                </tr>
              </thead>
              <tbody>
                {goods.map((good) => (
                  <tr key={good.id}>
                    <td className="fw-pt-first">
                      {[good.item, good.colour].filter(Boolean).join(' · ')}
                      <span className="fw-pt-sub">{good.code}</span>
                      {good.lots.length > 0 ? <span className="fw-pt-sub">{t('productionTab.materials.lots', { lots: good.lots.join(', ') })}</span> : null}
                    </td>
                    <td data-label={t('productionTab.materials.col.arrived')}>
                      <span className="fw-pt-bar">
                        <ProgressBar value={good.expected > 0 ? Math.min(100, Math.round((good.arrived / good.expected) * 100)) : null} ariaLabel={t('productionTab.materials.arrivedOf', { arrived: q(good.arrived, null), expected: q(good.expected, good.uom) })} height={6} />
                      </span>
                      {t('productionTab.materials.arrivedOf', { arrived: q(good.arrived, null), expected: q(good.expected, good.uom) })}
                    </td>
                    <td data-label={t('productionTab.materials.col.used')}>{q(good.used, good.uom)}</td>
                    <td data-label={t('productionTab.materials.col.left')}>{q(good.left, good.uom)}</td>
                    <td data-label={t('productionTab.materials.col.state')}>{good.toCome > 0 ? <Tag tone="warning">{t('productionTab.materials.toCome', { quantity: q(good.toCome, good.uom) })}</Tag> : <Tag tone="success">{t('productionTab.materials.allArrived')}</Tag>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
        <div className="fw-pt-now-blk fw-pt-mat-buy">
          <h3 className="fw-pt-h3">{t('productionTab.materials.buyTitle')}</h3>
          {workOrders === 0 ? <Quiet>{t('productionTab.materials.noWork')}</Quiet> : null}
          {model.readiness && !model.readiness.value && !model.readiness.problem ? <PartReading rows={2} height={22} /> : null}
          {model.readiness?.problem ? <PartFailed part={t('productionTab.materials.buyTitle')} problem={model.readiness.problem} /> : null}
          {bought && bought.length > 0 ? (
            <>
              {missingBought.length > 0 ? (
                <ul className="fw-pt-units">
                  {missingBought.map((material) => (
                    <li key={material.key} className="fw-pt-inline">
                      <span>{material.label ?? '—'}</span> <ReadinessPill word={material.word} date={material.date} />
                      {material.needed !== null ? <span className="fw-pt-sub">{t('productionTab.materials.needed', { quantity: q(material.needed, material.uom) })}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {readyBought.length > 0 ? (
                <Disclosure summary={t('productionTab.materials.folded', { word: r('readiness.RECEIVED'), count: readyBought.length })}>
                  <ul className="fw-pt-units">
                    {readyBought.map((material) => (
                      <li key={material.key}>{material.label ?? '—'}</li>
                    ))}
                  </ul>
                </Disclosure>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <Disclosure summary={t('productionTab.materials.howTitle')}>
        <p className="fw-pt-hint">{t('productionTab.materials.howBody')}</p>
      </Disclosure>
      {model.receipt?.dialog ? <ReceiptDialog order={order} model={model.receipt.dialog} actions={actions?.receipt} /> : null}
      {model.askBuyers?.element ?? null}
    </Section>
  )
}
