'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, MessageSquare, MoreHorizontal, PauseCircle, ShieldOff, Unlock } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import type { WorkOrder } from '../../../_shared/api'
import { mayCancel, nextStep, openChecks, RECORD_TABS, STATUS_TONE, type RecordTab } from '../../../_shared/model'
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
import '../../../_shared/production.css'

export type { WorkOrderRecordActions, WorkOrderRecordModel } from '../record-model'

/**
 * SCR-070 — the work order studio (design production.workorders "Record: Work order"; 00 §2.2; Owner L1: the tabs always
 * in view). The band: ‹ Work orders, "<number> · <style>", the state, batch number, revision and due date, the next step
 * as the primary (Release → Start → Complete → Close, held with its reason), the thread (⌘J), ⋯ Cancel. The tabs:
 * Overview (release check or frozen spec, facts, the size run with cut / bundled / sewn / finished per cell), Materials
 * (planned and issued, the pick list), Cutting (SCR-071), Bundles and Operations (SCR-072), Quality (read-only), Activity
 * (the record panels; beside any tab on a wide screen with ⌘J). Totals per work order, operation or line only; no money.
 */
export function WorkOrderRecordView({ model, actions, panels }: { model: WorkOrderRecordModel; actions?: WorkOrderRecordActions; panels?: ReactNode }) {
  return (
    <WithMessages namespaces={['production', DAILY_NAMESPACE, 'lists', 'records']}>
      <WorkOrderRecord model={model} actions={actions} panels={panels} />
    </WithMessages>
  )
}

function WorkOrderRecord({ model, actions, panels }: { model: WorkOrderRecordModel; actions?: WorkOrderRecordActions; panels?: ReactNode }) {
  const t = useT('production')
  const listHref = `${model.prefix}/production/work-orders`
  const loaded = model.workOrder

  if (loaded.status !== 'ready') {
    return (
      <div className="fw-pr">
        <div className="fw-pr-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title')} />
        </div>
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
    )
  }
  return <ReadyRecord workOrder={loaded.value} model={model} actions={actions} panels={panels} />
}

