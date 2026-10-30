'use client'

import { useMemo, useState } from 'react'
import { Layers, Scissors } from 'lucide-react'
import { Banner, EmptyState, Field, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Availability } from '../../work-orders/daily/api'
import { hideHeld, type AvailableHide } from '../../work-orders/daily/model'
import type { CutRow } from '../api'
import { allocateHeld, areaNumber, CUTTING_NAMESPACE, materialLine, newCutHeld, newCutRowHeld, unitWord, type CuttingCan, type Part, type Phrase } from '../model'
import type { CuttingActions } from './CuttingView'

/** A phrase in the catalogue's words (null stays null: a button that is not held). */
export function say(t: (key: string, params?: Record<string, string | number>) => string, words: Phrase | null): string | null {
  return words ? t(words.key, words.params) : null
}

export interface NewCutModel {
  /** The work orders New cut order offers (waiting, nothing allocated); null while they are read. */
  readonly choices: readonly CutRow[] | null
  readonly problem: string | null
  readonly busy: boolean
  /** Design cases: the work orders ticked. */
  readonly picked?: readonly string[]
}

/**
 * pop:ct-new — New cut order (design production.cutting, "band primary"; Esc closes, the focus returns to the opener):
 * the released work orders with nothing cut and no hide allocated, with their material and colour, garments and pieces.
 * W2a cuts one work order at a time — one leather and colour, by hide —, so Create cut order takes one work order and
 * opens Allocate hides for it (the hides reserved whole for the work order: the cut that the cutting table then logs).
 * A second work order of another material cannot be ticked, with why; two of the same material are held: a cut order of
 * several work orders comes with fabric lays (MES-034, W2b). The table is the tablet's own station: every cut records
 * the table it was cut at.
 */
