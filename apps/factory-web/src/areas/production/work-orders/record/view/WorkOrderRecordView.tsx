'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, PackageCheck, PauseCircle, ShieldOff, Unlock, Zap } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { WorkOrder } from '../../../_shared/api'
import { isWideTab, mayCancel, nextStep, openChecks, RECORD_TABS, STATUS_TONE, type RecordTab } from '../../../_shared/model'
import { BundlesTab } from '../../bundles/view/BundlesTab'
import { CuttingTab } from '../../cutting/view/CuttingTab'
import { OperationsTab } from '../../progress/view/OperationsTab'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../record-model'
import { RecordDialogs } from './Dialogs'
import { DAILY_NAMESPACE, holdHeld, holdReasonWords } from '../../daily/model'
import { DailyDialogs } from '../../daily/view/DailyDialogs'
import { say } from '../../daily/view/DailyParts'
import { MaterialsTab } from './MaterialsTab'
import { OverviewTab } from './OverviewTab'
import { QualityTab } from './QualityTab'
import { LabourTab } from '../../labour/view/LabourTab'
import { documentDoors, minutesOf, SHIFT_NAMESPACE, splitHeld } from '../../every-shift/model'
import { SplitDialog } from '../../every-shift/view/SplitDialog'
import '../../../_shared/production.css'
// B-W2b-245: Spec differences and Change request (design pop:wo-diff, pop:wo-change).
import { SpecDialogs } from '../../spec/view/SpecParts'
import { requestHeld, SPEC_NS } from '../../spec/model'
// B-W2b-424: Close work order (design pop:wo-close), its Undo, a closed work order's close and Reopen; the variance at close.
import { CLOSE_NS } from '../../close/model'
import { CloseBanners, CloseParts } from '../../close/view/CloseParts'
import { VarianceAtClose } from '../../labour/variance/view/VarianceAtClose'
// ---- B-TH-265: the work order on RecordFrame (the band in the shell's row, the docked thread, one notice) and "Order files (n)" ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'
import { hasOrderFiles } from '../order-files/model'
import { OrderFilesButton, OrderFilesDialog, OrderThreadButton } from '../order-files/view/OrderFiles'
// ---- end B-TH-265
// ---- F-PR-05a: the band facts (customer, sales orders and POs, % done, health, waiting on), Report finished as the main step, Preview ----
import { finishHeld } from '../../daily/model'
import { previewHeld, reportFirst, customerFactOf } from '../overview/model'
import { BandFacts } from './BandFacts'
// ---- end F-PR-05a

export type { WorkOrderRecordActions, WorkOrderRecordModel } from '../record-model'

/**
 * SCR-070 — the work order studio (design production.workorders "Record: Work order"; 00 §2.2; Owner L1: the tabs always in view), on
 * RecordFrame (B-TH-265; the rule of picture 38): the band in the shell's band row (‹ Work orders, "<number> · <style>", ONE status
 * pill, rush, split from, batch number, revision and due date, the site and customers, "Order files (n)"; the next step as the primary
 * — Release → Start → Complete → Close, held with its reason — beside Put on hold / Release the hold; the thread (⌘J); ⋯ Split, Print
 * traveller, the style revision, Change request, Cancel, Copy number and the Keyboard line), the work order's thread docked beside
 * every tab (its own notes, never shareable with a customer, a note may go to the floor; one of its orders' threads picked beside it;
 * Activity's tools in the thread's "⋯", R-ACT), ONE notice in the body column, and the tabs 9 → 7: Overview (release check or frozen
 * spec, facts, the size run with cut / bundled / sewn / finished per cell), Materials (planned and issued, the pick list), Cutting
 * (SCR-071), Bundles and Operations (SCR-072), Quality (read-only), Labour & cost. Documents went into the band's ⋯ (R-7), Activity
 * into the docked thread; every old ?tab= keeps working (R-8). Totals per work order, operation or line only; no money.
 */
// B-TH-265: `thread` is the docked thread (the container's WorkOrderThreads with the office's OfficeRecordThread, or a design case's);
// `printThread` what the print view shows of it.
export function WorkOrderRecordView({ model, actions, thread, printThread, fields }: { model: WorkOrderRecordModel; actions?: WorkOrderRecordActions; thread?: ReactNode; printThread?: ReactNode; /** B-TH-280: the custom fields (Overview & release only). */ fields?: ReactNode }) {
  return (
    <WithMessages namespaces={['production', DAILY_NAMESPACE, SHIFT_NAMESPACE, 'lists', 'records', /* B-W2b-245 */ SPEC_NS, /* B-W2b-424 */ CLOSE_NS]}>
      <WorkOrderRecord model={model} actions={actions} thread={thread} printThread={printThread} fields={fields} />
    </WithMessages>
  )
}

