'use client'

import { useRef, type ReactNode } from 'react'
import { useActiveTabInView } from '../../../shell/view/active-tab' // pp-fx7 (re-walk R2-01): one part for the body's and the band's tabs
import { AlertCircle, WifiOff } from 'lucide-react'
import { Banner, EmptyState, Tabs, type TabItem } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import type { ApprovalPage, ChangeRequest, DocumentsRead, OrderRecord, ProgressRead, ShipmentsRead } from '../api'
import type { RecordTab } from '../model'
import { useOrderWords } from '../words'
import type { ProductionOrder } from '../../production/api' // F-PR-12a
import type { ProductionQuality } from '../../production/api' // F-PR-12c
import { QualityPhotoDialog, type QualityCardActions, type QualityPhotoModel } from './QualityCard' // F-PR-12c
import { AskDialog, type AskDialogActions, type AskDialogModel } from './AskDialog' // F-PR-13
// ---- F-PR-24: Report a problem (the dialog My production opens too) and the chip of the problems reported on the order
import type { ProblemChip } from '../../production/problem/model'
import { ReportProblemDialog, type ReportProblemActions, type ReportProblemModel } from '../../production/problem/view/ReportProblemDialog'
// ---- end F-PR-24
// ---- B-TH-275: the order docks its conversation (the portal record frame, B-TH-273): no Messages tab, no Ask modal.
import { PortalRecordFrame } from '../../../shell/record/PortalRecordFrame'
import type { PortalFrameMode } from '../../../shell/record/model'
import type { PortalDockWidth } from '../../../shell/record/model' // F-SA-264
import { orderNameOf } from '../model'
// ---- end B-TH-275
// ---- pp-w1 (w1.3, D6 a): the order's tabs in the body under the band, as the office's (the factory's TabLink: no prefetch)
import { TabLink } from '../../../../lib/tab-link/TabLink'
import { orderTabsOf } from '../band'
import { RecordNotices } from '../../../../lib/record-frame/RecordNotices' // w1.4: the office's notice slot, shared
// ---- end pp-w1
import { CancelDialog, PayDialog, PreviewDialog, ReconfirmDialog, type CancelDialogActions, type CancelDialogModel, type ChangeDialogActions, type ChangeDialogModel, type PayDialogActions, type PayDialogModel, type PreviewModel, type ReconfirmDialogActions, type ReconfirmDialogModel } from './Dialogs'
import { DocumentsTab } from './DocumentsTab'
import type { OrderFilesModel } from '../../../../lib/record-thread/files-view/model' // F-SA-238
import { LinesTab } from './LinesTab'
import { Loading } from './parts'
import { ShipmentsTab } from './ShipmentsTab'
import { OverviewTab } from './OverviewTab' // pp-w2 (w2.4): replaces Status & progress
import { MoneyTab } from './MoneyTab' // owb-po5.2
import type { OwnValue } from '../../../../lib/order-lines' // owb-po6.1
import type { LineAsks } from '../order-lines' // owb-po6.1
import type { MoneyRead, NoticeDraft } from '../money' // owb-po6.2
import type { NoticeWindowModel } from './MoneyTab' // owb-po6.2
import '../orders.css'
import type { PriceCheckActions, PriceCheckModel } from './PriceCheck' // F-CP-143

/**
 * SCR-184 › one order (design portal.customer.orders rec "Order"; B-TH-275, picture 22; pp-w1: Overview, Lines, Shipments, Files).
 * The frame's band holds the title ("Your order 12": the customer's own number), their PO, the status and its chips, the ONE
 * "Ask for a change…", the ⋯ (Re-confirm version N, Ask to cancel, Pay the deposit, the order confirmation PDF, Report a problem,
 * Ask a question); this view draws the four tabs under the band (D6 a, as the office), the tab and the pop-ups
 * beside the order's ONE conversation, docked by the portal record frame (`children`: PortalThread live, ThreadView in the design;
 * from 1280 px on the right — a third below 1600 px, 40 % from 1600 — narrower behind the band's "Messages (2 new)"). Each part reads on its own: a part that failed says so with
 * Try again, never as an empty part. Loading, a failed read and a missing order draw no conversation.
 */

