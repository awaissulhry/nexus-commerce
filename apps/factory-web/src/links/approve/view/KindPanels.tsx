'use client'

import { FileText, ImageOff, PenLine } from 'lucide-react'
import { Banner, Card, ChangeReview, KeyValue, type ChangeReviewItem } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatNumber } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../lib/pdf/labels'
import type { ApprovalFile, ApprovalPage, RevisedOrder } from '../api'
import { filesInOrder, isPdf, isPicture, linePrices, markable, netMoved, panelOf, sizeMoves, type ApproveActions, type ApproveViewModel } from '../model'

/** A file's size as people read it: "65 KB", "2.4 MB". */
export function sizeText(bytes: number, locale: 'it' | 'en'): string {
  return bytes >= 1024 * 1024
    ? formatNumber(bytes / (1024 * 1024), locale, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 })
    : formatNumber(Math.max(1, Math.round(bytes / 1024)), locale, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 })
}

/**
 * The kind's own panel (design sections revised-order, proof, concession, sample): the facts the record shares, in the
 * reader's language, and what the kind shows — a revised order line by line, old → new, with the party's own prices; the
 * proof itself with zoom; the concession's photos side by side; the sample's photos and spec. Every photo opens full size
 * and may be marked ("Mark the photo"). A file that cannot be read says so with Try again; answering stays possible.
 */
export function KindPanelView({ page, model, actions }: { page: ApprovalPage; model: ApproveViewModel; actions?: ApproveActions }) {
  const panel = panelOf(page.request.kind)
  switch (panel) {
    case 'revised-order':
      return <RevisedOrderPanel page={page} model={model} />
    case 'proof':
      return <FilesPanel page={page} model={model} actions={actions} title="panel.proof.title" hint="panel.proof.hint" inlinePdf />
    case 'signature':
      return <FilesPanel page={page} model={model} actions={actions} title="panel.signature.title" hint="panel.signature.hint" inlinePdf />
    case 'concession':
      return <FilesPanel page={page} model={model} actions={actions} title="panel.concession.title" hint="panel.concession.hint" sideBySide />
    default:
      return <FilesPanel page={page} model={model} actions={actions} title={`panel.sample.title.${page.request.kind}`} hint="panel.sample.hint" />
  }
}

function Facts({ page }: { page: ApprovalPage }) {
  if (page.content.facts.length === 0) return null
  return <KeyValue labelCase="sentence" items={page.content.facts.map((fact) => ({ label: fact.label, value: <span lang={page.locale}>{fact.value}</span> }))} />
}

function FilesPanel({ page, model, actions, title, hint, inlinePdf = false, sideBySide = false }: { page: ApprovalPage; model: ApproveViewModel; actions?: ApproveActions; title: string; hint: string; inlinePdf?: boolean; sideBySide?: boolean }) {
  const t = useT('link-approve')
  const shell = useT('shell')
  const files = filesInOrder(page.files)
  // A proof or a document to sign: its (first) PDF right in the page, with the viewer's zoom.
  const pdf = inlinePdf ? (files.find((file) => isPdf(file.contentType)) ?? null) : null
  const pdfShown = pdf ? model.files[pdf.id] : undefined
  const tiles = pdf ? files.filter((file) => file.id !== pdf.id) : files
  return (
    <Card padded className="fw-ap-card">
      <h2 className="fw-ap-h2">{t(title, { kind: page.request.kindName })}</h2>
      <p className="fw-ap-hint">{t(hint, { company: page.request.from.companyName })}</p>
      <Facts page={page} />
      {pdf && (
        <div className="fw-ap-pdf">
          <div className="fw-ap-file-head">
            <strong>{pdf.originalName}</strong>
            <MarkButton file={pdf} model={model} actions={actions} page={page} />
          </div>
          {pdfShown?.problem ? (
            <Banner
              tone="warning"
              title={t('files.problem')}
              action={
                <Button size="sm" onClick={() => actions?.onRetryFile?.(pdf.id)}>
                  {t('retry')}
                </Button>
              }
            />
          ) : pdfShown?.src instanceof Uint8Array ? (
            <PdfViewer src={pdfShown.src} title={pdf.originalName} fileName={pdf.originalName} labels={pdfViewerLabels(shell)} height="min(70vh, 720px)" />
          ) : (
            <p className="fw-ap-hint" role="status">
              <Spinner size={14} /> {t('files.loading')}
            </p>
          )}
        </div>
      )}
      {tiles.length > 0 && (
        <ul className={`fw-ap-files${sideBySide ? ' side' : ''}`} aria-label={t('files.label')}>
          {tiles.map((file, index) => (
            <FileTile key={file.id} file={file} model={model} actions={actions} page={page} caption={sideBySide && tiles.length === 2 ? t(index === 0 ? 'files.first' : 'files.second') : null} />
          ))}
        </ul>
      )}
      {files.length === 0 && <p className="fw-ap-hint">{t('files.none')}</p>}
    </Card>
  )
}