function ReadyRecord({ workOrder, model, actions, panels }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions; panels?: ReactNode }) {
  const t = useT('production')
  const locale = useLocale()
  const recordHref = `${model.prefix}/production/work-orders/${workOrder.id}`
  const step = nextStep(workOrder, model.can, model.check.value, model.wip.value)
  const stepHeld = step.held ? t(step.held.key, step.held.params) : model.busy ? t('held.busy') : null

  // Keys: ⌘J the thread; ⌘↵ the next step's dialog (never while typing or inside a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        actions?.onDock?.()
        return
      }
      if (target?.closest('[role="dialog"]') || model.dialog) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !typing && step.kind && !stepHeld) {
        event.preventDefault()
        actions?.onDialog?.(step.kind === 'release' ? { kind: 'release' } : { kind: 'move', move: step.kind })
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

  const primary = step.kind ? (
    <Button
      size="sm"
      variant="primary"
      heldReason={stepHeld}
      onClick={() => actions?.onDialog?.(step.kind === 'release' ? { kind: 'release' } : { kind: 'move', move: step.kind as 'start' | 'complete' | 'close' })}
      aria-keyshortcuts="Meta+Enter Control+Enter"
    >
      {step.kind === 'release' && checksOpen > 0 ? t('step.releaseOpen', { count: checksOpen }) : t(`step.${step.kind}`)}
    </Button>
  ) : null

  const more = [
    ...(mayCancel(workOrder, model.can) ? [{ id: 'cancel', label: t('action.cancel'), tone: 'danger' as const, onSelect: () => actions?.onDialog?.({ kind: 'cancel' }) }] : []),
    {
      id: 'copy',
      label: t('action.copyNumber'),
      onSelect: () => {
        void navigator.clipboard?.writeText(workOrder.number).catch(() => undefined)
      },
    },
  ]

  // B-W2a-46 (wo-hold "band second action"): Put on hold, or Release the hold while it is held.
  const daily = model.daily ?? null
  const tw = useT(DAILY_NAMESPACE)
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

  const activity = panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null)
  const showDock = model.dockOpen && model.tab !== 'activity' && !!activity
  const customers = [...new Set(workOrder.orders.map((order) => order.partyName))]
  const colourways = [...new Set(workOrder.cells.map((cell) => cell.colourwayCode))]

  return (
    <div className="fw-pr">
      <div className="fw-pr-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/production/work-orders`}>{t('record.back')}</Link>}
          title={
            <span className="fw-pr-title">
              {workOrder.number}{' '}
              <span className="fw-pr-title-sub">
                · {workOrder.style.code} {workOrder.style.name}
                {colourways.length > 0 ? ` · ${colourways.join(', ')}` : ''}
              </span>
            </span>
          }
          actions={
            <span className="fw-pr-actions">
              {primary}
              {holdButton}
              {activity && (
                <Button size="sm" variant={model.dockOpen ? 'tonal' : 'secondary'} active={model.dockOpen} aria-pressed={model.dockOpen} onClick={() => actions?.onDock?.()} title={t('record.dockHint')}>
                  <MessageSquare size={14} aria-hidden /> <span>{t('record.dock')}</span>
                  <span className="fw-pr-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
              <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
            </span>
          }
        />
        <div className="fw-pr-meta-row">
          <span className="fw-pr-meta">
            <Pill tone={STATUS_TONE[workOrder.status]}>{t(`status.${workOrder.status}`)}</Pill>
            {workOrder.batchNumber && <Tag tone="info">{t('record.batch', { batch: workOrder.batchNumber })}</Tag>}
            {workOrder.revision && <Tag tone="neutral">{t(workOrder.spec.frozen ? 'record.revFrozen' : 'record.revDraft', { revision: workOrder.revision.revision })}</Tag>}
            {workOrder.dueDate && (
              <Tag tone={workOrder.daysLate && workOrder.daysLate > 0 ? 'danger' : 'neutral'}>
                {workOrder.daysLate && workOrder.daysLate > 0 ? t('record.dueLate', { date: formatDate(`${workOrder.dueDate}T12:00:00Z`, { locale }), count: workOrder.daysLate }) : t('record.due', { date: formatDate(`${workOrder.dueDate}T12:00:00Z`, { locale }) })}
              </Tag>
            )}
            <span className="fw-pr-hint">{[workOrder.site.code, ...customers].join(' · ')}</span>
          </span>
          <span className="fw-pr-status" role="status">
            {t(`live.${model.live}`)}
          </span>
        </div>
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
      </div>

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
      {workOrder.status === 'CLOSED' && <Banner tone="info" title={t('record.closed')} />}
      {!model.can.manage && !model.can.release && <Banner tone="info" title={t('record.readOnly')} />}

      <div className={showDock ? 'fw-pr-body has-dock' : 'fw-pr-body'}>
        <div className="fw-pr-main">
          {model.tab === 'overview' && <OverviewTab workOrder={workOrder} model={model} actions={actions} />}
          {model.tab === 'materials' && <MaterialsTab workOrder={workOrder} model={model} actions={actions} />}
          {model.tab === 'cutting' && <CuttingTab workOrder={workOrder} model={model} actions={actions} />}
          {model.tab === 'bundles' && <BundlesTab workOrder={workOrder} model={model} actions={actions} />}
          {model.tab === 'operations' && <OperationsTab workOrder={workOrder} model={model} actions={actions} />}
          {model.tab === 'quality' && <QualityTab workOrder={workOrder} model={model} actions={actions} />}
          {model.tab === 'labour' && <LabourTab labour={model.labour} prefix={model.prefix} workOrderId={workOrder.id} draft={workOrder.status === 'DRAFT'} onRetry={actions?.onRetryLabour} />}
          {model.tab === 'activity' && (activity ?? <p className="fw-pr-hint">{t('record.noPanels')}</p>)}
        </div>
        {showDock && (
          <aside className="fw-pr-dock" aria-label={t('record.dockLabel')}>
            {activity}
          </aside>
        )}
      </div>

      <RecordDialogs workOrder={workOrder} model={model} actions={actions} />
      {daily && <DailyDialogs workOrder={workOrder} daily={daily} actions={actions?.daily} pick={model.pick?.value ?? null} bundles={model.bundles.value} />}
    </div>
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
