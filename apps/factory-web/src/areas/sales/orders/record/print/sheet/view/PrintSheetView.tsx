'use client'

import type { CSSProperties, ReactElement } from 'react'
import { Printer, X } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { DeptChip } from '../../../../../../../lib/department/view/DeptChip'
import { formatDate } from '../../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../../lib/i18n/provider'
import { codeBoxOf, codePlaceOf, frameOf, type PercentBox, type SheetCardModel, type SheetPageModel } from '../model'
import '../print-sheet.css'

/**
 * owb-ss4 step 4.2 — the ONE print sheet, drawn over the page (its container puts it in a portal on <body>): a bar on screen (what
 * prints, Print, Close; hidden on paper), then one A4 page per design page — the mockup page whole, the QR of the work order number at
 * its place, from print 2 on "Print N · date" in its foot — and the basket cards, 2 × 4 per A4 sheet: QR of the BN code, the basket
 * number big, the picture, the customer CODE, the due date, the steps (number, English, Urdu shaped by the browser inside <bdi>) each with
 * a box for a pen tick. On paper it is black on white (print-sheet.css `@media print`). Draws its model; fetches nothing.
 */

export interface PrintSheetViewModel {
  readonly state: 'reading' | 'failed' | 'ready'
  /** Why it could not be read (a `shipments` word: problem.read.*). */
  readonly problem: string | null
  readonly title: { readonly key: string; readonly params: Readonly<Record<string, string>> } | null
  /** owb-ss4b: `pageMm` — the design page's own size, once drawn (the code is placed in it, as Place the scan code places it). */
  readonly pages: readonly (SheetPageModel & { readonly src: string | null; readonly pageMm: { readonly widthMm: number; readonly heightMm: number } | null; readonly failed: boolean; readonly qrSrc: string | null })[]
  readonly cardSheets: readonly (readonly (SheetCardModel & { readonly pictureSrc: string | null; readonly qrSrc: string | null })[])[]
  /** Pictures and codes still drawing (Print waits for them). */
  readonly drawing: boolean
}

export interface PrintSheetViewActions {
  readonly onPrint?: () => void
  readonly onClose?: () => void
}

