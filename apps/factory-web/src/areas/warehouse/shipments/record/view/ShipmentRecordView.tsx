'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Shipment } from '../../api'
import { actsOnShipments, carrierWords, hasLeft, isFinal, isWideTab, nextStep, openChecks, placeOf, readyChecks, RECORD_TABS, STATUS_TONE, TRACKING_TONE, type RecordTab, type StepKind } from '../../model'
// ---- B-TH-264: the shipment on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'
// B-W2b-410: the record's parts in depth (holds, split, cartons, how it travels, label prints, papers, delivery, notice).
import type { ShipmentDepthSlots } from '../../queue/record-depth'
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
 * SCR-067 — a shipment (design warehouse.shipments "Record: Shipment"; 00 §2.2; Owner L1: the tabs always in view), on RecordFrame
 * (B-TH-264; the rule of picture 38). The band in the shell's band row: ‹ Shipments, "<number> · <customer> · <city CC>", ONE state
 * pill, the order, the customer's PO, who carries it (and the tracking once it left), the next step as the primary — Mark packed →
 * Issue DDT → Buy labels → Mark handed over, each held with its reason —, the Thread button (⌘J), ⋯ (Annul DDT…, Cancel shipment,
 * Change delivery, the driver's pack …, its Keyboard line). The thread is docked beside every tab (40 %; one third on Lines &
 * cartons under 1600 px): "Reply to <customer>" reaches this shipment's customer only, its files are this shipment's; Activity's
 * tools are in its "⋯" (R-ACT). The tabs 7 → 5: Lines & cartons (Ready to ship: every check the law and the customer need with its
 * fix; the lines from released garments only; the cartons), Documents (the DDT: the draft and its problems, issued once with its
 * number and frozen, annulled with its reason; the Declaration of Conformity and the user information; the customer's document
 * link; the files open in the File viewer), Carrier & tracking (who carries it, the labels, then the carrier's events and the proof
 * of delivery: every action of Carrier & label and Tracking & delivery), Export (the intra-EU transport evidence) and Invoice (the
 * freight charged — the one price on a shipment, drawn only with the price grain). ONE notice in the body column.
 */
// B-W2b-170: `trackingLink`, the container's tracking-page card (links.tracking) on Carrier & tracking.
// B-W2b-410: `depth`, the parts in depth (each its own container) slotted into the tabs, the band and ⋯.
// B-TH-264: `thread` the docked thread (the office's OfficeRecordThread docked, or a design case's), `printThread` what the print
// view shows of it.
export function ShipmentRecordView({ model, actions, thread, printThread, trackingLink, depth }: { model: ShipmentRecordModel; actions?: ShipmentRecordActions; thread?: ReactNode; printThread?: ReactNode; trackingLink?: ReactNode; depth?: ShipmentDepthSlots }) {
  return (
    <WithMessages namespaces={['shipments', 'lists', 'records']}>
      <ShipmentRecord model={model} actions={actions} thread={thread} printThread={printThread} trackingLink={trackingLink} depth={depth} />
    </WithMessages>
  )
}

