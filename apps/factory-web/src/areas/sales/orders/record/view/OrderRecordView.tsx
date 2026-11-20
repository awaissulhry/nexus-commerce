'use client'

import { useEffect, useRef, type ReactNode } from 'react' // F-OP-102: useRef
import Link from 'next/link'
import { useSearchParams } from 'next/navigation' // F-OP-210: the tab links keep the dock's scope
import { FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import { amendHeld, closeLinesHeld, copyHeld, reopenHeld } from '../../daily-model'
import { splitHeld } from '../../model' // F-OP-111
import { DOCK_DEFAULTS } from '../../model' // F-SA-263
import { cancelHeld, dayInstant, depositGate, groupedMenu, isFinal, isMadeToMeasure, promiseHeld, readyHeld, recordTabs, STATUS_TONE, tabCountOf, type MenuGroup } from '../../model'
import { ChangesTab } from '../changes/view/ChangesTab'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { OrderDialogs } from './Dialogs'
import { LinesTab } from './LinesTab'
import { MoneyTab } from './MoneyTab'
import { ProductionTab } from './ProductionTab'
import { ShipmentsTab } from './ShipmentsTab'
// ---- B-W2b-323 (orders in depth on screen) ----
import { depthMenuItems, DepthNotice, DepthPills, WaitingBanner } from '../../depth/view/DepthBand'
import { RefuseYesDialog } from '../../depth/view/DepthBand' // F-OP-101
// ---- F-OP-116: the page's work-order dialogs and the ONE decide window of a work-order change ----
import { WorkOrderActsDialogs } from '../../../../../lib/production/work-order-acts/view/WorkOrderActsDialogs'
import { NewWorkOrderDialog } from '../../../../production/work-orders/view/NewWorkOrderDialog' // F-OP-102
import { WorkOrderChangeReview } from '../../../../home/approvals/work-order-changes/view/WorkOrderChangeReview'
import { DepthDialogs } from '../../depth/view/DepthDialogs'
import { NAMESPACE as DEPTH } from '../../depth/model'
import { askHeld, openRequest, withdrawHeld } from '../../depth/model' // F-OP-102: the band's Ask / Take back
// ---- B-TH-214: the order on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { useRecordFrame, type RecordFrameState } from '../../../../_shared/record-frame/RecordFrame' // F-OP-102: the owner door
import { makeHeldOf } from '../production' // F-OP-102
import { makeInMenu } from '../../model' // F-OP-102
import { linesNotInProduction } from '../../model' // F-OP-102
import { readOnlyOnPage } from '../../model' // F-OP-303 (walk #6)
import { bandMenuFor, bandStepOf } from '../../model' // F-OP-311 (oo-walk #10): Read-only sees no move in the band
import { planningHref } from '../../../../../lib/production/work-order-acts/model' // F-OP-102
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'
import { tabHref } from '../../../../_shared/record-frame/address' // F-OP-210
import { TabLink } from '../../../../../lib/tab-link/TabLink' // F-OP-210
// ---- B-TH-256: what points at the order (its complaints and returns, planning's re-promises, the gates' refusals) ----
import { DeclineDialog, GateNotices, LinksSaid, RePromiseNotices } from '../links/view/OrderLinks'
import '../../orders.css'
// ---- F-SA-230: the band's health (Late / At risk only), the ⋯ People (the production lane's dialogs, reused in place) ----
import { AssignSupervisorDialog } from '../../../../_shared/production-supervisor/view/AssignSupervisorDialog'
import { SUPERVISOR_NS } from '../../../../_shared/production-supervisor/model'
import { NoteDialog } from '../../../../production/_shared/notes/view/NoteDialog'
import { NOTES_NS, openHeld as noteHeld } from '../../../../production/_shared/notes/model'
// ---- end F-SA-230
// ---- F-SA-232: Overview, the first tab; the band's health and the customer's urgency from the production read ----
import { BandHealth, BandUrgency, OverviewTab } from './OverviewTab'
import { FilesTab } from './FilesTab' // F-SA-237
// F-SA-243: the order page's doors to the ONE review window, its notices and Still to do.
import { RequestDoorNoticeBanner, RequestDoorWindow } from '../../../../home/approvals/requests/view/RequestReview'
import { RequestBandNotices } from './RequestsSection'
import { bandHealthOf, healthInputOf, readOf } from '../overview/model'
import { changesBadgeOf, changesDotOf, orderWaitingOf } from '../overview/model' // F-OP-117: the Changes count, R-22 (F-OP-301: the ONE call)
import { createShipmentDoor } from '../shipments/model' // F-OP-121
import { answerHeldOf, OWNER_WORDS_NS } from '../overview/people' // F-OO-111 (BC-2): "Who answers the customer…" held in the card's words
// ---- end F-SA-232

export type { OrderRecordActions, OrderRecordModel } from '../record-model'

/**
 * SCR-039 — the order studio (design sales.orders "Record: Sales order"; 00 §2.2; Owner L1: the tabs always in view), on RecordFrame
 * (B-TH-214; threads plan O-SAL-ORD-REC, picture 29). The band in the shell's band row: ‹ Orders, "<number> · <customer>", ONE status
 * pill, the customer PO and the quote it came from, the next step by state as the primary (Confirmed → Make work orders, held while
 * production waits for the deposit; In production / Ready / Partly shipped → Change promise date; Shipped → Close order, held until
 * settled unless the person may close it anyway with a reason), the Thread button (⌘J), ⋯ with its Keyboard line. The thread is
 * docked beside every tab (40 %; one third on Lines under 1600 px); Activity's tools are in the thread's "⋯" (R-ACT), its files in
 * the Files view. The tabs 9 → 5: Lines (one size grid per style), Production & dates (the work orders and the deposit gate, the
 * promise and its history, the brand tech pack in force), Shipments & invoices (the shipments; the deposit — request, the
 * bank-details page, the payment, the TD02 and its SDI state —, the invoices, the balance), Confirmation & changes (the order
 * confirmation and the accepted quote's evidence; the amendments), Margin (the margin grain only). ONE notice in the body column,
 * the most serious first, the rest behind "N more notices".
 * B-TH-256: Shipments & invoices also lists the order's complaints and returns; the notices hold the compliance gates' refusals that
 * still block its work orders or shipments and planning's re-promises (Accept / Decline).
 * F-SA-230 (sales page plan N2; 10-order-page §1, §2, §4): the tabs re-cut without losing anything — Lines · Production (the work
 * orders, the dates #dates, the tech pack) · Changes (the confirmation #confirmation, the amendments) · Money (totals, deposit,
 * payment schedule, invoices & credit notes #invoices, the margin #margin by its grain) · Shipments (left to ship, shipments,
 * deliveries, complaints & returns); every old `?tab=` lands on its new tab and section. The band: the health chip only for Late /
 * At risk (the Late banner went), the priority in words, Made to measure; ⋯ grouped (Next steps · Edit · People · Go to · Copy;
 * Cancel last) with Assign supervisor… and Ask the supervisor… (the production lane's dialogs); notices most serious first.
 */
// B-W2b-398: `delivered` is the Shipments tab's card "Delivered (from carrier)". B-TH-214: `thread` the docked thread (the
// office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
// F-OO-211 (11-design §8.1): `customFields` — the order's custom fields (the container's RecordCustomFields, built once), drawn by
// Overview beside Order facts (the 7 + 8 pair); the order page no longer fills the frame's `fields` slot (every other record page does).
export function OrderRecordView({ model, actions, thread, printThread, customFields, delivered }: { model: OrderRecordModel; actions?: OrderRecordActions; thread?: ReactNode; printThread?: ReactNode; /* F-OO-211 */ customFields?: ReactNode; delivered?: ReactNode }) {
  return (
    <WithMessages namespaces={['orders', 'sales', 'lists', 'records', DEPTH /* B-W2b-323 */, SUPERVISOR_NS, NOTES_NS /* F-SA-230 */, OWNER_WORDS_NS /* F-OO-111 */]}>
      <OrderRecord model={model} actions={actions} thread={thread} printThread={printThread} customFields={customFields} delivered={delivered} />
    </WithMessages>
  )
}

function OrderRecord({ model, actions, thread, printThread, customFields, delivered }: { model: OrderRecordModel; actions?: OrderRecordActions; thread?: ReactNode; printThread?: ReactNode; customFields?: ReactNode; delivered?: ReactNode }) {
  const t = useT('orders')
  const listHref = `${model.prefix}/sales/orders`
  const loaded = model.order

  if (loaded.status !== 'ready') {
    return (
      <RecordFrame
        recordType="SalesOrder"
        personId={model.personId ?? null}
        band={{ back: <Link href={listHref}>{t('record.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title'), moreLabel: t('record.more') }}
        thread={null}
        threadLabel={t('record.dockLabel')}
      >
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-so-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-so-stack">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(`record.state.${loaded.status}.title`)}
              description={loaded.status === 'error' ? t(loaded.problem) : t(`record.state.${loaded.status}.body`)}
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={listHref}>{t('record.backToList')}</Link>
                  </Button>
                )
              }
            />
          </Card>
        )}
      </RecordFrame>
    )
  }
  return <ReadyRecord order={loaded.value} model={model} actions={actions} thread={thread} printThread={printThread} customFields={customFields} delivered={delivered} />
}

