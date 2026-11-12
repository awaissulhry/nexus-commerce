'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileText, FileX, MoreHorizontal, ShieldOff, Truck } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { actionHeld, emptyShipDraft, lifecycleOf, listHref, RECORD_TABS, recordHref, receiveDraftOf, type TransferView } from '../../model'
import { Freshness, isPageKey, LifecyclePill, NoticeLine, TransfersMessages, useWords } from '../../parts'
import type { TransferRecordActions, TransferRecordModel } from '../view-model'
import { RecordDialogs } from './Dialogs'
import { LinesTab } from './LinesTab'
import { ReceivedTab } from './ReceivedTab'
import { TransitTab } from './TransitTab'

export type { TransferRecordActions, TransferRecordModel } from '../view-model'

/**
 * SCR-361 — a transfer's record (design warehouse.transfers "Record: Transfer", opens as a record page): ‹ Transfers,
 * "Transfer TRF-… · A1 → B1", the companies when two, the lifecycle pill (Draft / In transit / Partly received / Received /
 * Closed / Cancelled), the freshness; actions Print DDT and the primary of the moment — Ship (held until every line is
 * placed and in stock) while a draft, Receive while in transit — and ⋯ Cancel (draft only), Copy number. Tabs: Lines (autosave
 * per cell while a draft, the stock picker), In transit (the DDT and the transport), Received (what arrived, the
 * differences, Settle). Keys: s ship, r receive, p print DDT, a add from stock.
 */
export function TransferRecordView({ model, actions }: { model: TransferRecordModel; actions?: TransferRecordActions }) {
  return (
    <TransfersMessages>
      <Body model={model} actions={actions} />
    </TransfersMessages>
  )
}