function ShipmentRecord({ model, actions, thread, printThread, trackingLink, depth }: { model: ShipmentRecordModel; actions?: ShipmentRecordActions; thread?: ReactNode; printThread?: ReactNode; trackingLink?: ReactNode; depth?: ShipmentDepthSlots }) {
  const t = useT('shipments')
  const listHref = `${model.prefix}/warehouse/shipments`
  const loaded = model.shipment

  if (loaded.status !== 'ready') {
    return (
      <RecordFrame
        recordType="Shipment"
        personId={model.personId ?? null}
        band={{ back: <Link href={listHref}>{t('record.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.title'), moreLabel: t('record.more') }}
        thread={null}
        threadLabel={t('record.dockLabel')}
      >
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
      </RecordFrame>
    )
  }
  return <ReadyRecord shipment={loaded.value} model={model} actions={actions} thread={thread} printThread={printThread} trackingLink={trackingLink} depth={depth} />
}

const STEP_DIALOG: Record<Exclude<StepKind, 'pack'>, 'issueDdt' | 'buyLabels' | 'handOver'> = { issueDdt: 'issueDdt', buyLabels: 'buyLabels', handOver: 'handOver' }

function ReadyRecord({ shipment, model, actions, thread, printThread, trackingLink, depth }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions; thread?: ReactNode; printThread?: ReactNode; trackingLink?: ReactNode; depth?: ShipmentDepthSlots }) {
  const t = useT('shipments')
  const locale = useLocale()
  const recordHref = `${model.prefix}/warehouse/shipments/${shipment.id}`
  const liveDdt = model.ddts.value?.find((row) => row.status === 'LIVE') ?? null
  const facts = { shipment, ddt: liveDdt, labels: model.labels?.value ?? null, documents: model.documents.value }
  // B-W2b-410: a carrier booked by hand buys no label: the next step goes on to the hand-over.
  const step = nextStep(depth?.noLabels ? { ...facts, labels: { toLabel: 0, parcels: [] } } : facts, model.can)
  // B-W2b-410: a hold in force stops packing, labels and the hand-over (the DB refuses them): the primary says why.
  const holdHeld = depth?.stepHeld && step.kind && step.kind !== 'issueDdt' ? depth.stepHeld : null
  const stepHeld = step.held ? t(step.held.key, step.held.params) : (holdHeld ?? (model.busy ? t('held.busy') : null))
  const checks = readyChecks(facts)
  const runStep = () => {
    if (!step.kind || stepHeld) return
    if (step.kind === 'pack') actions?.onPack?.()
    else actions?.onDialog?.({ kind: STEP_DIALOG[step.kind] })
  }

  // Keys: ⌘↵ the next step; d issue DDT, l buy labels (each opens its confirm; never while typing or in a dialog). ⌘J is the
  // frame's (the thread).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
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
    // B-TH-264: Carrier & tracking counts the parcels a carrier takes (the tracking events are read inside it).
    if (tab === 'carrier') return shipment.transportBy === 'CARRIER' ? shipment.parcels.length : null
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
      {/* B-W2b-F50: in test mode the step makes TEST labels (nothing bought): "Make 2 test labels". */}
      {t(step.kind === 'buyLabels' && model.labels?.value?.testMode === true ? 'step.buyLabelsTest' : `step.${step.kind}`, { number: model.preview?.value?.expectedNumber ?? '', count: model.labels?.value?.toLabel ?? shipment.parcels.filter((parcel) => !parcel.trackingNumber).length })}
    </Button>
  ) : null

  const annulHeld = !model.can.annulDdt ? t('held.noAnnul') : shipment.status === 'DELIVERED' || shipment.status === 'RETURNED' ? t('held.annulDelivered') : null
  const cancelHeld = !model.can.manage ? t('held.noManage') : shipment.parcels.some((parcel) => parcel.trackingNumber) ? t('held.cancelLabels') : liveDdt ? t('held.cancelDdt') : null
  const deliveryHeld = !model.can.manage ? t('held.noManage') : liveDdt ? t('held.deliveryDdt') : null
  const more: MenuItemDef[] = [
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
    // B-W2b-410: Place a hold…, Split…
    ...(depth?.more ?? []),
  ]

  const place = placeOf(shipment.shipTo)
  const carrier = carrierWords(shipment)
  const trackingProblem = model.tracking?.value?.problem
  const latest = model.tracking?.value?.parcels.map((parcel) => parcel.status).find((value) => value !== null) ?? null

  return (
    <>
      <RecordFrame
        recordType="Shipment"
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        wide={isWideTab(model.tab)}
        band={{
          back: <Link href={`${model.prefix}/warehouse/shipments`}>{t('record.back')}</Link>,
          title: (
            <span className="fw-sh-title">
              {shipment.number}{' '}
              <span className="fw-sh-title-sub">
                · {shipment.party.legalName}
                {place ? ` · ${place}` : ''}
              </span>
            </span>
          ),
          status: <Pill tone={STATUS_TONE[shipment.status]}>{t(`status.${shipment.status}`)}</Pill>,
          meta: (
            <>
              {latest && hasLeft(shipment.status) && <Tag tone={TRACKING_TONE[latest] ?? 'neutral'}>{t(`trackingStatus.${latest}`)}</Tag>}
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
            </>
          ),
          primary,
          more,
          moreLabel: t('record.more'),
        }}
      >
        <div className="fw-sh">
          <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

          {/* B-TH-264: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
          <RecordNotices>
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
            {shipment.status === 'SHIPPED' && shipment.ddtRequired && !liveDdt && model.ddts.value && <Banner tone="danger" title={t('record.needsDdt')} />}
            {depth?.banner}
            {trackingProblem && <Banner tone="warning" title={t('record.trackingProblem')}>{trackingProblem}</Banner>}
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
            {hasLeft(shipment.status) && shipment.shippedAt && <Banner tone="info" title={t('record.shipped', { when: formatDateTime(shipment.shippedAt, { locale }) })} />}
            {!actsOnShipments(model.can) && !isFinal(shipment.status) && <Banner tone="info" title={t('record.readOnly')} />}
          </RecordNotices>

          <div className="fw-sh-main">
            {model.tab === 'lines' && <LinesTab shipment={shipment} checks={checks} model={model} actions={actions} depth={depth ? { cartons: depth.cartons, holds: depth.holds, held: depth.held } : undefined} />}
            {model.tab === 'documents' && <DocumentsTab shipment={shipment} model={model} actions={actions} papers={depth?.papers} />}
            {/* B-TH-264: Carrier & tracking — who carries it and the labels, then the carrier's events and the delivery (both bodies as they are). */}
            {model.tab === 'carrier' && (
              <div className="fw-sh-stack">
                <CarrierTab shipment={shipment} model={model} actions={actions} depth={depth ? { booking: depth.booking, labels: depth.labels, noLabels: depth.noLabels } : undefined} />
                <TrackingTab shipment={shipment} model={model} actions={actions} trackingLink={trackingLink} depth={depth ? { delivery: depth.delivery, notice: depth.notice } : undefined} />
              </div>
            )}
            {/* B-W2b-412: the export papers in place of W2a's destination card. */}
            {model.tab === 'export' && <ExportTab shipment={shipment} model={model} actions={actions} papers={depth?.exportPapers} />}
            {model.tab === 'invoice' && <InvoiceTab shipment={shipment} model={model} actions={actions} />}
          </div>
        </div>
      </RecordFrame>

      <ShipmentDialogs shipment={shipment} model={model} actions={actions} />
      {depth?.dialogs}
    </>
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