type Part<T> = { state: 'loading' | 'error' | 'ready'; read: T | null }

export type OrderDialog =
  | { kind: 'change'; model: ChangeDialogModel }
  | { kind: 'cancel'; model: CancelDialogModel }
  | { kind: 'reconfirm'; model: ReconfirmDialogModel }
  | { kind: 'pay'; model: PayDialogModel }
  | { kind: 'preview'; model: PreviewModel }
  // F-PR-12c: a photo the factory shared on the order, full size (Overview › Quality and photos).
  | { kind: 'photo'; model: QualityPhotoModel }
  // F-PR-13: the Ask dialog (what, the details of a production ask, what it means before Send).
  | { kind: 'ask'; model: AskDialogModel }

export interface OrderRecordViewModel {
  /** B-W2b-374 (XF3:04): the lines' options and artwork (OrderPage mounts PortalLineOptions), drawn on the Lines tab. */
  options?: ReactNode
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
  /** F-SA-238: the order's shared files grouped like the office's Files tab (the same body, its customer face); absent: not read. */
  files?: (OrderFilesModel & { readonly notFound: boolean }) | null
  /** A preview / download cannot start (offline, a preview): why, or null. */
  fileHeld: string | null
  /** The line whose sizes are open (the address's `line=`). */
  openLine: string | null
  /** The tracking number just copied (its button says so). */
  copied: string | null
  /** B-W2b-170: why "Copy tracking link" waits (a preview, offline), or null; `link:<shipment id>` in `copied` once copied. */
  linkHeld?: string | null
  dialog: OrderDialog | null
  /** B-W2b-194: "Reorder this line" (New order's reorder of this order; a person who may order), else null. */
  reorderHref?: string | null
  // ---- B-TH-275
  /** "Made from your request #7" (its page) or "your quote #3" (its conversation page), from the summary read; null: none. */
  madeFrom?: { kind: 'request' | 'quote'; href: string; label: string | null } | null
  /** The design review: the frame's layout whatever the window (docked at 1440, the narrow "Messages (2 new)"). */
  frame?: { mode: PortalFrameMode; viewOpen?: boolean; newCount?: number; /* F-SA-264 */ width?: PortalDockWidth; hidden?: boolean }
  // ---- end B-TH-275
  // ---- F-PR-12a: the order's production (GET /portal/production/:orderId, B-PR-18) on the Overview (was Status & progress), part 1
  /**
   * `hidden`: not part of the reader's access (no portal.production.view), not in production, or not one of its orders (404):
   * no production section is drawn (a section not shared is not drawn); absent: the same.
   */
  production?: { state: 'loading' | 'error' | 'ready' | 'hidden'; read: ProductionOrder | null }
  /** Where "See what waits for you" leads (Waiting for you once built, until then Home). */
  waitingHref?: string | null
  // ---- end F-PR-12a
  // ---- F-PR-12c: + Quality & photos (GET /portal/production/:orderId/quality, B-PR-19), read only at the level that shares it
  /** `hidden`: the level does not share it, not in production, not its order or not part of its access: not drawn; absent: the same. */
  quality?: { state: 'loading' | 'error' | 'ready' | 'hidden'; read: ProductionQuality | null }
  // ---- end F-PR-12c
  // ---- F-PR-24: the problems the customer reported on this order and Report a problem (production drawn only)
  /**
   * `chip`: "Problem reported · Waiting on us since 16 Nov", then "Answered 17 Nov" (never who); `report`: Report a problem and why it
   * waits (null: it may open); absent or null: nothing of it is drawn.
   */
  problem?: { readonly chip: ProblemChip | null; readonly report: { readonly held: string | null } | null } | null
  /** The Report a problem dialog, open. */
  report?: ReportProblemModel | null
  // ---- end F-PR-24
  // ---- F-CP-143 (customer page plan C3, D2): the customer's own price check on the Lines tab — a price holder's (its Buyer, Finance,
  // Admin); absent or null: none (anyone else reads "Prices are not part of your access.", and no call is made).
  priceCheck?: PriceCheckModel | null
  // ---- end F-CP-143
  /** owb-po6.1: the lines' asks typed after Confirm and not sent yet (the save bar); absent: none. */
  lineAsks?: LineAsks  /** owb-po6.2: the money read (price grain; `hidden`: not built yet or refused — the round-1 cards) and the "I paid" window. */
  money?: { state: 'loading' | 'error' | 'ready' | 'hidden'; read: MoneyRead | null }
  noticeWindow?: NoticeWindowModel | null
  /** owb-po6.3: "Report a complaint or a return…" (today's returns flow with this order; null: not part of the access). */
  reportHref?: string | null
  /** owb-po6.3: the shipment whose label is being sent, and why "Send the shipping label" waits (a preview, offline, no upload right). */
  labelBusy?: string | null
  labelHeld?: string | null
  /** owb-po6.4: "Use as the picture" is saving. */
  pictureBusy?: boolean
}

