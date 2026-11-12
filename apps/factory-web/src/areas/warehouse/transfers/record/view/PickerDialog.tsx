'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { PackagePlus } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Kbd, Select, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { Qty, QualityPill } from '../../../../_shared/stock/parts'
import type { QualityStatus } from '../../../../_shared/stock/api'
import { actionHeld, decimalText, type StockRow, type TransferView } from '../../model'
import { NoticeLine, useWords } from '../../parts'
import type { PickerState, TransferRecordActions, TransferRecordModel } from '../view-model'

/**
 * Add from stock (design tr-lines "add from a stock picker"; "picked from stock with availability"): what the sending site
 * holds, place by place (never its transit place), less what this draft's lines take already, on the shared list frame.
 * Select the rows (x / Space / shift-click), type how much of each (all that is available by default; a hide travels whole),
 * Add N lines. A blocked or rejected lot, or nothing left, cannot be selected: the row says why.
 */

export const stockKeyOf = (row: Pick<StockRow, 'location' | 'item' | 'colour' | 'lot' | 'hide'>): string => [row.location.id, row.item.id, row.colour?.id ?? '-', row.lot?.id ?? '-', row.hide?.id ?? '-'].join('|')

/** The picked rows and their quantities, as the API's line bodies (the container sends them one by one). */
export function pickedBodies(picker: PickerState): { itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null; fromLocationId: string; quantity?: string }[] {
  const rows = picker.stock?.rows ?? []
  return Object.entries(picker.picked).flatMap(([key, text]) => {
    const row = rows.find((entry) => stockKeyOf(entry) === key)
    if (!row) return []
    return [{ itemId: row.item.id, itemColourId: row.colour?.id ?? null, lotId: row.lot?.id ?? null, hideId: row.hide?.id ?? null, fromLocationId: row.location.id, ...(row.hide ? {} : { quantity: decimalText(text) ?? text }) }]
  })
}

/** Why the picker's Add waits, or null. */
export function pickerHeld(picker: PickerState): { key: string; params?: Record<string, string | number> } | null {
  const rows = picker.stock?.rows ?? []
  const keys = Object.keys(picker.picked)
  if (keys.length === 0) return { key: 'picker.pickFirst' }
  for (const key of keys) {
    const row = rows.find((entry) => stockKeyOf(entry) === key)
    if (!row || row.hide) continue
    const value = decimalText(picker.picked[key] ?? '')
    if (value === null) return { key: 'held.pickQuantity', params: { item: row.item.code } }
    if (Number(value) > Number(row.available)) return { key: 'refusal.NOT_ENOUGH_STOCK' }
  }
  return null
}

interface PickContext {
  picked: Readonly<Record<string, string>>
  onType: (key: string, text: string) => void
}
const PickedContext = createContext<PickContext>({ picked: {}, onType: () => undefined })

function TakeCell({ data }: ICellRendererParams<StockRow>) {
  const context = useContext(PickedContext)
  const { t } = useWords()
  if (!data) return null
  const key = stockKeyOf(data)
  const picked = context.picked[key]
  if (picked === undefined) return <span className="fw-trf-hint">—</span>
  if (data.hide) return <Qty value={data.available} uom={data.item.baseUom} decimals={4} />
  return <Input size="sm" inputMode="decimal" className="fw-trf-qty" aria-label={t('picker.takeOf', { item: data.item.code })} value={picked} onChange={(event) => context.onType(key, event.target.value)} />
}

