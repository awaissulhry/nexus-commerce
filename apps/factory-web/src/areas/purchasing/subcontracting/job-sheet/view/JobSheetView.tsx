'use client'

import { Printer } from 'lucide-react'
import { Banner, Card, KeyValue, SummaryTable } from '@nexus/ui/components'
import { SizeGridView } from '@nexus/ui/grid'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayAt, quantity } from '../../../../_shared/buying/model'
import type { SubcontractOrder } from '../../api'
import { sizeRun } from '../../model'
import { dateLocale, gridCopy } from '../../record/view/OperationsTab'
import '../job-sheet.css'

/** SCR-128-job-sheet — the order's job sheet on paper: one view model, nothing fetched. */
export interface JobSheetModel {
  /** The company the page works in (its name heads the sheet). */
  readonly company: string
  /** Who printed it, and when it was read. */
  readonly person: string
  readonly readAt: string | null
  readonly order: { readonly value: SubcontractOrder | null; readonly problem: string | null }
  readonly timeZone: string
}

/**
 * The job sheet (design tab:job-sheet, "printed and sent with the kit"): the company and site, the order's number, the
 * workshop and its stock location, the work order and style, the order date and when the goods are due back, then each
 * operation with its pieces per size and its own return date, the kit's components with colour, lot and quantity, and
 * the note for the workshop (never the internal one). No fee and no price (Owner answer C2: no prices on supplier
 * papers). Opened in a new tab from the record; the print stylesheet hides the Office frame, the browser saves a PDF.
 */
export function JobSheetView({ model }: { model: JobSheetModel }) {
  return (
    <WithMessages namespaces={['subcontracting', 'subcontract-order']}>
      <Sheet model={model} />
    </WithMessages>
  )
}

function Sheet({ model }: { model: JobSheetModel }) {
  const t = useT('subcontract-order')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const order = model.order.value
  const kit = order ? order.kitLines.filter((line) => line.status !== 'CANCELLED') : []
  return (
    <article className="fw-scj">
      <header className="fw-scj-head">
        <h1 className="fw-scj-title">{order ? t('sheet.title', { number: order.number, workshop: order.workshop.name }) : t('sheet.titleLoading')}</h1>
        <p className="fw-scj-muted">{order ? t('sheet.meta', { company: model.company, site: order.site.code, at: model.readAt ? formatDateTime(model.readAt, place) : '—', person: model.person }) : model.person}</p>
        <p className="fw-scj-muted">{t('sheet.purpose')}</p>
        <Button className="fw-scj-button" variant="secondary" onClick={() => window.print()} heldReason={order ? undefined : t('sheet.held')}>
          <Printer size={14} aria-hidden /> {t('sheet.print')}
        </Button>
      </header>
      {model.order.problem ? (
        <Banner tone="danger" title={t('sheet.failed')}>
          {t(model.order.problem)}
        </Banner>
      ) : !order ? (
        <p className="fw-scj-muted" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <>
          <Card padded>
            <div className="fw-scj-section">
              <KeyValue
                dense
                columns={3}
                labelCase="sentence"
                items={[
                  { label: t('sheet.workshop'), value: `${order.workshop.code} · ${order.workshop.name}` },
                  { label: t('sheet.location'), value: `${order.location.code} · ${order.location.name}` },
                  { label: t('sheet.workOrder'), value: `${order.workOrder.number} · ${order.workOrder.style.code} ${order.workOrder.style.name}` },
                  { label: t('sheet.orderDate'), value: formatDate(dayAt(order.orderDate), place) },
                  { label: t('sheet.back'), value: order.expectedBackDate ? formatDate(dayAt(order.expectedBackDate), place) : t('ops.noDate') },
                  { label: t('sheet.pieces'), value: String(order.pieces.ordered) },
                ]}
              />
            </div>
          </Card>
          <section className="fw-scj-section" aria-label={t('sheet.opsTitle')}>
            <h2 className="fw-scj-h2">{t('sheet.opsTitle')}</h2>
            {order.operations.length === 0 ? (
              <p className="fw-scj-muted">{t('sheet.noOps')}</p>
            ) : (
              <div className="fw-scj-ops">
                {order.operations.map((operation) => {
                  const run = sizeRun(operation.sizes)
                  return (
                    <div key={operation.id} className="fw-scj-op">
                      <h3 className="fw-scj-h2">{t('ops.card.title', { line: operation.seq, seq: operation.workOrderOperation.seq, code: operation.workOrderOperation.code, name: operation.workOrderOperation.name })}</h3>
                      <p className="fw-scj-muted">{t('sheet.opLine', { count: operation.pieces, date: operation.expectedBackDate ? formatDate(dayAt(operation.expectedBackDate), place) : t('ops.noDate') })}</p>
                      {operation.sizes.length === 0 ? <p className="fw-scj-muted">{t('ops.notSplit', { count: operation.pieces })}</p> : <SizeGridView colours={run.colours} sizes={run.sizes} value={run.value} locale={dateLocale(locale)} copy={gridCopy(t)} caption={t('ops.sizesOf', { line: operation.seq })} />}
                      {operation.note && <p className="fw-scj-muted">{operation.note}</p>}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
          <section className="fw-scj-section" aria-label={t('sheet.kitTitle')}>
            <h2 className="fw-scj-h2">{t('sheet.kitTitle')}</h2>
            {kit.length === 0 ? (
              <p className="fw-scj-muted">{t('sheet.noKit')}</p>
            ) : (
              <SummaryTable
                label={t('sheet.kitTitle')}
                columns={[t('kit.col.component'), t('sheet.colour'), t('kit.col.lot'), t('kit.col.quantity')]}
                align={['left', 'left', 'left', 'right']}
                stackOnPhone
                rows={kit.map((line) => ({
                  id: line.id,
                  cells: [`${line.item.code} ${line.item.name}`, line.colour ? `${line.colour.code} · ${line.colour.name}` : '—', line.lot ? `${line.lot.code}${line.hide ? ` · ${line.hide.code}` : ''}` : '—', `${quantity(line.quantity, locale, 4)} ${t(`uom.${line.uom}`)}`],
                }))}
              />
            )}
          </section>
          {order.note && (
            <section className="fw-scj-section" aria-label={t('sheet.noteTitle')}>
              <h2 className="fw-scj-h2">{t('sheet.noteTitle')}</h2>
              <p className="fw-scj-muted">{order.note}</p>
            </section>
          )}
          <p className="fw-scj-muted">{t('sheet.ours')}</p>
        </>
      )}
    </article>
  )
}
