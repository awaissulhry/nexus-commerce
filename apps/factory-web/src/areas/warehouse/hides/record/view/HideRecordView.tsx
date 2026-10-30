'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Bookmark, MoreHorizontal, Printer, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, type TabItem } from '@nexus/ui/components'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { CutRow, HideRecord } from '../../../../_shared/stock/api'
import { convertArea, decimalValue, lotWaitKey, movesHref, otherAreaUnit, quantity } from '../../../../_shared/stock/model'
import { CrViPill, HideStatePill, QualityPill } from '../../../../_shared/stock/parts'
import { AreaBar, LotsMessages, MovesTable, PartState, RecordFrame, useWords } from '../../../lots/shared/parts'
import { HIDE_TABS, nextStepKey, tagHeldKey, type HideRecordActions, type HideRecordModel, type HideTab } from '../../model'
import { PrintTagsDialog } from '../../print/PrintTagsDialog'
import { holdOfHide, holdReasonWords, reserveSelectionHeld, scrapSelectionHeld } from '../../../lots/shared/daily'
import { demandLabel, demandRecord } from '../../../stock/daily/model'
import { ReserveDialog } from '../../../stock/daily/ReserveDialog'
import { WriteOffDialog } from '../../../stock/daily/WriteOffDialog'

export type { HideRecordActions, HideRecordModel } from '../../model'

/**
 * SCR-200-record — one hide (design warehouse.hides "Record: Hide"): the band (‹ Hides, "Hide <tag> · article colour",
 * its state and its lot's quality, Print tag, ⋯ Open lot / Open in Movements), and the tabs: Overview (what the hide is
 * and where it lies — read only: W1 has no correction of grade, shade or defects —, what happened to its area in one
 * bar with words, the lot's quality, Cr VI and the next step), Cuts (the cut log, append-only: every cut with its work
 * order, area, remnant, pieces, station and device; the worker only where the site records workers) and Moves (the
 * ledger rows that name this hide, with the running balance). Consumed or scrapped: read only, said in a Banner.
 * B-W2a-64 (design hd-side): the next step also says "Held: <the hold's reason>" for a quality hold and "Reserved for
 * <work order>" (a link) for a reservation; Reserve to a work order… and Scrap… from the band, held with the reason.
 */
export function HideRecordView({ model, actions }: { model: HideRecordModel; actions?: HideRecordActions }) {
  return (
    <LotsMessages>
      <HideRecordBody model={model} actions={actions} />
    </LotsMessages>
  )
}

