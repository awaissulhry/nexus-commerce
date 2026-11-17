'use client'

import type { KeyboardEvent } from 'react'
import { ChevronLeft, Download, ExternalLink, FolderOpen, Lock, MessageSquare } from 'lucide-react'
import { Banner, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { FileRow, Modal } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../../lib/pdf/labels'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import type { OrderFile, OrderFilesGroup, OrderWorksheet } from '../api'
import { leftOutOf, lookOf, openableOf, orderFilesCount, orderNameOf, orderThreadDoor, sectionsOf, type OrderFilesActions, type OrderFilesEntry, type OrderFilesModel, type OrderThreadChoice, type ShownFile } from '../model'
import '../order-files.css'

/**
 * B-TH-265 (agreement T9; their B-PR-44 route): "Order files (n)" in the work order's band — the orders' own files, their lines' (and
 * quote lines') artwork and the made-to-measure worksheets, one group per order, so nobody types an order's details again (L16).
 * Each file opens ONLY through the work order's own route (`POST …/order-files/:fileId/open`), a worksheet through the made-to-measure
 * route; what was left out is said as a count, never named. "Open the order's thread" shows that order's thread in the dock (only an
 * order whose thread the reader may read).
 * F-PR-25 (17-web-r2 §1.3): one window — each order a group (the customer's PO first), its files in three parts (Order · Lines ·
 * Measurements, newest first; a measurement sheet the reader may not open is the lock line "Measurement sheet: opens with the
 * measurements right (n)", counted, never dropped); a PDF or a picture opens BESIDE the list (DS PdfViewer, or the picture as it
 * is), Download beside it; on a phone the list alone, a file full screen and ‹ (or Esc) back to the list. ↑ ↓ move along the list.
 * The band's "Order thread" shows the order's thread in the work order's dock (several orders: a menu, their PO first).
 */
export function OrderFilesButton({ model, actions }: { model: OrderFilesModel; actions?: OrderFilesActions }) {
  const t = useT('production')
  const count = orderFilesCount(model.files)
  return (
    <Button size="sm" variant="quiet" aria-haspopup="dialog" onClick={() => actions?.onOpen?.()}>
      <FolderOpen size={14} aria-hidden /> {count === null ? t('orderFiles.buttonPlain') : t('orderFiles.button', { count })}
    </Button>
  )
}

/** F-PR-25: "Order thread" in the band — the order's thread in the work order's dock (shared with that order's customer). */
export function OrderThreadButton({ choices, actions }: { choices: readonly OrderThreadChoice[]; actions?: OrderFilesActions }) {
  const t = useT('production')
  const frame = useRecordFrame()
  const door = orderThreadDoor(choices)
  const show = (orderId: string) => {
    actions?.onThread?.(orderId)
    frame?.showThread?.()
  }
  if (door.kind === 'none') return null
  if (door.kind === 'one') {
    return (
      <Button size="sm" variant="quiet" title={t('orderThread.hint', { customer: door.choice.party.name })} onClick={() => show(door.choice.orderId)}>
        <MessageSquare size={14} aria-hidden /> {t('orderThread.button')}
      </Button>
    )
  }
  const items: MenuItemDef[] = door.choices.map((choice) => ({ id: choice.orderId, label: orderWords(t, choice), description: t('orderThread.hint', { customer: choice.party.name }), onSelect: () => show(choice.orderId) }))
  return (
    <Menu
      label={
        <>
          <MessageSquare size={14} aria-hidden /> {t('orderThread.menu', { count: door.choices.length })}
        </>
      }
      items={items}
      triggerProps={{ 'aria-label': t('orderThread.menuLabel', { count: door.choices.length }) }}
    />
  )
}

/** An order as people name it: "PO AL-7781 · SO-2026-0142" (the customer's PO first), else the number alone. */
function orderWords(t: ReturnType<typeof useT>, order: { readonly number: string; readonly customerRef: string | null }): string {
  const name = orderNameOf(order)
  return name.po ? t('orderFiles.orderName', { po: name.po, number: name.number }) : name.number
}

export function OrderFilesDialog({ number, model, choices, actions }: { number: string; model: OrderFilesModel; choices: readonly OrderThreadChoice[]; actions?: OrderFilesActions }) {
  const t = useT('production')
  if (!model.open) return null
  return (
    <Modal
      open
      sheet
      size="xl"
      onClose={() => actions?.onClose?.()}
      title={t('orderFiles.title', { number })}
      subtitle={t('orderFiles.intro')}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {t('orderFiles.close')}
          </Button>
        </>
      }
    >
      <OrderFilesBody model={model} choices={choices} actions={actions} />
    </Modal>
  )
}