export interface OrderRecordActions extends QualityCardActions /* F-PR-12c: onRetryQuality, onReport, onPhoto */ {
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
  onCopy?: (text: string) => void
  /** B-W2b-170: a link to the shipment's branded tracking page, copied to the clipboard. */
  onCopyTrackingLink?: (shipmentId: string) => void
  onPreview?: (file: { fileId: string; title: string }) => void
  onDownload?: (file: { fileId: string; name: string }) => void
  /** F-SA-238: open a file of the grouped list (a library document as today; any other shared file through the files route). */
  onOpenOrderFile?: (file: { fileId: string; name: string; contentType: string; library: boolean }) => void
  onRetryFiles?: () => void
  onDismissNotice?: () => void
  /** owb-po5.3: Asks & changes › All changes (the ONE log's window). */
  onChanges?: () => void
  // ---- owb-po6.1: the ONE lines table — an ask typed on a confirmed line, its save bar, an own column's value (at once)
  onLineAsk?: (lineId: string, text: string) => void
  onUndoAsk?: () => void
  onDiscardAsks?: () => void
  onReviewAsks?: () => void
  onOwnValue?: (lineId: string, columnId: string, value: OwnValue['value'], version: number | null) => void
  // ---- owb-po6.2: the money read again; "I paid: tell the factory…" on a step, its window
  onRetryMoney?: () => void
  onNotify?: (stepId: string) => void
  onNoticeDraft?: (draft: NoticeDraft) => void
  onNoticeSend?: () => void
  onNoticeClose?: () => void
  /** owb-po6.3: the label file picked for a shipment at the factory's warehouse: uploaded on the shipment, then sent. */
  onSendLabel?: (shipmentId: string, file: File) => void
  /** owb-po6.4: a file of the order becomes its picture (only for who may change it). */
  onUsePicture?: (fileId: string) => void
  // F-PR-12a: the order's production read again; the hold banner's "Ask a question" (the order's docked conversation).
  onRetryProduction?: () => void
  onAsk?: () => void
  // F-PR-24: Report a problem on this order; its dialog.
  onReportProblem?: () => void
  report?: ReportProblemActions
  /** F-CP-143: "Your prices…", its window, read again. */
  priceCheck?: PriceCheckActions
  dialog?: {
    change?: ChangeDialogActions
    cancel?: CancelDialogActions
    reconfirm?: ReconfirmDialogActions
    pay?: PayDialogActions
    preview?: { onClose?: () => void; onDownload?: () => void; onRetry?: () => void }
    // F-PR-12c
    photo?: { onIndex?: (index: number) => void; onClose?: () => void; onRetry?: () => void }
    // F-PR-13
    ask?: AskDialogActions
  }
}

/** pp-fx5 (walk W-13): the order's tab strip keeps the tab you are on whole in view (the shell's one part, shared with a band's tabs). */
function OrderTabs({ label, tabs, active }: { label: string; tabs: TabItem[]; active: string }) {
  const root = useRef<HTMLDivElement>(null)
  useActiveTabInView(root, `${active}:${tabs.length}`)
  return (
    <div ref={root} className="fw-pord-tabs">
      <Tabs ariaLabel={label} tabs={tabs} active={active} size="sm" overflow="scroll" linkAs={TabLink} />
    </div>
  )
}

