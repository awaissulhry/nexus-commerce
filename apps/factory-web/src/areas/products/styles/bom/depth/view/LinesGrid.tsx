'use client'

import { useMemo, useRef } from 'react'
import Link from 'next/link'
import { CornerDownRight, FolderTree, Layers, MoreHorizontal, Truck } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../../list-frame/model'
import type { BomLineInput, BomView } from '../../../api'
import { decimalText, stepLabel } from '../../../model'
import type { StyleRecordActions } from '../../../record/record-model'
import { moveSeq } from '../../bom-model'
import { depthHeld, lineName, lineRows, ready, type BomDepthActions, type BomDepthModel, type LineRow } from '../model'

/**
 * The Lines view of the Materials (BOM) tab on the shared list frame (B-W2b-241; design style.bom.lines with W2b's Section
 * column and group rows, Alternates, Customer-supplied and Option): every line of the revision in its grouped order — a line
 * grouped under another sits one step in under its group row — with its section (its own, or its material kind's), its
 * material (a link to the material; a sub-assembly says which revision it takes), W1's quantity at the base size, wastage,
 * gross, what it varies by and the operation that uses it, then its alternates, who sends it (and whether it goes to the
 * workshop) and the option it is only for. Enter opens the line in depth; ⋯ also edits W1's fields, moves and removes it;
 * Alt+↑ / Alt+↓ move the focused line. With rows selected: Section… N, Group… N, Supply… N (held with why). A frozen
 * revision draws the same rows read only.
 */
