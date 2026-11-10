'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Wand2 } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { NexusGrid, SHEET_GRID_OPTIONS, type ColDef, type ColGroupDef, type GridApi, type ICellRendererParams } from '@nexus/ui/grid'
import { sizeColumnGroup, type SizeValue } from '@nexus/ui/grid/size-columns/index'
import { Button } from '@nexus/ui/primitives'
import { CellSaveMark, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { BomLine, BomView } from '../../../api'
import { sizeCells } from '../../bom-model'
import { markKey, sizeQty, type CellMark } from '../model'

interface SizeRow {
  id: string
  kind: 'line' | 'total'
  line: BomLine | null
  label: string
  sub: string
  values: Record<string, SizeValue>
}

/**
 * The By size view on the DS SizeColumns (B-W2b-241, moved off W1's own inputs as B-W2b-207 asked; design style.bom.bysize:
 * "Type, paste, or 'Fill from base by increment' (per size step)", "A missing size reads '— missing' in an error tone, not
 * 0", the base size marked, "Totals per size for leather area"): one row per size-dependent line, one column per size of the
 * range; a cell saves by itself on a draft (W1's PUT …/lines/:lineId/sizes, one size), a pasted row lands across the sizes,
 * a word is refused in the DS words and the stored value stays; typed offline it waits on this page ("…") and is sent when
 * the browser is back. "Fill…" on a row opens Fill from base by increment. The leather lines' total per size (with wastage)
 * sits under them, unknown while a line lacks the size. A frozen revision draws the same cells as text.
 */
export function SizesGrid({
  bom,
  editable,
  heldWhy,
  marks,
  offline,
  focus,
  onCell,
  onFill,
  onFocused,
}: {
  bom: BomView
  editable: boolean
  heldWhy: string | null
  marks: Record<string, CellMark>
  offline: boolean
  focus?: { lineId: string; size: string } | null
  onCell: (lineId: string, size: string, value: string | null) => void
  onFill: (lineId: string) => void
  onFocused?: () => void
}) {
  const t = useT('products-bom-depth')
  const tp = useT('products')
  const locale = useLocale()
  const ds = useDsWords()
  const [refused, setRefused] = useState<string | null>(null)
  const apiRef = useRef<GridApi<SizeRow> | null>(null)
  const sizes = bom.sizes.map((size) => size.code)
  const lines = bom.lines.filter((line) => line.sizeDependent)
  const leather = lines.filter((line) => line.item.kind === 'LEATHER')
  const rows = useMemo<SizeRow[]>(
    () =>
      lines.map((line) => ({
        id: line.id,
        kind: 'line',
        line,
        label: `${line.seq} · ${line.item.code}`,
        sub: `${line.placement ?? line.item.name} · ${tp(`uom.${line.uom}`)}`,
        values: Object.fromEntries(sizes.map((size) => [size, sizeQty(line, size)])),
      })),
    [lines, sizes.join(','), tp],
  )
  const total = useMemo<SizeRow | null>(() => {
    if (leather.length === 0) return null
    // Each leather line's quantity with wastage per size (W1's gross): a size any line lacks has no total.
    const totals = sizeCells(leather, sizes)
    return { id: 'total', kind: 'total', line: null, label: tp('bom.sizes.leatherTotal'), sub: t('sizes.totalSub'), values: Object.fromEntries(totals.map((entry) => [entry.size, entry.total])) }
  }, [leather, sizes.join(','), tp, t])
  const latest = useRef({ marks, onCell, editable })
  latest.current = { marks, onCell, editable }
  const marksKey = JSON.stringify(marks)

  const columns = useMemo<Array<ColDef<SizeRow> | ColGroupDef<SizeRow>>>(() => {
    const LineCell = ({ data }: ICellRendererParams<SizeRow>) =>
      data ? (
        <span className="fw-bmd-cell">
          <b>{data.label}</b>
          <span className="fw-bmd-sub">{data.sub}</span>
        </span>
      ) : null
    const FillCell = ({ data }: ICellRendererParams<SizeRow>) =>
      data?.kind === 'line' ? (
        <Button size="sm" variant="quiet" heldReason={heldWhy} onClick={() => onFill(data.id)} aria-label={t('sizes.fillOne', { line: data.label })}>
          <Wand2 size={13} aria-hidden /> {t('sizes.fill')}
        </Button>
      ) : null
    const group = sizeColumnGroup<SizeRow>({
      sizes,
      base: bom.style.baseSize,
      value: (row, size) => row.values[size] ?? null,
      editable: (row) => latest.current.editable && row.kind === 'line',
      required: (row) => row.kind === 'line',
      scale: 4,
      onChange: (row, size, value) => {
        setRefused(null)
        latest.current.onCell(row.id, size, value)
      },
      onRefused: (_row, size, text) => setRefused(ds.sizeColumns.notNumber(size, text)),
      locale: INTL_LOCALE[locale],
      cellLabel: (row, size) => tp('bom.sizeCell', { line: row.label, size }),
      labels: ds.sizeColumns,
      headerName: t('sizes.group'),
    })
    const SizeCell = (params: ICellRendererParams<SizeRow>) => {
      if (!params.data) return null
      const size = (params.colDef?.colId ?? '').replace(/^size:/, '')
      const mark = latest.current.marks[markKey(params.data.id, size)]
      return (
        <span className="fw-bmd-sizecell">
          {mark && mark.state !== 'refused' && mark.value !== undefined ? (mark.value === null ? ds.sizeColumns.missing : mark.value) : params.valueFormatted}
          {mark?.state === 'refused' ? (
            <span className="fw-bmd-refused" role="img" aria-label={t(mark.problem ?? 'mark.refused')} title={t(mark.problem ?? 'mark.refused')}>
              !
            </span>
          ) : mark ? (
            <CellSaveMark state={mark.state} />
          ) : null}
        </span>
      )
    }
    return [
      { colId: 'line', headerName: tp('bom.col.material'), minWidth: 200, flex: 1.4, pinned: 'left', cellRenderer: LineCell, valueGetter: (params) => params.data?.label ?? '', sortable: false, suppressHeaderMenuButton: true },
      { ...group, children: group.children.map((column) => ({ ...column, cellRenderer: SizeCell })) },
      { colId: 'fill', headerName: t('sizes.fillCol'), minWidth: 110, maxWidth: 130, pinned: 'right', cellRenderer: FillCell, sortable: false, suppressHeaderMenuButton: true },
    ]
  }, [t, tp, locale, ds.sizeColumns, sizes.join(','), bom.style.baseSize, heldWhy, marksKey, onFill])

  // "Show me" on a size: the cell gets the focus once the grid is there.
  useEffect(() => {
    const api = apiRef.current
    if (!focus || !api) return
    const node = api.getRowNode(focus.lineId)
    if (node && node.rowIndex !== null) {
      api.ensureIndexVisible(node.rowIndex)
      api.ensureColumnVisible(`size:${focus.size}`)
      api.setFocusedCell(node.rowIndex, `size:${focus.size}`)
    }
    onFocused?.()
  }, [focus, rows])

  if (lines.length === 0) return <EmptyState title={tp('bom.sizes.empty.title')} description={tp('bom.sizes.empty.body')} />
  const waiting = Object.values(marks).filter((mark) => mark.state === 'waiting').length
  return (
    <div className="fw-bmd-stack">
      {heldWhy && <Banner tone="info" title={heldWhy} />}
      {offline && waiting > 0 && <Banner tone="warning" title={t('sizes.offline', { count: waiting })} />}
      <div className="fw-bmd-grid-box fw-bmd-sheet" role="region" aria-label={tp('bom.view.sizes')}>
        <NexusGrid<SizeRow>
          {...SHEET_GRID_OPTIONS}
          rowData={rows}
          pinnedBottomRowData={total ? [total] : undefined}
          columnDefs={columns}
          getRowId={(params) => params.data.id}
          cellSelection
          domLayout="autoHeight"
          onGridReady={(event) => {
            apiRef.current = event.api
          }}
        />
      </div>
      {refused && <Banner tone="warning" title={refused} />}
      <p className="fw-bmd-hint">{t(editable ? 'sizes.hint' : 'sizes.hintRead')}</p>
    </div>
  )
}
