'use client'

import type { ReactNode } from 'react'
import { AlertCircle, WifiOff } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import type { ApprovalPage, ChangeRequest, DocumentsRead, OrderRecord, ProgressRead, ShipmentsRead } from '../api'
import type { RecordTab } from '../model'
import { useOrderWords } from '../words'
import { CancelDialog, ChangeDialog, PayDialog, PreviewDialog, ReconfirmDialog, type CancelDialogActions, type CancelDialogModel, type ChangeDialogActions, type ChangeDialogModel, type PayDialogActions, type PayDialogModel, type PreviewModel, type ReconfirmDialogActions, type ReconfirmDialogModel } from './Dialogs'
import { DocumentsTab } from './DocumentsTab'
import { LinesTab } from './LinesTab'
import { Loading } from './parts'
import { ShipmentsTab } from './ShipmentsTab'
import { StatusTab } from './StatusTab'
import '../orders.css'

/**
 * SCR-184 › one order (design portal.customer.orders rec "Order": Status & progress, Lines, Shipments & tracking, Documents,
 * Messages). The frame's band holds the title, their PO first, the status, "Ask for a change" (and "Re-confirm version N"
 * while a revised version waits), the ⋯ (Ask to cancel, Pay the deposit, Promise date history, the order confirmation PDF,
 * Ask a question) and the five tabs; this view draws the tab and the pop-ups. Each part reads on its own: a part that failed
 * says so with Try again, never as an empty part.
 */

type Part<T> = { state: 'loading' | 'error' | 'ready'; read: T | null }

export type OrderDialog =
  | { kind: 'change'; model: ChangeDialogModel }
  | { kind: 'cancel'; model: CancelDialogModel }
  | { kind: 'reconfirm'; model: ReconfirmDialogModel }
  | { kind: 'pay'; model: PayDialogModel }
  | { kind: 'preview'; model: PreviewModel }

export interface OrderRecordViewModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  record: OrderRecord | null
  tab: RecordTab
  prefix: string
  offlineSince: string | null
  /** A sent request, a signed re-confirmation, a payment: one line at the top (a message key + its words). */
  notice: { tone: 'success' | 'info' | 'warning' | 'danger'; key: string; params?: Readonly<Record<string, string | number>> } | null
  /** The revised order that waits (B-W2b-184's REVISED_ORDER request); `noAccess`: the person cannot read approvals. */
  revision: { state: 'loading' | 'error' | 'ready' | 'noAccess'; page: ApprovalPage | null }
  /** Why "Review and confirm" cannot open (words), or null. */
  reconfirmHeld: string | null
  /** Production progress (C1); `hidden`: the account does not share it (404) — the section is not drawn. */
  progress: { state: 'loading' | 'error' | 'ready' | 'hidden'; read: ProgressRead | null }
  requests: { state: 'loading' | 'error' | 'ready' | 'noAccess'; items: readonly ChangeRequest[] }
  /** "Withdraw" cannot act now: why (words), or null. */
  withdrawHeld: string | null
  /** "Ask for a change on this line" cannot open: why (words), or null. */
  changeHeld: string | null
  /** Per open deposit the person may pay here: "Pay by card" and why it waits (null: it may). */
  pay: Readonly<Record<string, { held: string | null }>>
  shipments: Part<ShipmentsRead>
  documents: { state: 'loading' | 'error' | 'ready' | 'noAccess'; read: DocumentsRead | null }
  /** A preview / download cannot start (offline, a preview): why, or null. */
  fileHeld: string | null
  /** The line whose sizes are open (the address's `line=`). */
  openLine: string | null
  /** The tracking number just copied (its button says so). */
  copied: string | null
  /** B-W2b-170: why "Copy tracking link" waits (a preview, offline), or null; `link:<shipment id>` in `copied` once copied. */
  linkHeld?: string | null
  /** The promise history is open (the band's ⋯ opens it too). */
  historyOpen?: boolean
  dialog: OrderDialog | null
  /** B-W2b-194: "Reorder this line" (New order's reorder of this order; a person who may order), else null. */
  reorderHref?: string | null
}

