'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle2, CircleDashed, ClipboardCheck, GitBranch, MinusCircle, MoreHorizontal, Trash2, Undo2, XCircle } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, SummaryTable, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { LotRecord } from '../../../../_shared/stock/api'
import { lotWaitKey, movesHref, quantity } from '../../../../_shared/stock/model'
import { CrViPill, Dual, QualityPill, Qty } from '../../../../_shared/stock/parts'
import type { ReleaseChecklist } from '../../api'
import { checkKey, checklistHead, holdGroups, LOT_TABS, rejectedWithStock, traceSummary, type LotHolds, type LotRecordActions, type LotRecordModel, type LotTab } from '../../model'
import { DockButton, LotsMessages, MovesTable, PartState, RecordFrame, useWords, type Words } from '../../shared/parts'
import { demandLabel, demandRecord, holdsBySubject, reasonLabel } from '../../../stock/daily/model'
import { WriteOffDialog } from '../../../stock/daily/WriteOffDialog'
import { TraceDialog } from '../../trace/TraceDialog'
import { TraceTree } from '../../trace/TraceTree'

export type { LotRecordActions, LotRecordModel } from '../../model'

/**
 * SCR-201-record — a lot (design warehouse.lots "Record: Lot"): the band (‹ Lots & traceability, "Lot <code> · material
 * colour · supplier", its quality and Cr VI, the way to the release checklist in Compliance › Tests & substances — the
 * ONE place a lot is released, blocked or rejected, held in words without quality.lots.view), and the tabs: Overview
 * (the release checklist read-only in our words, the lot's facts, where its stock is, its hides), Trace (came from: the
 * supplier, the purchase order line, the receipt and the supplier's DDT; went to: the work orders, their shipments and
 * customers), Moves (the ledger filtered by the lot with the running balance) and Activity (thread, files, history).
 * B-W2a-64: the band's Trace…; Overview's "Where it is" with reserved and available (the lot at its site: reservations
 * hold a site's stock, not a place) and who reserved it; Quality status (the status, read only, and the holds that touch
 * the lot and its hides, by kind with counts; incoming inspections come later); the Trace tab's tree under the recorded
 * links; a rejected lot with stock asks what happens to it: return to the supplier (a claim) or write it off per place.
 */
export function LotRecordView({ model, actions, panels }: { model: LotRecordModel; actions?: LotRecordActions; panels?: ReactNode }) {
  return (
    <LotsMessages>
      <LotRecordBody model={model} actions={actions} panels={panels} />
    </LotsMessages>
  )
}

