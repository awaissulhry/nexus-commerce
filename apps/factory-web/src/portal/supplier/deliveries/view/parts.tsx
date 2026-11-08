'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { DetailPopover, KeyValue, SummaryTable, type KeyValueItem } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { Notice, NoticePage } from '../api'
import { reasonWords, verdictTone, type HideRow, type LineCheck } from '../model'
import { useDeliveryWords, type DeliveryWords } from '../words'
import '../deliveries.css'

/**
 * The parts the Ship notices views share (SCR-227): a verdict pill, a check's reasons in words, the packing list per hide
 * (the shared list frame, read-only: arrows, Enter opens a row's detail — design pop:row-detail "Hide 2231-017", the DS
 * DetailPopover: the values and why it is Check / Not as ordered), the checks per line, and the delivery's terms.
 */

export function VerdictPill({ verdict }: { verdict: HideRow['verdict'] }) {
  const { t } = useDeliveryWords()
  if (verdict === null) return <Pill tone="danger">{t('verdict.unread')}</Pill>
  return <Pill tone={verdictTone(verdict)}>{t(`verdict.${verdict}`)}</Pill>
}

export function Reasons({ reasons, words }: { reasons: HideRow['reasons']; words: DeliveryWords }) {
  if (reasons.length === 0) return null
  return (
    <ul className="fw-psn-reasons">
      {reasons.map((reason, index) => (
        <li key={`${reason.code}-${index}`} className={reason.verdict === 'NOT_AS_ORDERED' ? 'fw-psn-bad' : reason.verdict === 'CHECK' ? 'fw-psn-warn' : undefined}>
          {reasonWords(reason, words.t, words.locale)}
        </li>
      ))}
    </ul>
  )
}

/** The detail of one hide (design pop:row-detail): the values, then why it is Check / Not as ordered (or not read). */
function HideDetail({ row, words }: { row: HideRow; words: DeliveryWords }) {
  const { t, qty, say } = words
  const items: KeyValueItem[] = [
    ...(row.row !== null ? [{ label: t('hide.row'), value: String(row.row) }] : []),
    { label: t('hide.line'), value: row.line !== null ? String(row.line) : '—' },
    { label: t('hide.area'), value: row.area ? qty(row.area, row.unit) : '—' },
    { label: t('hide.grade'), value: row.grade ?? '—' },
    { label: t('hide.thickness'), value: row.thicknessMm ? t('hide.mm', { value: words.qty(row.thicknessMm, null) }) : '—' },
    { label: t('hide.dyeBatch'), value: row.dyeBatch ?? '—' },
    ...(row.note ? [{ label: t('hide.note'), value: row.note }] : []),
  ]
  return (
    <div className="fw-psn-detail">
      <div className="fw-psn-detail-head">
        <strong>{t('hide.title', { hide: row.hideNumber || t('hide.noNumber') })}</strong>
        <VerdictPill verdict={row.verdict} />
      </div>
      <KeyValue items={items} dense labelCase="sentence" />
      {row.problems.length > 0 ? (
        <ul className="fw-psn-reasons">
          {row.problems.map((problem) => (
            <li key={problem.key} className="fw-psn-bad">
              {say(problem)}
            </li>
          ))}
        </ul>
      ) : row.reasons.length > 0 ? (
        <Reasons reasons={row.reasons} words={words} />
      ) : (
        <p className="fw-psn-hint">{t('hide.allGood')}</p>
      )}
    </div>
  )
}

export interface HidesTableProps {
  rows: readonly HideRow[]
  /** "Your packing list" or "What the sheet says". */
  label: string
  /** Design cases: a row's detail open. */
  openHide?: string | null
}

/** The packing list per hide (read-only list frame; Enter opens the row's detail). */
export function HidesTable({ rows, label, openHide = null }: HidesTableProps) {
  const words = useDeliveryWords()
  const { t, qty, say } = words
  const latest = useRef({ words, openHide })
  latest.current = { words, openHide }
  const sheet = rows.some((row) => row.row !== null)

  const columns = useMemo((): ColDef<HideRow>[] => {
    const CheckCell = ({ data }: ICellRendererParams<HideRow>) => {
      if (!data) return null
      const now = latest.current.words
      const first = data.problems[0] ? now.say(data.problems[0]) : data.reasons[0] ? reasonWords(data.reasons[0], now.t, now.locale) : null
      return (
        <span className="fw-psn-check">
          <DetailPopover
            trigger={<VerdictPill verdict={data.verdict} />}
            triggerLabel={now.t('hide.open', { hide: data.hideNumber || now.t('hide.noNumber') })}
            triggerClassName="fw-psn-trigger"
            label={now.t('hide.title', { hide: data.hideNumber || now.t('hide.noNumber') })}
            hoverDelay={0}
            {...(latest.current.openHide === data.id ? { open: true } : {})}
          >
            <HideDetail row={data} words={now} />
          </DetailPopover>
          {first ? <span className={data.verdict === null || data.verdict === 'NOT_AS_ORDERED' ? 'fw-psn-sub fw-psn-bad' : 'fw-psn-sub'}>{first}</span> : null}
        </span>
      )
    }
    const text = (colId: string, header: string, value: (row: HideRow) => string, size: { flex?: number; minWidth?: number }): ColDef<HideRow> => ({ colId, headerName: header, valueGetter: ({ data }) => (data ? value(data) : ''), sortable: false, ...size })
    return [
      ...(sheet ? [text('row', t('hide.row'), (row) => (row.row !== null ? String(row.row) : ''), { flex: 0.4, minWidth: 80 })] : []),
      text('hide', t('hide.hide'), (row) => row.hideNumber || '—', { flex: 0.9, minWidth: 120 }),
      text('line', t('hide.line'), (row) => (row.line !== null ? String(row.line) : '—'), { flex: 0.6, minWidth: 130 }),
      text('area', t('hide.area'), (row) => (row.area ? qty(row.area, row.unit) : '—'), { flex: 0.7, minWidth: 110 }),
      text('grade', t('hide.grade'), (row) => row.grade ?? '—', { flex: 0.5, minWidth: 100 }),
      text('thickness', t('hide.thickness'), (row) => (row.thicknessMm ? t('hide.mm', { value: qty(row.thicknessMm, null) }) : '—'), { flex: 0.6, minWidth: 100 }),
      text('dyeBatch', t('hide.dyeBatch'), (row) => row.dyeBatch ?? '—', { flex: 0.6, minWidth: 100 }),
      { colId: 'check', headerName: t('hide.check'), cellRenderer: CheckCell, sortable: false, flex: 2.2, minWidth: 260, autoHeight: true, wrapText: true },
    ]
  }, [t, qty, sheet, say])

  return (
    <ListFrame<HideRow>
      label={label}
      title={label}
      listKey={null}
      rows={rows}
      rowId={(row) => row.id}
      columns={columns}
      count={t('hide.count', { count: rows.length })}
      onOpen={(row) => {
        // Enter on a row opens its detail (design kb "Enter opens a row's detail"): the row's own trigger.
        const trigger = document.querySelector<HTMLButtonElement>(`[row-id="${CSS.escape(row.id)}"] .fw-psn-trigger`)
        trigger?.click()
      }}
    />
  )
}