export interface OrderRecordActions {
  onRetry?: () => void
  onRetryRevision?: () => void
  onRetryProgress?: () => void
  onRetryRequests?: () => void
  onRetryShipments?: () => void
  onRetryDocuments?: () => void
  onReconfirm?: () => void
  onPay?: (depositId: string) => void
  onWithdraw?: (request: ChangeRequest) => void
  onChangeLine?: (lineId: string) => void
  onLine?: (lineId: string) => void
  onHistory?: (open: boolean) => void
  onCopy?: (text: string) => void
  /** B-W2b-170: a link to the shipment's branded tracking page, copied to the clipboard. */
  onCopyTrackingLink?: (shipmentId: string) => void
  onPreview?: (file: { fileId: string; title: string }) => void
  onDownload?: (file: { fileId: string; name: string }) => void
  onDismissNotice?: () => void
  dialog?: {
    change?: ChangeDialogActions
    cancel?: CancelDialogActions
    reconfirm?: ReconfirmDialogActions
    pay?: PayDialogActions
    preview?: { onClose?: () => void; onDownload?: () => void; onRetry?: () => void }
  }
}

export function OrderRecordView({ model, actions, children }: { model: OrderRecordViewModel; actions?: OrderRecordActions; children?: ReactNode }) {
  const { t, time } = useOrderWords()
  if (model.state === 'loading') return <Loading rows={4} height={80} />
  if (model.state === 'missing') {
    return (
      <div className="fw-pord">
        <EmptyState
          icon={<AlertCircle size={24} aria-hidden />}
          title={t('record.missing')}
          description={t('record.missingBody')}
          action={
            <Button asChild>
              <a href={`${model.prefix}/orders`}>{t('record.toList')}</a>
            </Button>
          }
        />
      </div>
    )
  }
  if (model.state === 'error' || !model.record) {
    return (
      <div className="fw-pord">
        <EmptyState icon={<AlertCircle size={24} aria-hidden />} title={t('record.failed')} description={t('record.failedBody')} action={<Button onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
      </div>
    )
  }
  const record = model.record
  const dialog = model.dialog
  return (
    <div className="fw-pord">
      {model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline.title', { time: time(model.offlineSince) })} /> : null}
      {model.notice ? (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('notice.hide')}
            </Button>
          }
        />
      ) : null}
      {model.tab === 'status' ? <StatusTab model={model} record={record} actions={actions} /> : null}
      {model.tab === 'lines' ? <LinesTab model={model} record={record} actions={actions} /> : null}
      {model.tab === 'shipments' ? <ShipmentsTab model={model} actions={actions} /> : null}
      {model.tab === 'documents' ? <DocumentsTab model={model} actions={actions} /> : null}
      {model.tab === 'messages' ? (
        <section id="messages" className="fw-pord-tab" aria-label={t('tabs.messages')}>
          <p className="fw-pord-hint">{t('messages.hint')}</p>
          {children}
        </section>
      ) : null}
      {dialog?.kind === 'change' ? <ChangeDialog model={dialog.model} actions={actions?.dialog?.change} /> : null}
      {dialog?.kind === 'cancel' ? <CancelDialog model={dialog.model} actions={actions?.dialog?.cancel} /> : null}
      {dialog?.kind === 'reconfirm' ? <ReconfirmDialog model={dialog.model} actions={actions?.dialog?.reconfirm} /> : null}
      {dialog?.kind === 'pay' ? <PayDialog model={dialog.model} actions={actions?.dialog?.pay} /> : null}
      {dialog?.kind === 'preview' ? <PreviewDialog model={dialog.model} onClose={actions?.dialog?.preview?.onClose} onDownload={actions?.dialog?.preview?.onDownload} onRetry={actions?.dialog?.preview?.onRetry} /> : null}
    </div>
  )
}