function LotRecordBody({ model, actions, panels }: { model: LotRecordModel; actions?: LotRecordActions; panels?: ReactNode }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const listHref = `${model.prefix}/warehouse/lots`
  const record = model.record
  const value = record.status === 'ready' ? record.value : null
  const lot = value?.lot ?? null
  const base = lot ? `${model.prefix}/warehouse/lots/${encodeURIComponent(lot.id)}` : listHref
  const activity = panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null)
  const showDock = model.dockOpen && model.tab !== 'activity' && !!activity
  const decideHref = lot ? `${model.prefix}/compliance/tests/${encodeURIComponent(lot.id)}?tab=release` : ''
  const keyHref = lot ? movesHref(model.prefix, { siteId: lot.siteId, itemId: lot.item.id, lotId: lot.id }) : ''

  const activeHolds = model.holds?.value ? holdGroups(model.holds.value).reduce((sum, group) => sum + group.active, 0) : null
  const tabs: TabItem[] = LOT_TABS.map((tab: LotTab) => ({
    id: tab,
    href: tab === 'overview' ? base : `${base}?tab=${tab}`,
    label: t(`lt.tab.${tab}`),
    count: tab === 'moves' && value ? value.moves : tab === 'trace' && value ? value.trace.forward.workOrders.length : tab === 'quality' && activeHolds ? activeHolds : null,
  }))

  const title = lot ? (
    <span className="fw-wl-title">
      {t('lt.record.title', { code: lot.code })}{' '}
      <span className="fw-wl-title-sub">· {[`${lot.item.code} ${lot.item.name}`, lot.colour?.name, lot.supplier?.name].filter(Boolean).join(' · ')}</span>
    </span>
  ) : null
  const actionsBar = lot ? (
    <span className="fw-st-actions">
      {model.can.lotsView ? (
        <Button size="sm" variant="primary" asChild>
          <Link href={decideHref}>
            <ClipboardCheck size={14} aria-hidden /> {t('lt.record.toChecklist')}
          </Link>
        </Button>
      ) : (
        <Button size="sm" variant="primary" heldReason={t('lt.record.noQuality')}>
          <ClipboardCheck size={14} aria-hidden /> {t('lt.record.toChecklist')}
        </Button>
      )}
      <Button size="sm" onClick={() => actions?.onTrace?.()}>
        <GitBranch size={14} aria-hidden /> {t('lt.find.open')}
      </Button>
      {activity && <DockButton open={model.dockOpen} onDock={actions?.onDock} />}
      <Menu
        label={<MoreHorizontal size={16} aria-label={t('rec.more')} />}
        align="right"
        triggerProps={{ 'aria-label': t('rec.more') }}
        items={[
          { id: 'moves', label: t('lt.openMoves'), href: keyHref },
          ...(lot.receipt ? [{ id: 'receipt', label: t('lt.openReceipt', { number: lot.receipt.number }), href: `${model.prefix}/warehouse/receipts/${encodeURIComponent(lot.receipt.id)}` }] : []),
          { id: 'hides', label: t('lt.openHides'), href: `${model.prefix}/warehouse/hides?lot=${encodeURIComponent(lot.id)}&view=all` },
          { id: 'copy', label: t('lt.record.copyCode'), onSelect: () => void navigator.clipboard?.writeText(lot.code).catch(() => undefined) },
        ]}
      />
    </span>
  ) : null

  return (
    <RecordFrame
      backHref={listHref}
      backLabel={t('lt.back')}
      loaded={record}
      kind="lt"
      title={title}
      actions={actionsBar}
      tabs={tabs}
      tab={model.tab}
      tabsLabel={t('lt.record.tabsLabel')}
      onRetry={actions?.onRetry}
      meta={
        lot ? (
          <>
            <QualityPill status={lot.qualityStatus} />
            {(lot.crVi.required || lot.crVi.status !== 'NOT_REQUIRED') && <CrViPill status={lot.crVi.status} value={lot.crVi.valueMgKg} limit={lot.crVi.limitMgKg} />}
            <Tag tone="neutral">{lot.siteCode}</Tag>
            <span className="fw-wl-hint">{lot.receivedAt ? t('lt.record.received', { date: formatDate(lot.receivedAt, place) }) : t('lt.opening')}</span>
          </>
        ) : null
      }
      status={
        <>
          {model.asOf ? t('stock:live.updated', { time: formatTime(model.asOf, place) }) : null}
          {model.asOf ? ' · ' : null}
          {t(`stock:live.${model.live}`)}
        </>
      }
    >
      {model.changed && (
        <Banner
          tone="info"
          title={t('rec.changed', { time: formatTime(model.changed.at, place) })}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('rec.reload')}
            </Button>
          }
        />
      )}
      {lot?.qualityStatus === 'REJECTED' && <Banner tone="info" title={t('lt.record.rejected', { date: lot.qualityDecidedAt ? formatDate(lot.qualityDecidedAt, place) : '—' })}>{lot.qualityNote ?? undefined}</Banner>}
      {value && rejectedWithStock(value) && <RejectedStock value={value} model={model} actions={actions} />}
      {value && (
        <div className={showDock ? 'fw-wl-body has-dock' : 'fw-wl-body'}>
          <div className="fw-wl-stack">
            {model.tab === 'overview' && <OverviewTab value={value} model={model} actions={actions} decideHref={decideHref} keyHref={keyHref} />}
            {model.tab === 'quality' && <QualityTab value={value} model={model} actions={actions} decideHref={decideHref} />}
            {model.tab === 'trace' && (
              <>
                <TraceTab value={value} model={model} />
                <Card padded>
                  <div className="fw-wl-stack tight">
                    <h3 className="fw-wl-h3">{t('lt.tree.title')}</h3>
                    <p className="fw-wl-hint">{t('lt.tree.intro')}</p>
                    {model.trace && (
                      <PartState value={model.trace} label={t('lt.tree.title')} onRetry={actions?.onRetryTrace}>
                        {(trace) => <TraceTree trace={trace} prefix={model.prefix} holdReasons={model.holdReasons} affectedOnly={model.affectedOnly} />}
                      </PartState>
                    )}
                  </div>
                </Card>
              </>
            )}
            {model.tab === 'moves' && (
              <PartState value={model.moves} label={t('lt.tab.moves')} onRetry={actions?.onRetryMoves}>
                {(moves) => <MovesTable moves={moves} prefix={model.prefix} label={t('lt.movesLabel', { code: value.lot.code })} keyHref={keyHref} onMore={actions?.onMoreMoves} />}
              </PartState>
            )}
            {model.tab === 'activity' && (activity ?? <p className="fw-wl-hint">{t('rec.noPanels')}</p>)}
          </div>
          {showDock && (
            <aside className="fw-wl-dock" aria-label={t('rec.dockLabel')}>
              {activity}
            </aside>
          )}
        </div>
      )}
      {model.writeOff && <WriteOffDialog model={model.writeOff} actions={actions?.writeOff} />}
      {model.find && <TraceDialog model={model.find} actions={actions?.find} />}
    </RecordFrame>
  )
}

