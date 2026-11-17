'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, Gavel, Rocket, Send, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Kbd, Skeleton, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { OrderView, RequestView } from '../../api'
import { actionHeld, isLiveOrderStatus, KIND_TABS, listHref, moveHeld, recordHref, styleHref, type RecordTab } from '../../model'
import { ChangesMessages, isPageKey, KindTag, NoticeLine, OrderPill, PriorityTag, RequestPill, useWords } from '../../parts'
import { DecideDialog } from '../../view/DecideDialog'
import type { ChangeRecordActions, ChangeRecordModel, RecordDialog } from '../view-model'
import { OrderAffectedTab, OrderApprovalsTab, OrderChangeTab, OrderImpactTab } from './OrderTabs'
import { RequestAffectedTab, RequestApprovalsTab, RequestChangeTab, RequestImpactTab } from './RequestTabs'
// ---- B-TH-262: the change on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

export type { ChangeRecordActions, ChangeRecordModel } from '../view-model'

/**
 * SCR-117-record — a change (design products.changes "Record: Change"; Owner L1: the tabs always in view), on RecordFrame (B-TH-262;
 * the rule of picture 38, the tabs of picture 39): the band in the shell's band row — ‹ Changes & versions, its number and style, ONE
 * pill (its status), kind, priority, title and a change order's approvals "1 of 2" as the band's details; the primary act its state
 * allows — a request: Accept or reject…; a change order: Submit for approval, Approve…, Release revision N; the Thread button (⌘J);
 * ⋯ the rest (Start the draft revision, Write a change order, the style, Copy number, Cancel…) and the Keyboard line. The change's
 * thread is docked beside every tab (40 %); Activity's tools are in the thread's "⋯" (R-ACT). Tabs: a request 5 → 3 (Change, Impact &
 * affected, Approvals); a change order 5 → 4 (Change, Impact, Approvals, Affected records). ONE notice in the body column. A real
 * address: ⌘-click on a row opens it in a new tab (design tab:changes.record, beside the style's draft revision).
 */
// B-TH-262: `thread` is the docked thread (the office's OfficeRecordThread docked, or a design case's), `printThread` what the print view
// shows of it (the record panels' print form).
export function ChangeRecordView({ model, actions, thread, printThread }: { model: ChangeRecordModel; actions?: ChangeRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <ChangesMessages>
      <Body model={model} actions={actions} thread={thread} printThread={printThread} />
    </ChangesMessages>
  )
}

/** The words of a tab: a request's `impact` is the merged "Impact & affected". */
export const tabWords = (kind: ChangeRecordModel['kind'], tab: RecordTab): string => (kind === 'request' && tab === 'impact' ? 'tab.impactAffected' : `tab.${tab}`)

/** The page's states before the change is read (loading, not found, failed, no access): the band with the way back, no thread. */
function Waiting({ model, title, children }: { model: ChangeRecordModel; title: ReactNode; children: ReactNode }) {
  const { t } = useWords()
  return (
    <RecordFrame recordType={model.kind === 'order' ? 'ChangeOrder' : 'ChangeRequest'} personId={model.me} band={{ back: <Link href={listHref(model.prefix)}>{t('record.back')}</Link>, title, moreLabel: t('record.more') }} thread={null} threadLabel={t('record.dockLabel')}>
      <div className="fw-chg">{children}</div>
    </RecordFrame>
  )
}

function Problem({ title, body, back, onRetry, icon }: { title: string; body: string; back: ReactNode; onRetry?: () => void; icon: ReactNode }) {
  const { t } = useWords()
  return (
    <Card padded>
      <EmptyState
        icon={icon}
        title={title}
        description={body}
        action={
          <span className="fw-chg-actions">
            {back}
            {onRetry && (
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            )}
          </span>
        }
      />
    </Card>
  )
}

