'use client'

import Link from 'next/link'
import { Banner, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { WorkOrderCost } from '../api'
import {
  basisPhrase,
  bridgeSteps,
  COSTING_NAMESPACE,
  decimalText,
  methodPhrase,
  moneyText,
  movesHref,
  pctText,
  quantityText,
  signedMoney,
  statePhrase,
  unitCostText,
  varianceTone,
  type CostingCan,
} from '../model'

/**
 * The parts of one work order's cost that the cost DetailModal (SCR-154 pop:wo-cost) and the work order's Labour & cost
 * tab (production.workorders rec:labour) both draw, from `GET /costing/work-orders/:id`: the facts (basis, the method in
 * words, open or final), the bridge from the basis to the actual (each reason signed), planned · actual · variance · per
 * garment per part, the materials issued (per lot and hide, a line → its stock movements), labour per operation
 * (standard minutes earned × cost per minute — never per person) and what waits to be costed. Every amount needs the cost
 * grain: without it the amounts are not drawn (never a '—'), and minutes and quantities stay.
 */

type T = (key: string, params?: Record<string, string | number>) => string

/** The facts at the top: basis, totals (cost grain), method, state. */
export function CostFacts({ detail, can }: { detail: WorkOrderCost; can: Pick<CostingCan, 'cost'> }) {
  const t = useT(COSTING_NAMESPACE)
  const locale = useLocale()
  const basis = basisPhrase(detail)
  const method = methodPhrase(null, detail.method)
  const state = statePhrase(detail)
  return (
    <>
      <KeyValue
        columns={3}
        labelCase="sentence"
        items={[
          { label: t('detail.basis'), value: t(basis.key), hint: detail.basis ? undefined : t('detail.basisNone') },
          ...(can.cost
            ? [
                { label: t('col.standard'), value: moneyText(detail.standardTotal ?? null, detail.currency, locale) },
                { label: t('col.estimate'), value: moneyText(detail.estimateTotal ?? null, detail.currency, locale), hint: detail.estimateComplete ? undefined : t('detail.estimatePart') },
                { label: t('col.actual'), value: moneyText(detail.actualTotal ?? null, detail.currency, locale), hint: t('detail.actualHint', { moved: moneyText(detail.movedToStock ?? null, detail.currency, locale) }) },
                {
                  label: t('col.variance'),
                  value: (
                    <span className="fw-fco-inline">
                      <span className="fw-fco-num">{signedMoney(detail.variance ?? null, detail.currency, locale)}</span>
                      <Pill tone={varianceTone(detail)}>{pctText(detail.variancePct ?? null, locale, true)}</Pill>
                    </span>
                  ),
                  hint: detail.final ? undefined : t('detail.varianceOpen'),
                },
              ]
            : []),
          { label: t('col.pieces'), value: String(detail.workOrder.pieces) },
          { label: t('col.reason'), value: detail.biggestReason ? t(`reason.${detail.biggestReason}`) : t('reason.none') },
          { label: t('col.state'), value: <Tag tone={detail.final ? 'success' : 'info'}>{t(state.key)}</Tag> },
          { label: t('detail.method'), value: t(method.key, { method: method.params?.method ? t(`method.name.${method.params.method}`) : '' }), hint: detail.provisional ? t('detail.provisional') : undefined },
        ]}
      />
      {!can.cost && <Banner tone="info" title={t('noCost.title')}>{t('noCost.body')}</Banner>}
    </>
  )
}

/** From the basis to the actual (design "Bridge"): each reason signed; the steps add up to the variance exactly. */
export function CostBridge({ detail, can }: { detail: WorkOrderCost; can: Pick<CostingCan, 'cost'> }) {
  const t = useT(COSTING_NAMESPACE)
  const locale = useLocale()
  if (!can.cost) return null
  const steps = bridgeSteps(detail)
  return (
    <section className="fw-fco-card" aria-label={t('bridge.title')}>
      <h3 className="fw-fco-h3">{t('bridge.title')}</h3>
      {!steps ? (
        <p className="fw-fco-muted">{t('bridge.none')}</p>
      ) : (
        <dl className="fw-fco-bridge" aria-label={t('bridge.title')}>
          {steps.map((step) => {
            const total = step.reason === 'BASIS' || step.reason === 'ACTUAL'
            const direction = total || step.amount === null ? '' : step.amount > 0 ? ' is-up' : step.amount < 0 ? ' is-down' : ''
            const label = step.reason === 'BASIS' ? t(`bridge.basis.${detail.basis}`) : step.reason === 'ACTUAL' ? t('bridge.actual') : t(`reason.${step.reason}`)
            return (
              <div key={step.id} className={`fw-fco-bridge-row${total ? ' is-total' : ''}${direction}`}>
                <dt>{label}</dt>
                <dd>{total ? moneyText(step.amount, detail.currency, locale) : signedMoney(step.amount, detail.currency, locale)}</dd>
              </div>
            )
          })}
        </dl>
      )}
      {steps && !detail.final && <p className="fw-fco-muted">{t('bridge.open')}</p>}
    </section>
  )
}

/** Planned (the basis) · actual · variance · per garment, per part (design wo-cost "SummaryTable"). */
export function CostSummary({ detail, can }: { detail: WorkOrderCost; can: Pick<CostingCan, 'cost'> }) {
  const t = useT(COSTING_NAMESPACE)
  const locale = useLocale()
  if (!can.cost) return null
  const money = (value: number | null | undefined) => moneyText(value ?? null, detail.currency, locale)
  return (
    <section className="fw-fco-card" aria-label={t('parts.title')}>
      <h3 className="fw-fco-h3">{t('parts.title')}</h3>
      <SummaryTable
        label={t('parts.title')}
        stackOnPhone
        columns={[t('parts.part'), t('parts.planned'), t('parts.actual'), t('parts.variance'), t('parts.perGarment')]}
        align={[undefined, 'right', 'right', 'right', 'right']}
        rows={[
          ...detail.parts.map((part) => ({ id: part.part, cells: [t(`part.${part.part}`), money(part.planned), money(part.actual), signedMoney(part.variance ?? null, detail.currency, locale), money(part.perGarment)] })),
          {
            id: 'total',
            cells: [
              <b key="l">{t('parts.total')}</b>,
              <b key="p">{money(detail.basis === 'STANDARD' ? detail.standardTotal : detail.estimateTotal)}</b>,
              <b key="a">{money(detail.actualTotal)}</b>,
              <b key="v">{signedMoney(detail.variance ?? null, detail.currency, locale)}</b>,
              <b key="g">{money(detail.perGarment.actual)}</b>,
            ],
          },
        ]}
      />
      <p className="fw-fco-muted">{t('parts.hint', { planned: money(detail.perGarment.planned), actual: money(detail.perGarment.actual) })}</p>
    </section>
  )
}

/** The materials issued to it: planned and issued quantities, cost per unit against the standard, the lots and hides. */
export function CostMaterials({ detail, can, prefix }: { detail: WorkOrderCost; can: Pick<CostingCan, 'cost' | 'moves'>; prefix: string }) {
  const t = useT(COSTING_NAMESPACE)
  const locale = useLocale()
  return (
    <section className="fw-fco-card" aria-label={t('materials.title')}>
      <h3 className="fw-fco-h3">{t('materials.title')}</h3>
      {detail.materials.length === 0 ? (
        <p className="fw-fco-muted">{t('materials.none')}</p>
      ) : (
        <SummaryTable
          label={t('materials.title')}
          stackOnPhone
          columns={[t('materials.item'), t('materials.planned'), t('materials.issued'), ...(can.cost ? [t('materials.unitCost'), t('materials.amount')] : [])]}
          align={[undefined, 'right', 'right', ...(can.cost ? (['right', 'right'] as const) : [])]}
          rows={detail.materials.map((material) => ({
            id: material.item.id,
            cells: [
              <span key="i" className="fw-fco-cell">
                {can.moves ? (
                  <Link className="fw-fco-link" href={movesHref(prefix, detail.workOrder.siteId, material.item.id)} aria-label={t('materials.movesLink', { code: material.item.code })}>
                    {`${material.item.code} · ${material.item.name}`}
                  </Link>
                ) : (
                  <span>{`${material.item.code} · ${material.item.name}`}</span>
                )}
                {material.lots.length > 0 && (
                  <ul className="fw-fco-lots" aria-label={t('materials.lots')}>
                    {material.lots.map((lot, index) => (
                      <li key={`${lot.lotId ?? ''}|${lot.hideId ?? ''}|${index}`}>
                        {[lot.lotCode ?? t('materials.noLot'), lot.hideCode, quantityText(lot.quantity, material.item.baseUom, locale), can.cost ? moneyText(lot.amount ?? null, detail.currency, locale) : null].filter(Boolean).join(' · ')}
                      </li>
                    ))}
                  </ul>
                )}
              </span>,
              quantityText(material.plannedQuantity, material.item.baseUom, locale),
              quantityText(material.issuedQuantity, material.item.baseUom, locale),
              ...(can.cost
                ? [
                    <span key="u" className="fw-fco-cell">
                      <span className="fw-fco-num">{unitCostText(material.unitCost ?? null, detail.currency, locale)}</span>
                      <span className="fw-fco-cell-sub">{t('materials.standard', { cost: unitCostText(material.standardUnitCost ?? null, detail.currency, locale) })}</span>
                    </span>,
                    moneyText(material.amount ?? null, detail.currency, locale),
                  ]
                : []),
            ],
          }))}
        />
      )}
    </section>
  )
}

/** Labour per operation: standard minutes planned and earned (good garments reported), cost per minute, amount. Never a person. */
export function CostLabour({ detail, can }: { detail: WorkOrderCost; can: Pick<CostingCan, 'cost'> }) {
  const t = useT(COSTING_NAMESPACE)
  const locale = useLocale()
  return (
    <section className="fw-fco-card" aria-label={t('labour.title')}>
      <h3 className="fw-fco-h3">{t('labour.title')}</h3>
      {detail.labour.length === 0 ? (
        <p className="fw-fco-muted">{t('labour.none')}</p>
      ) : (
        <SummaryTable
          label={t('labour.title')}
          stackOnPhone
          columns={[t('labour.operation'), t('labour.planned'), t('labour.earned'), ...(can.cost ? [t('labour.perMinute'), t('labour.amount')] : [])]}
          align={[undefined, 'right', 'right', ...(can.cost ? (['right', 'right'] as const) : [])]}
          rows={detail.labour.map((row) => ({
            id: row.operation.id,
            cells: [
              <span key="o" className="fw-fco-cell">
                <span>{`${row.operation.seq} · ${row.operation.name}`}</span>
                <span className="fw-fco-cell-sub">{`${row.operation.code} · ${t(`centre.${row.operation.workCentreKind}`)}`}</span>
              </span>,
              t('labour.minutes', { minutes: decimalText(row.plannedMinutes, locale, 1) }),
              t('labour.minutes', { minutes: decimalText(row.earnedMinutes, locale, 1) }),
              ...(can.cost ? [unitCostText(row.perMinute ?? null, detail.currency, locale), moneyText(row.amount ?? null, detail.currency, locale)] : []),
            ],
          }))}
        />
      )}
      <p className="fw-fco-muted">{t('labour.privacy')}</p>
    </section>
  )
}

/** Scrap charged or recorded, and what waits to be costed (in our words, by code). */
export function CostScrapAndWaiting({ detail, can }: { detail: WorkOrderCost; can: Pick<CostingCan, 'cost'> }) {
  const t: T = useT(COSTING_NAMESPACE)
  const locale = useLocale()
  return (
    <>
      {detail.scrap.length > 0 && (
        <section className="fw-fco-card" aria-label={t('scrap.title')}>
          <h3 className="fw-fco-h3">{t('scrap.title')}</h3>
          <SummaryTable
            label={t('scrap.title')}
            stackOnPhone
            columns={[t('ledger.col.date'), t('ledger.col.event'), t('ledger.col.item'), t('ledger.col.quantity'), ...(can.cost ? [t('ledger.col.value')] : [])]}
            align={[undefined, undefined, undefined, 'right', ...(can.cost ? (['right'] as const) : [])]}
            rows={detail.scrap.map((row) => ({
              id: row.entryId,
              cells: [
                formatDate(row.occurredAt, { locale }),
                t(`event.${row.event}`),
                row.item ? `${row.item.code} · ${row.item.name}` : '—',
                row.item ? quantityText(row.quantity, row.item.baseUom, locale) : decimalText(row.quantity, locale),
                ...(can.cost ? [moneyText(row.value ?? null, detail.currency, locale)] : []),
              ],
            }))}
          />
          <p className="fw-fco-muted">{t('scrap.hint')}</p>
        </section>
      )}
      {detail.waitingItems.length > 0 && (
        <Banner tone="warning" title={t('waiting.title', { count: detail.waitingItems.length })}>
          <ul className="fw-fco-notes">
            {WAITING_ORDER.filter((code) => detail.waitingItems.some((item) => item.code === code)).map((code) => (
              <li key={code}>{t(`waiting.${code}`, { count: detail.waitingItems.filter((item) => item.code === code).length })}</li>
            ))}
          </ul>
        </Banner>
      )}
    </>
  )
}

const WAITING_ORDER = ['NOT_VALUED', 'NO_RATE', 'CURRENCY', 'LOCKED', 'NO_SCAN', 'SCRAP_APPROVAL'] as const