function Problem({ title, body, back, onRetry, icon }: { title: string; body: string; back: ReactNode; onRetry?: () => void; icon: ReactNode }) {
  const { t } = useWords()
  return (
    <div className="fw-trf">
      <Card padded>
        <EmptyState
          icon={icon}
          title={title}
          description={body}
          action={
            <span className="fw-trf-actions">
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

function Body({ model, actions }: { model: TransferRecordModel; actions?: TransferRecordActions }) {
  const { t, say, day } = useWords()
  const list = listHref(model.prefix)
  const back = (
    <Button size="sm" asChild>
      <Link href={list}>{t('record.backToList')}</Link>
    </Button>
  )
  const transfer = model.loaded.status === 'ready' ? model.loaded.transfer : null
  const offline = model.live === 'offline'

  // s ship, r receive, p print the DDT, a add from stock — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.dialog || !transfer || model.busy) return
      if (event.key === 's' && !actionHeld(transfer.actions.ship, offline)) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'ship', draft: emptyShipDraft(transfer), busy: false, notice: null, lines: [] })
      } else if (event.key === 'r' && !actionHeld(transfer.actions.receive, offline)) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'receive', draft: receiveDraftOf(transfer), scan: '', scanNote: null, busy: false, notice: null, lines: [] })
      } else if (event.key === 'p' && transfer.ddt?.fileId) {
        event.preventDefault()
        actions?.onOpenDdt?.()
      } else if (event.key === 'a' && !actionHeld(transfer.actions.lines, offline)) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'pick', picker: { q: '', locationId: transfer.fromLocation?.id ?? null, stock: null, problem: null, picked: {}, busy: false, notice: null } })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.busy, transfer, offline, actions])

  if (!model.can.view || model.loaded.status === 'forbidden') return <Problem icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} body={t('noAccess.body')} back={back} />
  if (model.loaded.status === 'loading')
    return (
      <div className="fw-trf" aria-busy="true">
        <p className="fw-trf-hint" role="status">
          <Spinner size={14} /> {t('record.loading')}
        </p>
        <Skeleton height={36} width="40%" />
        <Skeleton height={28} width="60%" />
        <Skeleton height={240} />
      </div>
    )
  if (model.loaded.status === 'notFound') return <Problem icon={<FileX size={24} aria-hidden />} title={t('record.notFoundTitle')} body={t('record.notFoundBody')} back={back} />
  if (model.loaded.status === 'error') return <Problem icon={<FileX size={24} aria-hidden />} title={t('record.failedTitle')} body={t(model.loaded.problem)} back={back} onRetry={() => actions?.onRetry?.()} />
  const r = transfer as TransferView
  const lifecycle = lifecycleOf(r.status, r.totals.openDifferences)

  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: recordHref(model.prefix, r.id, tab),
    label: t(`tab.${tab}`),
    count: tab === 'lines' ? r.lines.length : tab === 'transit' ? (r.totals.inTransitLines > 0 ? r.totals.inTransitLines : null) : r.totals.openDifferences > 0 ? r.totals.openDifferences : null,
  }))

  const cancelHeld = say(actionHeld(r.actions.cancel, offline))
  const menu: MenuItemDef[] = [
    { id: 'copy', label: t('record.copyNumber'), onSelect: () => actions?.onCopy?.() },
    { id: 'list', label: t('record.backToList'), href: list },
    ...(r.status === 'DRAFT' ? [{ id: 'cancel', label: t('record.cancel'), tone: 'danger' as const, disabled: !!cancelHeld, description: cancelHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'cancel', reason: '', busy: false, notice: null }) }] : []),
  ]
  const busy = model.busy ? t('common.working') : null
  const primary =
    r.status === 'DRAFT' ? (
      <Button size="sm" variant="primary" heldReason={busy ?? say(actionHeld(r.actions.ship, offline))} onClick={() => actions?.onDialog?.({ kind: 'ship', draft: emptyShipDraft(r), busy: false, notice: null, lines: [] })} aria-keyshortcuts="s">
        <Truck size={14} aria-hidden /> {t('record.ship')}
      </Button>
    ) : r.status === 'SHIPPED' || r.status === 'PARTLY_RECEIVED' ? (
      <Button size="sm" variant="primary" heldReason={busy ?? say(actionHeld(r.actions.receive, offline))} onClick={() => actions?.onDialog?.({ kind: 'receive', draft: receiveDraftOf(r), scan: '', scanNote: null, busy: false, notice: null, lines: [] })} aria-keyshortcuts="r">
        {t('record.receive')}
      </Button>
    ) : null
  const printButton = (
    <Button size="sm" variant="secondary" heldReason={r.ddt ? (r.ddt.fileId ? (offline ? t('held.offline') : null) : t('held.pdfMissing')) : t('refusal.NO_DDT')} onClick={() => actions?.onOpenDdt?.()} aria-keyshortcuts="p">
      <FileText size={14} aria-hidden /> {t('record.printDdt')}
    </Button>
  )

  return (
    <div className="fw-trf">
      <div className="fw-trf-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={list}>{t('record.back')}</Link>}
          title={
            <span>
              {t('record.title', { number: r.number })} <span className="fw-trf-title-name">· {t('record.route', { from: r.from.code, to: r.to.code })}</span>
            </span>
          }
          meta={
            <span className="fw-trf-row">
              <span>{r.interCompany ? t('record.companies', { from: r.from.companyName, to: r.to.companyName }) : r.from.companyName}</span>
              {r.ddt && <span>{t('record.ddtMeta', { number: r.ddt.number })}</span>}
            </span>
          }
          status={
            <span className="fw-trf-row">
              <LifecyclePill lifecycle={lifecycle} />
              <Freshness asOf={model.asOf} live={model.live} />
            </span>
          }
          actions={
            <span className="fw-trf-actions">
              {printButton}
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
      {r.status === 'CANCELLED' && <Banner tone="info" title={t('record.cancelledBanner', { reason: r.cancelReason ?? '—' })} />}
      {r.late && <Banner tone="warning" title={t('record.lateBanner', { day: day(r.expectedOn) })} />}
      <NoticeLine notice={model.notice} lines={model.lines} onDismiss={actions?.onDismissNotice} />
      {model.tab === 'lines' && <LinesTab transfer={r} model={model} actions={actions} />}
      {model.tab === 'transit' && <TransitTab transfer={r} model={model} actions={actions} />}
      {model.tab === 'received' && <ReceivedTab transfer={r} model={model} actions={actions} />}
      <RecordDialogs transfer={r} model={model} actions={actions} />
    </div>
  )
}