function HideRecordBody({ model, actions }: { model: HideRecordModel; actions?: HideRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const listHref = `${model.prefix}/warehouse/hides`
  const value = model.record.status === 'ready' ? model.record.value : null
  const hide = value?.hide ?? null
  const base = hide ? `${model.prefix}/warehouse/hides/${encodeURIComponent(hide.id)}` : listHref
  const keyHref = hide ? movesHref(model.prefix, { siteId: hide.siteId, itemId: hide.item.id, lotId: hide.lot.id, hideId: hide.id }) : ''
  const lotHref = hide ? `${model.prefix}/warehouse/lots/${encodeURIComponent(hide.lot.id)}` : ''
  const tagHeld = !model.can.printLabels ? t('hd.print.noRight') : hide && tagHeldKey(hide) ? t(tagHeldKey(hide)!) : null
  const reserveHeld = hide ? reserveSelectionHeld([hide], model.daily) ?? (hide.reservedFor ? 'hd.daily.held.reservedAlready' : null) : null
  const scrapHeld = hide ? scrapSelectionHeld([hide], model.daily) : null

  const tabs: TabItem[] = HIDE_TABS.map((tab: HideTab) => ({
    id: tab,
    href: tab === 'overview' ? base : `${base}?tab=${tab}`,
    label: t(`hd.tab.${tab}`),
    count: tab === 'cuts' && value ? value.cuts.length : null,
  }))

  return (
    <RecordFrame
      backHref={listHref}
      backLabel={t('hd.back')}
      loaded={model.record}
      kind="hd"
      onRetry={actions?.onRetry}
      tabs={tabs}
      tab={model.tab}
      tabsLabel={t('hd.record.tabsLabel')}
      title={
        hide ? (
          <span className="fw-wl-title">
            {t('hd.record.title', { code: hide.code })} <span className="fw-wl-title-sub">· {[`${hide.item.code} ${hide.item.name}`, hide.colour?.name].filter(Boolean).join(' · ')}</span>
          </span>
        ) : null
      }
      actions={
        hide ? (
          <span className="fw-st-actions">
            <Button size="sm" heldReason={tagHeld} onClick={() => actions?.print?.onOpen?.([hide.id])}>
              <Printer size={14} aria-hidden /> {t('hd.printTag')}
            </Button>
            <Button size="sm" heldReason={reserveHeld ? t(reserveHeld) : null} onClick={() => actions?.onReserve?.()}>
              <Bookmark size={14} aria-hidden /> {t('hd.daily.reserveOne')}
            </Button>
            <Button size="sm" variant="danger-outline" heldReason={scrapHeld ? t(scrapHeld) : null} onClick={() => actions?.onScrap?.()}>
              <Trash2 size={14} aria-hidden /> {t('hd.daily.scrapOne')}
            </Button>
            <Menu
              label={<MoreHorizontal size={16} aria-label={t('rec.more')} />}
              align="right"
              triggerProps={{ 'aria-label': t('rec.more') }}
              items={[
                { id: 'lot', label: t('hd.openLot', { code: hide.lot.code }), href: lotHref },
                { id: 'moves', label: t('hd.openMoves'), href: keyHref },
                { id: 'copy', label: t('hd.record.copyTag'), onSelect: () => void navigator.clipboard?.writeText(hide.code).catch(() => undefined) },
              ]}
            />
          </span>
        ) : null
      }
      meta={
        hide ? (
          <>
            <HideStatePill state={hide.state} />
            <QualityPill status={hide.lot.qualityStatus} />
            <span className="fw-wl-hint">{hide.receivedAt ? t('hd.record.received', { date: formatDate(hide.receivedAt, place) }) : ''}</span>
          </>
        ) : null
      }
      status={
        <>
          {model.asOf ? `${t('stock:live.updated', { time: formatTime(model.asOf, place) })} · ` : null}
          {t(`stock:live.${model.live}`)}
        </>
      }
    >
      {hide && (hide.state === 'CONSUMED' || hide.state === 'SCRAPPED') && <Banner tone="info" title={t(hide.state === 'CONSUMED' ? 'hd.record.consumed' : 'hd.record.scrapped')}>{t('hd.record.readOnly')}</Banner>}
      {value && (
        <div className="fw-wl-stack">
          {model.tab === 'overview' && <Overview value={value} model={model} lotHref={lotHref} />}
          {model.tab === 'cuts' && <Cuts value={value} model={model} />}
          {model.tab === 'moves' && (
            <PartState value={model.moves} label={t('hd.tab.moves')} onRetry={actions?.onRetryMoves}>
              {(moves) => <MovesTable moves={moves} prefix={model.prefix} label={t('hd.movesLabel', { code: value.hide.code })} keyHref={keyHref} onMore={actions?.onMoreMoves} />}
            </PartState>
          )}
        </div>
      )}
      {model.print && hide && <PrintTagsDialog dialog={model.print} hides={[hide]} actions={actions?.print} />}
      {model.reserve && <ReserveDialog model={model.reserve} actions={actions?.reserve} />}
      {model.writeOff && <WriteOffDialog model={model.writeOff} actions={actions?.writeOff} />}
    </RecordFrame>
  )
}

function Overview({ value, model, lotHref }: { value: HideRecord; model: HideRecordModel; lotHref: string }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const hide = value.hide
  const lot = value.lot
  const unit = (uom: typeof hide.areaUom) => t(`stock:uom.${uom}`)
  const other = otherAreaUnit(hide.areaUom)
  const converted = other ? convertArea(decimalValue(hide.area) ?? 0, hide.areaUom, other) : null
  const wait = lotWaitKey({ qualityStatus: lot.qualityStatus, crVi: { required: lot.crVi.status !== 'NOT_REQUIRED', status: lot.crVi.status } })
  const hold = holdOfHide(model.holds, hide)
  const next = nextStepKey(value, !!hold)
  const reserved = hide.reservedFor
  const reservedHref = reserved ? `${model.prefix}${recordAddress(demandRecord(reserved.demand), OFFICE_PAGES)}` : null
  return (
    <div className="fw-wl-split">
      <div className="fw-wl-stack">
        <Card padded>
          <div className="fw-wl-stack tight">
            <h3 className="fw-wl-h3">{t('hd.facts.title')}</h3>
            <KeyValue
              dense
              columns={3}
              labelCase="sentence"
              items={[
                { label: t('hd.facts.tag'), value: <span className="fw-wl-code">{hide.code}</span> },
                { label: t('hd.facts.tannery'), value: hide.supplierCode ?? '—' },
                { label: t('hd.facts.article'), value: `${hide.item.code} · ${hide.item.name}` },
                { label: t('hd.facts.colour'), value: hide.colour ? `${hide.colour.code} ${hide.colour.name}` : '—' },
                {
                  label: t('hd.facts.lot'),
                  value: (
                    <Link className="fw-st-link" href={lotHref}>
                      {lot.code}
                    </Link>
                  ),
                },
                { label: t('hd.facts.batch'), value: [hide.lot.dyeBatch, hide.shade ?? hide.lot.shade ? t('hd.shade', { shade: hide.shade ?? hide.lot.shade ?? '' }) : null].filter(Boolean).join(' · ') || '—' },
                { label: t('hd.facts.grade'), value: hide.grade ?? '—' },
                { label: t('hd.facts.thickness'), value: hide.thicknessMm ? `${quantity(hide.thicknessMm, locale)} mm` : '—' },
                { label: t('hd.facts.area'), value: `${quantity(hide.area, locale)} ${unit(hide.areaUom)}`, hint: converted !== null && other ? `${quantity(converted, locale)} ${unit(other)}` : undefined },
                { label: t('hd.facts.left'), value: `${quantity(hide.left, locale)} ${unit(hide.item.baseUom)}`, hint: hide.onHand === '0.0000' && hide.left !== '0.0000' ? t('hd.atCutting') : undefined },
                { label: t('hd.facts.place'), value: hide.location ? `${hide.location.code} · ${hide.location.name}` : '—' },
                {
                  label: t('hd.facts.received'),
                  value: lot.receipt ? (
                    <Link className="fw-st-link" href={`${model.prefix}/warehouse/receipts/${encodeURIComponent(lot.receipt.id)}`}>
                      {lot.receipt.number}
                    </Link>
                  ) : (
                    t('lt.opening')
                  ),
                  hint: hide.receivedAt ? formatDateTime(hide.receivedAt, place) : undefined,
                },
              ]}
            />
            <p className="fw-wl-hint">{t('hd.facts.readOnly')}</p>
          </div>
        </Card>
        <Card padded>
          <div className="fw-wl-stack tight">
            <h3 className="fw-wl-h3">{t('hd.area.title')}</h3>
            <AreaBar area={value.area} cuts={value.cuts.filter((cut) => !cut.reversalOfId && !cut.reversedById).length} />
          </div>
        </Card>
        <Card padded>
          <div className="fw-wl-stack tight">
            <h3 className="fw-wl-h3">{t('hd.defects.title')}</h3>
            <p className="fw-wl-text">{hide.defects ?? t('hd.defects.none')}</p>
            <p className="fw-wl-hint">{t('hd.defects.photos')}</p>
          </div>
        </Card>
      </div>
      <Card padded>
        <div className="fw-wl-stack tight">
          <h3 className="fw-wl-h3">{t('hd.side.title')}</h3>
          <span className="fw-wl-chips">
            <QualityPill status={lot.qualityStatus} />
            {lot.crVi.status !== 'NOT_REQUIRED' && <CrViPill status={lot.crVi.status} value={lot.crVi.valueMgKg} limit={lot.crVi.limitMgKg} />}
          </span>
          <p className="fw-wl-text">
            <b>{t(next, { reason: hold ? holdReasonWords(hold, model.holdReasons, locale) : wait ? t(`stock:${wait}`) : '', demand: reserved ? demandLabel(reserved.demand) : '' })}</b>
          </p>
          {hold && <p className="fw-wl-hint">{t('hd.daily.holdSince', { date: formatDate(hold.placedAt, place), what: t(hold.subjectType === 'Hide' ? 'hd.daily.holdOfHide' : 'hd.daily.holdOfLot') })}</p>}
          {reserved && reservedHref && (
            <Link className="fw-st-link" href={reservedHref}>
              {t('hd.daily.openDemand', { demand: demandLabel(reserved.demand) })}
            </Link>
          )}
          {lot.qualityNote && <p className="fw-wl-hint">{t('lt.side.note', { note: lot.qualityNote })}</p>}
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('hd.side.supplier'), value: lot.supplier?.name ?? '—', hint: lot.supplierLotRef ? t('lt.supplierLot', { ref: lot.supplierLotRef }) : undefined },
              { label: t('hd.side.testedOn'), value: lot.crVi.testedOn ? formatDate(`${lot.crVi.testedOn}T12:00:00Z`, place) : '—' },
            ]}
          />
          <Link className="fw-st-link" href={lotHref}>
            {t('hd.side.toLot', { code: lot.code })}
          </Link>
        </div>
      </Card>
    </div>
  )
}