export function NewCutDialog({ model, can, actions }: { model: NewCutModel; can: CuttingCan; actions?: CuttingActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const [selected, setSelected] = useState<readonly string[]>(model.picked ?? [])
  const choices = model.choices
  const picked = (choices ?? []).filter((row) => selected.includes(row.workOrder.id))
  const held = say(t, newCutHeld(picked, can, model.busy))
  const columns = useMemo<ColDef<CutRow>[]>(
    () => [
      { colId: 'cut', headerName: t('col.workOrder'), minWidth: 120, flex: 1, valueGetter: (params) => params.data?.workOrder.number ?? '' },
      { colId: 'style', headerName: t('col.style'), minWidth: 120, flex: 1, valueGetter: (params) => params.data?.style.code ?? '' },
      { colId: 'material', headerName: t('col.material'), minWidth: 160, flex: 1.4, valueGetter: (params) => (params.data ? materialLine(params.data) : '') },
      { colId: 'garments', headerName: t('col.garments'), minWidth: 90, flex: 0.6, type: 'rightAligned', valueGetter: (params) => params.data?.garments.planned ?? 0 },
      { colId: 'pieces', headerName: t('col.piecesPlanned'), minWidth: 90, flex: 0.6, type: 'rightAligned', valueGetter: (params) => params.data?.pieces.planned ?? 0 },
    ],
    [t],
  )
  return (
    <Modal
      open
      onClose={() => actions?.onNew?.(false)}
      title={t('newCut.title')}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onNew?.(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => picked[0] && actions?.onCreateCut?.(picked[0].workOrder.id)}>
            {model.busy ? <Spinner size={12} /> : <Scissors size={13} aria-hidden />} {t('newCut.go')}
          </Button>
        </>
      }
    >
      <div className="fw-ct-dialog">
        <p>{t('newCut.body')}</p>
        <ListFrame<CutRow>
          label={t('newCut.tableLabel')}
          rows={model.problem ? [] : choices}
          rowId={(row) => row.workOrder.id}
          columns={columns}
          count={choices ? t('newCut.count', { count: choices.length }) : '—'}
          selection={{ selected, onChange: setSelected, actions: <SelectionLabel>{t('newCut.picked', { count: picked.length })}</SelectionLabel> }}
          isRowSelectable={(row) => say(t, newCutRowHeld(row, picked))}
          listKey={null}
          state={
            model.problem ? (
              <EmptyState title={t('list.failed')} description={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
            ) : choices && choices.length === 0 ? (
              <EmptyState title={t('newCut.empty.title')} description={t('newCut.empty.body')} />
            ) : undefined
          }
        />
        <p className="fw-ct-hint">{t('newCut.table')}</p>
        <p className="fw-ct-hint">{t('newCut.fabric')}</p>
      </div>
    </Modal>
  )
}

export interface AllocModel {
  /** The cut (its work order) the hides go to; null while it is read. */
  readonly cut: CutRow | null
  /** The leather and colour the dialog shows (a cut of two leathers allocates one at a time). */
  readonly material: { readonly itemId: string; readonly itemColourId: string | null } | null
  readonly availability: Part<Availability>
  readonly busy: boolean
  readonly problem: Phrase | null
  /** Design cases: the hides ticked. */
  readonly picked?: readonly string[]
}

/**
 * pop:ct-alloc — Allocate hides (design production.cutting, from Lay or hides; "the Find hides dialog (one component
 * with Warehouse › Hides)"): the hides of the cut's leather and colour at its site, each with its area and whether it
 * may be taken — on hold or not released, reserved for another demand, already this cut's, empty: such a hide cannot be
 * ticked, with why — and Allocate N hides (each reserved whole for the work order: POST /inventory/reservations; the
 * cutting table's first cut of it issues it). A work order on hold says so: hides may be allocated, the table cuts
 * nothing for it until quality releases the hold.
 */
export function AllocateHidesDialog({ model, can, actions }: { model: AllocModel; can: CuttingCan; actions?: CuttingActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.picked ?? [])
  const cut = model.cut
  const workOrderId = cut?.workOrder.id ?? ''
  const availability = model.availability.value
  const hides = availability?.hides ?? null
  const free = (hides ?? []).filter((hide) => hideHeld(hide, workOrderId) === null)
  const picked = (hides ?? []).filter((hide) => selected.includes(hide.hide.id))
  const area = picked.reduce((sum, hide) => sum + Number(hide.onHand), 0)
  const uom = unitWord(availability?.item.baseUom ?? '')
  const held = say(t, allocateHeld(cut, can)) ?? (model.busy ? t('held.busy') : picked.length === 0 ? t('alloc.held.none') : null)
  const material = cut?.materials.find((entry) => entry.itemId === model.material?.itemId && entry.itemColourId === (model.material?.itemColourId ?? null)) ?? cut?.materials[0] ?? null
  const columns = useMemo<ColDef<AvailableHide>[]>(
    () => [
      { colId: 'hide', headerName: t('alloc.col.hide'), minWidth: 140, flex: 1, valueGetter: (params) => params.data?.hide.code ?? '' },
      { colId: 'area', headerName: t('alloc.col.area'), minWidth: 110, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? `${areaNumber(params.data.onHand, locale)} ${uom}` : '') },
      {
        colId: 'state',
        headerName: t('alloc.col.state'),
        minWidth: 200,
        flex: 1.4,
        cellRenderer: ({ data }: ICellRendererParams<AvailableHide>) => {
          if (!data) return null
          const why = hideHeld(data, workOrderId)
          return why ? <Tag tone={why === 'reserve.why.mine' ? 'success' : 'warning'}>{t(`alloc.${why}`)}</Tag> : <Tag tone="info">{t('alloc.free')}</Tag>
        },
      },
    ],
    [t, locale, uom, workOrderId],
  )
  return (
    <Modal
      open
      onClose={() => actions?.onAllocate?.(null)}
      title={t('alloc.title', { number: cut?.workOrder.number ?? '—' })}
      subtitle={material ? [material.code, material.colourCode].filter(Boolean).join(' · ') : undefined}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onAllocate?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => material && actions?.onReserve?.(picked.map((hide) => hide.hide.id), { itemId: material.itemId, itemColourId: material.itemColourId })}>
            {model.busy ? <Spinner size={12} /> : <Layers size={13} aria-hidden />} {t('alloc.go', { count: picked.length })}
          </Button>
        </>
      }
    >
      <div className="fw-ct-dialog">
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
        {cut?.state === 'HELD' && <Banner tone="warning" title={t('alloc.heldWorkOrder', { reason: cut.workOrder.holdReason ?? t('common.noReason') })} />}
        {cut && cut.materials.length > 1 && (
          <Field label={t('alloc.material')}>
            <Select
              size="sm"
              value={material ? `${material.itemId}|${material.itemColourId ?? ''}` : ''}
              onChange={(event) => {
                const [itemId, itemColourId] = event.target.value.split('|')
                setSelected([])
                actions?.onMaterial?.({ itemId: itemId ?? '', itemColourId: itemColourId || null })
              }}
            >
              {cut.materials.map((entry) => (
                <option key={`${entry.itemId}|${entry.itemColourId ?? ''}`} value={`${entry.itemId}|${entry.itemColourId ?? ''}`}>
                  {[entry.code, entry.colourCode].filter(Boolean).join(' · ')}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {cut && <p>{t('alloc.body', { garments: cut.garments.toCut, pieces: Math.max(0, cut.pieces.planned - cut.pieces.cut) })}</p>}
        <ListFrame<AvailableHide>
          label={t('alloc.tableLabel')}
          rows={model.availability.problem ? [] : hides}
          rowId={(row) => row.hide.id}
          columns={columns}
          count={hides ? t('alloc.count', { count: hides.length, free: free.length }) : '—'}
          selection={{ selected, onChange: setSelected, actions: <SelectionLabel>{t('alloc.picked', { count: picked.length, area: areaNumber(String(area), locale), uom })}</SelectionLabel> }}
          isRowSelectable={(row) => {
            const why = hideHeld(row, workOrderId)
            return why ? t(`alloc.${why}`) : null
          }}
          listKey={null}
          state={
            model.availability.problem ? (
              <EmptyState title={t('alloc.failed')} description={t(model.availability.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
            ) : hides && hides.length === 0 ? (
              <EmptyState title={t('alloc.empty.title')} description={t('alloc.empty.body')} />
            ) : undefined
          }
        />
        <p className="fw-ct-hint">{t('alloc.hint')}</p>
      </div>
    </Modal>
  )
}
