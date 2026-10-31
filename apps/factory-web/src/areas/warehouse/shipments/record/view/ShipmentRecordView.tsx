'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, MessageSquare, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import type { Shipment } from '../../api'
import { actsOnShipments, carrierWords, hasLeft, isFinal, nextStep, openChecks, placeOf, readyChecks, RECORD_TABS, STATUS_TONE, TRACKING_TONE, type RecordTab, type StepKind } from '../../model'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'
import { CarrierTab } from './CarrierTab'
import { ShipmentDialogs } from './Dialogs'
import { DocumentsTab } from './DocumentsTab'
import { ExportTab } from './ExportTab'
import { InvoiceTab } from './InvoiceTab'
import { LinesTab } from './LinesTab'
import { TrackingTab } from './TrackingTab'
import '../../shipments.css'

export type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'

/**
 * SCR-067 — a shipment (design warehouse.shipments "Record: Shipment"; 00 §2.2; Owner L1: the tabs always in view). The
 * band: ‹ Shipments, "<number> · <customer> · <city CC>", the order, who carries it, the state (and the tracking once it
 * left), the next step as the primary — Mark packed → Issue DDT → Buy labels → Mark handed over, each held with its
 * reason — the thread (⌘J), ⋯ (Annul DDT…, Cancel shipment, Change delivery). The tabs: Lines & cartons (Ready to ship:
 * every check the law and the customer need with its fix; the lines from released garments only; the cartons), Documents
 * (the DDT: the draft and its problems, issued once with its number and frozen, annulled with its reason; the
 * Declaration of Conformity and the user information; the customer's document link), Carrier & label, Tracking &
 * delivery, Activity (the record panels; beside any tab on a wide screen with ⌘J). B-W2a-71 adds Export (the intra-EU
 * transport evidence: the papers that prove the goods reached another EU state) and Invoice (the freight charged — the
 * one price on a shipment, drawn only with the price grain), Void labels, the order's backorder, Other documents and the
 * driver's pack (a new tab).
 */
export function ShipmentRecordView({ model, actions, panels }: { model: ShipmentRecordModel; actions?: ShipmentRecordActions; panels?: ReactNode }) {
  return (
    <WithMessages namespaces={['shipments', 'lists', 'records']}>
      <ShipmentRecord model={model} actions={actions} panels={panels} />
    </WithMessages>
  )
}

