'use client'

import { Printer } from 'lucide-react'
import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { stopsOf, walkOf, walkOrder } from '../../model'
import { NoPickingAccess, PickingMessages, useHeldWords, useQty, useReadinessWord, useWords } from '../../parts'
import type { PrintModel } from '../../view-model'

/**
 * SCR-237-print — the pick lists on paper (design warehouse.picking tab:pk-tab-pdf, "Pick list PDF (sorted by bin path)":
 * paper for the picker when the handheld is not used): the company, when it was read, then ONE walk through the store for
 * every work order asked (SCOPE W2a rule 1: many work orders at once, one pick list), place by place in bin path order
 * with a box to tick, then each work order's lines in the same order with needed, picked and short, and its held stock
 * in words. One view model, nothing fetched; the print stylesheet hides the Office frame.
 */
export function PickingPrintView({ model }: { model: PrintModel }) {
  return (
    <PickingMessages>
      <PickingPaper model={model} />
    </PickingMessages>
  )
}

function PickingPaper({ model }: { model: PrintModel }) {
  const t = useWords()
  const locale = useLocale()
  const qty = useQty()
  const word = useReadinessWord()
  const held = useHeldWords()
  if (!model.allowed) {
    return (
      <article className="fw-pk-print">
        <NoPickingAccess />
      </article>
    )
  }
  const sheets = model.sheets.value
  const walk = sheets ? walkOf(sheets) : []
  return (
    <article className="fw-pk-print">
      <header className="fw-pk-print-head">
        <h2 className="fw-pk-print-title">{t('print.title', { count: sheets?.length ?? model.ids.length })}</h2>
        <p className="fw-st-sub">
          {model.readAt
            ? t('print.meta', {
                company: model.company,
                at: formatDateTime(model.readAt, {
                  locale,
                  timeZone: model.timeZone,
                }),
              })
            : model.company}
        </p>
        <p className="fw-st-sub">{t('print.how')}</p>
        <Button className="fw-pk-print-button" variant="secondary" onClick={() => window.print()} heldReason={sheets && sheets.length > 0 ? undefined : t('print.held')}>
          <Printer size={14} aria-hidden /> {t('print.button')}
        </Button>
      </header>
      {model.sheets.problem ? (
        <Banner tone="danger" title={t('list.failed')}>
          {t(`stock:${model.sheets.problem}`)}
        </Banner>
      ) : !sheets ? (
        <p className="fw-st-sub" role="status">
          <Spinner size={14} /> {t('print.reading')}
        </p>
      ) : sheets.length === 0 ? (
        <EmptyState title={t('print.empty')} description={t('print.emptyBody')} />
      ) : (
        <>
          <section className="fw-pk-print-section" aria-label={t('print.walkTitle')}>
            <h3 className="fw-pk-h3">{t('print.walkTitle')}</h3>
            {walk.length === 0 ? (
              <p className="fw-st-sub">{t('print.walkNone')}</p>
            ) : (
              <SummaryTable
                label={t('print.walkTitle')}
                columns={[t('print.col.place'), t('print.col.workOrder'), t('print.col.material'), t('print.col.take'), t('print.col.quantity'), t('print.col.tick')]}
                widths={['14%', '14%', '22%', '26%', '14%', '10%']}
                align={[undefined, undefined, undefined, undefined, 'right', 'right']}
                stackOnPhone
                rows={walk.flatMap((stop) =>
                  stop.picks.map((pick, index) => ({
                    id: `${stop.locationCode}-${pick.workOrder}-${pick.itemCode}-${pick.hideCode ?? pick.lotCode ?? index}`,
                    cells: [
                      <b key="p">{index === 0 ? stop.locationCode || '—' : ''}</b>,
                      pick.workOrder,
                      [pick.itemCode, pick.colourCode].filter(Boolean).join(' '),
                      `${pick.hideCode ? t('sheet.hide', { hide: pick.hideCode }) : pick.lotCode ? t('sheet.lot', { lot: pick.lotCode }) : t('sheet.anyLot')} · ${pick.reserved ? t('sheet.reserved') : t('sheet.proposed')}`,
                      qty(pick.quantity, pick.uom),
                      <span key="b" className="fw-pk-box" aria-hidden />,
                    ],
                  })),
                )}
              />
            )}
          </section>
          {sheets.map((sheet) => (
            <section key={sheet.workOrder.id} className="fw-pk-print-section" aria-label={t('sheet.title', { number: sheet.workOrder.number })}>
              <h3 className="fw-pk-h3">
                {t('sheet.title', { number: sheet.workOrder.number })} · {sheet.workOrder.style.code} · {t('list.pieces', { count: sheet.workOrder.pieces })}
              </h3>
              <p className="fw-st-sub">
                {[
                  sheet.cutDate
                    ? t('sheet.cut', {
                        date: formatDate(`${sheet.cutDate}T12:00:00Z`, {
                          locale,
                        }),
                      })
                    : t('list.notPlanned'),
                  word(sheet.readiness.word, sheet.readiness.date),
                  t(`kit.status.${sheet.kit.status}`),
                  t('list.lines', {
                    picked: sheet.kit.picked,
                    all: sheet.kit.all,
                  }),
                  sheet.workOrder.onHold
                    ? sheet.workOrder.onHold.reason
                      ? t('list.onHoldWhy', {
                          reason: sheet.workOrder.onHold.reason,
                        })
                      : t('list.onHold')
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {sheet.lines.length === 0 ? (
                <p className="fw-st-sub">{t('sheet.noLines')}</p>
              ) : (
                <SummaryTable
                  label={t('sheet.tableLabel', {
                    number: sheet.workOrder.number,
                  })}
                  columns={[t('sheet.col.where'), t('sheet.col.material'), t('sheet.col.needed'), t('sheet.col.picked'), t('sheet.col.short')]}
                  widths={['40%', '24%', '12%', '12%', '12%']}
                  align={[undefined, undefined, 'right', 'right', 'right']}
                  stackOnPhone
                  rows={walkOrder(sheet.lines).map((line) => ({
                    id: `${line.itemId}|${line.itemColourId ?? '-'}`,
                    cells: [
                      line.covered
                        ? t('sheet.allPicked')
                        : stopsOf(line)
                            .map(
                              (stop) =>
                                `${stop.locationCode || '—'} ${stop.hideCode ? t('sheet.hide', { hide: stop.hideCode }) : stop.lotCode ? t('sheet.lot', { lot: stop.lotCode }) : t('sheet.anyLot')} · ${qty(stop.quantity, line.baseUom)}`,
                            )
                            .join('; ') || t('sheet.nothingUsable'),
                      `${[line.itemCode, line.colourCode].filter(Boolean).join(' ')} — ${line.itemName}`,
                      qty(line.planned, line.baseUom),
                      qty(line.issued, line.baseUom),
                      line.covered ? '—' : qty(line.toIssue, line.baseUom),
                    ],
                  }))}
                />
              )}
              {sheet.lines.some((line) => line.held.length > 0) && (
                <ul className="fw-pk-print-held">
                  {sheet.lines.flatMap((line) =>
                    line.held.map((entry) => (
                      <li key={`${line.itemId}-${entry.lotId}-${entry.hideId ?? ''}`}>
                        {[line.itemCode, line.colourCode].filter(Boolean).join(' ')} · {held(entry)} · {qty(entry.onHand, line.baseUom)}
                      </li>
                    )),
                  )}
                </ul>
              )}
            </section>
          ))}
        </>
      )}
    </article>
  )
}