function WorkOrderRecord({ model, actions, thread, printThread, fields }: { model: WorkOrderRecordModel; actions?: WorkOrderRecordActions; thread?: ReactNode; printThread?: ReactNode; fields?: ReactNode }) {
  const t = useT('production')
  const listHref = `${model.prefix}/production/work-orders`
  const loaded = model.workOrder

  if (loaded.status !== 'ready') {
    // Loading, not found, no right, a failed read: the band and its state inside the frame, no thread yet.
    return (
      <RecordFrame
        recordType="WorkOrder"
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabel')}
        thread={null}
        band={{ back: <Link href={listHref}>{t('record.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title'), moreLabel: t('record.more') }}
      >
        <div className="fw-pr-main">
          {loaded.status === 'loading' ? (
            <Card padded aria-busy="true">
              <p className="fw-pr-hint" role="status">
                <Spinner size={14} /> {t('record.loading')}
              </p>
              <div className="fw-pr-stack">
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
        </div>
      </RecordFrame>
    )
  }
  return <ReadyRecord workOrder={loaded.value} model={model} actions={actions} thread={thread} printThread={printThread} fields={fields} />
}

function ReadyRecord({ workOrder, model, actions, thread, printThread, fields }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions; thread?: ReactNode; printThread?: ReactNode; fields?: ReactNode }) {
  const t = useT('production')
  const locale = useLocale()
  const recordHref = `${model.prefix}/production/work-orders/${workOrder.id}`
  const step = nextStep(workOrder, model.can, model.check.value, model.wip.value)
  const stepHeld = step.held ? t(step.held.key, step.held.params) : model.busy ? t('held.busy') : null
  // B-W2b-424: Close opens Close work order (planned against actual, a reason beyond the tolerance); the others their confirm.
  const openStep = () => {
    if (step.kind === 'release') actions?.onDialog?.({ kind: 'release' })
    else if (step.kind === 'close') actions?.close?.onOpen?.()
    else if (step.kind) actions?.onDialog?.({ kind: 'move', move: step.kind })
  }

  // Keys: ⌘↵ the next step's dialog (never while typing or inside a dialog). B-TH-265: ⌘J is the record frame's (the thread).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      if (target?.closest('[role="dialog"]') || model.dialog || model.close?.dialog || model.orderFiles?.open || model.health?.dialog || model.daily?.dialog) return
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter' || typing) return
      // F-PR-05a: ⌘↵ takes the band's primary — Report finished while released garments wait, else the next step.
      if (reportPrimary) {
        if (finishWait) return
        event.preventDefault()
        actions?.daily?.onDialog?.({ kind: 'finish' })
      } else if (step.kind && !stepHeld) {
        event.preventDefault()
        openStep()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const checksOpen = workOrder.status === 'DRAFT' ? openChecks(model.check.value) : 0
  const liveEntries = model.cutLog.value?.entries.filter((entry) => entry.live && !entry.reversalOfId).length ?? null
  const activeBundles = model.bundles.value?.bundles.filter((bundle) => bundle.status === 'ACTIVE').length ?? null
  const tabCount = (tab: RecordTab): number | null => {
    if (tab === 'materials') return workOrder.spec.materials.length
    if (tab === 'cutting') return liveEntries
    if (tab === 'bundles') return activeBundles
    if (tab === 'operations') return workOrder.spec.operations.length
    if (tab === 'quality') return model.quality?.value?.inspections.length ?? null
    return null
  }
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: `${recordHref}?tab=${tab}`,
    label:
      tab === 'overview' && checksOpen > 0 ? (
        <span className="fw-pr-tablabel">
          {t(`tab.${tab}`)}
          <span className="fw-pr-dot" aria-label={t('tab.problems', { count: checksOpen })} role="img" />
        </span>
      ) : (
        t(`tab.${tab}`)
      ),
    count: tabCount(tab),
  }))

  const stepButton = step.kind ? (
    <Button
      size="sm"
      variant="primary"
      heldReason={stepHeld}
      onClick={openStep}
      aria-keyshortcuts="Meta+Enter Control+Enter"
    >
      {step.kind === 'release' && checksOpen > 0 ? t('step.releaseOpen', { count: checksOpen }) : t(`step.${step.kind}`)}
    </Button>
  ) : null

  // B-W2b-59: Split work order (⋯, held with its reason). B-TH-265: Documents' doors (the traveller, the style revision) in the ⋯ (R-7).
  const ts = useT(SHIFT_NAMESPACE)
  // B-W2b-245: the ⋯ "Change request…".
  const tspec = useT(SPEC_NS)
  const heldWords = useScopedT('production')
  const splitWait = splitHeld(workOrder, model.can)
  // ---- F-PR-05a: while released garments wait to go into stock, Report finished is the band's primary and the next step moves to
  // the ⋯ (first line, held with its reason); "Preview as <customer>" opens its portal as it sees it (partners.preview).
  const tw = useT(DAILY_NAMESPACE)
  const daily = model.daily ?? null
  const finished = daily?.finished?.value ?? null
  const reportPrimary = !!daily && reportFirst(workOrder, finished)
  const finishWait = daily && reportPrimary ? say(tw, finishHeld(workOrder, finished, daily.can)) : null
  const fact = customerFactOf(workOrder)
  const previewWait = model.preview ? previewHeld(fact, model.preview.can, model.preview.busy) : null
  const stepLine: MenuItemDef[] =
    reportPrimary && step.kind
      ? [{ id: 'step', label: step.kind === 'release' && checksOpen > 0 ? t('step.releaseOpen', { count: checksOpen }) : t(`step.${step.kind}`), disabled: stepHeld !== null, ...(stepHeld ? { description: stepHeld } : {}), onSelect: openStep }]
      : []
  const previewLine: MenuItemDef[] = model.preview
    ? [{ id: 'preview', label: t('band.preview', { name: fact.kind === 'customer' ? (model.partiesView ? fact.name : fact.code) : t('band.theCustomer') }), disabled: previewWait !== null, description: previewWait ? t(previewWait.key, previewWait.params) : t('band.previewHint'), onSelect: () => actions?.onPreview?.() }]
    : []
  // ---- end F-PR-05a
  const more: MenuItemDef[] = [
    ...stepLine,
    { id: 'split', label: ts('split.open'), disabled: splitWait !== null, ...(splitWait ? { description: heldWords(splitWait.key, splitWait.params) } : {}), onSelect: () => actions?.onOpenSplit?.() },
    ...documentDoors(workOrder, model.prefix).map((door) => ({ id: door.id, label: ts(door.label.key, door.label.params), description: ts(door.description.key), href: door.href, target: '_blank' as const })),
    // B-W2b-245 (design pop:wo-change "⋯"): a change to this work order's spec is a change request.
    ...(model.spec ? [{ id: 'changeRequest', label: tspec('wo.changeOpen'), disabled: requestHeld(model.spec.can) !== null, ...(requestHeld(model.spec.can) ? { description: tspec(requestHeld(model.spec.can)!) } : {}), onSelect: () => actions?.spec?.onOpen?.({ kind: 'change' }) }] : []),
    {
      id: 'copy',
      label: t('action.copyNumber'),
      onSelect: () => {
        void navigator.clipboard?.writeText(workOrder.number).catch(() => undefined)
      },
    },
    ...previewLine,
    // Danger last, never beside the primary.
    ...(mayCancel(workOrder, model.can) ? [{ id: 'cancel', label: t('action.cancel'), tone: 'danger' as const, onSelect: () => actions?.onDialog?.({ kind: 'cancel' }) }] : []),
  ]

  // B-W2a-46 (wo-hold "band second action"): Put on hold, or Release the hold while it is held.
  // A notice's key may name its catalogue (`production-work-orders:notice.held`); else it is the area's.
  const notices = useScopedT('production')
  const activeHolds = (daily?.holds?.value ?? []).filter((hold) => hold.status === 'ACTIVE')
  const heldOwnHold = workOrder.hold?.recordType === 'QualityHold' ? workOrder.hold.recordId : null
  const releaseTarget = activeHolds[0]?.id ?? heldOwnHold
  const holdButton = !daily ? null : workOrder.status === 'ON_HOLD' ? (
    <Button size="sm" heldReason={!daily.can.holdsRelease ? tw('held.noHoldRelease') : !releaseTarget ? tw('held.underRecord') : null} onClick={() => releaseTarget && actions?.daily?.onDialog?.({ kind: 'releaseHold', holdId: releaseTarget })}>
      <Unlock size={14} aria-hidden /> <span>{tw('holds.release')}</span>
    </Button>
  ) : ['DRAFT', 'RELEASED', 'IN_PROGRESS'].includes(workOrder.status) ? (
    <Button size="sm" heldReason={say(tw, holdHeld(workOrder, daily.can, daily.busy))} onClick={() => actions?.daily?.onDialog?.({ kind: 'hold', workOrderIds: [workOrder.id], numbers: [workOrder.number] })}>
      <PauseCircle size={14} aria-hidden /> <span>{tw('holds.put')}</span>
    </Button>
  ) : null
  const holdWords = workOrder.hold ? (activeHolds[0] ? holdReasonWords(activeHolds[0].reasonCode, daily?.reasons ?? null, locale) : (workOrder.hold.reason ?? '—')) : null

  const colourways = [...new Set(workOrder.cells.map((cell) => cell.colourwayCode))]
  // F-PR-05a: Report finished (moved out of the Bundles tab) while released garments wait; else the next step.
  const reportButton = reportPrimary ? (
    <Button size="sm" variant="primary" heldReason={finishWait} onClick={() => actions?.daily?.onDialog?.({ kind: 'finish' })} aria-keyshortcuts="Meta+Enter Control+Enter">
      <PackageCheck size={14} aria-hidden /> {tw('finished.report', { count: finished?.garments.canReport ?? 0 })}
    </Button>
  ) : null
  // The band's primary: the step, and the hold beside it (at most two actions; the rest in the ⋯).
  const primary =
    reportButton || stepButton || holdButton ? (
      <span className="fw-pr-actions">
        {reportButton ?? stepButton}
        {holdButton}
      </span>
    ) : undefined

  return (
    <RecordFrame
      recordType="WorkOrder"
      personId={model.personId ?? null}
      threadLabel={t('record.dockLabel')}
      thread={thread ?? null}
      printThread={printThread}
      fields={fields /* B-TH-280 */}
      wide={isWideTab(model.tab)}
      band={{
        back: <Link href={`${model.prefix}/production/work-orders`}>{t('record.back')}</Link>,
        title: (
          <span className="fw-pr-title">
            {workOrder.number}{' '}
            <span className="fw-pr-title-sub">
              · {workOrder.style.code} {workOrder.style.name}
              {colourways.length > 0 ? ` · ${colourways.join(', ')}` : ''}
            </span>
          </span>
        ),
        status: <Pill tone={STATUS_TONE[workOrder.status]}>{t(`status.${workOrder.status}`)}</Pill>,
        meta: (
          <>
            {/* F-PR-05a: customer, its sales orders and POs, % done, health and waiting on lead the band's facts. */}
            <BandFacts workOrder={workOrder} model={model} />
            {workOrder.rush && (
              <Tag tone="danger">
                <Zap size={11} aria-hidden /> {ts('rush.word')}
              </Tag>
            )}
            {workOrder.splitFrom && (
              <Link className="fw-pr-link" href={`${model.prefix}/production/work-orders/${workOrder.splitFrom.id}`}>
                {ts('split.from', { number: workOrder.splitFrom.number })}
              </Link>
            )}
            {workOrder.batchNumber && <Tag tone="info">{t('record.batch', { batch: workOrder.batchNumber })}</Tag>}
            {workOrder.revision && <Tag tone="neutral">{t(workOrder.spec.frozen ? 'record.revFrozen' : 'record.revDraft', { revision: workOrder.revision.revision })}</Tag>}
            {workOrder.dueDate && (
              <Tag tone={workOrder.daysLate && workOrder.daysLate > 0 ? 'danger' : 'neutral'}>
                {workOrder.daysLate && workOrder.daysLate > 0 ? t('record.dueLate', { date: formatDate(`${workOrder.dueDate}T12:00:00Z`, { locale }), count: workOrder.daysLate }) : t('record.due', { date: formatDate(`${workOrder.dueDate}T12:00:00Z`, { locale }) })}
              </Tag>
            )}
            <span className="fw-pr-hint">{workOrder.site.code}</span>
            {/* B-TH-265 (agreement T9): the orders' own files, read through the work order's own route. */}
            {model.orderFiles && hasOrderFiles(model.orderFiles.files) && <OrderFilesButton model={model.orderFiles} actions={actions?.orderFiles} />}
            {/* F-PR-25: "Order thread" — the order's thread in the work order's dock (several orders: a menu, their PO first). */}
            {model.orderFiles && <OrderThreadButton choices={model.threadChoices ?? []} actions={actions?.orderFiles} />}
          </>
        ),
        primary,
        more,
        moreLabel: t('record.more'),
      }}
    >
      <div className="fw-pr-main">
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

        {/* B-TH-265: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
          {model.notice && (
            <Banner
              tone={model.notice.tone}
              title={notices(model.notice.words.key, model.notice.words.params)}
              action={
                actions?.onDismissNotice ? (
                  <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                    {t('common.dismiss')}
                  </Button>
                ) : undefined
              }
            />
          )}
          {workOrder.status === 'CANCELLED' && <Banner tone="danger" title={t('record.cancelled', { reason: workOrder.cancelReason ?? '—' })} />}
          {workOrder.status === 'ON_HOLD' && workOrder.hold && (
            <Banner tone="danger" title={tw('holds.banner', { reason: holdWords ?? '—', back: tw(`status.${workOrder.hold.fromStatus ?? 'DRAFT'}`) })}>
              {tw('holds.floorRefuses')}
            </Banner>
          )}
          {model.changed && (
            <Banner
              tone="info"
              title={t('record.changed', { time: formatTime(model.changed.at, { locale }) })}
              action={
                <Button size="sm" onClick={() => actions?.onReload?.()}>
                  {t('record.reload')}
                </Button>
              }
            />
          )}
          {/* The shell's band says the tab's live state; offline, the page says its figures may be old. */}
          {model.live === 'offline' && <Banner tone="warning" title={t('live.offline')} />}
          {/* B-W2b-424: the Undo after a close; a closed work order's close (who, when, why) with Reopen…. */}
          {model.close ? <CloseBanners workOrder={workOrder} model={model.close} actions={actions?.close} /> : workOrder.status === 'CLOSED' && <Banner tone="info" title={t('record.closed')} />}
          {!model.can.manage && !model.can.release && <Banner tone="info" title={t('record.readOnly')} />}
          {/* F-PR-05a (L8): a work order made before the one-customer rule says so once. */}
          {fact.kind === 'mixed' && <Banner tone="warning" title={t('band.mixedBanner')} />}
        </RecordNotices>

        {model.tab === 'overview' && <OverviewTab workOrder={workOrder} model={model} actions={actions} />}
        {model.tab === 'materials' && <MaterialsTab workOrder={workOrder} model={model} actions={actions} />}
        {model.tab === 'cutting' && <CuttingTab workOrder={workOrder} model={model} actions={actions} />}
        {model.tab === 'bundles' && <BundlesTab workOrder={workOrder} model={model} actions={actions} />}
        {model.tab === 'operations' && <OperationsTab workOrder={workOrder} model={model} actions={actions} />}
        {model.tab === 'quality' && <QualityTab workOrder={workOrder} model={model} actions={actions} />}
        {model.tab === 'labour' && (
          <LabourTab
            labour={model.labour}
            prefix={model.prefix}
            workOrderId={workOrder.id}
            draft={workOrder.status === 'DRAFT'}
            onRetry={actions?.onRetryLabour}
            minutes={minutesOf(workOrder, model.wip.value)}
            labourHref={model.can.labour ? `${model.prefix}/production/labour` : null}
            variance={model.variance ? <VarianceAtClose model={model.variance} onRetry={actions?.onRetryVariance} /> : null}
          />
        )}
      </div>

      <RecordDialogs workOrder={workOrder} model={model} actions={actions} />
      {model.split && <SplitDialog workOrder={workOrder} model={model.split} actions={actions?.split} />}
      {daily && <DailyDialogs workOrder={workOrder} daily={daily} actions={actions?.daily} pick={model.pick?.value ?? null} bundles={model.bundles.value} />}
      {/* B-W2b-245 */}
      {model.spec && <SpecDialogs workOrder={workOrder} model={model.spec} prefix={model.prefix} actions={actions?.spec} />}
      {/* B-W2b-424 */}
      {model.close && <CloseParts workOrder={workOrder} model={model.close} actions={actions?.close} />}
      {/* B-TH-265 */}
      {model.orderFiles && <OrderFilesDialog number={workOrder.number} model={model.orderFiles} choices={model.threadChoices ?? []} actions={actions?.orderFiles} />}
    </RecordFrame>
  )
}

/** A tab's part while it loads, or when its read failed (never drawn as empty): with Try again. */
export function PartState({ problem, onRetry, label }: { problem: string | null; onRetry?: () => void; label: string }) {
  const t = useT('production')
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
      <p className="fw-pr-hint" role="status">
        <Spinner size={14} /> {t('part.loading', { part: label })}
      </p>
    </Card>
  )
}

/** A tab that shows nothing before the release (the floor cuts, bundles and scans a released work order). */
export function NotReleased({ what }: { what: string }) {
  const t = useT('production')
  return (
    <Card padded>
      <EmptyState title={t('part.notReleased.title')} description={t('part.notReleased.body', { what })} />
    </Card>
  )
}
