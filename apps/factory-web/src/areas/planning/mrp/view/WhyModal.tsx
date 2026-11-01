'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { FilePlus2 } from 'lucide-react'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { dayAt, decimalValue, quantity } from '../../../_shared/buying/model'
import type { Explain, PegDemand, PlanLine, StockLine } from '../api'
import { draftHeld, MRP_NAMESPACE, type PlanActions, type PlanModel } from '../model'
import '../mrp.css'

/**
 * "Why this number — <material>" (design planning.mrp why-drawer, shown as a centred detail: the Owner's rule for
 * details): the netting as sentences from the numbers, the ladder (need → − usable → − on order → = short → rounding →
 * = buy), what each order and size needs, today's stock with the reason a lot is not counted, the open purchase lines
 * (one arriving after the need is not counted), and the dates. The DS DetailModal (B-W2b-18): its Prev / Next (J / K)
 * walk the lines, b drafts the PO, Esc closes.
 * Every word is this app's (the API's English sentence is never drawn).
 */
export function WhyModal({ model, actions, order }: { model: PlanModel; actions?: PlanActions; order: readonly string[] }) {
  const t = useT('buying')
  const w = useT(MRP_NAMESPACE)
  const locale = useLocale()
  const why = model.why!
  const explain = why.explain.status === 'ready' ? why.explain.value : null
  const planLine = model.plan.status === 'ready' ? (model.plan.value.lines.find((line) => line.id === why.lineId) ?? null) : null
  const line: PlanLine | null = explain?.line ?? planLine
  const held = line ? draftHeld(line, model.can) : null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'b' && !event.metaKey && !event.ctrlKey && line && !held) {
        const target = event.target as HTMLElement | null
        if (target?.closest('input, textarea, select')) return
        event.preventDefault()
        actions?.onDraftOne?.(line.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const unit = line ? t(`uom.${line.uom}`) : ''
  const q = (value: string | null | undefined) => quantity(value, locale)

  return (
    <DetailModal
      open
      onClose={() => actions?.onWhy?.(null)}
      title={line ? t('why.title', { material: `${line.item.code} ${line.item.name}${line.colour ? ` · ${line.colour.name}` : ''}` }) : t('why.titleLoading')}
      subtitle={line ? t('why.subtitle', { action: t(`plan.action.${line.action}`), supplier: line.supplier?.name ?? t('plan.noSupplier') }) : undefined}
      // Prev / Next with "3 of 12", J / K and the held ends: the DS DetailModal's (B-W2b-18), over the plan's lines as shown.
      nav={order.includes(why.lineId) ? { ids: order, current: why.lineId, onGo: (id) => actions?.onWhy?.(id), noun: t('why.noun') } : undefined}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onWhy?.(null)}>
            {t('common.close')}
          </Button>
          {line?.action === 'BUY' && (
            <Button size="sm" variant="primary" heldReason={held ? (held === 'held.noPurchasing' ? w('held.noPurchasingRequests') : t(held)) : null} onClick={() => line && actions?.onDraftOne?.(line.id)} aria-keyshortcuts="b">
              <FilePlus2 size={13} aria-hidden /> {t('plan.draftShort')}
            </Button>
          )}
        </>
      }
    >
      {why.explain.status === 'loading' ? (
        <p className="fw-by-hint" role="status">
          <Spinner size={14} /> {t('why.loading')}
        </p>
      ) : why.explain.status !== 'ready' ? (
        <Banner tone="danger" title={t(why.explain.status === 'error' ? why.explain.problem : 'problem.gone')} />
      ) : (
        <WhyBody explain={why.explain.value} unit={unit} q={q} model={model} actions={actions} />
      )}
    </DetailModal>
  )
}