function ReadyRecord({ order, model, actions, thread, printThread, customFields, delivered }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; thread?: ReactNode; printThread?: ReactNode; customFields?: ReactNode; delivered?: ReactNode }) {
  const t = useT('orders')
  const d = useT(DEPTH) // B-W2b-323
  const locale = useLocale()
  const frameRef = useRef<RecordFrameState | null>(null) // F-OP-102: the frame's doors for the band's ⋯ (FrameBridge fills it)
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  // F-OP-210 (11-dock §4; RC4): every tab link keeps the dock's scope (`thread=`): a pick in the dock survives a change of tab.
  const search = useSearchParams()?.toString() ?? ''
  // F-OP-311 (oo-walk #10): Read-only on the page (the cards' own rule) sees no next step and no move in the ⋯; everyone else keeps
  // every move, held with its words.
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const step = bandStepOf(order, model.can, readOnly)
  const createDoor = createShipmentDoor(order, model.can, model.prefix, !!actions?.onCreateShipment) // F-OP-121
  const stepHeld = step.held ? t(step.held.key, step.held.params?.date ? { ...step.held.params, date: formatDate(dayInstant(String(step.held.params.date)), { locale }) } : step.held.params) : model.busy ? t('held.busy') : null
  const gate = depositGate(order)
  // ---- F-OP-102 (10-order-page §2.1): the primary by state, in place — Make work orders… opens its dialog here (F-OP-112); while the
  // order waits for a yes, the approver confirms it here (F-OP-101), anyone else asks for it or takes their request back (the depth's
  // own dialogs and holds). ⌘↵ runs the same.
  const approval = model.depth?.approval?.value ?? null
  const yesRequest = approval ? openRequest(approval) : null
  const yesWait = step.kind === 'askYes' && approval && model.depth ? (yesRequest ? withdrawHeld(approval, model.depth.can) : askHeld(approval, model.depth.can)) : null
  const primaryHeld = step.kind === 'askYes' ? (stepHeld ?? (yesWait ? d(yesWait.key) : !approval ? d('held.reading') : null)) : stepHeld
  const runPrimary = () => {
    if (step.kind === 'makeWorkOrders') return actions?.makeWorkOrders?.onOpen?.()
    if (step.kind === 'confirmYes' && step.taskId) return actions?.yes?.onConfirm?.(step.taskId)
    if (step.kind === 'askYes') return actions?.depth?.onDialog?.(yesRequest ? { kind: 'withdraw' } : { kind: 'ask', note: '' })
    if (step.kind === 'createShipment') return actions?.onCreateShipment?.() // F-OP-121: in place
    if (step.kind === 'close' || step.kind === 'changePromise') actions?.onDialog?.({ kind: step.kind === 'close' ? 'close' : 'promise' })
  }
  const primaryLabel = step.kind === 'confirmYes' ? t('approval.confirm') : step.kind === 'askYes' ? d(yesRequest ? 'wait.withdraw' : 'wait.ask') : step.kind ? t(`step.${step.kind}`) : ''
  // ---- end F-OP-102

  // Keys: ⌘↵ the next step (never while typing or inside a dialog). ⌘J is the frame's (the thread).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      if (target?.closest('[role="dialog"]') || model.dialog) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !typing && step.kind && !primaryHeld) {
        event.preventDefault()
        // F-OP-121: Create shipment… without the container goes to Warehouse's New shipment with this order chosen.
        if (step.kind === 'createShipment' && createDoor?.kind === 'warehouse') window.location.assign(createDoor.href)
        else runPrimary() // F-OP-102: the primary, in place
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const openDeposits = order.chain.depositRequests.filter((request) => request.status === 'OPEN').length
  // F-SA-230: the tabs re-cut (Lines · Production · Changes · Money · Shipments), each counting what it lists; Money's dot: a deposit open.
  // F-SA-232: Overview carries a mark while the order is late or at risk (the band's same chip, the same read).
  const production = readOf(model.production)
  const attention = bandHealthOf(healthInputOf(order, production?.headline ?? null, production?.dates ?? null))
  // ---- F-OP-117 (R-22): Changes counts the ONE waiting list's rows — the Overview card's own (null before the production read: no
  // number that is not true); its dot when one of them waits on this reader.
  // F-OP-301 (walk #1): the same call Overview's card and the Changes tab make (orderWaitingOf), so the three agree.
  const waiting = orderWaitingOf(order, model, locale)
  const waitingCard = production?.headline && waiting.status === 'ready' ? waiting.card : null
  const changesCount = waitingCard ? changesBadgeOf(waitingCard) : null
  const changesDot = waitingCard ? changesDotOf(waitingCard) : false
  // ---- end F-OP-117
  const tabs: TabItem[] = recordTabs(model.can).map((tab) => ({
    id: tab,
    href: tabHref(recordHref, tab, search), // F-OP-210
    label:
      tab === 'overview' && attention ? (
        <span className="fw-so-tablabel">
          {t(`tab.${tab}`)}
          <span className="fw-so-dot" aria-label={t('tab.attention')} role="img" />
        </span>
      ) : tab === 'changes' && changesDot ? (
        // F-OP-117: one of the waiting rows is this reader's to do.
        <span className="fw-so-tablabel">
          {t(`tab.${tab}`)}
          <span className="fw-so-dot" aria-label={t('badge.yourTurn')} role="img" />
        </span>
      ) : tab === 'money' && openDeposits > 0 ? (
        <span className="fw-so-tablabel">
          {t(`tab.${tab}`)}
          <span className="fw-so-dot" aria-label={t('tab.depositOpen')} role="img" />
        </span>
      ) : (
        t(`tab.${tab}`)
      ),
    count: tab === 'files' ? (model.files?.read?.total ?? null) : tabCountOf(tab, order, { changes: changesCount /* F-OP-117 */, viewInvoices: model.can.viewInvoices /* F-OP-306 */ }), // F-SA-237: the files the reader may open
  }))
  // F-SA-230: a section an old address named (`?tab=margin` → Money #margin) comes into view once its tab is drawn.
  useEffect(() => {
    const id = typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' })
  }, [model.tab])

  // F-OP-102: one primary by state, every one in place (no page change).
  const primary =
    step.kind === 'createShipment' && createDoor?.kind === 'warehouse' ? (
      // F-OP-121: without the container (a design case), Warehouse's New shipment with this order chosen.
      <Button size="sm" variant="primary" asChild aria-keyshortcuts="Meta+Enter Control+Enter">
        <Link href={createDoor.href}>{t('action.createShipment')}</Link>
      </Button>
    ) : step.kind ? (
      <Button size="sm" variant="primary" heldReason={primaryHeld} onClick={runPrimary} aria-keyshortcuts="Meta+Enter Control+Enter">
        {primaryLabel}
      </Button>
    ) : null

  // F-OO-112: a held phrase says its values too (Mark ready's "3 of 7 released"; before, the ⋯ dropped every phrase's values).
  const held = (phrase: { key: string; params?: Record<string, string | number> } | null) => (phrase ? t(phrase.key, phrase.params) : undefined)
  const promiseWait = promiseHeld(order, model.can)
  const readyWait = readyHeld(order, model.can)
  // B-W2a-50: the order every day — amend, close and reopen lines, cancel, copy as a new quote (each held with its reason).
  const amendWait = amendHeld(order, model.can)
  const closeLinesWait = closeLinesHeld(order, model.can)
  const reopenWait = reopenHeld(order, model.can)
  const cancelWait = cancelHeld(order, model.can)
  const copyWait = copyHeld(model.can)
  const splitWait = splitHeld(order, model.can) // F-OP-111
  // ---- F-SA-230: ⋯ grouped (Next steps · Edit · People · Go to · Copy; Cancel last), every item of today kept, each held with its reason.
  const sup = useT(SUPERVISOR_NS)
  const notes = useT(NOTES_NS)
  const people = model.people ?? null
  const askWait = people ? noteHeld(people.mayNote, 1) : null
  // ---- F-OO-111 (BC-2, 10-design §1.7): "Who answers the customer…" is held without threads.post — the People card's own rule and words
  // for the same door (answerHeldOf: choosing who answers needs the right to write in the conversation), never hidden.
  const head = useT(OWNER_WORDS_NS)
  const answerWait = answerHeldOf({ thread: !!thread, mayWrite: people ? people.mayNote : null })
  const answerWords = answerWait ? (answerWait.ns === OWNER_WORDS_NS ? head(answerWait.key, answerWait.params) : t(answerWait.key)) : undefined
  // ---- end F-OO-111
  // ---- F-OP-102 (10-order-page §2.2): the ⋯ re-cut — Make work orders… also while in production with lines not in work orders;
  // Change ship-to… (edit mode with Ship to focused: one edit path); Who answers the customer… (the conversation's owner door);
  // Open in Planning › (the first work order). "Ask the customer to re-confirm…" is deferred (F-OP-105): no item.
  const makeWait = makeHeldOf(order, model.can)
  const firstWorkOrder = order.chain.workOrders[0] ?? null
  const groups: Partial<Record<MenuGroup, MenuItemDef[]>> = {
    next: [
        ...(!isFinal(order) && step.kind !== 'changePromise' ? [{ id: 'promise', label: t('action.promise'), disabled: !!promiseWait, description: held(promiseWait), onSelect: () => actions?.onDialog?.({ kind: 'promise' }) }] : []),
        ...(order.status === 'IN_PRODUCTION' ? [{ id: 'ready', label: t('action.ready'), disabled: !!readyWait, description: held(readyWait), onSelect: () => actions?.onDialog?.({ kind: 'ready' }) }] : []),
        ...(makeInMenu(order, linesNotInProduction(order)) ? [{ id: 'make', label: t('bandMenu.makeWorkOrders'), disabled: !!makeWait, description: makeWait ? t(makeWait.key, makeWait.params?.date ? { date: formatDate(dayInstant(String(makeWait.params.date)), { locale }) } : makeWait.params) : undefined, onSelect: () => actions?.makeWorkOrders?.onOpen?.() }] : []),
        // F-OP-121: Create shipment… in place (as Change promise date…, not repeated here while it is the band's next step).
        ...(createDoor?.kind === 'inPlace' && step.kind !== 'createShipment' ? [{ id: 'ship', label: t('step.createShipment'), onSelect: () => actions?.onCreateShipment?.() }] : []),
        ...(createDoor?.kind === 'warehouse' ? [{ id: 'ship', label: t('action.createShipment'), href: createDoor.href }] : []),
        // F-OP-123 (order page N5): Record a shipment made elsewhere… (held with its words: the order's state, the rights).
        ...(model.elsewhere ? [{ id: 'elsewhere', label: t('elsewhere.title'), disabled: !!model.elsewhere.held, description: held(model.elsewhere.held), onSelect: () => actions?.onRecordElsewhere?.() }] : []),
    ],
    edit: [
        ...(!isFinal(order) && model.can.manage
          ? [
              { id: 'amend', label: t('action.amend'), disabled: !!amendWait || !!model.amend, description: model.amend ? t('held.amending') : held(amendWait), onSelect: () => actions?.onAmendStart?.() },
              // F-OP-110: the delivery address moves through the edit header (the same edit path); while editing it focuses the field.
              { id: 'shipTo', label: t('bandMenu.changeShipTo'), disabled: !!amendWait, description: held(amendWait), onSelect: () => actions?.onChangeShipTo?.() },
              // F-OP-111: Split into new orders… (the parts become orders of their own; the deposit stays here).
              { id: 'split', label: t('split.action'), disabled: !!splitWait, description: held(splitWait), onSelect: () => actions?.onDialog?.({ kind: 'split' }) },
              { id: 'closeLines', label: t('action.closeLines'), disabled: !!closeLinesWait, description: held(closeLinesWait), onSelect: () => actions?.onDialog?.({ kind: 'closeLines' }) },
              ...(order.lines.some((line) => line.closedShort) ? [{ id: 'reopenLines', label: t('action.reopenLines'), disabled: !!reopenWait, description: held(reopenWait), onSelect: () => actions?.onDialog?.({ kind: 'reopenLines' }) }] : []),
            ]
          : []),
        // B-W2b-323: Set priority…, Set season…
        ...depthMenuItems(order, model.depth, actions?.depth, d),
    ],
    people: [
        ...(people
          ? [
              { id: 'assignSupervisor', label: t('menu.assignSupervisor'), disabled: !people.mayAssign, description: people.mayAssign ? undefined : sup('held.noRight'), onSelect: () => actions?.people?.onAssign?.() },
              { id: 'askSupervisor', label: t('menu.askSupervisor'), disabled: !!askWait, description: askWait ? notes(askWait.key, askWait.params) : undefined, onSelect: () => actions?.people?.onAsk?.() },
            ]
          : []),
        // F-OP-102 (N-1): who answers the customer is the order conversation's owner — its own dialog (the frame's door).
        ...(thread ? [{ id: 'whoAnswers', label: t('bandMenu.whoAnswers'), disabled: !!answerWait /* F-OO-111 */, description: answerWords, onSelect: () => frameRef.current?.openDoor?.('owner') }] : []),
    ],
    goTo: [
        ...(order.chain.quote && model.can.viewQuotes ? [{ id: 'quote', label: t('action.openQuote', { number: order.chain.quote.number }), href: `${model.prefix}/sales/quotes/${order.chain.quote.id}` }] : []),
        // B-W2b-180 (design conn "Portal › Orders & tracking"): the order as the customer sees it in their portal, read-only.
        ...(model.portal ? [{ id: 'portal', label: t('action.portal'), disabled: !!model.portal.held || model.portal.opening, description: model.portal.opening ? t('held.portalOpening') : held(model.portal.held), onSelect: () => actions?.onPortal?.() }] : []),
        // F-OP-102: Planning's board at the order's first work order (line, workshop, start and outside are Planning's).
        ...(firstWorkOrder && model.workOrderActs?.can.planning && !isFinal(order) ? [{ id: 'planning', label: t('wo.link.planning'), href: planningHref(model.prefix, firstWorkOrder.id) }] : []),
    ],
    copy: [
        {
          id: 'copy',
          label: t('action.copyNumber'),
          onSelect: () => {
            void navigator.clipboard?.writeText(order.number).catch(() => undefined)
          },
        },
        ...(model.can.manageQuotes || model.can.viewQuotes ? [{ id: 'copyQuote', label: t('action.copyAsQuote'), disabled: !!copyWait, description: held(copyWait), onSelect: () => actions?.onDialog?.({ kind: 'copyQuote' }) }] : []),
    ],
  }
  const cancelItem: MenuItemDef[] = !isFinal(order) && model.can.manage ? [{ id: 'cancel', label: t('action.cancel'), tone: 'danger' as const, disabled: !!cancelWait, description: held(cancelWait), onSelect: () => actions?.onDialog?.({ kind: 'cancel' }) }] : []
  const shownMenu = bandMenuFor(readOnly, groups, cancelItem) // F-OP-311 (oo-walk #10)
  const more: MenuItemDef[] = groupedMenu(shownMenu.groups, shownMenu.danger, (group) => t(`menu.group.${group}`))

  // ---- end F-SA-230

  const depositRequest = gate.request
  const depositOverdue = gate.state === 'WAITING' && !!depositRequest && depositRequest.dueDate < model.today
  // F-OO-111 (BC-1): the tab the yes and deposit banners show on — every tab but Overview (its strips say them, with the same doors).
  const notOverview = model.tab !== 'overview'
  const toMoney = (
    <Button size="sm" variant="quiet" asChild>
      <TabLink href={tabHref(recordHref, 'money', search) /* F-OP-210 */}>{t('tab.money')}</TabLink>
    </Button>
  )

  return (
    <>
      <RecordFrame
        recordType="SalesOrder"
        record={{ type: 'SalesOrder', id: order.id } /* F-OP-212: every ask that names no record is this order's */}
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        // F-OO-211: no `fields` here — the order's custom fields are Overview's card beside Order facts (the frame slot is the other pages').
        // F-SA-263: "hidden" kept for every order. F-OP-301 (walk #5): one dock width per viewport on every tab (DOCK_DEFAULTS), and a
        // width the person picks holds on every tab.
        defaultWidth={DOCK_DEFAULTS[model.tab]}
        dockTab={model.tab}
        // F-SA-244: the thread's ask cards open this page's ONE review window (the frame's answer door; the same `?open=` address).
        {...(model.requestDoor?.open ? { answer: { open: model.requestDoor.open, href: model.requestDoor.hrefOf } } : {})}
        band={{
          back: <Link href={ordersHref(model.prefix)}>{t('record.back')}</Link>,
          title: (
            <span className="fw-so-title">
              {order.number} <span className="fw-so-title-sub">· {order.party?.legalName ?? '—'}</span>
            </span>
          ),
          status: <Pill tone={STATUS_TONE[order.status]}>{t(`status.${order.status}`)}</Pill>,
          meta: (
            <>
              {/* F-SA-230 / F-SA-232: health only when it matters (Late · N d, At risk, from the production read; the order read's
                  lateness until it comes), never "On track"; the customer's own urgency. */}
              <BandHealth order={order} model={model} />
              <BandUrgency model={model} />
              {order.customerRef && <Tag tone="neutral">{t('record.customerRef', { ref: order.customerRef })}</Tag>}
              {/* B-TH-228: an order made straight from a request names it (office only), else "Typed by the office". */}
              {!order.chain.quote && model.madeFrom && (
                <Link className="fw-so-link fw-so-hint" href={`${model.prefix}/sales/incoming/${encodeURIComponent(model.madeFrom.id)}`}>
                  {t('record.madeFrom', { number: model.madeFrom.number })}
                </Link>
              )}
              {!order.chain.quote && !model.madeFrom && !model.madeFromReading && <Tag tone="neutral">{t('record.typed')}</Tag>}
              {order.chain.quote &&
                (model.can.viewQuotes ? (
                  <Link className="fw-so-link fw-so-hint" href={`${model.prefix}/sales/quotes/${order.chain.quote.id}`}>
                    {t('record.fromQuote', { number: order.chain.quote.number, revision: order.chain.quote.revision })}
                  </Link>
                ) : (
                  <span className="fw-so-hint">{t('record.fromQuote', { number: order.chain.quote.number, revision: order.chain.quote.revision })}</span>
                ))}
              {/* B-W2b-323: priority (Top with its reason), season, the confirmation sent. */}
              {model.depth && <DepthPills model={model.depth} />}
              {/* F-SA-230: a made-to-measure line marks the order (the list's word). */}
              {isMadeToMeasure(order) && <Tag tone="neutral">{t('record.madeToMeasure')}</Tag>}
            </>
          ),
          primary,
          more,
          moreLabel: t('record.more'),
        }}
      >
        {/* F-OP-102: the band's ⋯ reaches the frame's doors through this (the band's items are built outside the frame). */}
        <FrameBridge into={frameRef} />
        {/* F-OP-210: the factory's TabLink (no prefetch: a pick re-writes every tab's href). */}
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" linkAs={TabLink} />

        {/* B-TH-214: ONE notice in the body column; F-SA-230: the most serious first, the rest behind "N more notices". */}
        <RecordNotices>
          {model.notice && (
            <Banner
              tone={model.notice.tone}
              title={t(model.notice.words.key, model.notice.words.params)}
              action={
                model.notice.door || actions?.onDismissNotice ? (
                  <>
                    {/* F-OP-121: the door a notice offers (Pack and ship it in Warehouse ›) */}
                    {model.notice.door && (
                      <Button size="sm" asChild>
                        <Link href={model.notice.door.href}>{t(model.notice.door.words.key, model.notice.door.words.params)}</Link>
                      </Button>
                    )}
                    {actions?.onDismissNotice && (
                      <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                        {t('common.dismiss')}
                      </Button>
                    )}
                  </>
                ) : undefined
              }
            />
          )}
          {/* B-TH-256: the result of an Accept / Decline of a re-promise. */}
          <LinksSaid model={model.links} actions={actions?.links} />
          {model.depth && <DepthNotice model={model.depth} actions={actions?.depth} />}
          {order.status === 'CANCELLED' && <Banner tone="danger" title={t('record.cancelled', { reason: order.cancelReason ?? '—' })} />}
          {/* F-OO-111 (BC-1, Owner D5): on Overview the deposit and the yes banners step back — section 1's strips say the same with the
              same doors (one place per fact); on every other tab they stay. Every band tag stays. */}
          {depositOverdue && depositRequest && notOverview && <Banner tone="danger" title={t('record.depositOpen', { date: formatDate(dayInstant(depositRequest.dueDate), { locale }) })} action={toMoney} />}
          {gate.state === 'MISSING' && !isFinal(order) && notOverview && <Banner tone="danger" title={t('record.depositMissing')} action={toMoney} />}
          {/* B-TH-256: a compliance gate still blocks a work order or a shipment of this order (the gate's own words). */}
          <GateNotices model={model.links} prefix={model.prefix} />
          {/* B-W2b-323: the yes the order waits for. */}
          {/* F-OP-101: the approver decides it here (the order read's open yes). */}
          {model.depth && notOverview /* F-OO-111 */ && <WaitingBanner model={model.depth} actions={actions?.depth} prefix={model.prefix} yes={{ approvals: order.openApprovals, busy: model.busy }} onYes={actions?.yes} />}
          {/* F-SA-243: after an answer the window's own notice; "<Customer> asks: … · Answer…" and "Change of hh:mm: N steps need a
              decision · Open" (only while a row asks this reader) — one banner place, the most serious first. */}
          {model.requestDoor && <RequestDoorNoticeBanner door={model.requestDoor.parts} />}
          <RequestBandNotices order={order} model={model} />
          {/* B-W2b-368: the made-to-measure units the order waits for, each with its factory review. */}
          {model.reviewBanner}
          {order.reapprovalNeededAt && !isFinal(order) && (
            <Banner
              tone="warning"
              title={t('record.reapproval')}
              action={
                order.amendments.count > 0 && order.amendments.latestRevision !== null ? (
                  <Button size="sm" variant="quiet" asChild>
                    <TabLink href={tabHref(recordHref, 'changes', search) /* F-OP-210 */}>{t('record.amended', { revision: order.amendments.latestRevision })}</TabLink>
                  </Button>
                ) : undefined
              }
            />
          )}
          {/* B-TH-256: planning proposes new dates: Accept / Decline (orders.manage, never the proposer), "Tell the customer" only ticked. */}
          <RePromiseNotices model={model.links} actions={actions?.links} />
          {gate.state === 'WAITING' && !depositOverdue && depositRequest && notOverview /* F-OO-111 */ && <Banner tone="info" title={t('record.depositOpen', { date: formatDate(dayInstant(depositRequest.dueDate), { locale }) })} action={toMoney} />}
          {model.changed && (
            <Banner
              tone="info"
              title={model.changed.by ? t('record.changedBy', { name: model.changed.by, time: formatTime(model.changed.at, { locale }) }) : t('record.changed', { time: formatTime(model.changed.at, { locale }) })}
              action={
                <Button size="sm" onClick={() => actions?.onReload?.()}>
                  {t('record.reload')}
                </Button>
              }
            />
          )}
          {order.status === 'CLOSED' && <Banner tone="info" title={order.closedAt ? t('record.closed', { date: formatDate(order.closedAt, { locale }) }) : t('record.closedNoDate')} />}
          {/* F-OP-303 (walk #6): only for a reader who can change nothing here (shipping, invoices, a quote copy … counted too). */}
          {readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold }) && !isFinal(order) && <Banner tone="info" title={t('record.readOnly')} />}
        </RecordNotices>

        <div className="fw-so-main">
          {model.tab === 'overview' && <OverviewTab order={order} model={model} actions={actions} customFields={customFields /* F-OO-211 */} />}
          {model.tab === 'lines' && <LinesTab order={order} model={model} actions={actions} />}
          {/* F-SA-230 / F-SA-234 / F-SA-235: Production — the work orders with the order's own pieces, the dates and milestones (#dates),
              holds, quality & problems, the specs in force (the tech pack), the customer's materials. */}
          {model.tab === 'production' && (
            <div className="fw-so-merged">
              <ProductionTab order={order} model={model} actions={actions} />
            </div>
          )}
          {/* F-SA-230 / F-SA-236: Changes — one newest-first story: waiting on us / on the customer, the confirmation and the customer's
              yes (#confirmation), the history, what can still change. */}
          {model.tab === 'changes' && <ChangesTab order={order} model={model} actions={actions} />}
          {/* F-SA-230: Money — totals, deposit, payment schedule, invoices & credit notes (#invoices), the margin (#margin, by its grain). */}
          {model.tab === 'money' && <MoneyTab order={order} model={model} actions={actions} />}
          {/* F-SA-230: Shipments — left to ship, shipments, deliveries, complaints & returns; the money is on Money. */}
          {model.tab === 'shipments' && <ShipmentsTab order={order} model={model} actions={actions} delivered={delivered} />}
          {/* F-SA-237: Files — every file of the order by where it comes from (the thread's Files window draws the same body). */}
          {model.tab === 'files' && <FilesTab order={order} model={model} actions={actions} />}
        </div>
      </RecordFrame>

      <OrderDialogs order={order} model={model} actions={actions} />
      {/* F-OO-111 (W07's follow-up): Record a shipment made elsewhere… — its container's dialog while open, mounted ONCE for the page, so
          the band's ⋯ item opens it on every tab (Overview's More ▾ and the Shipments card head open the same one). */}
      {model.elsewhere?.dialog}
      {/* F-OP-101: Refuse… of an open yes (the page's one dialog slot). */}
      {model.dialog?.kind === 'refuseYes' && <RefuseYesDialog order={order} model={model} actions={{ onDialog: () => actions?.onDialog?.(null), yes: actions?.yes }} />}
      {/* F-SA-243: the ONE review window (Home › Approvals' own) opened on this page from its doors; Esc returns to the same tab. */}
      {model.requestDoor && <RequestDoorWindow door={model.requestDoor.parts} />}
      {model.depth && <DepthDialogs order={order} model={model.depth} actions={actions?.depth} prefix={model.prefix} />}
      {/* F-OP-116: the work-order rows' dialogs, once for the page (a row's ⋯, the waiting list's "Lift the customer's pause…"), and
          the ONE decide window of a work-order change (Approvals' own; opened by the page's state, Esc returns here). */}
      {model.workOrderActs && <WorkOrderActsDialogs model={model.workOrderActs} actions={actions?.workOrderActs} />}
      {/* F-OP-102 (F-OP-112): Make work orders… — the band's primary, the ⋯ and Production's card open the one dialog here. */}
      {/* op-fx4: the dialog is production's (useT('production')): the page brings that catalogue with it, as ProductionTab does —
          without it the dialog showed its keys (new.title, new.create). */}
      {model.makeWorkOrders?.dialog && (
        <WithMessages namespaces={['production']}>
          <NewWorkOrderDialog model={model.makeWorkOrders.dialog} can={model.makeWorkOrders.can} actions={actions?.makeWorkOrders?.dialog} />
        </WithMessages>
      )}
      {model.orderChanges?.review && (
        <WorkOrderChangeReview
          review={model.orderChanges.review}
          prefix={model.prefix}
          offline={model.liveState === 'offline'}
          busy={model.orderChanges.busy}
          nav={{ ids: (model.orderChanges.list?.value ?? []).filter((change) => change.status === 'PROPOSED').map((change) => change.id), onOpen: actions?.orderChanges?.onOpen }}
          actions={actions?.orderChanges}
        />
      )}
      <DeclineDialog model={model.links} actions={actions?.links} />
      {/* F-SA-230: the production lane's own dialogs, mounted as they are. */}
      {model.people?.assign && <AssignSupervisorDialog model={model.people.assign} actions={actions?.people?.assign} />}
      {model.people?.note && <NoteDialog model={model.people.note} actions={actions?.people?.note} />}
      {/* W1 browser repair: no labels here — ds-parts' StepUpModal takes the DS words itself (this page loads no ds-words catalogue). */}
      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('stepUp.confirm')}
      />
    </>
  )
}

const ordersHref = (prefix: string) => `${prefix}/sales/orders`

/** F-OP-102: hands the frame around the page to the band's ⋯ (its items are made outside the frame's context); draws nothing. */
function FrameBridge({ into }: { into: { current: RecordFrameState | null } }) {
  const frame = useRecordFrame()
  into.current = frame
  return null
}

/** A tab's part while it loads, or when its read failed (never drawn as empty): with Try again. */
export function PartState({ problem, onRetry, label }: { problem: string | null; onRetry?: () => void; label: string }) {
  const t = useT('orders')
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={t('part.failed', { part: label })}
          description={t(problem)}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      </Card>
    )
  }
  return (
    <Card padded aria-busy="true">
      <p className="fw-so-hint" role="status">
        <Spinner size={14} /> {t('part.loading', { part: label })}
      </p>
    </Card>
  )
}