function CheckMark({ state }: { state: 'OK' | 'OPEN' | 'NOT_NEEDED' | 'FINAL' }) {
  if (state === 'OK') return <CheckCircle2 size={16} className="fw-wl-ico is-ok" aria-hidden />
  if (state === 'FINAL') return <XCircle size={16} className="fw-wl-ico is-blocked" aria-hidden />
  if (state === 'OPEN') return <CircleDashed size={16} className="fw-wl-ico is-open" aria-hidden />
  return <MinusCircle size={16} className="fw-wl-ico" aria-hidden />
}

/** The release checklist, read-only, in our words (each check: its mark AND its words; the fix says where). */
function Checklist({ checklist, lot, decideHref, t }: { checklist: ReleaseChecklist; lot: LotRecord['lot']; decideHref: string; t: Words }) {
  const head = checklistHead(checklist, lot.qualityStatus)
  return (
    <div className="fw-wl-stack tight">
      <p className="fw-wl-text">
        <b>{t(head.key, { count: head.count })}</b>
      </p>
      <ul className="fw-wl-checks" aria-label={t('lt.release.label')}>
        {checklist.checks.map((check) => (
          <li key={check.code} className="fw-wl-check">
            {/* A released lot's state check is no open work: it says the lot is usable (a rejected one, that it is final). */}
            <CheckMark state={check.code === 'STATE' && check.state === 'OPEN' && lot.qualityStatus === 'RELEASED' ? 'OK' : check.code === 'STATE' && check.state === 'OPEN' && lot.qualityStatus === 'REJECTED' ? 'FINAL' : check.state} />
            <span className="fw-wl-check-words">
              <span>
                <b>{t(`lt.checkName.${check.code}`)}</b> · {t(checkKey(check, lot.qualityStatus))}
              </span>
              {check.state === 'OPEN' && check.fix && (
                <Link className="fw-st-link fw-wl-hint" href={decideHref}>
                  {t('lt.release.fixThere')}
                </Link>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="fw-wl-hint">{t('lt.release.where')}</p>
    </div>
  )
}

function OverviewTab({ value, model, actions, decideHref, keyHref }: { value: LotRecord; model: LotRecordModel; actions?: LotRecordActions; decideHref: string; keyHref: string }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const lot = value.lot
  const wait = lotWaitKey(lot)
  const unit = t(`stock:uom.${lot.item.baseUom}`)
  const leather = lot.item.tracking === 'HIDE'
  const lotHold = model.holds?.value ? (holdsBySubject(model.holds.value.lot).get(lot.id) ?? null) : null
  return (
    <div className="fw-wl-split">
      <div className="fw-wl-stack">
        <Card padded>
          <div className="fw-wl-stack tight">
            <h3 className="fw-wl-h3">{t('lt.release.title')}</h3>
            {model.checklist === null ? (
              <p className="fw-wl-hint">{t('lt.release.noRight')}</p>
            ) : (
              <PartState value={model.checklist} label={t('lt.release.title')} onRetry={actions?.onRetryChecklist}>
                {(checklist) => <Checklist checklist={checklist} lot={lot} decideHref={decideHref} t={t} />}
              </PartState>
            )}
          </div>
        </Card>
        <Card padded>
          <div className="fw-wl-stack tight">
            <h3 className="fw-wl-h3">{t('lt.facts.title')}</h3>
            <KeyValue
              dense
              columns={3}
              labelCase="sentence"
              items={[
                { label: t('lt.facts.code'), value: <span className="fw-wl-code">{lot.code}</span> },
                { label: t('lt.facts.material'), value: `${lot.item.code} · ${lot.item.name}` },
                { label: t('lt.facts.colour'), value: lot.colour ? `${lot.colour.code} ${lot.colour.name}` : '—' },
                { label: t('lt.facts.supplier'), value: lot.supplier?.name ?? '—' },
                { label: t('lt.facts.supplierLot'), value: lot.supplierLotRef ?? '—' },
                { label: t('lt.facts.dyeBatch'), value: lot.dyeBatch ?? '—' },
                { label: t('lt.facts.shade'), value: lot.shade ?? '—' },
                {
                  label: t('lt.facts.receipt'),
                  value: lot.receipt ? (
                    <Link className="fw-st-link" href={`${model.prefix}/warehouse/receipts/${encodeURIComponent(lot.receipt.id)}`}>
                      {lot.receipt.number}
                    </Link>
                  ) : (
                    t('lt.opening')
                  ),
                },
                { label: t('lt.facts.received'), value: lot.receivedAt ? formatDateTime(lot.receivedAt, place) : '—' },
              ]}
            />
          </div>
        </Card>
        <Card padded>
          <div className="fw-wl-stack tight">
            <div className="fw-wl-card-head">
              <h3 className="fw-wl-h3">{t('lt.where.title')}</h3>
              <Link className="fw-st-link fw-wl-hint" href={keyHref}>
                {t('lt.openMoves')}
              </Link>
            </div>
            {value.stock.length === 0 ? (
              <p className="fw-wl-hint">{t('lt.where.nothing')}</p>
            ) : (
              <SummaryTable
                label={t('lt.where.title')}
                columns={[t('lt.where.location'), t('lt.where.onHand'), ...(leather ? [t('lt.where.hides')] : []), t('lt.where.reserved'), t('lt.where.available'), t('lt.where.held')]}
                align={['left', 'right', 'right', 'right', 'right', 'right']}
                widths={leather ? ['30%', '16%', '10%', '14%', '15%', '15%'] : ['34%', '17%', '16%', '17%', '16%']}
                stackOnPhone
                rows={[
                  ...value.stock.map((row) => ({
                    id: row.location.id,
                    cells: [
                      `${row.location.code} · ${row.location.name}`,
                      <Link key="on" className="fw-st-link fw-st-num" href={movesHref(model.prefix, { siteId: lot.siteId, itemId: lot.item.id, lotId: lot.id, locationId: row.location.id, why: true })}>{`${quantity(row.onHand, locale)} ${unit}`}</Link>,
                      ...(leather ? [String(row.hides)] : []),
                      <span key="r" className="fw-st-sub" title={t('lt.where.perSite')}>
                        {t('lt.where.atSite')}
                      </span>,
                      <span key="a" className="fw-st-sub" title={t('lt.where.perSite')}>
                        {t('lt.where.atSite')}
                      </span>,
                      row.held === '0.0000' ? '—' : `${quantity(row.held, locale)} ${unit}`,
                    ],
                  })),
                  ...(model.figures?.value?.lot
                    ? [
                        {
                          id: 'site',
                          cells: [
                            <b key="l">{t('lt.where.site', { site: lot.siteCode })}</b>,
                            <b key="o" className="fw-st-num">{`${quantity(model.figures.value.lot.onHand, locale)} ${unit}`}</b>,
                            ...(leather ? [<b key="h">{String(lot.hides)}</b>] : []),
                            <b key="r" className="fw-st-num">{model.figures.value.lot.reserved === '0.0000' ? '—' : `${quantity(model.figures.value.lot.reserved, locale)} ${unit}`}</b>,
                            <b key="a" className={model.figures.value.lot.overReserved ? 'fw-st-num fw-st-warning' : 'fw-st-num'}>{`${quantity(model.figures.value.lot.available, locale)} ${unit}`}</b>,
                            <b key="d" className="fw-st-num">{model.figures.value.lot.held === '0.0000' ? '—' : `${quantity(model.figures.value.lot.held, locale)} ${unit}`}</b>,
                          ],
                        },
                      ]
                    : []),
                ]}
              />
            )}
            {model.figures && model.figures.value === null && <p className="fw-wl-hint">{model.figures.problem ? t('lt.where.figuresFailed') : t('lt.where.figuresLoading')}</p>}
            {model.figures?.value?.lot?.overReserved && <p className="fw-wl-hint fw-st-warning">{t('lt.where.overReserved')}</p>}
            {model.figures?.value && <Reservations figures={model.figures.value} model={model} unit={unit} />}
            {leather && <p className="fw-wl-hint">{t('lt.where.hidesLine', { inStock: value.hides.inStock, consumed: value.hides.consumed, scrapped: value.hides.scrapped })}</p>}
            {value.trace.forward.workOrders.length > 0 && <p className="fw-wl-hint">{t('lt.where.issued', { count: value.trace.forward.workOrders.length })}</p>}
          </div>
        </Card>
      </div>
      <Card padded>
        <div className="fw-wl-stack tight">
          <h3 className="fw-wl-h3">{t('lt.side.title')}</h3>
          <span className="fw-wl-chips">
            <QualityPill status={lot.qualityStatus} />
          </span>
          <p className="fw-wl-text">{lotHold ? t('lt.side.onHold', { reason: reasonLabel(model.holdReasons, lotHold.reasonCode, locale) }) : wait ? t(`stock:${wait}`) : t('lt.side.usable')}</p>
          {lot.qualityDecidedAt && <p className="fw-wl-hint">{t('lt.side.decided', { date: formatDateTime(lot.qualityDecidedAt, place) })}</p>}
          {lot.qualityNote && <p className="fw-wl-hint">{t('lt.side.note', { note: lot.qualityNote })}</p>}
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('lt.side.crVi'), value: lot.crVi.required || lot.crVi.status !== 'NOT_REQUIRED' ? <CrViPill status={lot.crVi.status} value={lot.crVi.valueMgKg} limit={lot.crVi.limitMgKg} /> : t('stock:crVi.NOT_REQUIRED') },
              { label: t('lt.side.evidence'), value: lot.crVi.evidence ? t(`stock:evidence.${lot.crVi.evidence}`) : lot.crVi.required ? t('stock:evidence.missing') : '—', hint: lot.crVi.testedOn ? t('lt.side.testedOn', { date: formatDate(`${lot.crVi.testedOn}T12:00:00Z`, place) }) : undefined },
              { label: t('lt.side.documents'), value: t('lt.documents', { count: lot.documents }) },
              { label: t('lt.side.onHand'), value: leather ? <Dual hides={lot.hides} area={lot.onHand} uom={lot.item.baseUom} both /> : <Qty value={lot.onHand} uom={lot.item.baseUom} /> },
            ]}
          />
          {model.can.lotsView && (
            <Link className="fw-st-link" href={decideHref}>
              {t('lt.decide')}
            </Link>
          )}
        </div>
      </Card>
    </div>
  )
}

function TraceTab({ value, model }: { value: LotRecord; model: LotRecordModel }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const back = value.trace.backward
  const forward = value.trace.forward
  const unit = t(`stock:uom.${value.lot.item.baseUom}`)
  const summary = traceSummary(forward)
  return (
    <div className="fw-wl-trace">
      <Card padded>
        <div className="fw-wl-stack tight">
          <h3 className="fw-wl-h3">{t('lt.trace.cameFrom')}</h3>
          {value.lot.opening ? (
            <p className="fw-wl-text">{t('lt.trace.opening')}</p>
          ) : (
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('lt.trace.supplier'), value: back.supplier?.name ?? '—', hint: value.lot.supplierLotRef ? t('lt.supplierLot', { ref: value.lot.supplierLotRef }) : undefined },
                {
                  label: t('lt.trace.order'),
                  value: back.purchaseOrder ? (
                    <Link className="fw-st-link" href={`${model.prefix}/purchasing/orders/${encodeURIComponent(back.purchaseOrder.id)}`}>
                      {back.purchaseOrder.lineSeq !== null ? t('lt.trace.orderLine', { number: back.purchaseOrder.number, seq: back.purchaseOrder.lineSeq }) : back.purchaseOrder.number}
                    </Link>
                  ) : (
                    t('lt.trace.noOrder')
                  ),
                },
                {
                  label: t('lt.trace.receipt'),
                  value: back.receipt ? (
                    <Link className="fw-st-link" href={`${model.prefix}/warehouse/receipts/${encodeURIComponent(back.receipt.id)}`}>
                      {back.receipt.number}
                    </Link>
                  ) : (
                    '—'
                  ),
                  hint: back.receipt ? formatDateTime(back.receipt.receivedAt, place) : undefined,
                },
                { label: t('lt.trace.ddt'), value: back.receipt?.supplierDdtNumber ?? t('lt.trace.noDdt'), hint: back.receipt?.supplierDdtDate ? formatDate(`${back.receipt.supplierDdtDate}T12:00:00Z`, place) : undefined },
              ]}
            />
          )}
        </div>
      </Card>
      <Card padded>
        <div className="fw-wl-stack tight">
          <h3 className="fw-wl-h3">{t('lt.trace.wentTo')}</h3>
          <p className="fw-wl-text">
            {summary.key === 'lt.trace.used'
              ? t('lt.trace.used', { orders: t('lt.trace.nOrders', { count: summary.params.orders! }), shipments: t('lt.trace.nShipments', { count: summary.params.shipments! }), customers: t('lt.trace.nCustomers', { count: summary.params.customers! }) })
              : t(summary.key)}
          </p>
          {forward.workOrders.length === 0 ? (
            <EmptyState icon={<XCircle size={20} aria-hidden />} title={t('lt.trace.notUsedTitle')} description={t('lt.trace.notUsedBody')} />
          ) : (
            <>
              <SummaryTable
                label={t('lt.trace.ordersLabel')}
                columns={[t('lt.trace.col.order'), t('lt.trace.col.batch'), t('lt.trace.col.issued'), t('lt.trace.col.returned'), t('lt.trace.col.at'), t('lt.trace.col.hides')]}
                align={['left', 'left', 'right', 'right', 'right', 'right']}
                stackOnPhone
                rows={forward.workOrders.map((order) => ({
                  id: order.id,
                  cells: [
                    order.number ? (
                      <Link key="wo" className="fw-st-link" href={`${model.prefix}/production/work-orders/${encodeURIComponent(order.id)}`}>
                        {order.number}
                      </Link>
                    ) : (
                      t('lt.trace.unknownOrder')
                    ),
                    order.batchNumber ?? '—',
                    `${quantity(order.issued, locale)} ${unit}`,
                    order.returned === '0.0000' ? '—' : `${quantity(order.returned, locale)} ${unit}`,
                    `${quantity(order.atWorkOrder, locale)} ${unit}`,
                    order.hides > 0 ? String(order.hides) : '—',
                  ],
                }))}
              />
              {forward.shipments.length === 0 ? (
                <p className="fw-wl-hint">{t('lt.trace.noShipments')}</p>
              ) : (
                <SummaryTable
                  label={t('lt.trace.shipmentsLabel')}
                  columns={[t('lt.trace.col.shipment'), t('lt.trace.col.customer'), t('lt.trace.col.state'), t('lt.trace.col.garments')]}
                  align={['left', 'left', 'left', 'right']}
                  stackOnPhone
                  rows={forward.shipments.map((shipment) => ({
                    id: shipment.id,
                    cells: [
                      <Link key="sh" className="fw-st-link" href={`${model.prefix}/warehouse/shipments/${encodeURIComponent(shipment.id)}`}>
                        {shipment.number}
                      </Link>,
                      shipment.customer?.name ?? '—',
                      t(`lt.shipmentStatus.${shipment.status}`),
                      String(shipment.garments),
                    ],
                  }))}
                />
              )}
              <p className="fw-wl-hint">{t('lt.trace.far')}</p>
            </>
          )}
        </div>
      </Card>
    </div>
  )
}

