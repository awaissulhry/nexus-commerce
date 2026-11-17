'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, Gavel, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import type { RoundView } from '../../api'
import { approvalHeld, isOpen, listHref, recordHref, RECORD_TABS, refusalPhrase, roundPhrase } from '../../model'
import { DecisionTag, isPageKey, KindTag, NoticeLine, SamplesMessages, StagePill, useWords } from '../../parts'
import { DecideDialog } from '../../view/DecideDialog'
import type { SampleRecordActions, SampleRecordModel } from '../view-model'
import { ApprovalTab } from './ApprovalTab'
import { FitTab } from './FitTab'
import { RecordDialogs } from './RecordDialogs'
import { RequestTab } from './RequestTab'
import { SampleTab } from './SampleTab'
import { ShipmentsTab } from './ShipmentsTab'
// ---- B-TH-262: the round on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

export type { SampleRecordActions, SampleRecordModel } from '../view-model'

/**
 * SCR-110-record — a sample round (design products.samples "Record: Sample round"; Owner L1: the tabs always in view), on RecordFrame
 * (B-TH-262; the rule of picture 38, the tabs of picture 39): the band in the shell's band row — ‹ Samples & prototypes, "<number> ·
 * <style>", ONE pill (its stage), its type and round, customer, pinned revision and decision as the band's details, the primary
 * "Decide…" while it waits for its decision, the Thread button (⌘J), ⋯ Move to a manual stage, the style, Copy number, Cancel round…
 * and the Keyboard line. The round's thread is docked beside every tab (40 %); Activity's tools are in the thread's "⋯" (R-ACT), its
 * files in the Files view. Tabs 6 → 5: Request (EditModeBar), Sample (what was made: its sample work orders), Fit & comments
 * (SizeColumns, autosave per cell), Approval (the decision, "Ask the customer" opens the thread's Ask a partner to approve, swatches,
 * the CE test sample), Shipments (autosave per cell). ONE notice in the body column. A real address: ⌘-click on a card opens it in a
 * new tab.
 */
// B-TH-262: `thread` is the docked thread (the office's OfficeRecordThread docked, or a design case's), `printThread` what the print view
// shows of it (ThreadPrint: the thread for paper, B-TH-280).
export function SampleRecordView({ model, actions, thread, printThread }: { model: SampleRecordModel; actions?: SampleRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <SamplesMessages>
      <Body model={model} actions={actions} thread={thread} printThread={printThread} />
    </SamplesMessages>
  )
}

/** The page's states before the round is read (loading, not found, failed, no access): the band with the way back, no thread. */
function Waiting({ model, title, children }: { model: SampleRecordModel; title: ReactNode; children: ReactNode }) {
  const { t } = useWords()
  return (
    <RecordFrame recordType="SampleRound" personId={model.me} band={{ back: <Link href={listHref(model.prefix)}>{t('record.back')}</Link>, title, moreLabel: t('record.more') }} thread={null} threadLabel={t('record.dockLabel')}>
      <div className="fw-smp">{children}</div>
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
  )
}

function Body({ model, actions, thread, printThread }: { model: SampleRecordModel; actions?: SampleRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
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

  // d: Decide on the sample (design kb) — never while typing or in a dialog. ⌘J is the frame's (the thread).
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
    return (
      <Waiting model={model} title={t('noAccess.title')}>
        <Problem icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} body={t('noAccess.body')} back={back} />
      </Waiting>
    )
  if (model.loaded.status === 'loading')
    return (
      <Waiting model={model} title={<Skeleton width={260} height={22} />}>
        <div className="fw-smp" aria-busy="true">
          <p className="fw-smp-hint" role="status">
            <Spinner size={14} /> {t('record.loading')}
          </p>
          <Skeleton height={28} width="60%" />
          <div className="fw-smp-two">
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

  return (
    <>
      <RecordFrame
        recordType="SampleRound"
        personId={model.me}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        wide={model.tab === 'fit'}
        band={{
          back: <Link href={list}>{t('record.back')}</Link>,
          title: (
            <span className="fw-smp-title">
              {r.number} <span className="fw-smp-title-name">· {r.style.code}</span>
            </span>
          ),
          status: <StagePill stage={r.stage} />,
          meta: (
            <span className="fw-smp-row">
              <KindTag kind={r.kind} />
              <span>{say(roundPhrase(r.kind, r.roundNo))}</span>
              <span>{r.party ? t('record.for', { customer: r.party.name }) : t('row.internal')}</span>
              <span>{t('record.pinned', { revision: r.revision.revision })}</span>
              {r.decision && <DecisionTag decision={r.decision} />}
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
          {r.stage === 'CANCELLED' && <Banner tone="info" title={t('record.cancelledBanner', { reason: r.cancelReason ?? '—' })} />}
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
        {model.tab === 'request' && <RequestTab model={model} round={r} actions={actions} />}
        {model.tab === 'sample' && <SampleTab model={model} round={r} actions={actions} />}
        {model.tab === 'fit' && <FitTab model={model} round={r} actions={actions} />}
        {model.tab === 'approval' && <ApprovalTab model={model} round={r} actions={actions} />}
        {model.tab === 'shipments' && <ShipmentsTab model={model} round={r} actions={actions} />}
      </RecordFrame>
      <RecordDialogs model={model} round={r} actions={actions} />
      {model.decide && <DecideDialog model={model.decide} actions={actions?.decide} />}
    </>
  )
}
