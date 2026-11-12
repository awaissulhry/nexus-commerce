'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, MoreHorizontal, PackagePlus, Trash2 } from 'lucide-react'
import { Banner, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Spinner } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { Qty, QualityPill } from '../../../../_shared/stock/parts'
import type { QualityStatus } from '../../../../_shared/stock/api'
import { actionHeld, quantityWords, type LineView, type TransferView } from '../../model'
import { LineStatePill, useWords } from '../../parts'
import type { CellSave, TransferRecordActions, TransferRecordModel } from '../view-model'

/**
 * Transfer › Lines (design warehouse.transfers/rec:Transfer/lines, tr-lines): what moves — material, colour, lot, hide,
 * quantity with its unit, what its place holds now, where it is picked — on the shared list frame. While a draft the
 * quantity cell takes the number (autosave per cell: Enter, Tab or leaving the cell saves it on the line's version; Esc
 * puts it back); a hide travels whole (no cell). Lines are added from the stock picker (Add from stock…). Read-only after
 * the ship.
 */

interface CellContext {
  editable: boolean
  held: string | null
  cells: Readonly<Record<string, CellSave>>
  onQuantity?: (lineId: string, text: string) => void
}
const QtyContext = createContext<CellContext>({ editable: false, held: null, cells: {} })

function QuantityCell({ data }: ICellRendererParams<LineView>) {
  const context = useContext(QtyContext)
  const { t, say, locale } = useWords()
  const shown = data ? quantityWords(data.quantity, locale) : ''
  const [text, setText] = useState(shown)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(shown)
  }, [shown])
  if (!data) return null
  if (!context.editable || data.hide) return <Qty value={data.quantity} uom={data.uom} decimals={4} />
  const save = context.cells[data.id]
  const commit = () => {
    if (text.trim() === shown.trim()) return
    context.onQuantity?.(data.id, text)
  }
  return (
    <span className="fw-trf-qty">
      <Input
        size="sm"
        inputMode="decimal"
        aria-label={t('lines.quantityOf', { seq: data.seq, item: data.item.code })}
        value={text}
        disabled={!!context.held}
        title={context.held ?? undefined}
        onFocus={(event) => {
          focused.current = true
          event.currentTarget.select()
        }}
        onBlur={() => {
          focused.current = false
          commit()
        }}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setText(shown)
          }
        }}
      />
      <span className={`fw-trf-qty-state ${save?.state ?? ''}`} aria-live="polite">
        {save?.state === 'saving' ? <Spinner size={12} /> : save?.state === 'saved' ? <Check size={14} aria-label={t('lines.saved')} /> : save?.state === 'failed' ? <AlertCircle size={14} aria-label={say(save.words) ?? ''} /> : null}
      </span>
    </span>
  )
}

