'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, Layers, MoreHorizontal } from 'lucide-react'
import { CellAction, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { formatDate } from '../../../../lib/i18n/format'
import { usePageKeys } from '../../../_shared/buying/hooks'
import { money, quantity } from '../../../_shared/buying/model'
import type { NeedRow } from '../api'
import { area, draftPoHeld, FEASIBILITY_FILTERS, feasibilityTone, gradeMixWords, lotWords, pct, sizesWords, visibleNeed, type FeasibilityFilter, type Words } from '../model'
import type { LeatherActions, LeatherModel } from '../view-model'

const focusedRowId = (): string | null => (typeof document === 'undefined' ? null : ((document.activeElement as HTMLElement | null)?.closest('.ag-row')?.getAttribute('row-id') ?? null))

/**
 * Leather need per order (design planning.leather sec:need; PLN-106, PLN-108): per open order line and leather, from the plan
 * run — the sizes, the area with the loss (the loss links to the style's BOM), what is left to find with about how many
 * hides, the grade mix of the free hides, the best single-shade lot and whether one shade covers the order (the pill opens
 * the drawer; Enter too). b drafts the PO of a Must buy line (What to buy & make's one-click). Ticked rows: Export N.
 * The value of what is left to find only with the cost grain (the column is not drawn otherwise).
 */
export function NeedSection({ model, actions, words }: { model: LeatherModel; actions?: LeatherActions; words: Words }) {
  const { t, locale } = words
  const need = model.need.status === 'ready' ? model.need.value : null
  const rows = useMemo(() => (need ? visibleNeed(need.rows, model.controls) : null), [need, model.controls])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const quiet = model.dialog !== null || model.controls.open !== null

  usePageKeys((event) => {
    if (quiet || event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== 'b') return
    const row = (rows ?? []).find((entry) => entry.id === focusedRowId())
    if (!row || draftPoHeld(row, model.can)) return
    event.preventDefault()
    actions?.onDraftPo?.(row.id)
  })

  const keys: ListKey[] = [
    { keys: ['Enter'], does: t('keys.open') },
    { keys: ['b'], does: t('keys.draftPo') },
  ]
  const unitOf = (row: NeedRow) => row.item.baseUom

  const OrderCell = ({ data }: ICellRendererParams<NeedRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span className="fw-lp-ellipsis">
          {data.order.number} · {t('row.line', { seq: data.orderLine.seq })}
        </span>
        <span className="fw-lp-sub">{data.orderLine.dueDate ? t('row.due', { date: formatDate(data.orderLine.dueDate, { locale, timeZone: model.timeZone }) }) : t('row.noDue')}</span>
      </span>
    ) : null
  const StyleCell = ({ data }: ICellRendererParams<NeedRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span className="fw-lp-ellipsis">
          {data.style.code} · {data.colourway?.name ?? '—'}
        </span>
        <span className="fw-lp-sub fw-lp-ellipsis">{sizesWords(data, words)}</span>
      </span>
    ) : null
  const LeatherCell = ({ data }: ICellRendererParams<NeedRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span className="fw-lp-ellipsis">
          {data.item.code}
          {data.colour ? ` · ${data.colour.name}` : ''}
        </span>
        <span className="fw-lp-sub fw-lp-ellipsis">{data.item.thicknessMinMm && data.item.thicknessMaxMm ? t('row.thickness', { min: quantity(data.item.thicknessMinMm, locale), max: quantity(data.item.thicknessMaxMm, locale) }) : data.item.name}</span>
      </span>
    ) : null
  const AreaCell = ({ data }: ICellRendererParams<NeedRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span>{area(data.area, unitOf(data), words)}</span>
        <span className="fw-lp-sub">
          <Link href={`${model.prefix}/products/styles/${data.style.id}?tab=bom`} className="fw-lp-link">
            {data.lossPct === null ? t('row.lossUnknown') : t('row.loss', { loss: pct(data.lossPct, words) })}
          </Link>
        </span>
      </span>
    ) : null
  const FindCell = ({ data }: ICellRendererParams<NeedRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span>
          {area(data.toFind, unitOf(data), words)}
          {data.hides !== null && Number(data.toFind) > 0 ? ` · ${t('row.hides', { count: data.hides })}` : ''}
        </span>
        <span className="fw-lp-sub fw-lp-ellipsis">{t('row.issuedReserved', { issued: area(data.issued, unitOf(data), words), reserved: area(data.reserved, unitOf(data), words) })}</span>
      </span>
    ) : null
  const GradeCell = ({ data }: ICellRendererParams<NeedRow>) => (data ? <span className="fw-lp-ellipsis">{gradeMixWords(data, words)}</span> : null)
  const LotCell = ({ data }: ICellRendererParams<NeedRow>) => (data ? <span className="fw-lp-ellipsis" title={lotWords(data.best, unitOf(data), words)}>{lotWords(data.best, unitOf(data), words)}</span> : null)
  const FeasibilityCell = ({ data }: ICellRendererParams<NeedRow>) =>
    data ? (
      <span className="fw-lp-inline">
        <Pill tone={feasibilityTone(data)}>{t(`feasibility.${data.feasibility}`)}</Pill>
        <CellAction label={t('row.openShade', { order: data.order.number })} description={t('row.openShadeHint')} icon={<Layers size={13} aria-hidden />} onActivate={() => actions?.onOpen?.(data.id)} />
      </span>
    ) : null
  const ValueCell = ({ data }: ICellRendererParams<NeedRow>) => (data ? <span>{money(data.value ?? null, data.currency, locale)}</span> : null)
  const MoreCell = ({ data }: ICellRendererParams<NeedRow>) =>
    data ? (
      <Menu
        label={<MoreHorizontal size={16} aria-hidden />}
        align="right"
        triggerProps={{ 'aria-label': t('row.menu', { order: data.order.number }) }}
        items={[
          { id: 'open', label: t('row.openShadeShort'), onSelect: () => actions?.onOpen?.(data.id) },
          { id: 'draft', label: t('row.draftPo'), onSelect: () => actions?.onDraftPo?.(data.id), disabled: draftPoHeld(data, model.can) !== null },
        ]}
      />
    ) : null

  const columns: ColDef<NeedRow>[] = [
    { colId: 'order', headerName: t('col.order'), minWidth: 170, flex: 1, cellRenderer: OrderCell },
    { colId: 'style', headerName: t('col.style'), minWidth: 190, flex: 1.2, cellRenderer: StyleCell },
    { colId: 'leather', headerName: t('col.leather'), minWidth: 170, flex: 1, cellRenderer: LeatherCell },
    { colId: 'area', headerName: t('col.area'), minWidth: 150, flex: 0.9, cellRenderer: AreaCell },
    { colId: 'find', headerName: t('col.toFind'), minWidth: 190, flex: 1.1, cellRenderer: FindCell },
    { colId: 'grades', headerName: t('col.grades'), minWidth: 140, flex: 0.8, cellRenderer: GradeCell },
    { colId: 'lot', headerName: t('col.bestLot'), minWidth: 200, flex: 1.2, cellRenderer: LotCell },
    { colId: 'feasibility', headerName: t('col.feasibility'), minWidth: 190, flex: 1, cellRenderer: FeasibilityCell },
    ...(model.seesCost ? [{ colId: 'value', headerName: t('col.value'), minWidth: 120, flex: 0.7, cellRenderer: ValueCell } satisfies ColDef<NeedRow>] : []),
    { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
  ]

  let state: ReactNode = undefined
  if (model.need.status === 'error') {
    state = <EmptyState title={t('need.error')} description={t(model.need.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('need')}>{t('common.retry')}</Button>} />
  } else if (need && !need.run) {
    state = <EmptyState title={t('need.noRun.title')} description={t('need.noRun.body')} />
  } else if (rows && rows.length === 0) {
    const filtered = model.controls.q.trim() !== '' || model.controls.feas !== 'all' || model.controls.tile === 'orders' || model.controls.tile === 'shade'
    state = filtered ? (
      <EmptyState
        title={t('empty.noMatch.title')}
        description={t('empty.noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              actions?.onSearch?.('')
              actions?.onFeasibility?.('all')
              actions?.onTile?.(null)
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('need.empty')} description={t('need.emptyBody')} />
    )
  }
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))

  return (
    <>
      <div className="fw-lp-section-head">
        <h2 className="fw-lp-h2" id="fw-lp-need">
          {t('need.title')}
        </h2>
        <p className="fw-lp-hint">{t('need.purpose')}</p>
      </div>
      <ListFrame<NeedRow>
        label={t('need.title')}
        listKey="planning.leather"
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('need.count', { count: rows.length }) : '—'}
        tools={
          <Select size="sm" aria-label={t('feasibility.label')} value={model.controls.feas} onChange={(event) => actions?.onFeasibility?.(event.target.value as FeasibilityFilter)}>
            {FEASIBILITY_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === 'all' ? t('feasibility.all') : t(`feasibility.${value}`)}
              </option>
            ))}
          </Select>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={() => null}
        keys={keys}
        onHelp={() => actions?.onKeys?.()}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
    </>
  )
}