export function OrderRecordView({ model, actions, children }: { model: OrderRecordViewModel; actions?: OrderRecordActions; children?: ReactNode }) {
  const words = useOrderWords()
  const { t, time, locale } = words
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
  const notice = model.notice ? (
    <Banner
      tone={model.notice.tone}
      title={t(model.notice.key, model.notice.params)}
      action={
        <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
          {t('notice.hide')}
        </Button>
      }
    />
  ) : null
  return (
    <PortalRecordFrame
      thread={children ?? null}
      threadLabel={t('messages.label', { name: orderNameOf(record.order, locale, t) })}
      design={model.frame /* pp-w1 (w1.1): no door beside the conversation — the band's ONE "Ask for a change…" (O1-B2) */}
    >
      <div className="fw-pord">
        {/* pp-w1 (w1.3; D2 a, D6 a): Overview · Lines · Shipments · Files in the body, `sm`, scrolling with its › arrow on a phone. */}
        <OrderTabs label={t('tabs.label')} tabs={orderTabsOf({ words, record, prefix: model.prefix, toConfirm: record.order.reconfirmNeeded && model.revision.state === 'ready' && !!model.revision.page?.content.revisedOrder, files: model.files?.read?.total ?? null, money: record.seesPrices })} active={model.tab} />
        {/* pp-w1 (w1.4): the order's notices in the office's ONE notice slot (lib/record-frame RecordNotices): the most serious shows,
            the rest wait behind "N more notices" — a failure first, then the lost connection, then what was just sent. */}
        <RecordNotices>
          {model.notice?.tone === 'danger' ? notice : null}
          {model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline.title', { time: time(model.offlineSince) })} /> : null}
          {model.notice && model.notice.tone !== 'danger' ? notice : null}
        </RecordNotices>
        {model.tab === 'overview' ? <OverviewTab model={model} record={record} actions={actions} /> : null}
        {model.tab === 'lines' ? <LinesTab model={model} record={record} actions={actions} /> : null}
        {model.tab === 'money' ? <MoneyTab model={model} record={record} actions={actions} /> : null}
        {model.tab === 'shipments' ? <ShipmentsTab model={model} actions={actions} /> : null}
        {model.tab === 'files' ? <DocumentsTab model={model} actions={actions} /> : null}
        {/* pp-fx4 (walk W-05): ONE Ask pop-up — a change is its steps 2 and 3 (the same Modal stays open as the steps move). */}
        {dialog?.kind === 'ask' ? <AskDialog flow={{ kind: 'ask', model: dialog.model, actions: actions?.dialog?.ask }} /> : dialog?.kind === 'change' ? <AskDialog flow={{ kind: 'change', model: dialog.model, actions: actions?.dialog?.change }} /> : null}
        {dialog?.kind === 'cancel' ? <CancelDialog model={dialog.model} actions={actions?.dialog?.cancel} /> : null}
        {dialog?.kind === 'reconfirm' ? <ReconfirmDialog model={dialog.model} actions={actions?.dialog?.reconfirm} /> : null}
        {dialog?.kind === 'pay' ? <PayDialog model={dialog.model} actions={actions?.dialog?.pay} /> : null}
        {dialog?.kind === 'preview' ? <PreviewDialog model={dialog.model} onClose={actions?.dialog?.preview?.onClose} onDownload={actions?.dialog?.preview?.onDownload} onRetry={actions?.dialog?.preview?.onRetry} /> : null}
        {/* F-PR-12c */}
        {dialog?.kind === 'photo' ? <QualityPhotoDialog model={dialog.model} onIndex={actions?.dialog?.photo?.onIndex} onClose={actions?.dialog?.photo?.onClose} onRetry={actions?.dialog?.photo?.onRetry} /> : null}
        {/* F-PR-24 */}
        {model.report ? <ReportProblemDialog model={model.report} actions={actions?.report} /> : null}
      </div>
    </PortalRecordFrame>
  )
}