function Body({ model, actions, thread, printThread }: { model: ChangeRecordModel; actions?: ChangeRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const { t, say } = useWords()
  const list = listHref(model.prefix)
  const back = (
    <Button size="sm" asChild>
      <Link href={list}>{t('record.backToList')}</Link>
    </Button>
  )
  const offline = model.live === 'offline'
  const request = model.loaded.status === 'ready' ? (model.loaded.request ?? null) : null
  const order = model.loaded.status === 'ready' ? (model.loaded.order ?? null) : null

  // a: Approve change (an order waiting for approval, a request to triage) — never while typing or in a dialog. ⌘J is the frame's.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.dialog || model.decide) return
      const waiting = (order && order.status === 'SUBMITTED' && order.actions.decide.allowed) || (request && (request.status === 'OPEN' || request.status === 'IN_REVIEW') && model.can.manage)
      if (event.key === 'a' && waiting) {
        event.preventDefault()
        actions?.onDecide?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.decide, model.can.manage, order, request, actions])

  if (!model.can.view || model.loaded.status === 'forbidden')
    return (
      <Waiting model={model} title={t('noAccess.title')}>
        <Problem icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} body={t('noAccess.body')} back={back} />
      </Waiting>
    )
  if (model.loaded.status === 'loading')
    return (
      <Waiting model={model} title={<Skeleton width={260} height={22} />}>
        <div className="fw-chg" aria-busy="true">
          <p className="fw-chg-hint" role="status">
            <Spinner size={14} /> {t('record.loading')}
          </p>
          <Skeleton height={28} width="60%" />
          <div className="fw-chg-two">
            <Skeleton height={220} />
            <Skeleton height={220} />
          </div>
        </div>
      </Waiting>
    )
  if (model.loaded.status === 'notFound')
    return (
      <Waiting model={model} title={t('record.notFoundTitle')}>
        <Problem icon={<FileX size={24} aria-hidden />} title={t('record.notFoundTitle')} body={t('record.notFoundBody')} back={back} />
      </Waiting>
    )
  if (model.loaded.status === 'error')
    return (
      <Waiting model={model} title={t('record.failedTitle')}>
        <Problem icon={<FileX size={24} aria-hidden />} title={t('record.failedTitle')} body={t(model.loaded.problem)} back={back} onRetry={() => actions?.onRetry?.()} />
      </Waiting>
    )

  const id = (order ?? request)!.id
  const number = order ? order.number : (request!.number ?? t('row.floorNoNumber'))
  const style = (order ?? request)!.style
  const tabs: TabItem[] = KIND_TABS[model.kind].map((tab) => ({
    id: tab,
    href: recordHref(model.prefix, model.kind, id, tab),
    label: t(tabWords(model.kind, tab)),
    count: tab === 'approvals' && order ? (order.approvalsList.length > 0 ? order.approvalsList.length : null) : tab === 'impact' && order ? order.workInProgress.length || null : null,
  }))
  const { primary, menu } = order ? orderActs(order, model, actions, t, say, offline) : requestActs(request!, model, actions, t, say, offline)

  return (
    <>
      <RecordFrame
        recordType={model.kind === 'order' ? 'ChangeOrder' : 'ChangeRequest'}
        personId={model.me}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back: <Link href={list}>{t('record.back')}</Link>,
          title: (
            <span>
              {number} <span className="fw-chg-title-name">· {style.code}</span>
            </span>
          ),
          status: order ? <OrderPill status={order.status} /> : <RequestPill status={request!.status} />,
          meta: (
            <span className="fw-chg-row">
              <KindTag kind={model.kind} />
              <PriorityTag priority={(order ?? request)!.priority} />
              <span>{(order ?? request)!.title}</span>
              {order && order.approvals.required > 0 && <span>{t('approvals.count', { approved: order.approvals.approved, required: order.approvals.required })}</span>}
            </span>
          ),
          primary,
          more: menu,
          moreLabel: t('record.more'),
        }}
      >
        <Tabs ariaLabel={t('record.tabs')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
        {/* B-TH-262: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
          <NoticeLine notice={model.notice} lines={model.lines} onDismiss={actions?.onDismissNotice} />
          {order?.status === 'REJECTED' && <Banner tone="danger" title={t('record.rejectedBanner')} />}
          {request?.status === 'REJECTED' && <Banner tone="danger" title={t('record.requestRejected', { note: request.decisionNote ?? '—' })} />}
          {order?.status === 'CANCELLED' && <Banner tone="info" title={t('record.cancelledBanner', { reason: order.cancelReason ?? '—' })} />}
          {offline && <Banner tone="warning" title={t('record.offline')} />}
          {model.stale && (
            <Banner
              tone="warning"
              title={t('record.stale', { time: model.stale })}
              action={
                <Button size="sm" variant="quiet" onClick={() => actions?.onReload?.()}>
                  {t('record.reload')}
                </Button>
              }
            />
          )}
        </RecordNotices>
        {request && model.tab === 'change' && <RequestChangeTab model={model} request={request} actions={actions} />}
        {/* B-TH-262 (R-5): a request's Impact & affected — where it was seen and what is made of it, then the style and revision it is about. */}
        {request && model.tab === 'impact' && (
          <div className="fw-chg-stack">
            <RequestImpactTab model={model} request={request} />
            <RequestAffectedTab model={model} request={request} />
          </div>
        )}
        {request && model.tab === 'approvals' && <RequestApprovalsTab model={model} request={request} />}
        {order && model.tab === 'change' && <OrderChangeTab model={model} order={order} actions={actions} />}
        {order && model.tab === 'impact' && <OrderImpactTab model={model} order={order} actions={actions} />}
        {order && model.tab === 'approvals' && <OrderApprovalsTab model={model} order={order} actions={actions} />}
        {order && model.tab === 'affected' && <OrderAffectedTab model={model} order={order} actions={actions} />}
      </RecordFrame>
      {order && model.dialog && <RecordDialogView dialog={model.dialog} order={order} actions={actions} offline={offline} />}
      {model.decide && <DecideDialog model={model.decide} prefix={model.prefix} canWorkOrders={model.can.workOrders} actions={actions?.decide} />}
    </>
  )
}

