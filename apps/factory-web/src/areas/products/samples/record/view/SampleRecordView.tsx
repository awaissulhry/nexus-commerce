'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, Gavel, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { RecordPanelsView, type RecordPanelsViewModel } from '../../../../../record-panels/view/RecordPanelsView'
import type { RoundView } from '../../api'
import { approvalHeld, isOpen, listHref, recordHref, RECORD_TABS, refusalPhrase, roundPhrase } from '../../model'
import { DecisionTag, Freshness, isPageKey, KindTag, NoticeLine, SamplesMessages, StagePill, useWords } from '../../parts'
import { DecideDialog } from '../../view/DecideDialog'
import type { SampleRecordActions, SampleRecordModel } from '../view-model'
import { ApprovalTab } from './ApprovalTab'
import { FitTab } from './FitTab'
import { RecordDialogs } from './RecordDialogs'
import { RequestTab } from './RequestTab'
import { SampleTab } from './SampleTab'
import { ShipmentsTab } from './ShipmentsTab'

export type { SampleRecordActions, SampleRecordModel } from '../view-model'

/**
 * SCR-110-record — a sample round (design products.samples "Record: Sample round"; Owner L1: the tabs always in view): ‹
 * Samples & prototypes, "<number> · <style>", its type and round, customer and pinned revision, its stage and decision;
 * the primary "Decide…" while it waits for its decision; ⋯ Move to a manual stage, Cancel round…, the style, Copy
 * number. Tabs: Request (EditModeBar), Sample (what was made: its sample work orders), Fit & comments (SizeColumns,
 * autosave per cell), Approval (the decision, the brand, swatches, the CE test sample), Shipments (autosave per cell),
 * Activity (the record panels: thread, files, history, approvals). A real address: ⌘-click on a card opens it in a new tab.
 */
export function SampleRecordView({ model, actions, panels, panelsPreview }: { model: SampleRecordModel; actions?: SampleRecordActions; panels?: ReactNode; panelsPreview?: RecordPanelsViewModel }) {
  return (
    <SamplesMessages>
      <Body model={model} actions={actions} panels={panels} panelsPreview={panelsPreview} />
    </SamplesMessages>
  )
}

