'use client'

import { Download, ExternalLink, FolderOpen, MessageSquare } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { FileRow, Modal } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import type { OrderFile, OrderFilesGroup } from '../api'
import { leftOutOf, openableOf, orderFilesCount, type OrderFilesActions, type OrderFilesModel, type OrderThreadChoice } from '../model'

/**
 * B-TH-265 (agreement T9; their B-PR-44 route): "Order files (n)" in the work order's band — the orders' own files, their lines' (and
 * quote lines') artwork and the made-to-measure worksheets, one group per order, so nobody types an order's details again (L16).
 * Each file opens ONLY through the work order's own route (`POST …/order-files/:fileId/open`), a worksheet through the made-to-measure
 * route; what was left out is said as a count, never named. "Open the order's thread" shows that order's thread in the dock (only an
 * order whose thread the reader may read).
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

export function OrderFilesDialog({ number, model, choices, actions }: { number: string; model: OrderFilesModel; choices: readonly OrderThreadChoice[]; actions?: OrderFilesActions }) {
  const t = useT('production')
  if (!model.open) return null
  return (
    <Modal
      open
      size="lg"
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

/** The dialog's content (also drawn on its own by the tests: the DS Modal draws nothing before the page is hydrated). */
export function OrderFilesBody({ model, choices, actions }: { model: OrderFilesModel; choices: readonly OrderThreadChoice[]; actions?: OrderFilesActions }) {
  const t = useT('production')
  const frame = useRecordFrame()
  const files = model.files
  const threadOf = (orderId: string) => choices.find((choice) => choice.orderId === orderId) ?? null
  return (
    <div className="fw-pr-stack">
      {model.problem && <Banner tone="danger" title={t('orderFiles.openFailed')}>{t(model.problem)}</Banner>}
      {files.state === 'loading' && (
        <p className="fw-pr-hint" role="status">
          <Spinner size={14} /> {t('orderFiles.reading')}
        </p>
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
  )
}

function fromWords(t: ReturnType<typeof useT>, file: OrderFile): string {
  if (file.from === 'ORDER' || !file.line) return t('orderFiles.fromOrder')
  return t(file.from === 'QUOTE_LINE' ? 'orderFiles.fromQuoteLine' : 'orderFiles.fromLine', { seq: file.line.seq })
}

function Group({ group, model, thread, actions, onThread }: { group: OrderFilesGroup; model: OrderFilesModel; thread: OrderThreadChoice | null; actions?: OrderFilesActions; onThread: (orderId: string) => void }) {
  const t = useT('production')
  const locale = useLocale()
  const leftOut = leftOutOf(group)
  const busy = (id: string) => model.opening === id
  return (
    <section className="fw-pr-stack" aria-label={group.order.number}>
      <div className="fw-pr-card-head">
        <span className="fw-pr-inline">
          <h3 className="fw-pr-h3">{group.order.number}</h3>
          {group.order.customerRef && <Tag tone="neutral">{t('orderFiles.customerRef', { ref: group.order.customerRef })}</Tag>}
          <span className="fw-pr-hint">{formatDate(`${group.order.orderDate}T12:00:00Z`, { locale })}</span>
        </span>
        {thread && (
          <Button size="sm" variant="quiet" onClick={() => onThread(thread.orderId)}>
            <MessageSquare size={14} aria-hidden /> {t('orderFiles.thread')}
          </Button>
        )}
      </div>
      {openableOf(group) === 0 && leftOut.length === 0 && <p className="fw-pr-hint">{t('orderFiles.none')}</p>}
      {group.files.map((file) => (
        <FileRow
          key={file.id}
          name={file.name}
          size={file.sizeBytes}
          status={[fromWords(t, file), t('orderFiles.version', { version: file.versionNo }), formatDate(file.at, { locale }), ...(file.bodyData ? [t('orderFiles.bodyData')] : [])].join(' · ')}
          actions={
            <>
              <Button size="sm" heldReason={busy(file.id) ? t('held.busy') : null} onClick={() => actions?.onOpenFile?.(file.id, 'preview')}>
                {busy(file.id) ? <Spinner size={12} /> : <ExternalLink size={13} aria-hidden />} {t('orderFiles.preview')}
              </Button>
              <Button size="sm" variant="quiet" heldReason={busy(file.id) ? t('held.busy') : null} onClick={() => actions?.onOpenFile?.(file.id, 'download')} aria-label={t('orderFiles.downloadNamed', { name: file.name })}>
                <Download size={13} aria-hidden /> {t('orderFiles.download')}
              </Button>
            </>
          }
        />
      ))}
      {group.worksheets.map((sheet) => (
        <FileRow
          key={sheet.documentId}
          name={t('orderFiles.worksheet', { seq: sheet.line.seq })}
          status={[t('orderFiles.version', { version: sheet.version }), formatDate(sheet.createdAt, { locale }), t('orderFiles.bodyData')].join(' · ')}
          actions={
            <Button size="sm" heldReason={busy(sheet.documentId) ? t('held.busy') : null} onClick={() => actions?.onOpenWorksheet?.(sheet.profileId, sheet.documentId)}>
              {busy(sheet.documentId) ? <Spinner size={12} /> : <ExternalLink size={13} aria-hidden />} {t('orderFiles.preview')}
            </Button>
          }
        />
      ))}
      {leftOut.map((entry) => (
        <p key={entry.key} className="fw-pr-hint">
          {t(entry.key, { count: entry.count })}
        </p>
      ))}
    </section>
  )
}