export function LinesTab({ transfer, model, actions }: { transfer: TransferView; model: TransferRecordModel; actions?: TransferRecordActions }) {
  const { t, say } = useWords()
  const offline = model.live === 'offline'
  const draft = transfer.status === 'DRAFT'
  const linesHeld = say(actionHeld(transfer.actions.lines, offline))
  const editable = draft && transfer.actions.lines.allowed
  const [selected, setSelected] = useState<readonly string[]>([])
  const latest = useRef(actions)
  latest.current = actions
  const context = useMemo<CellContext>(() => ({ editable, held: offline ? t('held.offline') : model.busy ? t('common.working') : null, cells: model.cells, onQuantity: (lineId, text) => latest.current?.onQuantity?.(lineId, text) }), [editable, offline, model.busy, model.cells, t])

  const columns = useMemo<ColDef<LineView>[]>(() => {
    const Material = ({ data }: ICellRendererParams<LineView>) =>
      data ? (
        <span className="fw-trf-cell">
          <span className="fw-trf-code">{data.item.code}</span>
          <span className="fw-trf-hint">{data.item.name}</span>
        </span>
      ) : null
    const Lot = ({ data }: ICellRendererParams<LineView>) =>
      data ? (
        data.lot ? (
          <span className="fw-trf-row">
            <span className="fw-trf-code">{data.lot.code}</span>
            {data.lot.qualityStatus !== 'RELEASED' && <QualityPill status={data.lot.qualityStatus as QualityStatus} />}
          </span>
        ) : (
          <span className="fw-trf-hint">—</span>
        )
      ) : null
    const Available = ({ data }: ICellRendererParams<LineView>) =>
      data ? data.available === null ? <span className="fw-trf-hint">{draftHint(data)}</span> : <Qty value={data.available} uom={data.uom} decimals={4} strong={Number(data.available) < Number(data.quantity)} /> : null
    const draftHint = (line: LineView) => (line.shippedQuantity === null ? t('lines.noPlace') : '—')
    const State = ({ data }: ICellRendererParams<LineView>) => (data ? <LineStatePill state={data.state} /> : null)
    const More = ({ data }: ICellRendererParams<LineView>) =>
      data && editable ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('lines.menu', { seq: data.seq }) }}
          items={[{ id: 'remove', label: t('lines.remove'), tone: 'danger', disabled: offline, description: offline ? t('held.offline') : undefined, onSelect: () => latest.current?.onRemoveLine?.(data.id) }]}
        />
      ) : null
    return [
      { colId: 'seq', headerName: t('col.seq'), minWidth: 64, maxWidth: 80, type: 'rightAligned', valueGetter: (params) => params.data?.seq ?? null },
      { colId: 'material', headerName: t('col.material'), minWidth: 180, flex: 1, valueGetter: (params) => (params.data ? `${params.data.item.code} · ${params.data.item.name}` : ''), cellRenderer: Material },
      { colId: 'colour', headerName: t('col.colour'), minWidth: 110, flex: 0.5, valueGetter: (params) => params.data?.colour?.name ?? '—' },
      { colId: 'lot', headerName: t('col.lot'), minWidth: 140, flex: 0.6, valueGetter: (params) => params.data?.lot?.code ?? '', cellRenderer: Lot },
      { colId: 'hide', headerName: t('col.hide'), minWidth: 120, flex: 0.5, valueGetter: (params) => params.data?.hide?.code ?? '—' },
      { colId: 'quantity', headerName: t('col.quantity'), minWidth: 150, flex: 0.6, valueGetter: (params) => params.data?.quantity ?? '', cellRenderer: QuantityCell },
      { colId: 'available', headerName: t('col.available'), minWidth: 130, flex: 0.5, valueGetter: (params) => params.data?.available ?? '', cellRenderer: Available },
      { colId: 'picked', headerName: t('col.picked'), minWidth: 130, flex: 0.5, valueGetter: (params) => params.data?.fromLocation?.code ?? transfer.fromLocation?.code ?? '—' },
      { colId: 'state', headerName: t('col.state'), minWidth: 120, flex: 0.5, valueGetter: (params) => (params.data ? t(`state.${params.data.state}`) : ''), cellRenderer: State },
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: More },
    ]
  }, [t, editable, offline, transfer.fromLocation])

  const keys: ListKey[] = [{ keys: ['a'], does: t('keys.add') }]
  const addButton = (
    <Button size="sm" variant="secondary" heldReason={linesHeld} onClick={() => actions?.onDialog?.({ kind: 'pick', picker: { q: '', locationId: transfer.fromLocation?.id ?? null, stock: null, problem: null, picked: {}, busy: false, notice: null } })} aria-keyshortcuts="a">
      <PackagePlus size={14} aria-hidden /> {t('lines.add')}
    </Button>
  )
  const state = transfer.lines.length === 0 ? <EmptyState title={t('lines.empty')} description={draft ? t('lines.emptyBody') : t('lines.emptyClosed')} action={draft && editable ? addButton : undefined} /> : undefined

  return (
    <section className="fw-trf-section" aria-label={t('tab.lines')}>
      {!draft && <Banner tone="info" title={t('lines.readOnly')} />}
      <QtyContext.Provider value={context}>
        <ListFrame<LineView>
          label={t('lines.label')}
          rows={state ? [] : transfer.lines}
          rowId={(row) => row.id}
          columns={columns}
          count={t('lines.count', { count: transfer.lines.length })}
          tools={draft ? addButton : undefined}
          selection={{
            selected,
            onChange: setSelected,
            actions: editable ? (
              <Button size="sm" variant="secondary" heldReason={offline ? t('held.offline') : model.busy ? t('common.working') : null} aria-label={t('lines.removeMany', { count: selected.length })} onClick={() => actions?.onRemoveLines?.(selected)}>
                <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('lines.removeMany', { count: selected.length })}</SelectionLabel>
              </Button>
            ) : (
              <span className="fw-trf-hint">{t('lines.selected', { count: selected.length })}</span>
            ),
          }}
          keys={keys}
          state={state}
          title={t('lines.label')}
        />
      </QtyContext.Provider>
      {draft && <p className="fw-trf-hint">{t('lines.foot')}</p>}
    </section>
  )
}