/** ↑ ↓ move between the list's rows (the first button of each), wherever the focus is in the list. */
function onListKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-order-file] button')].filter((button, index, all) => all.findIndex((other) => other.closest('[data-order-file]') === button.closest('[data-order-file]')) === index)
  if (rows.length === 0) return
  const at = rows.findIndex((button) => button.closest('[data-order-file]')?.contains(document.activeElement))
  const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at <= 0 ? 0 : at - 1)
  event.preventDefault()
  rows[next]?.focus()
}

/** The dialog's content (also drawn on its own by the tests: the DS Modal draws nothing before the page is hydrated). */
export function OrderFilesBody({ model, choices, actions }: { model: OrderFilesModel; choices: readonly OrderThreadChoice[]; actions?: OrderFilesActions }) {
  const t = useT('production')
  const frame = useRecordFrame()
  const files = model.files
  const shown = model.shown ?? null
  const threadOf = (orderId: string) => choices.find((choice) => choice.orderId === orderId) ?? null
  // Phone: the list alone; a shown file takes the whole window (‹ or Esc back to the list).
  const phoneShowing = !!frame?.phone && !!shown
  return (
    <div className={phoneShowing ? 'fw-pr-of is-showing' : 'fw-pr-of'}>
      <div className="fw-pr-of-list fw-pr-stack" onKeyDown={onListKeys}>
        {model.problem && <Banner tone="danger" title={t('orderFiles.openFailed')}>{t(model.problem)}</Banner>}
        {files.state === 'loading' && (
          <div className="fw-pr-stack" role="status" aria-label={t('orderFiles.reading')}>
            <p className="fw-pr-hint">
              <Spinner size={14} /> {t('orderFiles.reading')}
            </p>
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} height={44} />
            ))}
          </div>
        )}
        {files.state === 'error' && (
          <EmptyState
            title={t('orderFiles.failed')}
            description={t(files.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
        {files.state === 'ready' && files.read.groups.length === 0 && files.read.ordersLeftOut === 0 && <p className="fw-pr-hint">{t('orderFiles.empty')}</p>}
        {files.state === 'ready' &&
          files.read.groups.map((group) => (
            <Group
              key={group.order.id}
              group={group}
              model={model}
              thread={threadOf(group.order.id)}
              actions={actions}
              onThread={(orderId) => {
                actions?.onThread?.(orderId)
                frame?.showThread?.()
              }}
            />
          ))}
        {files.state === 'ready' && files.read.ordersLeftOut > 0 && <p className="fw-pr-hint">{t('orderFiles.ordersLeftOut', { count: files.read.ordersLeftOut })}</p>}
      </div>
      <Viewer shown={shown} model={model} actions={actions} phone={!!frame?.phone} />
    </div>
  )
}

function fromWords(t: ReturnType<typeof useT>, file: OrderFile): string {
  if (file.from === 'ORDER' || !file.line) return t('orderFiles.fromOrder')
  return t(file.from === 'QUOTE_LINE' ? 'orderFiles.fromQuoteLine' : 'orderFiles.fromLine', { seq: file.line.seq })
}

function Group({ group, model, thread, actions, onThread }: { group: OrderFilesGroup; model: OrderFilesModel; thread: OrderThreadChoice | null; actions?: OrderFilesActions; onThread: (orderId: string) => void }) {
  const t = useT('production')
  const locale = useLocale()
  const leftOut = leftOutOf(group).filter((entry) => entry.key !== 'orderFiles.measurementsLeftOut')
  const sections = sectionsOf(group)
  return (
    <section className="fw-pr-stack" aria-label={orderWords(t, group.order)}>
      <div className="fw-pr-card-head">
        <span className="fw-pr-inline">
          {/* The customer's PO first: what the customer calls the order (F-PR-25). */}
          <h3 className="fw-pr-h3">{orderWords(t, group.order)}</h3>
          <span className="fw-pr-hint">{formatDate(`${group.order.orderDate}T12:00:00Z`, { locale })}</span>
        </span>
        {thread && (
          <Button size="sm" variant="quiet" onClick={() => onThread(thread.orderId)}>
            <MessageSquare size={14} aria-hidden /> {t('orderFiles.thread')}
          </Button>
        )}
      </div>
      {openableOf(group) === 0 && group.measurementsLeftOut === 0 && leftOut.length === 0 && <p className="fw-pr-hint">{t('orderFiles.none')}</p>}
      {sections.map((section) => (
        <div key={section.key} className="fw-pr-of-section">
          <h4 className="fw-pr-of-part">{t(`orderFiles.section.${section.key}`)}</h4>
          <div className="fw-pr-stack">
            {section.entries.map((entry) => (
              <Entry key={entry.kind === 'file' ? entry.file.id : entry.sheet.documentId} entry={entry} model={model} actions={actions} />
            ))}
            {section.locked > 0 && (
              <p className="fw-pr-of-locked" role="note">
                <Lock size={13} aria-hidden /> {t('orderFiles.measurementsLeftOut', { count: section.locked })}
              </p>
            )}
          </div>
        </div>
      ))}
      {leftOut.map((entry) => (
        <p key={entry.key} className="fw-pr-hint">
          {t(entry.key, { count: entry.count })}
        </p>
      ))}
    </section>
  )
}

function Entry({ entry, model, actions }: { entry: OrderFilesEntry; model: OrderFilesModel; actions?: OrderFilesActions }) {
  const t = useT('production')
  const locale = useLocale()
  const shownId = model.shown?.id ?? null
  if (entry.kind === 'worksheet') {
    const sheet: OrderWorksheet = entry.sheet
    const name = t('orderFiles.worksheet', { seq: sheet.line.seq })
    const showing = model.shown?.id === sheet.documentId && model.shown.state === 'loading'
    return (
      <div data-order-file="">
        <FileRow
          name={name}
          status={[t('orderFiles.version', { version: sheet.version }), formatDate(sheet.createdAt, { locale }), t('orderFiles.bodyData')].join(' · ')}
          actions={
            <Button size="sm" aria-current={shownId === sheet.documentId ? 'true' : undefined} heldReason={showing ? t('held.busy') : null} onClick={() => actions?.onShowWorksheet?.(sheet, name)} aria-label={t('orderFiles.showNamed', { name })}>
              {showing ? <Spinner size={12} /> : <ExternalLink size={13} aria-hidden />} {t('orderFiles.preview')}
            </Button>
          }
        />
      </div>
    )
  }
  const file = entry.file
  const busy = model.opening === file.id
  const look = lookOf(file.contentType)
  const showing = model.shown?.id === file.id && model.shown.state === 'loading'
  return (
    <div data-order-file="">
      <FileRow
        name={file.name}
        size={file.sizeBytes}
        status={[fromWords(t, file), t('orderFiles.version', { version: file.versionNo }), formatDate(file.at, { locale }), ...(file.bodyData ? [t('orderFiles.bodyData')] : [])].join(' · ')}
        actions={
          <>
            {look !== 'other' && (
              <Button size="sm" aria-current={shownId === file.id ? 'true' : undefined} heldReason={showing ? t('held.busy') : null} onClick={() => actions?.onShowFile?.(file)} aria-label={t('orderFiles.showNamed', { name: file.name })}>
                {showing ? <Spinner size={12} /> : <ExternalLink size={13} aria-hidden />} {t('orderFiles.preview')}
              </Button>
            )}
            <Button size="sm" variant="quiet" heldReason={busy ? t('held.busy') : null} onClick={() => actions?.onDownload?.(file)} aria-label={t('orderFiles.downloadNamed', { name: file.name })}>
              <Download size={13} aria-hidden /> {t('orderFiles.download')}
            </Button>
          </>
        }
      />
    </div>
  )
}

/** Saves bytes the window already holds (a worksheet shown in the viewer) as a file on this device. */
function saveShown(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Beside the list: the shown file (a PDF in the viewer, a picture as it is), else what to do. On a phone it replaces the list. */
function Viewer({ shown, model, actions, phone }: { shown: ShownFile | null; model: OrderFilesModel; actions?: OrderFilesActions; phone: boolean }) {
  const t = useT('production')
  const shell = useT('shell')
  if (!shown) {
    return (
      <div className="fw-pr-of-viewer is-empty" aria-live="polite">
        <p className="fw-pr-hint">{t('orderFiles.pickHint')}</p>
      </div>
    )
  }
  const file = model.files.state === 'ready' ? model.files.read.groups.flatMap((group) => group.files).find((one) => one.id === shown.id) ?? null : null
  const download = () => {
    if (file) actions?.onDownload?.(file)
    else if (shown.state === 'ready' && shown.src instanceof Uint8Array) saveShown(shown.name, shown.src)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (phone && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      actions?.onBack?.()
    }
  }
  return (
    <div className="fw-pr-of-viewer" role="region" aria-label={shown.name} onKeyDown={onKeyDown}>
      <div className="fw-pr-card-head">
        <span className="fw-pr-inline">
          {phone && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onBack?.()} aria-label={t('orderFiles.back')}>
              <ChevronLeft size={14} aria-hidden /> {t('orderFiles.back')}
            </Button>
          )}
          <span className="fw-pr-of-name">{shown.name}</span>
          {file?.bodyData && <Tag tone="warning">{t('orderFiles.bodyData')}</Tag>}
        </span>
        {(file || (shown.state === 'ready' && shown.src instanceof Uint8Array)) && (
          <Button size="sm" variant="quiet" heldReason={file && model.opening === file.id ? t('held.busy') : null} onClick={download} aria-label={t('orderFiles.downloadNamed', { name: shown.name })}>
            <Download size={13} aria-hidden /> {t('orderFiles.download')}
          </Button>
        )}
      </div>
      {shown.state === 'loading' ? (
        <div role="status" aria-label={t('orderFiles.showing', { name: shown.name })}>
          <Skeleton height={420} />
        </div>
      ) : shown.state === 'error' ? (
        <Banner tone="danger" title={t('orderFiles.showFailed', { name: shown.name })} action={file ? <Button size="sm" onClick={() => actions?.onShowFile?.(file)}>{t('common.retry')}</Button> : undefined}>
          {t(shown.problem)}
        </Banner>
      ) : shown.look === 'pdf' && shown.src instanceof Uint8Array ? (
        <PdfViewer src={shown.src} title={shown.name} fileName={shown.name} onDownload={download} labels={pdfViewerLabels(shell)} height={phone ? '72vh' : 'min(64vh, 720px)'} />
      ) : shown.look === 'picture' && typeof shown.src === 'string' ? (
        <img className="fw-pr-of-picture" src={shown.src} alt={shown.name} />
      ) : (
        <p className="fw-pr-hint">{t('orderFiles.noPreview')}</p>
      )}
    </div>
  )
}
