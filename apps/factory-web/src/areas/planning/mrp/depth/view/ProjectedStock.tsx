'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Banner, DetailPopover, KeyValue, PerformanceGraph, SummaryTable } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { chart } from '@nexus/ui/tokens'
import { DetailModal } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { dayAt, decimalValue, quantity } from '../../../../_shared/buying/model'
import type { ItemProfile, ProfileRow } from '../api'
import { DEPTH_NAMESPACE, materialCode, profileChart, weekName, type DepthActions, type DepthModel } from '../model'

/**
 * "Projected stock — <material>" (design planning.mrp pop:item-profile, W2b; PLN-084 on GET /planning/item-profile): the
 * material's plan per week from today's plan — demand, receipts, the plan's own orders, the projected balance (with the
 * plan too) and what is still available to promise — each number opening the orders and purchase orders behind it
 * (record-links, ⌘-click = a new tab); a line chart of the projected balance with the safety-stock line; under the table
 * the plan's next orders (lot sizing), the earliest day a new order can be used and the demand it makes late. J / K walk
 * the materials in the grid's order. No money.
 */
export function ProjectedStock({ model, actions, prefix, order, timeZone }: { model: DepthModel; actions?: DepthActions; prefix: string; order: readonly string[]; timeZone?: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const open = model.profile
  if (!open) return null
  const loaded = open.profile
  const profile = loaded.status === 'ready' ? loaded.value : null
  const material = profile ? `${materialCode(profile)} · ${profile.item.name}` : t('profile.reading')
  const error = loaded.status === 'error' ? t(loaded.problem) : loaded.status === 'not_found' ? t('profile.notFound') : loaded.status === 'forbidden' ? t('problem.noRead') : undefined
  return (
    <DetailModal
      open
      onClose={() => actions?.onProfile?.(null)}
      title={t('profile.title', { material: profile ? materialCode(profile) : '…' })}
      subtitle={profile ? material : undefined}
      nav={order.includes(open.lineId) ? { ids: order, current: open.lineId, onGo: (id) => actions?.onProfile?.(id), noun: t('profile.noun') } : undefined}
      loading={loaded.status === 'loading'}
      error={error}
      onRetry={() => actions?.onRetryProfile?.()}
      footer={
        <>
          <span className="grow" />
          {profile && (
            <Button size="sm" asChild>
              <Link href={`${prefix}${recordAddress({ type: 'Item', id: profile.item.id, label: profile.item.code }, model.built)}`}>{t('profile.openMaterial')}</Link>
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={() => actions?.onProfile?.(null)}>
            {t('close')}
          </Button>
        </>
      }
    >
      {profile && <ProfileBody profile={profile} prefix={prefix} built={model.built} timeZone={timeZone} />}
    </DetailModal>
  )
}

function ProfileBody({ profile, prefix, built, timeZone }: { profile: ItemProfile; prefix: string; built: ReadonlySet<string>; timeZone?: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const tb = useT('buying')
  const locale = useLocale()
  const place = { locale, timeZone: timeZone ?? profile.site.timeZone }
  const day = (value: string) => formatDate(dayAt(value), place)
  const unit = tb(`uom.${profile.uom}`)
  const qty = (value: string | null) => (value === null ? '—' : `${quantity(value, locale, 4)} ${unit}`)
  const linkOf = (type: string, id: string, label: string) => `${prefix}${recordAddress({ type, id, label }, built)}`
  const weekWords = (row: ProfileRow) => {
    const name = weekName(row)
    if (name.kind === 'past') return t('profile.past')
    if (name.kind === 'later') return t('profile.later')
    return t('profile.week', { week: name.week, from: row.from ? day(row.from) : '', to: row.to ? day(row.to) : '' })
  }
  const graph = profileChart(profile)
  const cell = (row: ProfileRow, value: string, list: ReactNode, count: number, label: string) => {
    const number = decimalValue(value) ?? 0
    if (number === 0 || count === 0) return <span className="fw-mrd-num fw-mrd-sub">{number === 0 ? '—' : quantity(value, locale, 4)}</span>
    return (
      <DetailPopover trigger={<span className="fw-mrd-cellbtn">{quantity(value, locale, 4)}</span>} triggerLabel={t('profile.cellOpen', { what: label, week: weekWords(row), quantity: qty(value) })} label={t('profile.cellTitle', { what: label, week: weekWords(row) })} hoverDelay={0}>
        <div className="fw-mrd-popbody">{list}</div>
      </DetailPopover>
    )
  }
  const balance = (row: ProfileRow, value: string) => (
    <span className={`fw-mrd-num${row.short ? ' fw-mrd-short' : row.belowSafety ? ' fw-mrd-low' : ''}`}>
      {quantity(value, locale, 4)}
      {row.short ? ` · ${t('profile.short')}` : row.belowSafety ? ` · ${t('profile.belowSafety')}` : ''}
    </span>
  )
  const rows = profile.rows.map((row) => ({
    id: row.key,
    cells: [
      <span key="week" className="fw-mrd-cell">
        <span>{weekWords(row)}</span>
      </span>,
      cell(
        row,
        row.demand,
        <ul className="fw-mrd-refs">
          {row.demandRefs.map((ref, index) => (
            <li key={`${ref.orderLine.id}:${ref.size ?? ''}:${ref.workOrder?.id ?? ''}:${index}`}>
              <span>
                <Link className="fw-mrd-link" href={linkOf('SalesOrder', ref.order.id, ref.order.number)}>
                  {ref.order.number}
                </Link>{' '}
                {t('profile.ref.line', { line: ref.orderLine.seq })}
                {ref.size ? ` · ${t('profile.ref.size', { size: ref.size })}` : ''}
                {ref.workOrder ? (
                  <>
                    {' · '}
                    <Link className="fw-mrd-link" href={linkOf('WorkOrder', ref.workOrder.id, ref.workOrder.number)}>
                      {ref.workOrder.number}
                    </Link>
                  </>
                ) : null}
                {ref.order.rank !== null ? ` · ${t('profile.ref.rank', { rank: ref.order.rank })}` : ''}
              </span>
              <span className="fw-mrd-num">
                {qty(ref.quantity)} · {day(ref.day)}
              </span>
            </li>
          ))}
        </ul>,
        row.demandRefs.length,
        t('profile.col.demand'),
      ),
      cell(
        row,
        row.receipts,
        <ul className="fw-mrd-refs">
          {row.receiptRefs.map((ref, index) => (
            <li key={`${ref.purchaseOrder?.lineId ?? ref.requirementId ?? 'firm'}:${index}`}>
              <span>
                {ref.kind === 'PURCHASE_ORDER' && ref.purchaseOrder ? (
                  <>
                    <Link className="fw-mrd-link" href={linkOf('PurchaseOrder', ref.purchaseOrder.id, ref.purchaseOrder.number)}>
                      {ref.purchaseOrder.number}
                    </Link>{' '}
                    {t('profile.ref.line', { line: ref.purchaseOrder.lineSeq })}
                  </>
                ) : (
                  t('profile.ref.firm')
                )}
              </span>
              <span className="fw-mrd-num">
                {qty(ref.quantity)} · {day(ref.day)}
              </span>
            </li>
          ))}
        </ul>,
        row.receiptRefs.length,
        t('profile.col.receipts'),
      ),
      cell(
        row,
        row.planned,
        <ul className="fw-mrd-refs">
          {row.plannedRefs.map((ref) => (
            <li key={ref.seq}>
              <span>{t('profile.ref.planned', { seq: ref.seq })}</span>
              <span className="fw-mrd-num">
                {qty(ref.quantity)} · {day(ref.day)}
              </span>
            </li>
          ))}
        </ul>,
        row.plannedRefs.length,
        t('profile.col.planned'),
      ),
      balance(row, row.projected),
      <span key="with" className="fw-mrd-num">
        {quantity(row.projectedWithPlan, locale, 4)}
      </span>,
      <span key="atp" className={`fw-mrd-num${(decimalValue(row.atp) ?? 0) < 0 ? ' fw-mrd-short' : ''}`}>
        {quantity(row.atp, locale, 4)}
      </span>,
    ],
  }))
  const firstShort = profile.rows.find((row) => row.key === profile.firstShort) ?? null
  const firstLow = profile.rows.find((row) => row.key === profile.firstBelowSafety) ?? null
  const lots = profile.lots.list
  return (
    <div className="fw-mrd-stack">
      <p className="fw-mrd-hint">{t('profile.asOf', { time: formatDateTime(profile.asOf, place), site: `${profile.site.code} · ${profile.site.name}`, weeks: profile.horizon.weeks })}</p>
      {firstShort ? <Banner tone="danger" title={t('profile.firstShort', { week: weekWords(firstShort) })} /> : firstLow ? <Banner tone="warning" title={t('profile.firstLow', { week: weekWords(firstLow) })} /> : <Banner tone="success" title={t('profile.covered')} />}
      <KeyValue
        dense
        columns={3}
        labelCase="sentence"
        items={[
          { label: t('profile.onHand'), value: qty(profile.onHand) },
          { label: t('profile.safety'), value: profile.safetyStock === null ? t('profile.noSafety') : qty(profile.safetyStock) },
          { label: t('profile.net'), value: qty(profile.net) },
          { label: t('profile.uncovered'), value: qty(profile.uncovered) },
          { label: t('profile.allocation'), value: <Pill tone={profile.allocation === 'PRIORITY' ? 'info' : 'neutral'}>{t(`profile.allocationBy.${profile.allocation}`)}</Pill> },
          { label: t('profile.lotSizing'), value: profile.parameters ? t(`lot.${profile.parameters.lotSizing}`) : t('profile.defaults') },
        ]}
      />
      <figure className="fw-mrd-figure" aria-label={t('profile.chartLabel', { material: materialCode(profile) })}>
        <PerformanceGraph
          data={graph.data}
          xKey="week"
          left={{ key: 'projected', label: t('profile.chartProjected'), axisLabel: unit, color: chart.actual, axis: 'left', domain: graph.domain, ticks: graph.ticks, format: (value) => quantity(value, locale, 2) }}
          right={{ key: 'safety', label: t('profile.chartSafety'), axisLabel: unit, color: chart.cap, axis: 'right', domain: graph.domain, ticks: graph.ticks, format: (value) => quantity(value, locale, 2) }}
          height={220}
        />
        <figcaption>{t('profile.chartCaption')}</figcaption>
      </figure>
      <SummaryTable
        label={t('profile.table')}
        density="roomy"
        stackOnPhone
        columns={[t('profile.col.week'), t('profile.col.demand'), t('profile.col.receipts'), t('profile.col.planned'), t('profile.col.projected'), t('profile.col.withPlan'), t('profile.col.atp')]}
        align={['left', 'right', 'right', 'right', 'right', 'right', 'right']}
        widths={['22%', undefined, undefined, undefined, '16%', undefined, undefined]}
        rows={rows}
      />
      <div className="fw-mrd-cols">
        <div className="fw-mrd-stack">
          <h3 className="fw-mrd-h3">{t('profile.lotsTitle')}</h3>
          {lots.length === 0 ? (
            <p className="fw-mrd-hint">{t('profile.noLots')}</p>
          ) : (
            <ul className="fw-mrd-list">
              {lots.slice(0, 8).map((lot) => (
                <li key={lot.seq}>{t('profile.lot', { quantity: qty(lot.quantity), date: day(lot.date), from: day(lot.covers.from), to: day(lot.covers.to) })}</li>
              ))}
              {lots.length > 8 && <li>{t('profile.moreLots', { count: lots.length - 8 })}</li>}
            </ul>
          )}
          <p className="fw-mrd-hint">
            {profile.earliest.leadTimeDays === null
              ? t('profile.earliestNoLead', { arrival: day(profile.earliest.arrival), usable: day(profile.earliest.usable) })
              : t('profile.earliest', { arrival: day(profile.earliest.arrival), usable: day(profile.earliest.usable), lead: profile.earliest.leadTimeDays, delay: profile.earliest.delayDays ?? 0 })}
          </p>
        </div>
        <div className="fw-mrd-stack">
          <h3 className="fw-mrd-h3">{t('profile.delaysTitle', { count: profile.delays.length })}</h3>
          {profile.delays.length === 0 ? (
            <p className="fw-mrd-hint">{t('profile.noDelays')}</p>
          ) : (
            <ul className="fw-mrd-list">
              {profile.delays.slice(0, 8).map((delay, index) => (
                <li key={`${delay.orderLine.id}:${delay.size ?? ''}:${index}`}>
                  <Link className="fw-mrd-link" href={linkOf('SalesOrder', delay.order.id, delay.order.number)}>
                    {delay.order.number}
                  </Link>{' '}
                  {t('profile.delay', { line: delay.orderLine.seq, need: day(delay.needDate), earliest: day(delay.earliest), count: delay.daysLate, source: t(`profile.source.${delay.source}`) })}
                </li>
              ))}
              {profile.delays.length > 8 && <li>{t('profile.moreDelays', { count: profile.delays.length - 8 })}</li>}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