function WhyBody({ explain, unit, q, model, actions }: { explain: Explain; unit: string; q: (value: string | null | undefined) => string; model: PlanModel; actions?: PlanActions }) {
  const t = useT('buying')
  const w = useT(MRP_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const { line, now } = explain
  const held = decimalValue(line.heldStock) ?? 0
  const short = (decimalValue(line.netQuantity) ?? 0) > 0
  const sentences = [
    t('why.s.need', { quantity: q(line.grossQuantity), unit, count: line.orders.length }),
    t('why.s.usable', { quantity: q(line.usableStock), unit }),
    ...(held > 0 ? [t('why.s.held', { quantity: q(line.heldStock), unit })] : []),
    (decimalValue(line.onOrder) ?? 0) > 0 ? t('why.s.onOrder', { quantity: q(line.onOrder), unit }) : t('why.s.nothingOnOrder'),
    short ? t('why.s.short', { quantity: q(line.netQuantity), unit }) : t('why.s.covered'),
    ...(short && line.action === 'BUY'
      ? [
          line.estimatedHides !== null && line.suggestedUom !== 'HIDE'
            ? t('why.s.buyHides', { quantity: q(line.suggestedQuantity), unit: t(`uom.${line.suggestedUom}`), count: line.estimatedHides })
            : t('why.s.buy', { quantity: q(line.suggestedQuantity), unit: t(`uom.${line.suggestedUom}`) }),
        ]
      : short
        ? [t('why.s.make', { quantity: q(line.suggestedQuantity), unit: t(`uom.${line.suggestedUom}`) })]
        : []),
    ...(line.orderBy
      ? [
          line.orderBy.leadTimeDays === null
            ? t('why.s.orderByNoLead', { date: formatDate(dayAt(line.orderBy.date), place) })
            : t('why.s.orderBy', { date: formatDate(dayAt(line.orderBy.date), place), need: formatDate(dayAt(line.needDate), place), count: line.orderBy.leadTimeDays }),
        ]
      : []),
  ]

  return (
    <div className="fw-by-dialog">
      {now.changedSinceRun && (
        <Banner
          tone="info"
          title={t('why.changed', { usable: q(now.usableStock), onOrder: q(now.onOrder), net: q(now.netQuantity), unit })}
          action={
            model.can.planRun ? (
              <Button size="sm" onClick={() => actions?.onRun?.()} heldReason={model.running ? t('held.running') : null}>
                {t('plan.run')}
              </Button>
            ) : undefined
          }
        />
      )}
      <section className="fw-by-stack" aria-labelledby="fw-why-words">
        <h3 id="fw-why-words" className="fw-by-h3">
          {t('why.words')}
        </h3>
        <p className="fw-by-text">{sentences.join(' ')}</p>
      </section>

      <section className="fw-by-stack" aria-labelledby="fw-why-ladder">
        <h3 id="fw-why-ladder" className="fw-by-h3">
          {t('why.ladder')}
        </h3>
        <ol className="fw-by-ladder">
          {explain.bridge.map((rung) => (
            <li key={rung.step} className={rung.step === 'SHORT' || rung.step === 'BUY' ? 'fw-by-rung is-result' : 'fw-by-rung'}>
              <span className="fw-by-rung-label">{t(`why.step.${rung.step}.${line.action}`)}</span>
              <span className="fw-by-rung-value">
                {(decimalValue(rung.quantity) ?? 0) < 0 ? '− ' : rung.step === 'ROUNDING' ? '+ ' : rung.step === 'SHORT' || rung.step === 'BUY' ? '= ' : ''}
                {quantity(Math.abs(decimalValue(rung.quantity) ?? 0), locale)} {t(`uom.${rung.uom}`)}
              </span>
            </li>
          ))}
        </ol>
        {explain.rounding.length > 0 && (
          <ul className="fw-by-list">
            {explain.rounding.map((step) => (
              <li key={step.rule}>{t(`why.rounding.${step.rule}`, { quantity: q(step.quantity), unit: t(`uom.${line.suggestedUom}`) })}</li>
            ))}
          </ul>
        )}
      </section>

      <div className="fw-by-stack">
        <section className="fw-by-card" aria-labelledby="fw-why-orders">
          <h3 id="fw-why-orders" className="fw-by-h3">
            {t('why.orders')}
          </h3>
          {line.sources.length === 0 ? (
            <p className="fw-by-hint">{t('why.noOrders')}</p>
          ) : (
            <SummaryTable
              label={t('why.orders')}
              density="compact"
              stackOnPhone
              columns={[t('why.col.order'), t('why.col.size'), t('why.col.pieces'), t('why.col.needs'), t('why.col.issued'), t('why.col.due')]}
              align={['left', 'left', 'right', 'right', 'right', 'left']}
              rows={line.sources.map((source, index) => ({
                id: `${source.orderLineId}-${source.size}-${index}`,
                cells: [
                  `${source.orderNumber} · ${t('why.lineSeq', { seq: source.lineSeq })}`,
                  source.size,
                  source.made > 0 ? t('why.piecesMade', { pieces: source.pieces, made: source.made }) : String(source.pieces),
                  `${q(source.quantity)} ${unit}`,
                  `${q(source.issued)} ${unit}`,
                  source.dueDate ? formatDate(dayAt(source.dueDate), place) : '—',
                ],
              }))}
            />
          )}
        </section>

        <section className="fw-by-card" aria-labelledby="fw-why-stock">
          <h3 id="fw-why-stock" className="fw-by-h3">
            {t('why.stock')}
          </h3>
          {now.stock.length === 0 ? (
            <p className="fw-by-hint">{t('why.noStock')}</p>
          ) : (
            <SummaryTable
              label={t('why.stock')}
              density="compact"
              stackOnPhone
              columns={[t('why.col.lot'), t('why.col.quantity'), t('why.col.counted')]}
              align={['left', 'right', 'left']}
              rows={now.stock.map((entry, index) => ({
                id: `${entry.lot?.id ?? 'none'}-${index}`,
                cells: [
                  entry.lot ? (
                    <Link className="fw-by-link" href={`${model.prefix}/warehouse/lots/${encodeURIComponent(entry.lot.id)}`}>
                      {entry.lot.code}
                      {entry.hide ? ` · ${entry.hide.code}` : ''}
                    </Link>
                  ) : (
                    t('why.noLot')
                  ),
                  `${q(entry.quantity)} ${t(`uom.${entry.item.baseUom}`)}${entry.hides > 0 ? ` · ${t('why.hideCount', { count: entry.hides })}` : ''}`,
                  <HeldWords key="held" entry={entry} />,
                ],
              }))}
            />
          )}
        </section>

        <section className="fw-by-card" aria-labelledby="fw-why-purchases">
          <h3 id="fw-why-purchases" className="fw-by-h3">
            {t('why.purchases')}
          </h3>
          {now.purchases.length === 0 ? (
            <p className="fw-by-hint">{t('why.noPurchases')}</p>
          ) : (
            <SummaryTable
              label={t('why.purchases')}
              density="compact"
              stackOnPhone
              columns={[t('why.col.po'), t('why.col.open'), t('why.col.due'), t('why.col.counted')]}
              align={['left', 'right', 'left', 'left']}
              rows={now.purchases.map((purchase) => ({
                id: purchase.purchaseOrderLineId,
                cells: [
                  <Link key="po" className="fw-by-link" href={`${model.prefix}/purchasing/orders/${purchase.purchaseOrderId}`}>
                    {purchase.purchaseOrderNumber} · {t('why.lineSeq', { seq: purchase.seq })}
                  </Link>,
                  `${q(purchase.openQuantity)} ${unit}`,
                  `${formatDate(dayAt(purchase.dueDate), place)}${purchase.confirmed ? ` · ${t('why.confirmed')}` : ` · ${t('why.asked')}`}`,
                  purchase.why ? <Tag tone="warning">{t(`why.purchaseWhy.${purchase.why}`, { quantity: q(purchase.notCounted), unit })}</Tag> : <Tag tone="success">{t('why.countedQuantity', { quantity: q(purchase.counted), unit })}</Tag>,
                ],
              }))}
            />
          )}
        </section>
      </div>

      {line.firm && (
        <Banner tone="info" title={w(line.firm.carried ? 'why.firmCarried' : 'why.firm', { quantity: q(line.firm.quantity), unit: t(`uom.${line.firm.uom}`), date: formatDate(dayAt(line.firm.date), place) })} />
      )}

      <section className="fw-by-card" aria-labelledby="fw-why-pegging">
        <h3 id="fw-why-pegging" className="fw-by-h3">
          {w('peg.title')}
        </h3>
        {explain.pegging.length === 0 ? <p className="fw-by-hint">{w('peg.none')}</p> : <PeggingTree demands={explain.pegging} unit={unit} q={q} prefix={model.prefix} place={place} />}
      </section>

      <p className="fw-by-hint">{t('why.inputs', { time: formatDateTime(explain.run.finishedAt ?? explain.run.startedAt, place), trigger: t(`plan.trigger.${explain.run.trigger}`) })}</p>
    </div>
  )
}

/** A stock line's reason; B-W2a-70: a quality hold says its own reason and since when (the hold's words in this language). */
function HeldWords({ entry }: { entry: StockLine }) {
  const t = useT('buying')
  const w = useT(MRP_NAMESPACE)
  const locale = useLocale()
  if (!entry.reason) return <Tag tone="success">{t('why.reason.counted')}</Tag>
  const tag = <Tag tone={entry.held ? 'warning' : 'neutral'}>{t(`why.reason.${entry.reason}`)}</Tag>
  if (!entry.hold) return tag
  return (
    <span className="fw-by-inline">
      {tag}
      <span className="fw-by-cell-sub">{w(entry.hold.subjectType === 'Hide' ? 'why.holdHide' : 'why.holdLot', { reason: locale === 'it' ? entry.hold.reasonIt : entry.hold.reasonEn, date: formatDate(entry.hold.placedAt, { locale }) })}</span>
    </span>
  )
}

/**
 * The pegging tree (design why-drawer, W2a: "for orders: pegging tree up to the customer order or MTM unit"): each
 * demand — the order line and its size (or the made-to-measure unit), the work order that makes it, the day and how
 * much — and under it the supplies that cover it as the run pegged them: a reservation (its lot or hide), stock, a
 * purchase order line, the planned order (firm or not). Every record is a link.
 */
function PeggingTree({ demands, unit, q, prefix, place }: { demands: readonly PegDemand[]; unit: string; q: (value: string | null | undefined) => string; prefix: string; place: { locale: ReturnType<typeof useLocale>; timeZone?: string } }) {
  const w = useT(MRP_NAMESPACE)
  const day = (value: string | null) => (value ? formatDate(dayAt(value), place) : '—')
  return (
    <ul className="fw-mrp-peg" aria-label={w('peg.title')}>
      {demands.map((demand, index) => (
        <li key={`${demand.orderLine?.id ?? demand.kind}-${demand.size ?? 'mtm'}-${demand.workOrder?.id ?? '-'}-${index}`} className="fw-mrp-peg-demand">
          <span className="fw-mrp-peg-head">
            {demand.order ? (
              <Link className="fw-by-link" href={`${prefix}/sales/orders/${encodeURIComponent(demand.order.id)}`}>
                {demand.order.number}
              </Link>
            ) : (
              <span>{w(`peg.kind.${demand.kind}`)}</span>
            )}
            {demand.orderLine && <span>{w('peg.line', { seq: demand.orderLine.seq })}</span>}
            <span>{demand.size ? w('peg.size', { size: demand.size }) : w('peg.mtm')}</span>
            {demand.workOrder && (
              <span>
                {w('peg.on')}{' '}
                <Link className="fw-by-link" href={`${prefix}/production/work-orders/${encodeURIComponent(demand.workOrder.id)}`}>
                  {demand.workOrder.number}
                </Link>
              </span>
            )}
            <span className="fw-by-num">{w('peg.need', { quantity: q(demand.quantity), unit, date: day(demand.demandDate) })}</span>
          </span>
          <ul className="fw-mrp-peg-supplies">
            {demand.supplies.map((supply) => (
              <li key={supply.seq}>
                <Tag tone={supply.kind === 'PLANNED' ? (supply.firm ? 'info' : 'warning') : 'success'}>{w(supply.kind === 'PLANNED' && supply.firm ? 'peg.supply.FIRM' : `peg.supply.${supply.kind}`)}</Tag>{' '}
                <span className="fw-by-num">{q(supply.quantity)} {unit}</span>
                {supply.reservation && <span className="fw-by-cell-sub"> · {supply.reservation.hide?.code ?? supply.reservation.lot?.code ?? w('peg.anyLot')}</span>}
                {supply.purchaseOrder && (
                  <span className="fw-by-cell-sub">
                    {' '}
                    ·{' '}
                    <Link className="fw-by-link" href={`${prefix}/purchasing/orders/${encodeURIComponent(supply.purchaseOrder.id)}`}>
                      {w('peg.poLine', { number: supply.purchaseOrder.number, seq: supply.purchaseOrder.seq })}
                    </Link>
                  </span>
                )}
                {supply.date && <span className="fw-by-cell-sub"> · {w('peg.date', { date: day(supply.date) })}</span>}
              </li>
            ))}
            {demand.supplies.length === 0 && <li className="fw-by-cell-sub">{w('peg.nothing')}</li>}
          </ul>
        </li>
      ))}
    </ul>
  )
}