/** The checks per line (design "Checks per line … Verdict per row and per line"), with what our receipt took once received. */
export function LineChecks({ lines, received, label }: { lines: readonly LineCheck[]; received: boolean; label: string }) {
  const words = useDeliveryWords()
  const { t, qty } = words
  const columns = [t('lines.col.line'), t('lines.col.article'), t('lines.col.shipping'), t('lines.col.list'), ...(received ? [t('lines.col.received')] : []), t('lines.col.check')]
  return (
    <SummaryTable
      label={label}
      columns={columns}
      stackOnPhone
      widths={received ? ['8%', '24%', '13%', '15%', '13%', undefined] : ['8%', '26%', '14%', '16%', undefined]}
      align={received ? [undefined, undefined, 'right', 'right', 'right', 'left'] : [undefined, undefined, 'right', 'right', 'left']}
      rows={lines.map((line) => ({
        id: line.id,
        cells: [
          line.seq !== null ? String(line.seq) : '—',
          line.title,
          qty(line.quantity, line.uom),
          line.leather ? (line.hides > 0 ? t('lines.hides', { count: line.hides, area: line.area ? qty(line.area, line.uom) : '—' }) : t('lines.noList')) : '—',
          ...(received
            ? [
                <span key="received" className={line.differs ? 'fw-psn-warn' : undefined}>
                  {line.receivedQuantity !== null ? qty(line.receivedQuantity, line.uom) : '—'}
                  {line.differs ? <span className="nds-summary-sub">{t('lines.differs')}</span> : null}
                </span>,
              ]
            : []),
          <span key="check" className="fw-psn-check">
            <VerdictPill verdict={line.verdict} />
            <Reasons reasons={line.reasons} words={words} />
          </span>,
        ],
      }))}
    />
  )
}

/** The delivery's terms as they stand (design step 3 "Transport and papers"). */
export function TermsFacts({ notice, site, prefix, extra }: { notice: Notice; site: NoticePage['site']; prefix: string; extra?: readonly KeyValueItem[] }) {
  const { t, day, at } = useDeliveryWords()
  const dash = (value: ReactNode | null | undefined) => (value === null || value === undefined || value === '' ? '—' : value)
  const items: KeyValueItem[] = [
    { label: t('terms.order'), value: <a href={`${prefix}/orders/${encodeURIComponent(notice.purchaseOrder.id)}?tab=asn`}>{notice.purchaseOrder.number}</a> },
    { label: t('terms.shipDate'), value: dash(notice.shipDate ? day(notice.shipDate) : null) },
    { label: t('terms.expectedDate'), value: dash(notice.expectedDate ? (site ? t('terms.expectedAt', { date: day(notice.expectedDate), site: site.name }) : day(notice.expectedDate)) : null) },
    { label: t('terms.parcels'), value: dash(notice.parcels !== null ? String(notice.parcels) : null) },
    { label: t('terms.carrier'), value: dash(notice.carrier) },
    { label: t('terms.trackingNumber'), value: dash(notice.trackingNumber) },
    { label: t('terms.ddtNumber'), value: dash(notice.ddtNumber ? (notice.ddtDate ? t('terms.ddtOn', { number: notice.ddtNumber, date: day(notice.ddtDate) }) : notice.ddtNumber) : null) },
    { label: t('terms.supplierRef'), value: dash(notice.supplierRef) },
    ...(notice.note ? [{ label: t('terms.note'), value: notice.note }] : []),
    ...(notice.sentAt ? [{ label: t('terms.sentAt'), value: at(notice.sentAt) }] : []),
    ...(notice.receivedAt ? [{ label: t('terms.receivedAt'), value: at(notice.receivedAt) }] : []),
    ...(extra ?? []),
  ]
  return <KeyValue items={items} columns={3} labelCase="sentence" />
}