export function LinesGrid({ bom, model, actions, recordActions, prefix }: { bom: BomView; model: BomDepthModel; actions?: BomDepthActions; recordActions?: StyleRecordActions; prefix: string }) {
  const t = useT('products-bom-depth')
  const tp = useT('products')
  const locale = useLocale()
  const structure = ready(model.structure)
  const depth = ready(model.depth)
  const options = ready(model.options)
  const rows = useMemo(() => lineRows(bom, structure, depth, options, locale), [bom, structure, depth, options, locale])
  const held = depthHeld(structure, model.canManage, model.offline, model.busy)
  // A row's box: held only on a revision that is not a draft (AG reads it when the row is made; the actions say the rest).
  const selectHeld = bom.revision.status !== 'DRAFT' || bom.style.status === 'ARCHIVED' ? t('hold.frozen') : null
  // W1's line writes (edit, move, remove) keep W1's rule: a draft and the right; offline they are held too.
  const lineHeld = !model.canManage ? 'hold.noManage' : bom.revision.status !== 'DRAFT' || bom.style.status === 'ARCHIVED' ? 'hold.frozen' : model.offline ? 'hold.offline' : null
  const base = bom.style.baseSize
  const latest = useRef({ actions, recordActions, held, lineHeld, rows, lines: bom.lines })
  latest.current = { actions, recordActions, held, lineHeld, rows, lines: bom.lines }

  const move = (row: LineRow, delta: -1 | 1) => {
    const seq = moveSeq(latest.current.lines, row.id, delta)
    if (seq !== null) void latest.current.recordActions?.onEditLine?.(row.id, { seq } as BomLineInput)
  }
  const moveRef = useRef(move)
  moveRef.current = move

  const columns = useMemo<ColDef<LineRow>[]>(() => {
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    // Each column's value says everything its cell shows: AG redraws a cell only when its value changes (the columns stay
    // the same, so an open ⋯ menu is never closed by a live read), and the phone cards read the same words.
    const materialSub = (row: LineRow) =>
      row.structure?.subAssembly
        ? t('lines.sub', { code: row.structure.subAssembly.style.code, revision: row.structure.subAssembly.revision.revision, status: t(`revisionStatus.${row.structure.subAssembly.revision.status}`) })
        : row.structure && row.structure.groupedLineIds.length > 0
          ? t('lines.group', { count: row.structure.groupedLineIds.length })
          : tp(`kind.${row.line.item.kind}`)
    const atBaseOf = (row: LineRow) => row.line.bySize.find((entry) => entry.size === base) ?? row.line.bySize[0]
    const qtyText = (row: LineRow) => `${decimalText(atBaseOf(row)?.qty ?? row.line.qty, locale)} ${tp(`uom.${row.line.uom}`)}`
    const wastageText = (row: LineRow) => t('lines.wastage', { pct: decimalText(row.line.wastagePct, locale), gross: atBaseOf(row)?.gross ? decimalText(atBaseOf(row)!.gross, locale) : tp('bom.missing') })
    const supplyText = (row: LineRow) =>
      row.depth ? (row.depth.customerSupplied ? t('supply.sentBy', { name: row.depth.customerSupplied.name }) : row.depth.subAssembly ? t('supply.weMake') : t('supply.weBuy')) : ''
    const supplySub = (row: LineRow) =>
      row.depth?.issueToSubcontract ? t(row.depth.kit === 'CUT' ? 'supply.workshopCut' : 'supply.workshop') : row.depth?.supplier ? t('supply.from', { name: row.depth.supplier.name }) : ''
    const MaterialCell = ({ data }: ICellRendererParams<LineRow>) => {
      if (!data) return null
      return (
        <span className="fw-bmd-indent" style={{ ['--fw-bmd-level' as string]: data.level }}>
          {data.level > 0 && <CornerDownRight size={13} aria-label={t('lines.groupedUnder')} />}
          <span className="fw-bmd-cell">
            <span>
              <Link className="fw-bmd-link" href={`${prefix}/products/materials/${data.line.item.id}`}>
                <b>{data.line.item.code}</b>
              </Link>{' '}
              {data.line.item.name}
            </span>
            <span className="fw-bmd-sub">{materialSub(data)}</span>
          </span>
        </span>
      )
    }
    const SectionCell = ({ data }: ICellRendererParams<LineRow>) => {
      const own = data?.structure
      if (!own) return <span className="fw-bmd-sub">—</span>
      return (
        <span className="fw-bmd-cell">
          <span>{t(`section.${own.section}`)}</span>
          {!own.filed && <span className="fw-bmd-sub">{t('lines.fromKind')}</span>}
        </span>
      )
    }
    const QtyCell = ({ data }: ICellRendererParams<LineRow>) =>
      data ? (
        <span className="fw-bmd-cell fw-bmd-num">
          <span>{qtyText(data)}</span>
          <span className="fw-bmd-sub">{wastageText(data)}</span>
        </span>
      ) : null
    const DependsCell = ({ data }: ICellRendererParams<LineRow>) => {
      if (!data) return null
      const line = data.line
      if (!line.sizeDependent && !line.colourDependent && !line.itemColour && !line.colourway) return <span className="fw-bmd-sub">{t('lines.same')}</span>
      return (
        <span className="fw-bmd-inline">
          {line.sizeDependent && <Tag tone="info">{tp('bom.bySize')}</Tag>}
          {line.colourDependent ? <Tag tone="info">{tp('bom.byColour')}</Tag> : line.itemColour ? <Tag tone="neutral">{line.itemColour.code}</Tag> : null}
          {line.colourway && <Tag tone="warning">{tp('bom.onlyIn', { code: line.colourway.code })}</Tag>}
        </span>
      )
    }
    const OperationCell = ({ data }: ICellRendererParams<LineRow>) =>
      data?.line.routingStep ? (
        <span className="fw-bmd-cell">
          <span>{tp('bom.operationAt', { step: stepLabel(data.line.routingStep) })}</span>
          <span className="fw-bmd-sub">{data.line.routingStep.name}</span>
        </span>
      ) : (
        <span className="fw-bmd-sub">{tp('bom.noOperation')}</span>
      )
    const AlternatesCell = ({ data }: ICellRendererParams<LineRow>) => {
      const own = data?.depth
      if (!own) return <span className="fw-bmd-sub">{data?.structure ? t('alt.count', { count: data.structure.alternates }) : '—'}</span>
      if (own.alternates.length === 0) return <span className="fw-bmd-sub">{t('alt.none')}</span>
      const first = own.alternates[0]!
      return (
        <span className="fw-bmd-cell">
          <span>
            {t('alt.count', { count: own.alternates.length })} · <b>{first.item.code}</b>
          </span>
          <span className="fw-bmd-sub">{t(`alt.use.${first.allowedWhen}`)}</span>
        </span>
      )
    }
    const SupplyCell = ({ data }: ICellRendererParams<LineRow>) => {
      const own = data?.depth
      if (!own) return <span className="fw-bmd-sub">—</span>
      return (
        <span className="fw-bmd-cell">
          <span>{supplyText(data!)}</span>
          {supplySub(data!) && <span className="fw-bmd-sub">{supplySub(data!)}</span>}
        </span>
      )
    }
    const OptionCell = ({ data }: ICellRendererParams<LineRow>) => (data?.option ? <Tag tone="info">{data.option.label}</Tag> : <span className="fw-bmd-sub">{data?.structure ? t('option.every') : '—'}</span>)
    const MoreCell = ({ data }: ICellRendererParams<LineRow>) => {
      if (!data) return null
      const now = latest.current
      const fresh = now.rows.find((row) => row.id === data.id) ?? data
      const lineWhy = now.lineHeld ? t(now.lineHeld) : undefined
      const sorted = [...now.lines].sort((a, b) => a.seq - b.seq)
      const at = sorted.findIndex((line) => line.id === data.id)
      const items: MenuItemDef[] = [
        { id: 'open', label: t('menu.open'), onSelect: () => now.actions?.onDialog?.({ kind: 'line', lineId: data.id, part: 'structure' }) },
        { id: 'alternates', label: t('menu.alternates', { count: fresh.depth?.alternates.length ?? fresh.structure?.alternates ?? 0 }), onSelect: () => now.actions?.onDialog?.({ kind: 'line', lineId: data.id, part: 'alternates' }) },
        { id: 'edit', label: tp('bom.editOne', { line: data.seq }), disabled: !!lineWhy, description: lineWhy, onSelect: () => now.recordActions?.onDialog?.({ kind: 'bomLine', lineId: data.id }) },
        { id: 'up', label: tp('bom.moveUp', { line: data.seq }), disabled: !!lineWhy || at <= 0, description: lineWhy ?? (at <= 0 ? tp('bom.held.first') : undefined), onSelect: () => moveRef.current(data, -1) },
        { id: 'down', label: tp('bom.moveDown', { line: data.seq }), disabled: !!lineWhy || at === sorted.length - 1, description: lineWhy ?? (at === sorted.length - 1 ? tp('bom.held.last') : undefined), onSelect: () => moveRef.current(data, 1) },
        {
          id: 'remove',
          label: tp('bom.removeOne', { line: data.seq }),
          tone: 'danger',
          disabled: !!lineWhy || (fresh.structure?.groupedLineIds.length ?? 0) > 0,
          description: lineWhy ?? ((fresh.structure?.groupedLineIds.length ?? 0) > 0 ? t('lines.removeGroupHeld') : undefined),
          onSelect: () => now.recordActions?.onDialog?.({ kind: 'removeLine', lineId: data.id }),
        },
      ]
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} items={items} align="right" triggerProps={{ 'aria-label': t('menu.more', { line: lineName(data.line) }) }} />
    }
    return [
      { colId: 'seq', headerName: tp('bom.col.seq'), width: 76, minWidth: 64, valueGetter: (params) => params.data?.seq ?? '', cellClass: 'fw-bmd-num', ...plain },
      { colId: 'material', headerName: tp('bom.col.material'), minWidth: 240, flex: 2, cellRenderer: MaterialCell, valueGetter: (params) => (params.data ? `${'↳ '.repeat(params.data.level)}${params.data.line.item.code} ${params.data.line.item.name} · ${materialSub(params.data)}` : ''), ...plain },
      { colId: 'section', headerName: t('col.section'), minWidth: 130, flex: 0.9, cellRenderer: SectionCell, valueGetter: (params) => (params.data?.structure ? `${t(`section.${params.data.structure.section}`)}${params.data.structure.filed ? '' : ` · ${t('lines.fromKind')}`}` : ''), ...plain },
      { colId: 'placement', headerName: tp('bom.col.placement'), minWidth: 130, flex: 1, valueGetter: (params) => params.data?.line.placement ?? '—', ...plain },
      { colId: 'qty', headerName: tp('bom.col.qty', { size: base ?? '—' }), minWidth: 150, flex: 1, cellRenderer: QtyCell, valueGetter: (params) => (params.data ? `${qtyText(params.data)} · ${wastageText(params.data)}` : ''), ...plain },
      {
        colId: 'depends',
        headerName: tp('bom.col.depends'),
        minWidth: 140,
        flex: 1,
        cellRenderer: DependsCell,
        valueGetter: (params) => {
          const line = params.data?.line
          if (!line) return ''
          const parts = [line.sizeDependent ? tp('bom.bySize') : '', line.colourDependent ? tp('bom.byColour') : (line.itemColour?.code ?? ''), line.colourway ? tp('bom.onlyIn', { code: line.colourway.code }) : ''].filter(Boolean)
          return parts.length > 0 ? parts.join(', ') : t('lines.same')
        },
        ...plain,
      },
      { colId: 'operation', headerName: tp('bom.col.operation'), minWidth: 150, flex: 1, cellRenderer: OperationCell, valueGetter: (params) => (params.data?.line.routingStep ? `${tp('bom.operationAt', { step: stepLabel(params.data.line.routingStep) })} · ${params.data.line.routingStep.name}` : tp('bom.noOperation')), ...plain },
      {
        colId: 'alternates',
        headerName: t('col.alternates'),
        minWidth: 150,
        flex: 1,
        cellRenderer: AlternatesCell,
        valueGetter: (params) => {
          const row = params.data
          if (!row?.depth) return row?.structure ? t('alt.count', { count: row.structure.alternates }) : ''
          const first = row.depth.alternates[0]
          return first ? `${t('alt.count', { count: row.depth.alternates.length })} · ${first.item.code} · ${t(`alt.use.${first.allowedWhen}`)}` : t('alt.none')
        },
        ...plain,
      },
      { colId: 'supply', headerName: t('col.supply'), minWidth: 160, flex: 1.1, cellRenderer: SupplyCell, valueGetter: (params) => (params.data ? [supplyText(params.data), supplySub(params.data)].filter(Boolean).join(' · ') : ''), ...plain },
      { colId: 'option', headerName: t('col.option'), minWidth: 150, flex: 1, cellRenderer: OptionCell, valueGetter: (params) => params.data?.option?.label ?? (params.data?.structure ? t('option.every') : ''), ...plain },
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', suppressMovable: true, cellRenderer: MoreCell, ...plain },
    ]
  }, [t, tp, locale, base, prefix])

  const picked = rows.filter((row) => model.selected.includes(row.id))
  const bulkHeld = held ? t(held) : null
  const keys: ListKey[] = [
    { keys: ['↵'], does: t('keyHint.open') },
    { keys: ['n'], does: t('keyHint.add') },
    { keys: ['v'], does: t('keyHint.views') },
    { keys: ['⌥', '↑'], does: t('keyHint.move') },
  ]
  const sections = structure?.sections.length ?? 0

  return (
    <div
      className="fw-bmd-grid-box"
      onKeyDown={(event) => {
        // Alt+↑ / Alt+↓ move the focused line (W1's keys, kept on the grid).
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || lineHeld) return
        const id = (event.target as HTMLElement).closest<HTMLElement>('[row-id]')?.getAttribute('row-id')
        const row = rows.find((entry) => entry.id === id)
        if (!row) return
        event.preventDefault()
        event.stopPropagation()
        move(row, event.key === 'ArrowUp' ? -1 : 1)
      }}
    >
      <ListFrame<LineRow>
        label={t('lines.table')}
        listKey={null}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={sections > 0 ? t('lines.countSections', { count: rows.length, sections }) : t('lines.count', { count: rows.length })}
        isRowSelectable={() => selectHeld}
        selection={
          model.canManage
            ? {
                selected: model.selected,
                onChange: (ids) => actions?.onSelect?.(ids),
                actions: (
                  <>
                    <Button size="sm" aria-label={t('bulk.section', { count: picked.length })} heldReason={bulkHeld} onClick={() => actions?.onDialog?.({ kind: 'section', lineIds: picked.map((row) => row.id) })}>
                      <Layers size={13} aria-hidden /> <SelectionLabel>{t('bulk.section', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" aria-label={t('bulk.group', { count: picked.length })} heldReason={bulkHeld} onClick={() => actions?.onDialog?.({ kind: 'group', lineIds: picked.map((row) => row.id) })}>
                      <FolderTree size={13} aria-hidden /> <SelectionLabel>{t('bulk.group', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" aria-label={t('bulk.supply', { count: picked.length })} heldReason={bulkHeld ?? (model.depth.status !== 'ready' ? t('hold.loading') : null)} onClick={() => actions?.onDialog?.({ kind: 'supply', lineIds: picked.map((row) => row.id) })}>
                      <Truck size={13} aria-hidden /> <SelectionLabel>{t('bulk.supply', { count: picked.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              }
            : undefined
        }
        keys={keys}
        onOpen={(row) => actions?.onDialog?.({ kind: 'line', lineId: row.id, part: 'structure' })}
      />
    </div>
  )
}
