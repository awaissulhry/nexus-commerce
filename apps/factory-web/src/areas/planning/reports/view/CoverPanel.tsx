'use client'

import { useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { Download, ExternalLink, FilePlus2, MoreHorizontal, Package } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { SelectionLabel } from '@nexus/ui/grid'
import { Button, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { CoverRow, CoverState } from '../api'
import { COVER_WEEKS, coverCsvRows, draftOf, materialHref, purchaseOrderHref, quantityText } from '../model'
import { Head, NAMESPACE, stateOf } from './Parts'
import { coverRowId, type ReportsActions, type ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

const STATE_TONE: Record<CoverState, 'danger' | 'warning' | 'info' | 'success'> = { SHORT_NOW: 'danger', STOCK_OUT: 'warning', BELOW_SAFETY: 'info', COVERED: 'success' }

/**
 * Material cover (design sec cover, PLN-207: "Days of cover per material and projected stock-out dates"; "Material, days of cover,
 * stock-out date, open POs"; interaction "Draft PO"): every material the site's plan needs in the horizon, the soonest to run out
 * first, as the shared list frame — material (its page) and colour, days of cover with its state, the projected stock-out day and
 * the day it falls below the safety stock, on hand against what the orders need and the open purchase lines due, the open POs
 * with the next one due (its page). A row's ⋯ drafts the PO on What to buy & make (held with its reason), opens the material or
 * the next PO; selected rows are written to a CSV file. No money.
 */
export function CoverPanel({ model, actions }: Props) {
  const t = useT(NAMESPACE)
  const stock = useT('stock')
  const locale = useLocale()
  const read = model.cover
  const answer = read.status === 'ready' ? read.value : null
  const rows = useMemo(() => answer?.rows ?? null, [answer])
  const day = (date: string | null) => (date ? formatDate(`${date}T12:00:00Z`, { locale }) : '—')
  const unit = (uom: string) => stock(`uom.${uom}`)
  const selected = model.selected
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => coverRowId(row) === id))) actions?.onSelected?.(selected.filter((id) => rows.some((row) => coverRowId(row) === id)))
  }, [rows, selected, actions])
  const live = useRef({ prefix: model.prefix, can: model.can, siteId: model.site?.id ?? null })
  live.current = { prefix: model.prefix, can: model.can, siteId: model.site?.id ?? null }

  const columns = useMemo<ColDef<CoverRow>[]>(() => {
    const MaterialCell = ({ data }: ICellRendererParams<CoverRow>) =>
      data ? (
        <span className="fw-plr-cell">
          <Link className="fw-plr-link" href={materialHref(live.current.prefix, data.item.id, data.item.code)}>
            {`${data.item.code} · ${data.item.name}`}
          </Link>
          <span className="fw-plr-muted">{[data.colour?.name, t(`cover.action.${data.action}`)].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const CoverCell = ({ data }: ICellRendererParams<CoverRow>) =>
      data ? (
        <span className="fw-plr-cell">
          <span>{data.daysOfCover === null ? t('cover.beyond', { count: answer?.horizon.days ?? 0 }) : t('cover.days', { count: data.daysOfCover })}</span>
          <span>
            <Tag tone={STATE_TONE[data.state]}>{t(`cover.state.${data.state}`)}</Tag>
          </span>
        </span>
      ) : null
    const WhenCell = ({ data }: ICellRendererParams<CoverRow>) =>
      data ? (
        <span className="fw-plr-cell">
          <span>{data.stockOutOn ? t('cover.stockOutOn', { day: day(data.stockOutOn) }) : t('cover.noStockOut')}</span>
          <span className="fw-plr-muted">{data.belowSafetyOn ? t('cover.belowSafetyOn', { day: day(data.belowSafetyOn) }) : data.safetyStock ? t('cover.aboveSafety') : t('cover.noSafety')}</span>
        </span>
      ) : null
    const StockCell = ({ data }: ICellRendererParams<CoverRow>) =>
      data ? (
        <span className="fw-plr-cell">
          <span>{t('cover.onHand', { quantity: quantityText(data.onHand, unit(data.item.baseUom), locale) })}</span>
          <span className="fw-plr-muted">{t('cover.needs', { demand: quantityText(data.demand, unit(data.item.baseUom), locale), receipts: quantityText(data.receipts, unit(data.item.baseUom), locale) })}</span>
        </span>
      ) : null
    const PurchasesCell = ({ data }: ICellRendererParams<CoverRow>) => {
      if (!data) return null
      const next = data.openPurchases.next
      if (data.openPurchases.lines === 0) return <span className="fw-plr-muted">{t('cover.noPurchases')}</span>
      return (
        <span className="fw-plr-cell">
          <span>{t('cover.purchases', { count: data.openPurchases.orders, quantity: quantityText(data.openPurchases.quantity, unit(data.item.baseUom), locale) })}</span>
          {next ? (
            <span className="fw-plr-muted">
              {t('cover.nextDue', { day: day(next.day) })}{' '}
              <Link className="fw-plr-link" href={purchaseOrderHref(live.current.prefix, next.purchaseOrderId, next.number)}>
                {next.number}
              </Link>
            </span>
          ) : null}
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<CoverRow>) => {
      if (!data) return null
      const draft = draftOf(live.current.prefix, live.current.siteId ?? '', data, live.current.can)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('cover.menu', { material: [data.item.code, data.colour?.name].filter(Boolean).join(' ') }) }}
          items={[
            draft.href ? { id: 'draft', label: t('cover.draft'), icon: <FilePlus2 size={14} aria-hidden />, href: draft.href } : { id: 'draft', label: t('cover.draft'), icon: <FilePlus2 size={14} aria-hidden />, disabled: true, description: t(draft.held!) },
            { id: 'material', label: t('cover.openMaterial'), icon: <Package size={14} aria-hidden />, href: materialHref(live.current.prefix, data.item.id, data.item.code) },
            data.openPurchases.next
              ? { id: 'po', label: t('cover.openPo', { number: data.openPurchases.next.number }), icon: <ExternalLink size={14} aria-hidden />, href: purchaseOrderHref(live.current.prefix, data.openPurchases.next.purchaseOrderId, data.openPurchases.next.number) }
              : { id: 'po', label: t('cover.openPoNone'), icon: <ExternalLink size={14} aria-hidden />, disabled: true, description: t('cover.noPurchases') },
          ]}
        />
      )
    }
    return [
      { colId: 'material', headerName: t('cover.col.material'), minWidth: 220, flex: 1.6, valueGetter: (params) => (params.data ? `${params.data.item.code} ${params.data.item.name}` : ''), cellRenderer: MaterialCell },
      { colId: 'cover', headerName: t('cover.col.cover'), minWidth: 150, flex: 0.9, valueGetter: (params) => params.data?.daysOfCover ?? Number.MAX_SAFE_INTEGER, cellRenderer: CoverCell },
      { colId: 'when', headerName: t('cover.col.when'), minWidth: 190, flex: 1.1, valueGetter: (params) => params.data?.stockOutOn ?? '9999', cellRenderer: WhenCell },
      { colId: 'stock', headerName: t('cover.col.stock'), minWidth: 220, flex: 1.3, sortable: false, cellRenderer: StockCell },
      { colId: 'purchases', headerName: t('cover.col.purchases'), minWidth: 190, flex: 1.1, valueGetter: (params) => params.data?.openPurchases.lines ?? 0, cellRenderer: PurchasesCell },
      { colId: 'more', headerName: t('cover.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The words and the day format follow the language; the rows' links and rights read `live`.
  }, [t, stock, locale, answer?.horizon.days])

  const head = (
    <Head id="plr-cover" title={t('section.cover')} hint={answer ? t('cover.hint', { from: day(answer.horizon.from), to: day(answer.horizon.to) }) : t('cover.hintWeeks', { count: model.address.weeks })}>
      <SegmentedControl size="sm" wrap ariaLabel={t('cover.horizon')} value={String(model.address.weeks)} onChange={(value) => actions?.onAddress?.({ weeks: Number(value) })} options={COVER_WEEKS.map((value) => ({ value: String(value), label: t('cover.weeks', { count: value }) }))} />
    </Head>
  )
  const waiting = stateOf(read, t('cover.failed'), () => actions?.onRetry?.('cover'), { chart: false })
  if (waiting || !answer || !rows) {
    return (
      <section className="fw-plr-panel" aria-labelledby="plr-cover">
        {head}
        {waiting}
      </section>
    )
  }
  const chosen = rows.filter((row) => selected.includes(coverRowId(row)))
  const header = [t('cover.csv.code'), t('cover.csv.name'), t('cover.csv.colour'), t('cover.csv.unit'), t('cover.csv.onHand'), t('cover.csv.safety'), t('cover.csv.demand'), t('cover.csv.receipts'), t('cover.csv.days'), t('cover.csv.stockOut'), t('cover.csv.belowSafety'), t('cover.csv.state'), t('cover.csv.orders'), t('cover.csv.onOrder'), t('cover.csv.nextDue')]
  return (
    <section className="fw-plr-panel" aria-labelledby="plr-cover">
      {head}
      <p className="fw-plr-muted">{t('cover.counts', { shortNow: answer.counts.shortNow, stockOut: answer.counts.stockOut, belowSafety: answer.counts.belowSafety, covered: answer.counts.covered })}</p>
      <ListFrame<CoverRow>
        label={t('section.cover')}
        title={t('section.cover')}
        listKey={null}
        rows={rows}
        rowId={coverRowId}
        rowKind="two-line"
        columns={columns}
        count={answer.more > 0 ? t('cover.countAtLeast', { count: rows.length }) : t('cover.count', { count: rows.length })}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.(ids),
          actions: (
            <Button size="sm" variant="primary" onClick={() => actions?.onExport?.('cover', header, coverCsvRows(chosen, { state: (state) => t(`cover.state.${state}`) }))} heldReason={chosen.length === 0 ? t('cover.exportHeld') : null}>
              <Download size={14} aria-hidden />
              <SelectionLabel>{t('cover.exportSelected', { count: chosen.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={() => null}
        state={rows.length === 0 ? <EmptyState title={t('cover.empty')} description={t('cover.emptyHint')} /> : undefined}
      />
      <p className="fw-plr-muted">{[t('cover.definition'), answer.more > 0 ? t('cover.more', { count: answer.more }) : null, model.can.draft ? null : t('draft.heldRight')].filter(Boolean).join(' ')}</p>
    </section>
  )
}