type Words = ReturnType<typeof useWords>

function orderActs(order: OrderView, model: ChangeRecordModel, actions: ChangeRecordActions | undefined, t: Words['t'], say: Words['say'], offline: boolean): { primary: ReactNode; menu: MenuItemDef[] } {
  const busy = model.busy ? t('common.working') : null
  const primary =
    order.status === 'DRAFT' ? (
      <Button size="sm" variant="primary" heldReason={busy ?? say(actionHeld(order, 'submit', model.can, offline))} onClick={() => actions?.onSubmit?.()}>
        <Send size={14} aria-hidden /> {t('order.submit')}
      </Button>
    ) : order.status === 'SUBMITTED' ? (
      <Button size="sm" variant="primary" heldReason={busy ?? say(actionHeld(order, 'decide', model.can, offline))} onClick={() => actions?.onDecide?.()} aria-keyshortcuts="a">
        <Gavel size={14} aria-hidden /> {t('order.decide')}
      </Button>
    ) : order.status === 'APPROVED' && order.toRevision ? (
      <Button size="sm" variant="primary" heldReason={busy ?? say(actionHeld(order, 'release', model.can, offline))} onClick={() => actions?.onDialog?.({ kind: 'release', changeNote: order.title, busy: false, notice: null })}>
        <Rocket size={14} aria-hidden /> {t('order.release', { revision: order.toRevision.revision })}
      </Button>
    ) : null
  const startHeld = say(actionHeld(order, 'startDraft', model.can, offline))
  const cancelHeld = say(actionHeld(order, 'cancel', model.can, offline))
  const menu: MenuItemDef[] = [
    ...(order.toRevision ? [] : [{ id: 'startDraft', label: t('order.startDraft'), disabled: !!startHeld, description: startHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'startDraft', changeNote: order.title, busy: false, notice: null }) }]),
    { id: 'style', label: t('record.openStyle', { style: order.style.code }), href: styleHref(model.prefix, order.style.id, order.toRevision?.id ?? order.fromRevision.id) },
    { id: 'styleChanges', label: t('record.styleChanges', { style: order.style.code }), href: listHref(model.prefix, { style: order.style.id }) },
    { id: 'copy', label: t('record.copyNumber'), onSelect: () => actions?.onCopy?.() },
    ...(isLiveOrderStatus(order.status) ? [{ id: 'cancel', label: t('record.cancel'), tone: 'danger' as const, disabled: !!cancelHeld, description: cancelHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'cancel', reason: '', busy: false, notice: null }) }] : []),
  ]
  return { primary, menu }
}