function Problem({ title, body, back, onRetry, icon }: { title: string; body: string; back: ReactNode; onRetry?: () => void; icon: ReactNode }) {
  const { t } = useWords()
  return (
    <div className="fw-smp">
      <Card padded>
        <EmptyState
          icon={icon}
          title={title}
          description={body}
          action={
            <span className="fw-smp-actions">
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
    </div>
  )
}

function Body({ model, actions, panels, panelsPreview }: { model: SampleRecordModel; actions?: SampleRecordActions; panels?: ReactNode; panelsPreview?: RecordPanelsViewModel }) {
  const { t, say } = useWords()
  const list = listHref(model.prefix)
  const back = (
    <Button size="sm" asChild>
      <Link href={list}>{t('record.backToList')}</Link>
    </Button>
  )
  const round = model.loaded.status === 'ready' ? model.loaded.round : null
  const offline = model.live === 'offline'
  const decideHeld = round && model.approval.value ? approvalHeld(model.approval.value, 'decide', offline) : round && !model.can.decide ? { key: 'held.noDecide' } : null

  // d: Decide on the sample (design kb) — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.dialog || model.decide || !round) return
      if (event.key === 'd' && isOpen(round.stage) && round.stage !== 'REQUESTED' && model.can.decide) {
        event.preventDefault()
        actions?.onDecide?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.decide, model.can.decide, round, actions])

  if (!model.can.view || model.loaded.status === 'forbidden')
    return <Problem icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} body={t('noAccess.body')} back={back} />
  if (model.loaded.status === 'loading')
    return (
      <div className="fw-smp" aria-busy="true">
        <p className="fw-smp-hint" role="status">
          <Spinner size={14} /> {t('record.loading')}
        </p>
        <Skeleton height={36} width="40%" />
        <Skeleton height={28} width="60%" />
        <div className="fw-smp-two">
          <Skeleton height={220} />
          <Skeleton height={220} />
        </div>
      </div>
    )
  if (model.loaded.status === 'notFound') return <Problem icon={<FileX size={24} aria-hidden />} title={t('record.notFoundTitle')} body={t('record.notFoundBody')} back={back} />
  if (model.loaded.status === 'error') return <Problem icon={<FileX size={24} aria-hidden />} title={t('record.failedTitle')} body={t(model.loaded.problem)} back={back} onRetry={() => actions?.onRetry?.()} />
  const r = round as RoundView

  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: recordHref(model.prefix, r.id, tab),
    label: t(`tab.${tab}`),
    count: tab === 'sample' ? r.workOrdersList.length + r.workOrdersHeld : tab === 'fit' ? r.measurements : tab === 'approval' ? (r.swatches > 0 ? r.swatches : null) : tab === 'shipments' ? r.shipmentsList.length : null,
  }))

  const moves: MenuItemDef[] = isOpen(r.stage)
    ? r.moves
        .filter((move) => move.to !== r.stage)
        .map((move) => {
          const held = !model.can.manage ? t('held.noManage') : !move.allowed ? say(refusalPhrase(move.refusal?.code)) : offline ? t('held.offline') : null
          return { id: `move-${move.to}`, label: t('row.moveTo', { stage: t(`stage.${move.to}`) }), disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onMove?.(move.to) }
        })
    : []
  const cancelHeld = !model.can.manage ? t('held.noManage') : !r.actions.cancel.allowed ? say(refusalPhrase(r.actions.cancel.refusal?.code)) : offline ? t('held.offline') : null
  const menu: MenuItemDef[] = [
    ...moves,
    { id: 'style', label: t('record.openStyle', { style: r.style.code }), href: `${model.prefix}/products/styles/${encodeURIComponent(r.style.id)}?rev=${encodeURIComponent(r.revision.id)}` },
    { id: 'styleRounds', label: t('record.styleRounds', { style: r.style.code }), href: listHref(model.prefix, { style: r.style.id, revision: r.revision.id }) },
    { id: 'copy', label: t('record.copyNumber'), onSelect: () => actions?.onCopy?.() },
    ...(isOpen(r.stage) ? [{ id: 'cancel', label: t('record.cancel'), tone: 'danger' as const, disabled: !!cancelHeld, description: cancelHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'cancel', reason: '', busy: false, notice: null }) }] : []),
  ]
  const primary =
    isOpen(r.stage) && r.stage !== 'REQUESTED' ? (
      <Button size="sm" variant="primary" heldReason={model.busy ? t('common.working') : say(decideHeld) ?? (offline ? t('held.offline') : null)} onClick={() => actions?.onDecide?.()} aria-keyshortcuts="d">
        <Gavel size={14} aria-hidden /> {t('record.decide')}
      </Button>
    ) : null
  const activity = panels ?? (panelsPreview ? <RecordPanelsView model={panelsPreview} /> : null)

  return (
    <div className="fw-smp">
      <div className="fw-smp-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={list}>{t('record.back')}</Link>}
          title={
            <span className="fw-smp-title">
              {r.number} <span className="fw-smp-title-name">· {r.style.code}</span>
            </span>
          }
          meta={
            <span className="fw-smp-row">
              <KindTag kind={r.kind} />
              <span>{say(roundPhrase(r.kind, r.roundNo))}</span>
              <span>{r.party ? t('record.for', { customer: r.party.name }) : t('row.internal')}</span>
              <span>{t('record.pinned', { revision: r.revision.revision })}</span>
            </span>
          }
          status={
            <span className="fw-smp-row">
              <StagePill stage={r.stage} />
              {r.decision && <DecisionTag decision={r.decision} />}
              <Freshness asOf={model.asOf} live={model.live} />
            </span>
          }
          actions={
            <span className="fw-smp-actions">
              {primary}
              <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('record.more') }} items={menu} />
            </span>
          }
        />
        <Tabs ariaLabel={t('record.tabs')} tabs={tabs} active={model.tab} />
      </div>
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
      {r.stage === 'CANCELLED' && <Banner tone="info" title={t('record.cancelledBanner', { reason: r.cancelReason ?? '—' })} />}
      <NoticeLine notice={model.notice} lines={model.lines} onDismiss={actions?.onDismissNotice} />
      {model.tab === 'request' && <RequestTab model={model} round={r} actions={actions} />}
      {model.tab === 'sample' && <SampleTab model={model} round={r} actions={actions} />}
      {model.tab === 'fit' && <FitTab model={model} round={r} actions={actions} />}
      {model.tab === 'approval' && <ApprovalTab model={model} round={r} actions={actions} />}
      {model.tab === 'shipments' && <ShipmentsTab model={model} round={r} actions={actions} />}
      {model.tab === 'activity' && (activity ?? <p className="fw-smp-hint">{model.can.thread ? t('activity.none') : t('activity.noRight')}</p>)}
      <RecordDialogs model={model} round={r} actions={actions} />
      {model.decide && <DecideDialog model={model.decide} actions={actions?.decide} />}
    </div>
  )
}

