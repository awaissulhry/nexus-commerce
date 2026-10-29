'use client'

import { Fragment, type ReactNode } from 'react'
import { Modal, SummaryTable } from '@nexus/ui/components'
import { Button, Kbd, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { QualityMessages } from '../../../quality/_shared/parts'
import type { Entry, Trace } from '../api'
import { RISK_TONE, STATUS_TONE } from '../model'
import '../register.css'

/**
 * The PPE register's small parts (SCR-113), drawn by the list, the New entry dialog and the record: the register's words
 * with the shared quality words, the risk and status marks (a word, never colour alone), and the trace — where the
 * garments are now — as small read-only tables (DS SummaryTable; the design's TraceTree is a DS part not built yet).
 */

/** The `register` words plus the shared `quality`, `lists` and `records` words. */
export function RegisterMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={['register']}>{children}</QualityMessages>
}

export function RiskTag({ risk }: { risk: Entry['risk'] }) {
  const t = useT('register')
  return <Tag tone={RISK_TONE[risk]}>{t(`risk.${risk}`)}</Tag>
}

export function StatusPill({ status }: { status: Entry['status'] }) {
  const t = useT('register')
  return (
    <Pill tone={STATUS_TONE[status]} dot>
      {t(`status.${status}`)}
    </Pill>
  )
}

/** A business day or instant as the person's date, "—" when unknown. */
export function DayText({ value }: { value: string | null | undefined }) {
  const locale = useLocale()
  if (!value) return <>—</>
  return <time dateTime={value}>{formatDate(value, { locale })}</time>
}

/** The batches or serials, the first few and "and N more". */
export function codesText(codes: readonly string[], more: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const shown = codes.join(', ')
  return more > 0 ? t('list.andMore', { codes: shown, count: more }) : shown
}

/** The trace's tables: counts, work orders and their cells, shipments that left, customers, lots, and problems in words. */
export function TraceTables({ trace, compact = false }: { trace: Trace; compact?: boolean }) {
  const t = useT('register')
  const locale = useLocale()
  const c = trace.counts
  const counts = [
    { label: t('trace.workOrders'), value: c.workOrders },
    { label: t('trace.concerned'), value: c.concerned },
    { label: t('trace.released'), value: c.released },
    { label: t('trace.packed'), value: c.packed },
    { label: t('trace.shipped'), value: c.shipped },
    { label: t('trace.returned'), value: c.returned },
    { label: t('trace.customers'), value: c.customers },
  ]
  const cellRows = trace.workOrders.flatMap((order) =>
    order.cells.map((cell) => ({
      id: `${order.id}-${cell.workOrderSizeId}`,
      cells: [
        <span key="wo" className="fw-q-code">
          {order.number}
        </span>,
        `${cell.colourwayCode} · ${cell.size}`,
        cell.concerned,
        cell.released,
        cell.packed,
        cell.shipped,
        cell.returned,
      ] as ReactNode[],
    })),
  )
  return (
    <div className="fw-reg-trace">
      <dl className="fw-q-facts" aria-label={t('trace.countsLabel')}>
        {counts.map((item) => (
          <div key={item.label} className="fw-q-fact">
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      <p className="fw-q-hint">{trace.shippedGoods ? t('trace.shippedGoods') : t('trace.noShippedGoods')}</p>
      {trace.problems.length > 0 && (
        <div className="fw-reg-problems" role="note">
          <p className="fw-reg-problems-title">{t('trace.problemsTitle', { count: trace.problems.length })}</p>
          <ul className="fw-q-lines">
            {trace.problems.map((problem) => (
              <li key={`${problem.path}-${problem.code}`}>{problem.message}</li>
            ))}
          </ul>
        </div>
      )}
      {trace.workOrders.length > 0 && (
        <SummaryTable
          label={t('trace.workOrdersTable')}
          columns={[t('trace.col.workOrder'), t('trace.col.batch'), t('trace.col.reach'), t('trace.col.via'), t('trace.col.status')]}
          rows={trace.workOrders.map((order) => ({
            id: order.id,
            cells: [
              <span key="n" className="fw-q-code">
                {order.number}
              </span>,
              order.batchNumber ? <span className="fw-q-code">{order.batchNumber}</span> : '—',
              t(`trace.reach.${order.reach}`),
              order.via.map((via) => t(`trace.via.${via}`)).join(', '),
              order.status,
            ],
          }))}
          stackOnPhone
        />
      )}
      {!compact && cellRows.length > 0 && (
        <SummaryTable
          label={t('trace.cellsTable')}
          columns={[t('trace.col.workOrder'), t('trace.col.cell'), t('trace.concerned'), t('trace.released'), t('trace.packed'), t('trace.shipped'), t('trace.returned')]}
          rows={cellRows}
          align={[undefined, undefined, 'right', 'right', 'right', 'right', 'right']}
          stackOnPhone
        />
      )}
      {trace.shipments.length > 0 && (
        <SummaryTable
          label={t('trace.shipmentsTable')}
          columns={[t('trace.col.shipment'), t('trace.col.customer'), t('trace.col.ddt'), t('trace.col.left'), t('trace.col.garments')]}
          rows={trace.shipments.map((shipment) => ({
            id: shipment.id,
            cells: [
              <span key="n" className="fw-q-code">
                {shipment.number}
              </span>,
              `${shipment.partyName} (${shipment.partyCode})`,
              shipment.ddtNumbers.length > 0 ? shipment.ddtNumbers.join(', ') : '—',
              shipment.left ? (shipment.shippedAt ? t('trace.leftOn', { date: formatDate(shipment.shippedAt, { locale }) }) : t('trace.leftYes')) : t('trace.notLeft'),
              shipment.garments,
            ],
          }))}
          stackOnPhone
        />
      )}
      {!compact && trace.customers.length > 0 && (
        <SummaryTable
          label={t('trace.customersTable')}
          columns={[t('trace.col.customer'), t('trace.col.shipments'), t('trace.col.ddt'), t('trace.col.garments')]}
          rows={trace.customers.map((customer) => ({
            id: customer.partyId,
            cells: [`${customer.name} (${customer.code})`, customer.shipmentNumbers.join(', '), customer.ddtNumbers.length > 0 ? customer.ddtNumbers.join(', ') : '—', customer.garments],
          }))}
          stackOnPhone
        />
      )}
      {!compact && trace.lots.length > 0 && (
        <SummaryTable
          label={t('trace.lotsTable')}
          columns={[t('trace.col.lot'), t('trace.col.workOrders')]}
          rows={trace.lots.map((lot) => ({ id: lot.id, cells: [<span key="l" className="fw-q-code">{lot.code}</span>, lot.workOrderNumbers.join(', ') || '—'] }))}
          stackOnPhone
        />
      )}
    </div>
  )
}

/** Every key of the page (`?`): the list's own and the frame's, in words. */
export function ShortcutsModal({ open, keys, onClose }: { open: boolean; keys: ReadonlyArray<{ keys: readonly string[]; does: string }>; onClose?: () => void }) {
  const t = useT('register')
  const q = useT('quality')
  return (
    <Modal open={open} onClose={() => onClose?.()} title={t('keys.title')} size="sm" footer={<Button onClick={() => onClose?.()}>{q('common.close')}</Button>}>
      <dl className="fw-reg-keymap">
        {keys.map((entry) => (
          <Fragment key={entry.does}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does}</dd>
          </Fragment>
        ))}
      </dl>
    </Modal>
  )
}
