'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Download, FileX, MessageSquare, MoreHorizontal, ShieldOff, Undo2, XCircle } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu, Modal, Tabs, type TabItem } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Pill, Skeleton, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import { dayAt, money, quantity } from '../../../../_shared/buying/model'
import type { LotWithHides, Receipt, ReceiptHide, ReceiptLine, ReceiptLot } from '../../api'
import { RECEIPT_TABS, RECEIPT_TONE, reversalMoves, type ReceiptRecordActions, type ReceiptRecordModel, type ReceiptTab } from '../../model'
import '../../../../_shared/buying/buying.css'

export type { ReceiptRecordActions, ReceiptRecordModel } from '../../model'

export const LOT_TONE = { QUARANTINE: 'warning', RELEASED: 'success', BLOCKED: 'danger', REJECTED: 'danger' } as const
const CR_VI_TONE = { NOT_REQUIRED: 'neutral', PENDING: 'warning', PASS: 'success', FAIL: 'danger' } as const

/**
 * SCR-063 — a goods receipt (design warehouse.receipts "Record: Receipt"): the band (‹ Receipts, "<number> ·
 * <supplier> · <PO>", the state, the supplier's DDT, site and goods-in location, when it came and was posted, ⋯ Reverse
 * receipt…), the tabs: Lines (what came against which order line, with the difference against the order and its
 * tolerance; values with the cost grain), Lots & hides (SCR-062 the lots with their quality state, chromium VI and why
 * they wait; SCR-061 every hide one by one on the list frame, with what lies of it now), Activity. Reverse: only while
 * its stock is untouched — else held with what used it, in words — with the reason; nothing is deleted.
 */
export function ReceiptRecordView({ model, actions, panels }: { model: ReceiptRecordModel; actions?: ReceiptRecordActions; panels?: ReactNode }) {
  return (
    <WithMessages namespaces={['buying', 'lists', 'records']}>
      <ReceiptRecord model={model} actions={actions} panels={panels} />
    </WithMessages>
  )
}

function ReceiptRecord({ model, actions, panels }: { model: ReceiptRecordModel; actions?: ReceiptRecordActions; panels?: ReactNode }) {
  const t = useT('buying')
  const listHref = `${model.prefix}/warehouse/receipts`
  const loaded = model.receipt
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-by">
        <div className="fw-by-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('rc.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('rc.record.title')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-by-hint" role="status">
              <Spinner size={14} /> {t('rc.record.loading')}
            </p>
            <div className="fw-by-stack">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(`record.${loaded.status}.title`)}
              description={loaded.status === 'error' ? t(loaded.problem) : t(`rc.record.${loaded.status}`)}
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={listHref}>{t('rc.record.backToList')}</Link>
                  </Button>
                )
              }
            />
          </Card>
        )}
      </div>
    )
  }
  return <ReadyReceipt receipt={loaded.value} model={model} actions={actions} panels={panels} />
}

