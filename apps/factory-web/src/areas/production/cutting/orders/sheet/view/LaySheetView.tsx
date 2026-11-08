'use client'

import { Banner, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { LabelPreview } from '@nexus/ui/components/LabelPreview/index'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { ticketLines } from '@nexus/factory-domain/production/cutorders/tickets'
import { useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { CutOrderRecord, LayView } from '../../api'
import { decimalText, layLength, layShade, lineGarments, liveLays, ORDERS_NAMESPACE, orderMaterial, ticketFacts, ticketLayout } from '../../model'
import { OrdersMessages } from '../../view/parts'
import '../../../cutting.css'

/** SCR-238-sheet — the lay sheet and cut ticket on paper (design tab:ct-tab-sheet, "paper at the cutting table"). */
export interface LaySheetModel {
  readonly prefix: string
  /** production.cutting.view. */
  readonly can: boolean
  readonly person: string
  readonly at: string
  /** The company's name: the ticket's heading. */
  readonly company: string | null
  readonly timeZone: string
  /** The cut order; null while it is read. */
  readonly record: CutOrderRecord | null
  /** The read's problem (a message key). */
  readonly problem: string | null
  /** One lay asked (`&lay=`); null: every lay. */
  readonly layId: string | null
  /** No cut order in the address. */
  readonly nothing: boolean
}

/**
 * The lay sheet / cut ticket "PDF" (a page made for paper, printed or saved as a PDF by the browser; no server PDF: the label PDF
 * route makes hide, lot, bundle and carton labels only): per lay of a fabric cut order — or once for leather — the cut ticket as
 * the label printer prints it (Code 128 of its number), the marker, sizes and plies, the rolls to spread by shade and shrinkage
 * group with blank columns for the spreading report (plies spread, splices, end loss, end returned), the count at both ends and
 * the cut, and the garments of each work order in this lay. A planned cut order prints without tickets (made at release), said.
 * No person's name on it: the table and the times only.
 */
export function LaySheetView({ model }: { model: LaySheetModel }) {
  return (
    <OrdersMessages>
      <Sheet model={model} />
    </OrdersMessages>
  )
}

function Sheet({ model }: { model: LaySheetModel }) {
  const t = useT(ORDERS_NAMESPACE)
  const ds = useDsWords()
  const locale = useLocale()
  const language: 'it' | 'en' = locale === 'en' ? 'en' : 'it'
  const record = model.record
  const back = { href: record ? `${model.prefix}/production/cutting/orders/${record.cutOrder.id}` : `${model.prefix}/production/cutting`, label: t('sheet.back') }
  if (!model.can) {
    return (
      <PrintView title={t('sheet.title')} back={back} labels={ds.printView} printHeld={t('noAccess.body', { permission: 'production.cutting.view' })}>
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body', { permission: 'production.cutting.view' })} />
      </PrintView>
    )
  }
  if (model.nothing || model.problem || !record) {
    return (
      <PrintView title={t('sheet.title')} back={back} labels={ds.printView} printHeld={model.nothing ? t('sheet.nothing') : model.problem ? t(model.problem) : t('sheet.reading')}>
        {model.nothing ? (
          <EmptyState title={t('sheet.nothing')} description={t('sheet.nothingBody')} />
        ) : model.problem ? (
          <EmptyState title={t('sheet.failed')} description={t(model.problem)} />
        ) : (
          <p className="fw-ct-hint" role="status">
            <Spinner size={14} /> {t('sheet.reading')}
          </p>
        )}
      </PrintView>
    )
  }
  const order = record.cutOrder
  const lays = liveLays(record).filter((lay) => model.layId === null || lay.id === model.layId)
  const place = { locale, timeZone: model.timeZone }
  return (
    <PrintView
      title={t('sheet.titleOf', { number: order.number })}
      meta={[model.company ?? '', `${t(`kind.${order.kind}`)} · ${orderMaterial(order)} · ${order.material.item.name}`, order.dueDate ? t('record.due', { date: formatDate(`${order.dueDate}T12:00:00Z`, place) }) : t('sheet.noDue')].filter(Boolean)}
      printedAt={formatDateTime(model.at, place)}
      printedBy={model.person}
      filters={model.layId ? [{ label: t('sheet.lay'), value: lays[0] ? t('lays.layOf', { seq: lays[0].seq, of: liveLays(record).length }) : '—' }] : null}
      back={back}
      labels={ds.printView}
      printHeld={order.status === 'CANCELLED' ? t('sheet.cancelled') : null}
    >
      {order.status === 'PLANNED' && <Banner tone="info" title={t('sheet.planned')} />}
      {order.status === 'CANCELLED' && <Banner tone="warning" title={t('sheet.cancelled')} />}
      {order.kind === 'LEATHER' ? (
        <PrintSection title={t('sheet.leather')}>
          <div className="fw-ct-sheet">
            <Ticket record={record} lay={null} language={language} company={model.company} />
            <Lines record={record} lay={null} />
          </div>
        </PrintSection>
      ) : lays.length === 0 ? (
        <EmptyState title={t('sheet.noLay')} description={t('sheet.noLayBody')} />
      ) : (
        lays.map((lay) => (
          <PrintSection key={lay.id} title={t('sheet.layTitle', { seq: lay.seq, of: liveLays(record).length, plies: lay.plies })}>
            <div className="fw-ct-sheet">
              <div className="fw-ct-sheet-head">
                <Ticket record={record} lay={lay} language={language} company={model.company} />
                <KeyValue
                  columns={2}
                  dense
                  items={[
                    { label: t('marker.name'), value: order.marker?.name ?? '—' },
                    { label: t('marker.sizes'), value: order.marker?.ratio || '—' },
                    { label: t('sheet.layLength'), value: (() => { const length = layLength(lay, order.marker); return length === null ? '—' : `${decimalText(length, locale, 4)} m` })() },
                    { label: t('marker.width'), value: order.marker?.widthCm ? `${decimalText(order.marker.widthCm, locale)} cm` : '—' },
                    { label: t('marker.plies'), value: t('lays.plies', { count: lay.plies }) },
                    { label: t('marker.perPly'), value: t('marker.garments', { count: order.marker?.garmentsPerPly ?? 0 }) },
                    { label: t('sheet.shade'), value: layShade(lay) ?? t('sheet.noRolls') },
                    { label: t('sheet.shrinkage'), value: lay.shrinkageGroup ?? '—' },
                  ]}
                />
              </div>
              <section aria-label={t('sheet.rolls')}>
                <h3 className="fw-ct-h3">{t('sheet.rolls')}</h3>
                <SummaryTable
                  label={t('sheet.rolls')}
                  density="roomy"
                  columns={[t('rolls.col.roll'), t('sheet.col.lot'), t('rolls.col.shade'), t('rolls.col.shrinkage'), t('sheet.col.planned'), t('sheet.col.spread'), t('sheet.col.splices'), t('sheet.col.endLoss'), t('sheet.col.endBack')]}
                  align={['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right']}
                  rows={[
                    ...lay.rolls.map((roll) => ({ id: roll.id, cells: [roll.code, roll.lotCode, roll.shade ?? '—', roll.shrinkageGroup ?? '—', String(roll.plies), '', '', '', ''] })),
                    // Lines to write a roll the table adds (scanned there).
                    ...[1, 2].map((n) => ({ id: `blank-${n}`, cells: ['', '', '', '', '', '', '', '', ''] })),
                  ]}
                />
                <p className="fw-ct-hint">{t('sheet.rule')}</p>
              </section>
              <KeyValue
                columns={3}
                dense
                items={[
                  { label: t('sheet.countLeft'), value: '______' },
                  { label: t('sheet.countRight'), value: '______' },
                  { label: t('sheet.cutAt'), value: '______' },
                  { label: t('sheet.table'), value: order.station?.code ?? '______' },
                  { label: t('sheet.ticketStart'), value: '______' },
                  { label: t('sheet.ticketEnd'), value: '______' },
                ]}
              />
              <Lines record={record} lay={lay} />
            </div>
          </PrintSection>
        ))
      )}
      <p className="fw-ct-hint">{t('sheet.footer')}</p>
    </PrintView>
  )
}

/** The cut ticket as the label printer prints it (factory-domain `ticketLines`, the language of the page). */
function Ticket({ record, lay, language, company }: { record: CutOrderRecord; lay: LayView | null; language: 'it' | 'en'; company: string | null }) {
  const t = useT(ORDERS_NAMESPACE)
  const facts = ticketFacts(record, lay, language, company)
  const lines = ticketLines(facts)
  return (
    <div className="fw-ct-sheet-ticket">
      <LabelPreview layout={ticketLayout(lines, facts.code)} scale={3} codeLabel={(value) => t('tickets.code', { code: value })} />
      {!facts.code && <p className="fw-ct-hint">{t('sheet.noTicket')}</p>}
    </div>
  )
}

/** The garments of each work order's size in this lay (ratio × the lay's plies), or of the leather cut order. */
function Lines({ record, lay }: { record: CutOrderRecord; lay: LayView | null }) {
  const t = useT(ORDERS_NAMESPACE)
  return (
    <section aria-label={t('lines.title')}>
      <h3 className="fw-ct-h3">{t('lines.title')}</h3>
      <SummaryTable
        label={t('lines.title')}
        columns={[t('lines.col.workOrder'), t('lines.col.style'), t('lines.col.cell'), t('lines.col.ratio'), t('sheet.col.garments')]}
        align={['left', 'left', 'left', 'right', 'right']}
        rows={record.lines.map((line) => ({ id: line.id, cells: [line.workOrder.number, line.style.code, `${line.colourway.code} ${line.size}`, line.ratio === null ? '—' : String(line.ratio), String(lineGarments(line, lay))] }))}
      />
    </section>
  )
}