/** Who reserved the lot (its ACTIVE reservations, design lt-stock "Reserved"): the demand, what it still holds, when it is needed. */
function Reservations({ figures, model, unit }: { figures: NonNullable<NonNullable<LotRecordModel['figures']>['value']>; model: LotRecordModel; unit: string }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  if (figures.reservations.length === 0) return <p className="fw-wl-hint">{t('lt.where.noReservations')}</p>
  return (
    <div className="fw-wl-stack tight">
      <h4 className="fw-wl-h3">{t('lt.where.reservedFor', { count: figures.reservations.length })}</h4>
      <ul className="fw-wl-checks">
        {figures.reservations.map((reservation) => (
          <li key={reservation.id} className="fw-st-inline">
            <Link className="fw-st-link fw-wl-code" href={`${model.prefix}${recordAddress(demandRecord(reservation.demand), OFFICE_PAGES)}`}>
              {demandLabel(reservation.demand)}
            </Link>
            <span className="fw-st-num">{reservation.hide ? t('lt.where.wholeHide', { code: reservation.hide.code }) : `${quantity(reservation.open, locale)} ${unit}`}</span>
            {reservation.needDate && <span className="fw-st-sub">{t('lt.where.needed', { date: formatDate(`${reservation.needDate}T12:00:00Z`, place) })}</span>}
            {reservation.stale && <Pill tone="warning">{t('lt.where.stale')}</Pill>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A rejected lot that still has stock (design lt-reject: "what happens to the stock"): return it, or write it off per place. */
function RejectedStock({ value, model, actions }: { value: LotRecord; model: LotRecordModel; actions?: LotRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const lot = value.lot
  const unit = t(`stock:uom.${lot.item.baseUom}`)
  const places = value.stock.filter((row) => row.onHand !== '0.0000')
  return (
    <Banner
      tone="warning"
      title={t('lt.reject.title')}
      action={
        <Button size="sm" asChild>
          <Link href={`${model.prefix}/purchasing/claims?return=${encodeURIComponent(lot.id)}`}>
            <Undo2 size={13} aria-hidden /> {t('lt.reject.return')}
          </Link>
        </Button>
      }
    >
      <div className="fw-wl-stack tight">
        <p className="fw-wl-text">{t('lt.reject.body')}</p>
        <span className="fw-st-actions">
          {places.map((row) => (
            <Button key={row.location.id} size="sm" variant="danger-outline" heldReason={model.daily.scrap ? null : t('lt.reject.noScrap')} onClick={() => actions?.onWriteOff?.(row.location.id)}>
              <Trash2 size={13} aria-hidden /> {t('lt.reject.writeOff', { place: row.location.code, quantity: `${quantity(row.onHand, locale)} ${unit}` })}
            </Button>
          ))}
        </span>
      </div>
    </Banner>
  )
}

/** Quality status (design rec:Lot/quality): the status read only (decided in Compliance), and the holds that touch the lot. */
function QualityTab({ value, model, actions, decideHref }: { value: LotRecord; model: LotRecordModel; actions?: LotRecordActions; decideHref: string }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const lot = value.lot
  const wait = lotWaitKey(lot)
  return (
    <div className="fw-wl-cards">
      <Card padded>
        <div className="fw-wl-stack tight">
          <h3 className="fw-wl-h3">{t('lt.quality.status')}</h3>
          <span className="fw-wl-chips">
            <QualityPill status={lot.qualityStatus} />
            {(lot.crVi.required || lot.crVi.status !== 'NOT_REQUIRED') && <CrViPill status={lot.crVi.status} value={lot.crVi.valueMgKg} limit={lot.crVi.limitMgKg} />}
          </span>
          <p className="fw-wl-text">{wait ? t(`stock:${wait}`) : t('lt.side.usable')}</p>
          {lot.qualityDecidedAt && <p className="fw-wl-hint">{t('lt.side.decided', { date: formatDateTime(lot.qualityDecidedAt, place) })}</p>}
          {lot.qualityNote && <p className="fw-wl-hint">{t('lt.side.note', { note: lot.qualityNote })}</p>}
          <p className="fw-wl-hint">{t('lt.quality.where')}</p>
          {model.can.lotsView ? (
            <Link className="fw-st-link" href={decideHref}>
              {t('lt.decide')}
            </Link>
          ) : (
            <p className="fw-wl-hint">{t('lt.record.noQuality')}</p>
          )}
        </div>
      </Card>
      <Card padded>
        <div className="fw-wl-stack tight">
          <h3 className="fw-wl-h3">{t('lt.quality.holdsTitle')}</h3>
          {model.holds === null ? (
            <p className="fw-wl-hint">{t('lt.quality.noRight')}</p>
          ) : (
            <PartState value={model.holds} label={t('lt.quality.holdsTitle')} onRetry={actions?.onRetryHolds}>
              {(holds) => <HoldLinks holds={holds} model={model} />}
            </PartState>
          )}
          <p className="fw-wl-hint">{t('lt.quality.inspections')}</p>
        </div>
      </Card>
    </div>
  )
}

/** The holds grouped by kind with counts (design lt-holds "EntityLinks grouped by kind"): each its state, reason and since. */
function HoldLinks({ holds, model }: { holds: LotHolds; model: LotRecordModel }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const groups = holdGroups(holds)
  if (groups.length === 0) return <EmptyState title={t('lt.quality.noHolds')} description={t('lt.quality.noHoldsBody')} />
  return (
    <div className="fw-wl-stack">
      {groups.map((group) => (
        <div key={group.kind} className="fw-wl-stack tight">
          <h4 className="fw-wl-h3">{t(`lt.quality.group.${group.kind}`, { count: group.rows.length, active: group.active })}</h4>
          <ul className="fw-wl-checks">
            {group.rows.map((hold) => (
              <li key={hold.id} className="fw-st-inline">
                <Link className="fw-st-link" href={`${model.prefix}${recordAddress({ type: 'QualityHold', id: hold.id }, OFFICE_PAGES)}`}>
                  {reasonLabel(model.holdReasons, hold.reasonCode, locale)}
                </Link>
                <Pill tone={hold.status === 'ACTIVE' ? 'danger' : 'neutral'}>{t(`lt.quality.holdStatus.${hold.status}`)}</Pill>
                <span className="fw-st-sub">{t('lt.quality.since', { date: formatDate(hold.placedAt, place) })}</span>
                {group.kind === 'Hide' && <span className="fw-st-sub">{hold.subjects.map((subject) => subject.label ?? '—').join(', ')}</span>}
                {hold.reasonNote && <span className="fw-st-sub">{hold.reasonNote}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