function ReadyReceipt({ receipt, model, actions, panels }: { receipt: Receipt; model: ReceiptRecordModel; actions?: ReceiptRecordActions; panels?: ReactNode }) {
  const t = useT('buying')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const href = `${model.prefix}/warehouse/receipts/${receipt.id}`

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        actions?.onDock?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const reverseHeld = !model.can.reverse ? t('held.noReverse') : receipt.status !== 'POSTED' ? t('rc.reverse.notPosted') : receipt.reversal && !receipt.reversal.possible ? t('rc.reverse.used') : null
  const tabs: TabItem[] = RECEIPT_TABS.map((tab: ReceiptTab) => ({
    id: tab,
    href: `${href}?tab=${tab}`,
    label: tab === 'lots' && receipt.summary.lotsInQuarantine > 0 ? (
      <span className="fw-by-tablabel">
        {t(`rc.tab.${tab}`)}
        <span className="fw-by-dot" aria-label={t('rc.tab.waiting', { count: receipt.summary.lotsInQuarantine })} role="img" />
      </span>
    ) : (
      t(`rc.tab.${tab}`)
    ),
    count: tab === 'lines' ? receipt.lines.length : tab === 'lots' ? receipt.summary.lots : null,
  }))
  const activity = panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null)
  const showDock = model.dockOpen && model.tab !== 'activity' && !!activity
  const more = [
    { id: 'reverse', label: t('rc.reverse.menu'), tone: 'danger' as const, disabled: reverseHeld !== null, onSelect: () => actions?.onDialog?.({ kind: 'reverse', reason: '' }) },
    ...(receipt.purchaseOrder ? [{ id: 'po', label: t('rc.openOrder', { number: receipt.purchaseOrder.number }), href: `${model.prefix}/purchasing/orders/${receipt.purchaseOrder.id}` }] : []),
    { id: 'copy', label: t('rc.record.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(receipt.number).catch(() => undefined) },
  ]

  return (
    <div className="fw-by">
      <div className="fw-by-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/warehouse/receipts`}>{t('rc.back')}</Link>}
          title={
            <span className="fw-by-title">
              {receipt.number}{' '}
              <span className="fw-by-title-sub">
                · {receipt.supplier.name}
                {receipt.purchaseOrder ? ` · ${receipt.purchaseOrder.number}` : ''}
              </span>
            </span>
          }
          actions={
            <span className="fw-by-actions">
              {receipt.status === 'POSTED' && (
                <Button size="sm" heldReason={reverseHeld} onClick={() => actions?.onDialog?.({ kind: 'reverse', reason: '' })}>
                  <Undo2 size={14} aria-hidden /> {t('rc.reverse.button')}
                </Button>
              )}
              {activity && (
                <Button size="sm" variant={model.dockOpen ? 'tonal' : 'secondary'} active={model.dockOpen} aria-pressed={model.dockOpen} onClick={() => actions?.onDock?.()} title={t('record.dockHint')}>
                  <MessageSquare size={14} aria-hidden /> <span>{t('record.dock')}</span>
                  <span className="fw-by-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
              <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
            </span>
          }
        />
        <div className="fw-by-meta-row">
          <span className="fw-by-meta">
            <Pill tone={RECEIPT_TONE[receipt.status]}>{t(`rcStatus.${receipt.status}`)}</Pill>
            {receipt.supplierDdtNumber ? <Tag tone="neutral">{t('rc.ddt', { number: receipt.supplierDdtNumber, date: receipt.supplierDdtDate ? formatDate(dayAt(receipt.supplierDdtDate), place) : '—' })}</Tag> : <Tag tone="warning">{t('rc.noDdt')}</Tag>}
            <span className="fw-by-hint">{[`${receipt.site.code} · ${receipt.site.name}`, receipt.location ? t('rc.record.at', { location: receipt.location.code }) : null, t('rc.record.receivedAt', { time: formatDateTime(receipt.receivedAt, place) })].filter(Boolean).join(' · ')}</span>
          </span>
          <span className="fw-by-status" role="status">
            {t(`live.${model.live}`)}
          </span>
        </div>
        <Tabs ariaLabel={t('rc.record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
      </div>

      {model.changed && (
        <Banner
          tone="info"
          title={t('record.changed', { time: formatTime(model.changed.at, place) })}
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
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {receipt.status === 'REVERSED' && <Banner tone="danger" title={t('rc.record.reversed', { time: receipt.reversedAt ? formatDateTime(receipt.reversedAt, place) : '—' })}>{receipt.reversalReason}</Banner>}
      {receipt.status === 'POSTED' && <Banner tone="info" title={t('rc.record.posted', { time: receipt.postedAt ? formatDateTime(receipt.postedAt, place) : '—' })} />}

      <div className={showDock ? 'fw-by-body has-dock' : 'fw-by-body'}>
        <div className="fw-by-main">
          {model.tab === 'lines' && <LinesTab receipt={receipt} model={model} />}
          {model.tab === 'lots' && <LotsTab receipt={receipt} model={model} actions={actions} />}
          {model.tab === 'activity' && (activity ?? <p className="fw-by-hint">{t('record.noPanels')}</p>)}
        </div>
        {showDock && (
          <aside className="fw-by-dock" aria-label={t('record.dockLabel')}>
            {activity}
          </aside>
        )}
      </div>

      {model.dialog?.kind === 'reverse' && <ReverseDialog receipt={receipt} model={model} actions={actions} />}
    </div>
  )
}

function LinesTab({ receipt, model }: { receipt: Receipt; model: ReceiptRecordModel }) {
  const t = useT('buying')
  const locale = useLocale()
  const columns = useMemo<ColDef<ReceiptLine>[]>(() => {
    const MaterialCell = ({ data }: ICellRendererParams<ReceiptLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-ellipsis">
            {data.item.code} · {data.item.name}
          </span>
          <span className="fw-by-cell-sub">{[data.colour ? `${data.colour.code} ${data.colour.name}` : null, data.orderLine ? t('rc.lineSeq', { seq: data.orderLine.seq }) : t('rc.noOrderLine')].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const QuantityCell = ({ data }: ICellRendererParams<ReceiptLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-num">
            {quantity(data.quantity, locale)} {t(`uom.${data.uom}`)}
          </span>
          <span className="fw-by-cell-sub">{[data.uom !== data.item.baseUom ? `${quantity(data.baseQuantity, locale)} ${t(`uom.${data.item.baseUom}`)}` : null, data.hideCount ? t('rc.hides', { count: data.hideCount }) : null].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const DiffCell = ({ data }: ICellRendererParams<ReceiptLine>) => {
      if (!data?.difference) return <span className="fw-by-cell-sub">—</span>
      const diff = data.difference
      const unit = t(`uom.${data.item.baseUom}`)
      return (
        <span className="fw-by-cell">
          <span>
            <Pill tone={diff.kind === 'OVER' ? 'danger' : diff.kind === 'SHORT' ? 'warning' : 'success'}>{t(`rc.diff.${diff.kind}`)}</Pill>
          </span>
          <span className="fw-by-cell-sub">{t(`rc.diffWords.${diff.kind}`, { after: quantity(diff.after, locale), expected: quantity(diff.expected, locale), open: quantity(diff.open, locale), more: quantity(diff.difference, locale), upTo: quantity(diff.upTo, locale), unit })}</span>
        </span>
      )
    }
    const LotsCell = ({ data }: ICellRendererParams<ReceiptLine>) => (data ? <span className="fw-by-ellipsis">{data.lots.map((lot) => lot.code).join(' · ') || '—'}</span> : null)
    const ValueCell = ({ data }: ICellRendererParams<ReceiptLine>) => (data ? <span className="fw-by-num">{data.value ? money(data.value.valueAmount, data.value.currency, locale) : '—'}</span> : null)
    return [
      { colId: 'seq', headerName: t('po.col.seq'), field: 'seq', minWidth: 58, maxWidth: 70, type: 'rightAligned' },
      { colId: 'material', headerName: t('rc.col.material'), minWidth: 220, flex: 1.6, cellRenderer: MaterialCell },
      { colId: 'quantity', headerName: t('rc.col.received'), minWidth: 150, flex: 1, cellRenderer: QuantityCell },
      { colId: 'difference', headerName: t('rc.col.difference'), minWidth: 260, flex: 1.8, cellRenderer: DiffCell },
      { colId: 'lots', headerName: t('rc.col.lots'), minWidth: 150, flex: 1, cellRenderer: LotsCell },
      { colId: 'note', headerName: t('rc.col.note'), field: 'note', minWidth: 150, flex: 1, tooltipField: 'note' },
      ...(model.can.cost ? [{ colId: 'value', headerName: t('rc.col.value'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: ValueCell } satisfies ColDef<ReceiptLine>] : []),
    ]
  }, [t, locale, model.can.cost])

  return (
    <div className="fw-by-stack">
      <Card padded>
        <KeyValue
          dense
          columns={3}
          labelCase="sentence"
          items={[
            { label: t('rc.summary.quantity'), value: receipt.summary.quantities.map((entry) => `${quantity(entry.baseQuantity, locale)} ${t(`uom.${entry.uom}`)}`).join(' · ') || '—' },
            { label: t('rc.summary.hides'), value: String(receipt.summary.hides) },
            { label: t('rc.summary.lots'), value: t('rc.lotsReleased', { released: receipt.summary.lotsReleased, count: receipt.summary.lots }), hint: receipt.summary.lotsInQuarantine > 0 ? t('rc.summary.waiting', { count: receipt.summary.lotsInQuarantine }) : undefined },
            ...(receipt.purchaseOrder ? [{ label: t('rc.summary.order'), value: <Link className="fw-by-link" href={`${model.prefix}/purchasing/orders/${receipt.purchaseOrder.id}`}>{`${receipt.purchaseOrder.number} · ${t(`poStatus.${receipt.purchaseOrder.status}`)}`}</Link> }] : []),
            ...(receipt.note ? [{ label: t('rc.summary.note'), value: receipt.note }] : []),
            ...(model.can.cost && receipt.value ? [{ label: t('rc.summary.value'), value: money(receipt.value.valueAmount, receipt.value.currency, locale) }] : []),
          ]}
        />
      </Card>
      {model.notes && model.notes.length > 0 && (
        <Banner tone="info" title={t('rc.result.notes')}>
          <ul className="fw-by-list">
            {model.notes.map((note, index) => (
              <li key={`${note.code}-${index}`}>{t(`rc.note.${note.code}`, { seq: note.seq ?? '—' })}</li>
            ))}
          </ul>
        </Banner>
      )}
      <ListFrame<ReceiptLine> label={t('rc.record.linesLabel')} rows={receipt.lines} rowId={(line) => line.id} columns={columns} count={t('rc.record.linesCount', { count: receipt.lines.length })} />
    </div>
  )
}

/** A lot's quality in words: released, rejected, blocked, or why it waits (its holds: Cr VI test, PPE certificate, the receiver's hold). */
export function lotWords(lot: ReceiptLot, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (lot.qualityStatus === 'RELEASED') return t('rc.lot.released')
  if (lot.qualityStatus === 'REJECTED') return t('rc.lot.rejected')
  if (lot.qualityStatus === 'BLOCKED') return t('rc.lot.blocked')
  const why = lot.holds.map((hold) => (hold === 'CR_VI_TEST' ? (lot.crViStatus === 'FAIL' ? t('rc.hold.crViFailed') : t('rc.hold.CR_VI_TEST_LIMIT', { limit: lot.crViLimitMgKg ?? '3.000' })) : t(`rc.hold.${hold}`)))
  return t('rc.lot.quarantine', { why: why.length > 0 ? why.join('; ') : t('rc.hold.quality') })
}

function LotsTab({ receipt, model, actions }: { receipt: Receipt; model: ReceiptRecordModel; actions?: ReceiptRecordActions }) {
  const t = useT('buying')
  if (!model.lots.value) {
    return model.lots.problem ? (
      <Card padded>
        <EmptyState title={t('common.partFailed', { part: t('rc.tab.lots') })} description={t(model.lots.problem)} action={<Button size="sm" onClick={() => actions?.onRetryLots?.()}>{t('common.retry')}</Button>} />
      </Card>
    ) : (
      <Card padded aria-busy="true">
        <p className="fw-by-hint" role="status">
          <Spinner size={14} /> {t('common.partLoading', { part: t('rc.tab.lots') })}
        </p>
      </Card>
    )
  }
  if (model.lots.value.length === 0) {
    return (
      <Card padded>
        <EmptyState title={t('rc.lots.none')} description={t('rc.lots.noneBody')} />
      </Card>
    )
  }
  return (
    <div className="fw-by-stack">
      {model.lots.value.map((lot) => (
        <LotCard key={lot.id} lot={lot} receipt={receipt} model={model} actions={actions} />
      ))}
    </div>
  )
}

function LotCard({ lot, receipt, model, actions }: { lot: LotWithHides; receipt: Receipt; model: ReceiptRecordModel; actions?: ReceiptRecordActions }) {
  const t = useT('buying')
  const locale = useLocale()
  const line = receipt.lines.find((entry) => entry.seq === lot.lineSeq) ?? null
  const unit = line ? t(`uom.${line.item.baseUom}`) : ''
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const picked = lot.hides.filter((hide) => selected.includes(hide.id))
  const columns = useMemo<ColDef<ReceiptHide>[]>(() => {
    const AreaCell = ({ data }: ICellRendererParams<ReceiptHide>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-num">
            {quantity(data.area, locale)} {t(`uom.${data.areaUom}`)}
          </span>
          <span className="fw-by-cell-sub">{data.areaUom !== line?.item.baseUom ? `${quantity(data.baseArea, locale)} ${unit}` : ''}</span>
        </span>
      ) : null
    const StateCell = ({ data }: ICellRendererParams<ReceiptHide>) => (data ? <Tag tone={data.state === 'FULL' ? 'success' : data.state === 'CONSUMED' || data.state === 'SCRAPPED' ? 'neutral' : 'info'}>{t(`rc.hideState.${data.state}`)}</Tag> : null)
    const OnHandCell = ({ data }: ICellRendererParams<ReceiptHide>) => (data ? <span className="fw-by-num">{`${quantity(data.onHand, locale)} ${unit}`}</span> : null)
    return [
      { colId: 'code', headerName: t('rc.hide.tag'), field: 'code', minWidth: 170, flex: 1.1, cellClass: 'fw-by-code' },
      { colId: 'tannery', headerName: t('rc.sheet.tannery'), field: 'supplierCode', minWidth: 160, flex: 0.9, valueFormatter: (params) => params.value ?? '—' },
      { colId: 'area', headerName: t('rc.sheet.area'), minWidth: 120, flex: 0.8, cellRenderer: AreaCell },
      { colId: 'grade', headerName: t('rc.sheet.grade'), field: 'grade', minWidth: 80, flex: 0.5, valueFormatter: (params) => params.value ?? '—' },
      { colId: 'thickness', headerName: t('rc.sheet.thickness'), field: 'thicknessMm', minWidth: 130, flex: 0.6, valueFormatter: (params) => (params.value ? `${params.value} mm` : '—') },
      { colId: 'shade', headerName: t('rc.sheet.shade'), field: 'shade', minWidth: 90, flex: 0.6, valueFormatter: (params) => params.value ?? '—' },
      { colId: 'defects', headerName: t('rc.sheet.defects'), field: 'defects', minWidth: 160, flex: 1.2, tooltipField: 'defects', valueFormatter: (params) => params.value ?? '—' },
      { colId: 'state', headerName: t('rc.hide.state'), minWidth: 110, flex: 0.7, cellRenderer: StateCell },
      { colId: 'onHand', headerName: t('rc.hide.onHand'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: OnHandCell },
    ]
  }, [t, locale, line, unit])

  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">
            {/* Warehouse › Lots & traceability (SCR-201): the lot's stock, trace and moves; its release links on from there. */}
            <Link className="fw-by-link" href={`${model.prefix}/warehouse/lots/${encodeURIComponent(lot.id)}`}>
              {lot.code}
            </Link>
            <span className="fw-by-title-sub">{line ? `· ${line.item.code} ${line.item.name}${line.colour ? ` · ${line.colour.name}` : ''}` : ''}</span>
          </h3>
          <span className="fw-by-meta">
            <Pill tone={LOT_TONE[lot.qualityStatus]}>{t(`lotStatus.${lot.qualityStatus}`)}</Pill>
            {lot.requiresCrViTest && <Pill tone={CR_VI_TONE[lot.crViStatus]}>{t(`crVi.${lot.crViStatus}`)}</Pill>}
          </span>
        </div>
        <p className="fw-by-text">
          {lot.qualityStatus === 'RELEASED' ? <CheckCircle2 size={14} className="fw-by-ico is-ok" aria-hidden /> : lot.qualityStatus === 'QUARANTINE' ? <AlertTriangle size={14} className="fw-by-ico is-warning" aria-hidden /> : <XCircle size={14} className="fw-by-ico is-blocked" aria-hidden />} {lotWords(lot, t)}
        </p>
        <KeyValue
          dense
          columns={3}
          labelCase="sentence"
          items={[
            { label: t('rc.receive.supplierLot'), value: lot.supplierLotRef ?? '—' },
            { label: t('rc.receive.dyeBatch'), value: lot.dyeBatch ?? '—' },
            { label: t('rc.receive.shade'), value: lot.shade ?? '—' },
            { label: t('rc.lots.received'), value: `${quantity(lot.baseQuantity, locale)} ${unit}${lot.hideCount > 0 ? ` · ${t('rc.hides', { count: lot.hideCount })}` : ''}` },
            { label: t('rc.lots.onHand'), value: `${quantity(lot.onHand, locale)} ${unit}` },
            { label: t('rc.lots.receivedAt'), value: lot.receivedAt ? formatDateTime(lot.receivedAt, { locale, timeZone: model.timeZone }) : '—' },
          ]}
        />
        {lot.qualityStatus === 'QUARANTINE' && <p className="fw-by-hint">{t('rc.lots.releaseWhere')}</p>}
        {lot.hides.length > 0 && (
          <ListFrame<ReceiptHide>
            label={t('rc.lots.hidesLabel', { lot: lot.code })}
            rows={lot.hides}
            rowId={(hide) => hide.id}
            columns={columns}
            rowKind="text"
            count={t('rc.sheet.sumBase', { count: lot.hides.length, area: quantity(lot.baseQuantity, locale), unit })}
            selection={{
              selected,
              onChange: setSelected,
              actions: (
                <Button size="sm" aria-label={t('rc.bulk.exportHides', { count: picked.length })} onClick={() => actions?.onExportHides?.(picked.map((hide) => hide.id))}>
                  <Download size={13} aria-hidden /> <SelectionLabel>{t('rc.bulk.exportHides', { count: picked.length })}</SelectionLabel>
                </Button>
              ),
            }}
          />
        )}
      </div>
    </Card>
  )
}

function ReverseDialog({ receipt, model, actions }: { receipt: Receipt; model: ReceiptRecordModel; actions?: ReceiptRecordActions }) {
  const t = useT('buying')
  const dialog = model.dialog!
  const blockers = receipt.reversal?.blockers ?? []
  const lots = receipt.lines.flatMap((line) => line.lots.map((lot) => lot.code))
  const location = receipt.reversal?.location ?? receipt.location?.code ?? '—'
  const held = model.busy ? t('held.busy') : blockers.length > 0 ? t('rc.reverse.used') : dialog.reason.trim().length < 3 ? t('rc.reverse.reasonNeeded') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('rc.reverse.title', { number: receipt.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" tone="danger" heldReason={held} onClick={() => actions?.onReverse?.()}>
            {model.busy && <Spinner size={12} />} {t('rc.reverse.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        {blockers.length > 0 ? (
          <>
            <Banner tone="danger" title={t('rc.reverse.usedTitle')} />
            <ul className="fw-by-checks">
              {blockers.map((blocker, index) => (
                <li key={`${blocker.code}-${index}`} className="fw-by-check">
                  <XCircle size={16} className="fw-by-ico is-blocked" aria-hidden />
                  <span className="fw-by-check-body">
                    {t(`rc.blocker.${blocker.code}`, { what: blocker.items.map((item) => `${t(`rc.blocker.kind.${item.kind}`)} ${item.code}`).join(', '), where: blocker.code === 'LEFT_STOCK' || blocker.code === 'ADDED' ? t(`rc.moveReason.${moveReasonKey(blocker.where)}`) : blocker.where, location, count: blocker.items.length })}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <ul className="fw-by-list">
            <li>{t('rc.reverse.moves', { count: reversalMoves(receipt) })}</li>
            {lots.length > 0 && <li>{t('rc.reverse.lots', { lots: lots.join(', '), count: lots.length })}</li>}
            {receipt.purchaseOrder && <li>{t('rc.reverse.order', { number: receipt.purchaseOrder.number })}</li>}
            <li>{t('rc.reverse.kept')}</li>
          </ul>
        )}
        {blockers.length === 0 && (
          <Field label={t('rc.reverse.reason')} required hint={t('rc.reverse.reasonHint')}>
            <Textarea rows={3} maxLength={500} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ kind: 'reverse', reason: event.target.value })} autoFocus />
          </Field>
        )}
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem.key, model.dialogProblem.params)} />}
      </div>
    </Modal>
  )
}

/** A stock move's reason (factory-db StockMoveReason) as one of this app's words, else "other". */
function moveReasonKey(reason: string): string {
  const known = ['SCRAP', 'ADJUSTMENT', 'COUNT', 'ISSUE', 'RETURN', 'TRANSFER', 'RECEIPT', 'OPENING']
  return known.includes(reason.toUpperCase()) ? reason.toUpperCase() : 'OTHER'
}