function ShipmentRecord({ model, actions, panels }: { model: ShipmentRecordModel; actions?: ShipmentRecordActions; panels?: ReactNode }) {
  const t = useT('shipments')
  const listHref = `${model.prefix}/warehouse/shipments`
  const loaded = model.shipment

  if (loaded.status !== 'ready') {
    return (
      <div className="fw-sh">
        <div className="fw-sh-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-sh-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-sh-stack">
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
  return <ReadyRecord shipment={loaded.value} model={model} actions={actions} panels={panels} />
}

const STEP_DIALOG: Record<Exclude<StepKind, 'pack'>, 'issueDdt' | 'buyLabels' | 'handOver'> = { issueDdt: 'issueDdt', buyLabels: 'buyLabels', handOver: 'handOver' }

function ReadyRecord({ shipment, model, actions, panels }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions; panels?: ReactNode }) {
  const t = useT('shipments')
  const locale = useLocale()
  const recordHref = `${model.prefix}/warehouse/shipments/${shipment.id}`
  const liveDdt = model.ddts.value?.find((row) => row.status === 'LIVE') ?? null
  const facts = { shipment, ddt: liveDdt, labels: model.labels?.value ?? null, documents: model.documents.value }
  const step = nextStep(facts, model.can)
  const stepHeld = step.held ? t(step.held.key, step.held.params) : model.busy ? t('held.busy') : null
  const checks = readyChecks(facts)
  const runStep = () => {
    if (!step.kind || stepHeld) return
    if (step.kind === 'pack') actions?.onPack?.()
    else actions?.onDialog?.({ kind: STEP_DIALOG[step.kind] })
  }

  // Keys: ⌘J the thread; ⌘↵ the next step; d issue DDT, l buy labels (each opens its confirm; never while typing or in a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        actions?.onDock?.()
        return
      }
      if (target?.closest('[role="dialog"]') || model.dialog || typing) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        runStep()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'd' && step.kind === 'issueDdt' && !stepHeld) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'issueDdt' })
      } else if (event.key === 'l' && step.kind === 'buyLabels' && !stepHeld) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'buyLabels' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const open = openChecks(checks)
  const tabCount = (tab: RecordTab): number | null => {
    if (tab === 'lines') return shipment.lines.length
    if (tab === 'documents') return model.documents.value ? model.documents.value.documents.filter((entry) => entry.byLink).length : null
    if (tab === 'carrier') return shipment.transportBy === 'CARRIER' ? shipment.parcels.length : null
    if (tab === 'tracking') return model.tracking?.value ? model.tracking.value.events.length : null
    return null
  }
  const problemTabs = new Set<RecordTab>(checks.filter((check) => check.state === 'open').map((check) => check.tab))
  // The evidence is chased after the goods left: its dot shows while it is awaited or partial.
  const evidenceOpen = shipment.transportEvidence.status === 'AWAITED' || shipment.transportEvidence.status === 'PARTIAL'
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: `${recordHref}?tab=${tab}`,
    label:
      (problemTabs.has(tab) && !isFinal(shipment.status) && !hasLeft(shipment.status)) || (tab === 'export' && evidenceOpen) ? (
        <span className="fw-sh-tablabel">
          {t(`tab.${tab}`)}
          <span className="fw-sh-dot" aria-label={t('tab.problem')} role="img" />
        </span>
      ) : (
        t(`tab.${tab}`)
      ),
    count: tabCount(tab),
  }))

  const primary = step.kind ? (
    <Button size="sm" variant="primary" heldReason={stepHeld} onClick={runStep} aria-keyshortcuts={step.kind === 'issueDdt' ? 'd Meta+Enter' : step.kind === 'buyLabels' ? 'l Meta+Enter' : 'Meta+Enter Control+Enter'}>
      {t(`step.${step.kind}`, { number: model.preview?.value?.expectedNumber ?? '', count: model.labels?.value?.toLabel ?? shipment.parcels.filter((parcel) => !parcel.trackingNumber).length })}
    </Button>
  ) : null

  const annulHeld = !model.can.annulDdt ? t('held.noAnnul') : shipment.status === 'DELIVERED' || shipment.status === 'RETURNED' ? t('held.annulDelivered') : null
  const cancelHeld = !model.can.manage ? t('held.noManage') : shipment.parcels.some((parcel) => parcel.trackingNumber) ? t('held.cancelLabels') : liveDdt ? t('held.cancelDdt') : null
  const deliveryHeld = !model.can.manage ? t('held.noManage') : liveDdt ? t('held.deliveryDdt') : null
  const more = [
    ...(shipment.status === 'DRAFT' || shipment.status === 'PACKED' ? [{ id: 'delivery', label: t('action.delivery'), disabled: !!deliveryHeld, description: deliveryHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'delivery' }) }] : []),
    ...(liveDdt ? [{ id: 'annul', label: t('action.annul', { number: liveDdt.number }), disabled: !!annulHeld, description: annulHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'annulDdt', ddtId: liveDdt.id }) }] : []),
    ...(shipment.status === 'PACKED' && model.can.pack ? [{ id: 'unpack', label: t('action.unpack'), disabled: !!liveDdt || shipment.parcels.some((parcel) => parcel.trackingNumber), description: liveDdt ? t('held.unpackDdt') : shipment.parcels.some((parcel) => parcel.trackingNumber) ? t('held.unpackLabels') : undefined, onSelect: () => actions?.onDialog?.({ kind: 'unpack' }) }] : []),
    ...(shipment.status === 'DRAFT' || shipment.status === 'PACKED' ? [{ id: 'cancel', label: t('action.cancel'), disabled: !!cancelHeld, description: cancelHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'cancel' }) }] : []),
    // B-W2a-71: the driver's pack (design tab:sh-tab-pack "All documents"), in a new tab.
    ...(shipment.status !== 'CANCELLED' ? [{ id: 'pack', label: t('action.pack'), href: `${recordHref}/pack`, target: '_blank' as const }] : []),
    ...(model.can.viewOrders ? [{ id: 'order', label: t('action.openOrder', { number: shipment.salesOrder.number }), href: `${model.prefix}/sales/orders/${shipment.salesOrderId}?tab=shipments` }] : []),
    {
      id: 'copy',
      label: t('action.copyNumber'),
      onSelect: () => {
        void navigator.clipboard?.writeText(shipment.number).catch(() => undefined)
      },
    },
  ]

  const activity = panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null)
  const showDock = model.dockOpen && model.tab !== 'activity' && !!activity
  const place = placeOf(shipment.shipTo)
  const carrier = carrierWords(shipment)
  const trackingProblem = model.tracking?.value?.problem
  const latest = model.tracking?.value?.parcels.map((parcel) => parcel.status).find((value) => value !== null) ?? null

  return (
    <div className="fw-sh">
      <div className="fw-sh-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/warehouse/shipments`}>{t('record.back')}</Link>}
          title={
            <span className="fw-sh-title">
              {shipment.number}{' '}
              <span className="fw-sh-title-sub">
                · {shipment.party.legalName}
                {place ? ` · ${place}` : ''}
              </span>
            </span>
          }
          actions={
            <span className="fw-sh-actions">
              {primary}
              {activity && (
                <Button size="sm" variant={model.dockOpen ? 'tonal' : 'secondary'} active={model.dockOpen} aria-pressed={model.dockOpen} onClick={() => actions?.onDock?.()} title={t('record.dockHint')}>
                  <MessageSquare size={14} aria-hidden /> <span>{t('record.dock')}</span>
                  <span className="fw-sh-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
              <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
            </span>
          }
        />
        <div className="fw-sh-meta-row">
          <span className="fw-sh-meta">
            <Pill tone={STATUS_TONE[shipment.status]}>{t(`status.${shipment.status}`)}</Pill>
            {latest && hasLeft(shipment.status) && <Pill tone={TRACKING_TONE[latest] ?? 'neutral'}>{t(`trackingStatus.${latest}`)}</Pill>}
            {!isFinal(shipment.status) && !hasLeft(shipment.status) && open > 0 && <Tag tone="warning">{t('record.checksOpen', { count: open })}</Tag>}
            {model.can.viewOrders ? (
              <Link className="fw-sh-link fw-sh-hint" href={`${model.prefix}/sales/orders/${shipment.salesOrderId}?tab=shipments`}>
                {t('record.order', { number: shipment.salesOrder.number })}
              </Link>
            ) : (
              <span className="fw-sh-hint">{t('record.order', { number: shipment.salesOrder.number })}</span>
            )}
            {shipment.salesOrder.customerRef && <Tag tone="neutral">{t('record.customerRef', { ref: shipment.salesOrder.customerRef })}</Tag>}
            <span className="fw-sh-hint">
              {t(carrier.key, carrier.params)}
              {shipment.serviceCode ? ` · ${shipment.serviceCode}` : ''}
            </span>
          </span>
          <span className="fw-sh-status" role="status">
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
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        >
          {model.notice.detail}
        </Banner>
      )}
      {shipment.status === 'CANCELLED' && <Banner tone="danger" title={t('record.cancelled', { reason: shipment.cancelReason ?? '—' })} />}
      {hasLeft(shipment.status) && shipment.shippedAt && <Banner tone="info" title={t('record.shipped', { when: formatDateTime(shipment.shippedAt, { locale }) })} />}
      {shipment.status === 'SHIPPED' && shipment.ddtRequired && !liveDdt && model.ddts.value && <Banner tone="danger" title={t('record.needsDdt')} />}
      {trackingProblem && <Banner tone="warning" title={t('record.trackingProblem')}>{trackingProblem}</Banner>}
      {!actsOnShipments(model.can) && !isFinal(shipment.status) && <Banner tone="info" title={t('record.readOnly')} />}

      <div className={showDock ? 'fw-sh-body has-dock' : 'fw-sh-body'}>
        <div className="fw-sh-main">
          {model.tab === 'lines' && <LinesTab shipment={shipment} checks={checks} model={model} actions={actions} />}
          {model.tab === 'documents' && <DocumentsTab shipment={shipment} model={model} actions={actions} />}
          {model.tab === 'carrier' && <CarrierTab shipment={shipment} model={model} actions={actions} />}
          {model.tab === 'tracking' && <TrackingTab shipment={shipment} model={model} actions={actions} />}
          {model.tab === 'export' && <ExportTab shipment={shipment} model={model} actions={actions} />}
          {model.tab === 'invoice' && <InvoiceTab shipment={shipment} model={model} actions={actions} />}
          {model.tab === 'activity' && (activity ?? <p className="fw-sh-hint">{t('record.noPanels')}</p>)}
        </div>
        {showDock && (
          <aside className="fw-sh-dock" aria-label={t('record.dockLabel')}>
            {activity}
          </aside>
        )}
      </div>

      <ShipmentDialogs shipment={shipment} model={model} actions={actions} />
    </div>
  )
}

/** A tab's part while it loads, or when its read failed (never drawn as empty): with Try again. */
export function PartState({ problem, onRetry, label }: { problem: string | null; onRetry?: () => void; label: string }) {
  const t = useT('shipments')
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
      <p className="fw-sh-hint" role="status">
        <Spinner size={14} /> {t('part.loading', { part: label })}
      </p>
    </Card>
  )
}