const pct = (box: PercentBox): CSSProperties => ({ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` })

export function PrintSheetView({ model, actions = {} }: { model: PrintSheetViewModel; actions?: PrintSheetViewActions }): ReactElement {
  const t = useT('print-start')
  const s = useT('shipments')
  const cards = model.cardSheets.reduce((sum, sheet) => sum + sheet.length, 0)
  return (
    <div className="fw-psheet" role="dialog" aria-modal="true" aria-label={model.title ? t(model.title.key, model.title.params) : t('sheet.title')}>
      <div className="fw-psheet-bar">
        <span className="fw-psheet-bar-t">
          <b>{model.title ? t(model.title.key, model.title.params) : t('sheet.title')}</b>
          {model.state === 'ready' ? <span className="fw-psheet-mu">{[t('sheet.pages', { count: model.pages.length }), t('sheet.cards', { count: cards })].join(' · ')}</span> : null}
        </span>
        {model.drawing && model.state === 'ready' ? (
          <span className="fw-psheet-mu" role="status">
            <Spinner size={14} /> {t('sheet.drawing')}
          </span>
        ) : null}
        <Button size="sm" variant="primary" heldReason={model.state !== 'ready' ? t('sheet.waitRead') : model.drawing ? t('sheet.drawing') : null} onClick={() => actions.onPrint?.()}>
          <Printer size={14} aria-hidden /> {t('sheet.print')}
        </Button>
        <Button size="sm" onClick={() => actions.onClose?.()} aria-keyshortcuts="Escape">
          <X size={14} aria-hidden /> {t('sheet.close')}
        </Button>
      </div>
      {model.state === 'reading' ? (
        <p className="fw-psheet-mu fw-psheet-pad" role="status">
          <Spinner size={14} /> {t('sheet.reading')}
        </p>
      ) : null}
      {model.state === 'failed' ? (
        <div className="fw-psheet-pad">
          <Banner tone="danger" title={t('sheet.failed')}>
            {model.problem ? s(model.problem) : null}
          </Banner>
        </div>
      ) : null}
      {model.state === 'ready' ? (
        <div className="fw-psheet-paper-list">
          {model.pages.map((page) => (
            <DesignPage key={page.key} page={page} />
          ))}
          {model.cardSheets.map((sheet, index) => (
            <section key={`cards-${index}`} className="fw-psheet-paper fw-psheet-cards" aria-label={t('sheet.cardSheet', { n: index + 1 })}>
              {sheet.map((card) => (
                <BasketCard key={card.bundleId} card={card} />
              ))}
            </section>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function DesignPage({ page }: { page: PrintSheetViewModel['pages'][number] }): ReactElement {
  const t = useT('print-start')
  const locale = useLocale()
  // owb-ss4b: the design page whole and centred on the paper (its own shape), the code at its place in the page's own millimetres.
  const pageMm = page.pageMm
  return (
    <section className="fw-psheet-paper fw-psheet-page" aria-label={t('sheet.pageOf', { label: page.label, page: page.page })}>
      {page.src && pageMm ? (
        <div className="fw-psheet-frame" style={pct(frameOf(pageMm))}>
          <img className="fw-psheet-mockup" src={page.src} alt={t('sheet.pageOf', { label: page.label, page: page.page })} />
          {page.qrSrc ? <img className="fw-psheet-qr" style={pct(codeBoxOf(codePlaceOf(page.placement, pageMm), pageMm))} src={page.qrSrc} alt={t('sheet.qrOf', { code: page.workOrderNumber })} /> : null}
        </div>
      ) : null}
      {!page.src && !page.failed ? <span className="fw-psheet-wait">{t('sheet.drawing')}</span> : null}
      {page.failed ? <span className="fw-psheet-wait">{t('sheet.pageFailed')}</span> : null}
      <span className="fw-psheet-foot">
        <span>
          {page.styleCode} · {page.workOrderNumber}
        </span>
        {page.mark ? <b>{t('sheet.mark', { n: page.mark.printNo, day: formatDate(page.mark.at, { locale }) })}</b> : null}
      </span>
    </section>
  )
}

function BasketCard({ card }: { card: PrintSheetViewModel['cardSheets'][number][number] }): ReactElement {
  const t = useT('print-start')
  const locale = useLocale()
  return (
    <article className="fw-psheet-card" aria-label={card.basketNo}>
      <div className="fw-psheet-card-top">
        {card.qrSrc ? <img className="fw-psheet-card-qr" src={card.qrSrc} alt={t('sheet.qrOf', { code: card.code })} /> : <span className="fw-psheet-card-qr" />}
        <div className="fw-psheet-card-id">
          <span className="fw-psheet-basket">{card.basketNo}</span>
          <span className="fw-psheet-card-l">
            {card.styleCode} · {card.label}
          </span>
          <span className="fw-psheet-card-l">
            <b>{card.customerCode}</b>
            {card.dueDate ? ` · ${t('sheet.due', { day: formatDate(card.dueDate, { locale }) })}` : ''} · {t('sheet.pieces', { count: card.pieces })}
            {card.mark ? (
              <>
                {' · '}
                <b>{t('sheet.mark', { n: card.mark.printNo, day: formatDate(card.mark.at, { locale }) })}</b>
              </>
            ) : null}
          </span>
        </div>
        {card.pictureSrc ? <img className="fw-psheet-card-pic" src={card.pictureSrc} alt="" /> : null}
      </div>
      <ol className="fw-psheet-steps">
        {card.steps.map((step) => (
          <li key={step.no} className="fw-psheet-step">
            <span className="fw-psheet-tick" aria-hidden />
            <DeptChip dept={step} />
            {step.nameUr ? (
              <bdi className="fw-psheet-ur" dir="rtl" lang="ur">
                {step.nameUr}
              </bdi>
            ) : null}
          </li>
        ))}
      </ol>
    </article>
  )
}