function Cuts({ value, model }: { value: HideRecord; model: HideRecordModel }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const columns = useMemo<ColDef<CutRow>[]>(() => {
    const unit = (uom: CutRow['uom']) => t(`stock:uom.${uom}`)
    const WhenCell = ({ data }: ICellRendererParams<CutRow>) =>
      data ? (
        <span className={data.reversedById ? 'fw-st-cell fw-st-struck' : 'fw-st-cell'}>
          <span className="fw-st-num">{formatDateTime(data.at, place)}</span>
          <span className="fw-st-sub">{data.reversalOfId ? t('hd.cuts.reverses') : data.reversedById ? t('hd.cuts.reversed') : data.deviceTime ? t('hd.cuts.deviceTime', { time: formatTime(data.deviceTime, place) }) : ''}</span>
        </span>
      ) : null
    const OrderCell = ({ data }: ICellRendererParams<CutRow>) =>
      data ? data.workOrder ? (
        <Link className="fw-st-link" href={`${model.prefix}/production/work-orders/${encodeURIComponent(data.workOrder.id)}?tab=cutting`}>
          {data.workOrder.number}
        </Link>
      ) : (
        <span>—</span>
      ) : null
    const AreaCell = ({ data }: ICellRendererParams<CutRow>) => (data ? <span className="fw-st-num">{`${data.reversalOfId ? '−' : ''}${quantity(data.areaUsed, locale)} ${unit(data.uom)}`}</span> : null)
    const RemnantCell = ({ data }: ICellRendererParams<CutRow>) => (data ? <span className="fw-st-num">{data.remnantArea === '0.0000' ? '—' : `${quantity(data.remnantArea, locale)} ${unit(data.uom)}`}</span> : null)
    const WhereCell = ({ data }: ICellRendererParams<CutRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis">{data.station ? `${data.station.code} · ${data.station.name}` : '—'}</span>
          <span className="fw-st-sub">{data.device ? data.device.name : t('hd.cuts.office')}</span>
        </span>
      ) : null
    return [
      { colId: 'when', headerName: t('hd.cuts.col.when'), minWidth: 160, flex: 1, cellRenderer: WhenCell },
      { colId: 'order', headerName: t('hd.cuts.col.order'), minWidth: 130, flex: 0.8, cellRenderer: OrderCell },
      { colId: 'area', headerName: t('hd.cuts.col.area'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: AreaCell },
      { colId: 'remnant', headerName: t('hd.cuts.col.remnant'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: RemnantCell },
      { colId: 'pieces', headerName: t('hd.cuts.col.pieces'), field: 'pieces', minWidth: 90, flex: 0.5, type: 'rightAligned' },
      { colId: 'where', headerName: t('hd.cuts.col.where'), minWidth: 180, flex: 1.1, cellRenderer: WhereCell },
      ...(value.stationOnly ? [] : [{ colId: 'by', headerName: t('hd.cuts.col.by'), field: 'cutBy', minWidth: 140, flex: 0.9, valueFormatter: (params: { value: unknown }) => (params.value as string | null) ?? '—' } satisfies ColDef<CutRow>]),
      { colId: 'note', headerName: t('hd.cuts.col.note'), field: 'note', minWidth: 140, flex: 1, tooltipField: 'note', valueFormatter: (params) => params.value ?? '—' },
    ]
  }, [t, locale, model.prefix, model.timeZone, value.stationOnly])
  const unit = t(`stock:uom.${value.area.uom}`)
  const live = value.cuts.filter((cut) => !cut.reversalOfId && !cut.reversedById).length
  return (
    <div className="fw-wl-stack tight">
      <p className="fw-wl-text">
        {t('hd.cuts.totals', { measured: `${quantity(value.area.measured, locale)} ${unit}`, cut: `${quantity(value.area.cut, locale)} ${unit}`, count: live, remnant: `${quantity(value.area.remnant, locale)} ${unit}` })}
      </p>
      <p className="fw-wl-hint">{value.stationOnly ? t('hd.cuts.stationOnly') : t('hd.cuts.workerNamed')}</p>
      <ListFrame<CutRow>
        label={t('hd.cuts.label', { code: value.hide.code })}
        rows={value.cuts}
        rowId={(row) => row.id}
        columns={columns}
        count={t('hd.cuts.count', { count: value.cuts.length })}
        state={value.cuts.length === 0 ? <EmptyState title={t('hd.cuts.none')} description={t('hd.cuts.noneBody')} /> : undefined}
      />
    </div>
  )
}