function MarkButton({ file, model, actions, page }: { file: ApprovalFile; model: ApproveViewModel; actions?: ApproveActions; page: ApprovalPage }) {
  const t = useT('link-approve')
  if (!markable(file) || page.request.decided !== null) return null
  const held = !page.may.answer ? (page.may.held ?? t('decision.held')) : model.answer === 'busy' ? t('sign.busy') : null
  const marked = model.markup?.fileId === file.id
  return (
    <Button size="sm" heldReason={held} onClick={() => actions?.onMark?.(file.id)} aria-haspopup="dialog">
      <PenLine size={14} aria-hidden /> {t(marked ? 'files.markAgain' : 'files.mark')}
    </Button>
  )
}

function FileTile({ file, model, actions, page, caption }: { file: ApprovalFile; model: ApproveViewModel; actions?: ApproveActions; page: ApprovalPage; caption: string | null }) {
  const t = useT('link-approve')
  const locale = useLocale()
  const shown = model.files[file.id]
  const picture = isPicture(file.contentType)
  const marked = model.markup?.fileId === file.id ? model.markup.marks.length : 0
  return (
    <li className="fw-ap-file">
      {caption && <span className="fw-ap-caption">{caption}</span>}
      <button type="button" className="fw-ap-file-open" aria-label={t('files.open', { name: file.originalName })} aria-haspopup="dialog" onClick={() => actions?.onOpen?.(file.id)}>
        <span className="fw-ap-thumb" aria-hidden>
          {!picture ? <FileText size={32} /> : shown?.problem ? <ImageOff size={28} /> : typeof shown?.src === 'string' ? <img src={shown.src} alt="" /> : <Skeleton width="100%" height="100%" />}
        </span>
      </button>
      <span className="fw-ap-file-name">{file.originalName}</span>
      <span className="fw-ap-sub">
        {t(picture ? 'files.picture' : isPdf(file.contentType) ? 'files.pdf' : 'files.other')} · {sizeText(file.sizeBytes, locale)}
        {marked > 0 && (
          <>
            {' '}
            <Tag tone="info">{t('files.marked', { count: marked })}</Tag>
          </>
        )}
      </span>
      {shown?.problem && (
        <span className="fw-ap-file-problem" role="status">
          <span className="fw-ap-sub">{t('files.problem')}</span>
          <Button size="sm" onClick={() => actions?.onRetryFile?.(file.id)}>
            {t('retry')}
          </Button>
        </span>
      )}
      <MarkButton file={file} model={model} actions={actions} page={page} />
    </li>
  )
}