export function PickerDialog({ transfer, model, picker, actions }: { transfer: TransferView; model: TransferRecordModel; picker: PickerState; actions?: TransferRecordActions }) {
  const { t, say } = useWords()
  const [q, setQ] = useState(picker.q)
  useEffect(() => setQ(picker.q), [picker.q])
  const rows = picker.stock?.rows ?? null
  const offline = model.live === 'offline'
  const held = say(actionHeld(transfer.actions.lines, offline)) ?? say(pickerHeld(picker))
  const heldText = picker.busy ? t('common.working') : held
  const selected = Object.keys(picker.picked)
  const setPicker = (patch: Partial<PickerState>) => actions?.onDialog?.({ kind: 'pick', picker: { ...picker, ...patch } })
  const context = useMemo<PickContext>(() => ({ picked: picker.picked, onType: (key, text) => actions?.onDialog?.({ kind: 'pick', picker: { ...picker, picked: { ...picker.picked, [key]: text } } }) }), [picker, actions])
  const places = useMemo(() => {
    const seen = new Map<string, { id: string; code: string; name: string }>()
    for (const row of rows ?? []) seen.set(row.location.id, row.location)
    if (transfer.fromLocation) seen.set(transfer.fromLocation.id, transfer.fromLocation)
    return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code))
  }, [rows, transfer.fromLocation])

  const columns = useMemo<ColDef<StockRow>[]>(() => {
    const Material = ({ data }: ICellRendererParams<StockRow>) =>
      data ? (
        <span className="fw-trf-cell">
          <span className="fw-trf-code">{data.item.code}</span>
          <span className="fw-trf-hint">{[data.item.name, data.colour?.name].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const Lot = ({ data }: ICellRendererParams<StockRow>) =>
      data ? (
        data.lot ? (
          <span className="fw-trf-row">
            <span>{data.lot.code}</span>
            {data.lot.qualityStatus !== 'RELEASED' && <QualityPill status={data.lot.qualityStatus as QualityStatus} />}
          </span>
        ) : (
          <span className="fw-trf-hint">—</span>
        )
      ) : null
    const Available = ({ data }: ICellRendererParams<StockRow>) => (data ? <Qty value={data.available} uom={data.item.baseUom} decimals={4} /> : null)
    return [
      { colId: 'place', headerName: t('col.place'), minWidth: 120, flex: 0.5, valueGetter: (params) => params.data?.location.code ?? '' },
      { colId: 'material', headerName: t('col.material'), minWidth: 180, flex: 1, valueGetter: (params) => params.data?.item.code ?? '', cellRenderer: Material },
      { colId: 'lot', headerName: t('col.lot'), minWidth: 140, flex: 0.6, valueGetter: (params) => params.data?.lot?.code ?? '', cellRenderer: Lot },
      { colId: 'hide', headerName: t('col.hide'), minWidth: 110, flex: 0.5, valueGetter: (params) => params.data?.hide?.code ?? '—' },
      { colId: 'available', headerName: t('col.available'), minWidth: 130, flex: 0.5, valueGetter: (params) => params.data?.available ?? '', cellRenderer: Available },
      { colId: 'take', headerName: t('col.take'), minWidth: 130, flex: 0.5, sortable: false, cellRenderer: TakeCell },
    ]
  }, [t])

  const onSelect = (ids: string[]) => {
    const next: Record<string, string> = {}
    for (const id of ids) {
      const row = (rows ?? []).find((entry) => stockKeyOf(entry) === id)
      next[id] = picker.picked[id] ?? row?.available ?? ''
    }
    setPicker({ picked: next })
  }
  const state = picker.problem ? (
    <EmptyState title={t('picker.failed')} description={t(picker.problem)} action={<Button size="sm" onClick={() => actions?.onPickerSearch?.({})}>{t('common.retry')}</Button>} />
  ) : rows !== null && rows.length === 0 ? (
    <EmptyState title={t('picker.empty')} description={t('picker.emptyBody', { site: transfer.from.code })} />
  ) : undefined

  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('picker.title', { site: transfer.from.code })}
      size="xl"
      footer={
        <>
          <span className="fw-trf-hint">{t('picker.picked', { count: selected.length })}</span>
          <span className="grow" />
          <Button size="sm" variant="secondary" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldText} onClick={() => actions?.onAddPicked?.()} aria-keyshortcuts="Meta+Enter">
            <PackagePlus size={14} aria-hidden /> {t('picker.add', { count: selected.length })}
            <span className="fw-trf-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
          </Button>
        </>
      }
    >
      <div className="fw-trf-form">
        {picker.stock === null && !picker.problem ? (
          <Skeleton height={160} />
        ) : (
          <PickedContext.Provider value={context}>
            <ListFrame<StockRow>
              label={t('picker.label')}
              rows={state ? [] : rows}
              rowId={stockKeyOf}
              columns={columns}
              count={picker.stock?.truncated ? t('picker.countMore', { count: rows?.length ?? 0 }) : t('picker.count', { count: rows?.length ?? 0 })}
              search={
                <Input
                  size="sm"
                  type="search"
                  className="fw-trf-search"
                  aria-label={t('picker.search')}
                  placeholder={t('picker.search')}
                  value={q}
                  onChange={(event) => setQ(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') actions?.onPickerSearch?.({ q })
                  }}
                />
              }
              tools={
                <Select size="sm" aria-label={t('picker.place')} value={picker.locationId ?? ''} onChange={(event) => actions?.onPickerSearch?.({ locationId: event.target.value || null })}>
                  <option value="">{t('picker.allPlaces')}</option>
                  {places.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.code} · {place.name}
                    </option>
                  ))}
                </Select>
              }
              selection={{ selected, onChange: onSelect, actions: <span className="fw-trf-hint">{t('picker.picked', { count: selected.length })}</span> }}
              isRowSelectable={(row) => (row.refusal ? t(`refusal.${row.refusal}`) : Number(row.available) <= 0 ? t('picker.allTaken') : null)}
              state={state}
              title={t('picker.label')}
            />
          </PickedContext.Provider>
        )}
        <NoticeLine notice={picker.notice} />
      </div>
    </Modal>
  )
}