function requestActs(request: RequestView, model: ChangeRecordModel, actions: ChangeRecordActions | undefined, t: Words['t'], say: Words['say'], offline: boolean): { primary: ReactNode; menu: MenuItemDef[] } {
  const open = request.status === 'OPEN' || request.status === 'IN_REVIEW'
  const decideHeld = model.busy ? t('common.working') : say(moveHeld(request, 'ACCEPTED', model.can, offline)) && say(moveHeld(request, 'REJECTED', model.can, offline))
  const free = request.status !== 'REJECTED' && request.status !== 'DONE' && (request.changeOrder === null || !isLiveOrderStatus(request.changeOrder.status))
  const orderHeld = !model.can.manage ? t('held.noManage') : offline ? t('held.offline') : null
  const writeOrder = `${listHref(model.prefix, { newOrder: true, style: request.style.id, request: request.id })}`
  const primary = open ? (
    <Button size="sm" variant="primary" heldReason={decideHeld || null} onClick={() => actions?.onDecide?.()} aria-keyshortcuts="a">
      <Gavel size={14} aria-hidden /> {t('request.decide')}
    </Button>
  ) : request.status === 'ACCEPTED' && free ? (
    orderHeld ? (
      <Button size="sm" variant="primary" heldReason={orderHeld}>
        {t('request.writeOrder')}
      </Button>
    ) : (
      <Button size="sm" variant="primary" asChild>
        <Link href={writeOrder}>{t('request.writeOrder')}</Link>
      </Button>
    )
  ) : null
  const menu: MenuItemDef[] = [
    ...(free && request.status !== 'ACCEPTED' ? [{ id: 'order', label: t('request.writeOrder'), disabled: !!orderHeld, description: orderHeld ?? undefined, href: orderHeld ? undefined : writeOrder }] : []),
    { id: 'style', label: t('record.openStyle', { style: request.style.code }), href: styleHref(model.prefix, request.style.id, request.revision?.id) },
    { id: 'styleChanges', label: t('record.styleChanges', { style: request.style.code }), href: listHref(model.prefix, { style: request.style.id }) },
    ...(request.number ? [{ id: 'copy', label: t('record.copyNumber'), onSelect: () => actions?.onCopy?.() }] : []),
  ]
  return { primary, menu }
}

/** Cancel…, Release revision N, Start the draft revision: each says what happens, then asks once. */
function RecordDialogView({ dialog, order, actions, offline }: { dialog: RecordDialog; order: OrderView; actions?: ChangeRecordActions; offline: boolean }) {
  const { t, say } = useWords()
  const busy = dialog.busy ? t('common.working') : null
  const held = busy ?? (offline ? t('held.offline') : dialog.kind === 'cancel' && !dialog.reason.trim() ? say({ key: 'refusal.CANCEL_REASON' }) : null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        actions?.onDialogSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, actions])
  const title = dialog.kind === 'cancel' ? t('dialog.cancelTitle', { number: order.number }) : dialog.kind === 'release' ? t('dialog.releaseTitle', { revision: order.toRevision?.revision ?? 0 }) : t('dialog.startTitle')
  const body = dialog.kind === 'cancel' ? t('dialog.cancelBody') : dialog.kind === 'release' ? t('dialog.releaseBody', { from: order.fromRevision.revision, to: order.toRevision?.revision ?? 0 }) : t('dialog.startBody', { from: order.fromRevision.revision })
  const submit = dialog.kind === 'cancel' ? t('dialog.cancelSubmit') : dialog.kind === 'release' ? t('dialog.releaseSubmit') : t('dialog.startSubmit')
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={title}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" variant="secondary" onClick={() => actions?.onDialog?.(null)}>
            {t('common.back')}
          </Button>
          <Button size="sm" variant={dialog.kind === 'cancel' ? 'danger' : 'primary'} heldReason={held} onClick={() => actions?.onDialogSubmit?.()} aria-keyshortcuts="Meta+Enter">
            {submit}
            <span className="fw-chg-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
          </Button>
        </>
      }
    >
      <div className="fw-chg-form">
        <NoticeLine notice={dialog.notice} />
        <p className="fw-chg-text">{body}</p>
        {dialog.kind === 'cancel' ? (
          <Field label={t('dialog.cancelWhy')} required>
            <Textarea rows={3} maxLength={1000} value={dialog.reason} onChange={(event) => actions?.onDialogPatch?.({ reason: event.target.value })} />
          </Field>
        ) : (
          <Field label={t('dialog.changeNote')} hint={t('dialog.changeNoteHint')}>
            <Textarea rows={2} maxLength={500} value={dialog.changeNote} onChange={(event) => actions?.onDialogPatch?.({ changeNote: event.target.value })} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