/** Design sec:revised-order — the order line by line, old → new (SAL-222), the totals old → new, and what that means. */
function RevisedOrderPanel({ page, model }: { page: ApprovalPage; model: ApproveViewModel }) {
  const t = useT('link-approve')
  const locale = useLocale()
  const order = page.content.revisedOrder
  if (!order) return <Facts page={page} />
  const money = (minor: number | undefined) => (minor === undefined ? '—' : formatNumber(minor / 100, locale, { style: 'currency', currency: order.currency }))
  const price = (value: string | null) => (value === null ? '—' : formatNumber(Number(value), locale, { style: 'currency', currency: order.currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }))
  const day = (value: string | null) => (value === null ? '—' : formatDate(`${value.slice(0, 10)}T12:00:00Z`, { locale, timeZone: model.timeZone }))
  const arrow = (before: string, after: string) => t('arrow', { before, after })
  const items: ChangeReviewItem[] = order.lines.map((line) => lineItem(order, line, t, arrow, money, price))
  const priced = order.netAmountBefore !== undefined
  return (
    <Card padded className="fw-ap-card">
      <h2 className="fw-ap-h2">{t('panel.order.title', { number: order.orderNumber, revision: order.revision })}</h2>
      <Facts page={page} />
      {order.header.length > 0 && (
        <KeyValue
          labelCase="sentence"
          items={order.header.map((entry) => ({
            label: t(`panel.order.header.${entry.field}`),
            value: entry.field === 'requestedDate' ? arrow(day(entry.before), day(entry.after)) : arrow(entry.before ?? '—', entry.after ?? '—'),
          }))}
        />
      )}
      <h3 className="fw-ap-h3">{t('panel.order.lines', { count: order.lines.length })}</h3>
      {items.length > 0 ? <ChangeReview label={t('panel.order.lines', { count: order.lines.length })} items={items} selectedIds={[]} onSelectionChange={() => undefined} tick={false} /> : <p className="fw-ap-hint">{t('panel.order.noLines')}</p>}
      {priced ? (
        <div className="fw-ap-totals">
          <KeyValue
            labelCase="sentence"
            columns={2}
            items={[
              { label: t('panel.order.net'), value: <strong>{arrow(money(order.netAmountBefore), money(order.netAmountAfter))}</strong> },
              { label: t('panel.order.gross'), value: arrow(money(order.grossAmountBefore), money(order.grossAmountAfter)) },
            ]}
          />
          {netMoved(order) && <Banner tone="info" title={t('panel.order.netMoved')} />}
        </div>
      ) : (
        <p className="fw-ap-hint">{t('panel.order.noPrices')}</p>
      )}
    </Card>
  )
}

function lineItem(
  order: RevisedOrder,
  line: RevisedOrder['lines'][number],
  t: (key: string, params?: Record<string, string | number>) => string,
  arrow: (before: string, after: string) => string,
  money: (minor: number | undefined) => string,
  price: (value: string | null) => string,
): ChangeReviewItem {
  const prices = linePrices(order, line.lineId)
  const moves = sizeMoves(line)
  const name = [line.style.code, line.style.name].filter(Boolean).join(' ')
  const colour = [line.colour.code, line.colour.name].filter(Boolean).join(' ')
  return {
    id: line.lineId,
    label: t('panel.order.line', { seq: line.seq, style: name, colour }),
    status: <Tag tone={line.change === 'REMOVED' ? 'danger' : line.change === 'ADDED' ? 'success' : 'warning'}>{t(`panel.order.change.${line.change}`)}</Tag>,
    note: t('panel.order.pieces', { before: line.piecesBefore, after: line.piecesAfter }),
    selectable: false,
    values: [
      ...moves.map((size) => ({ label: t('panel.order.size', { size: size.size }), value: arrow(String(size.before), String(size.after)) })),
      ...(prices?.unitPrice ? [{ label: t('panel.order.unitPrice'), value: arrow(price(prices.unitPrice.before), price(prices.unitPrice.after)) }] : []),
      ...(prices ? [{ label: t('panel.order.lineNet'), value: arrow(money(prices.netBefore), money(prices.netAfter)) }] : []),
    ],
  }
}
