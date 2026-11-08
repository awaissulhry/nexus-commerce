'use client'

import { useMemo } from 'react'
import { Scissors } from 'lucide-react'
import { Banner, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef } from '@nexus/ui/grid'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { Phrase } from '../../model'
import type { Station, WaitingCell, WaitingGroup } from '../api'
import { cellGarments, cellHeld, draftGarments, draftRatio, groupKeyOf, layPlies, newOrderHeld, ORDERS_NAMESPACE, type NewOrderDraft, type OrdersCan } from '../model'
import { OrdersMessages, useSay } from './parts'

export interface NewOrderModel {
  /** The materials with cells waiting (per material and colour at a site); null while they are read. */
  readonly groups: readonly WaitingGroup[] | null
  /** The read's problem (a message key). */
  readonly problem: string | null
  /** The chosen site's stations (the cutting table); null: not read (no print.view, or while reading). */
  readonly stations: readonly Station[] | null
  readonly draft: NewOrderDraft
  readonly busy: boolean
  /** The write's refusal, in words. */
  readonly error: Phrase | null
}

export interface NewOrderActions {
  onDraft?: (draft: NewOrderDraft) => void
  onCreate?: () => void
  onClose?: () => void
  onRetry?: () => void
}

/**
 * pop:ct-new, W2b part (design production.cutting "New cut order": "work orders of the same material and colour (fabric:
 * grouped, MES-034) · table"): one material and colour at one site, the cells of several work orders ticked (a cell with
 * nothing left cannot be ticked, with why), then — fabric — the marker (name, length, usable width), each cell's garments
 * in one ply (the ratio), the plies and how many lays they split into, or — leather — each cell's garments; the cutting table
 * and the due day. Create cut order makes it PLANNED (POST /production/cut-orders) and opens its record; the API checks each
 * cell again under its lock (another cut order may have taken it meanwhile: said in words).
 */
export function NewCutOrderDialog({ model, can, actions }: { model: NewOrderModel; can: OrdersCan; actions?: NewOrderActions }) {
  return (
    <OrdersMessages>
      <Dialog model={model} can={can} actions={actions} />
    </OrdersMessages>
  )
}

function Dialog({ model, can, actions }: { model: NewOrderModel; can: OrdersCan; actions?: NewOrderActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const say = useSay()
  const locale = useLocale()
  const draft = model.draft
  const group = model.groups?.find((entry) => groupKeyOf(entry) === draft.groupKey) ?? null
  const set = (next: Partial<NewOrderDraft>) => actions?.onDraft?.({ ...draft, ...next })
  const held = say(newOrderHeld(draft, group, can, model.busy))
  const picked = group ? group.cells.filter((cell) => draft.picked.includes(cell.workOrderSizeId)) : []
  const split = layPlies(draft)
  const columns = useMemo<ColDef<WaitingCell>[]>(
    () => [
      { colId: 'workOrder', headerName: t('newOrder.col.workOrder'), minWidth: 120, flex: 1, valueGetter: (params) => params.data?.workOrder.number ?? '' },
      { colId: 'style', headerName: t('newOrder.col.style'), minWidth: 110, flex: 1, valueGetter: (params) => params.data?.style.code ?? '' },
      { colId: 'cell', headerName: t('newOrder.col.cell'), minWidth: 90, flex: 0.7, valueGetter: (params) => (params.data ? `${params.data.colourway.code} ${params.data.size}` : '') },
      { colId: 'left', headerName: t('newOrder.col.left'), minWidth: 110, flex: 0.8, type: 'rightAligned', valueGetter: (params) => (params.data ? t('newOrder.leftOf', { left: params.data.left, quantity: params.data.quantity }) : '') },
      { colId: 'due', headerName: t('newOrder.col.due'), minWidth: 100, flex: 0.7, valueGetter: (params) => (params.data?.workOrder.dueDate ? formatDate(`${params.data.workOrder.dueDate}T12:00:00Z`, { locale }) : '—') },
    ],
    [t, locale],
  )
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('newOrder.title')}
      size="lg"
      footer={
        <>
          <span className="fw-ct-hint">{group ? t('newOrder.total', { count: draftGarments(draft, group) }) : null}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onCreate?.()}>
            {model.busy ? <Spinner size={12} /> : <Scissors size={13} aria-hidden />} {t('newOrder.go')}
          </Button>
        </>
      }
    >
      <div className="fw-ct-dialog">
        <p>{t('newOrder.body')}</p>
        {model.error && <Banner tone="danger" title={say(model.error)} />}
        {model.problem ? (
          <EmptyState title={t('newOrder.failed')} description={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
        ) : !model.groups ? (
          <p className="fw-ct-hint" role="status">
            <Spinner size={12} /> {t('newOrder.reading')}
          </p>
        ) : model.groups.length === 0 ? (
          <EmptyState title={t('newOrder.empty.title')} description={t('newOrder.empty.body')} />
        ) : (
          <>
            <Field label={t('newOrder.material')} hint={t('newOrder.materialHint')}>
              <Select size="sm" value={draft.groupKey ?? ''} onChange={(event) => set({ groupKey: event.target.value || null, picked: [], ratio: {}, quantity: {}, stationId: '' })}>
                <option value="">{t('newOrder.pickMaterial')}</option>
                {model.groups.map((entry) => (
                  <option key={groupKeyOf(entry)} value={groupKeyOf(entry)}>
                    {t('newOrder.group', {
                      kind: t(`kind.${entry.kind}`),
                      material: [entry.item.code, entry.colour?.code].filter(Boolean).join(' · '),
                      name: entry.item.name,
                      left: entry.garmentsLeft,
                      workOrders: new Set(entry.cells.map((cell) => cell.workOrder.id)).size,
                    })}
                  </option>
                ))}
              </Select>
            </Field>
            {group && (
              <>
                <ListFrame<WaitingCell>
                  label={t('newOrder.cells')}
                  rows={group.cells}
                  rowId={(cell) => cell.workOrderSizeId}
                  columns={columns}
                  count={t('newOrder.cellsCount', { count: group.cells.length })}
                  selection={{ selected: draft.picked, onChange: (ids) => set({ picked: ids }), actions: <SelectionLabel>{t('newOrder.picked', { count: picked.length })}</SelectionLabel> }}
                  isRowSelectable={(cell) => say(cellHeld(cell))}
                  listKey={null}
                />
                {group.kind === 'FABRIC' ? (
                  <div className="fw-ct-form">
                    <Field label={t('newOrder.markerName')} required>
                      <Input size="sm" value={draft.markerName} maxLength={80} onChange={(event) => set({ markerName: event.target.value })} />
                    </Field>
                    <Field label={t('newOrder.markerLength')} required hint={t('newOrder.markerLengthHint')}>
                      <Input size="sm" inputMode="decimal" value={draft.markerLength} onChange={(event) => set({ markerLength: event.target.value })} />
                    </Field>
                    <Field label={t('newOrder.markerWidth')} hint={t('newOrder.markerWidthHint')}>
                      <Input size="sm" inputMode="decimal" value={draft.markerWidth} onChange={(event) => set({ markerWidth: event.target.value })} />
                    </Field>
                    <Field label={t('newOrder.plies')} required hint={t('newOrder.pliesHint')}>
                      <Input size="sm" inputMode="numeric" value={draft.plies} onChange={(event) => set({ plies: event.target.value })} />
                    </Field>
                    <Field label={t('newOrder.lays')} hint={split ? t('newOrder.laysSplit', { split: split.join(' · ') }) : t('newOrder.laysHint')}>
                      <Input size="sm" inputMode="numeric" value={draft.lays} onChange={(event) => set({ lays: event.target.value })} />
                    </Field>
                  </div>
                ) : (
                  <p className="fw-ct-hint">{t('newOrder.leather')}</p>
                )}
                {picked.length > 0 && (
                  <section className="fw-ct-card" aria-label={t('newOrder.lines')}>
                    <h3 className="fw-ct-h3">{t('newOrder.lines')}</h3>
                    <SummaryTable
                      label={t('newOrder.lines')}
                      density="roomy"
                      stackOnPhone
                      columns={[t('newOrder.col.cell'), group.kind === 'FABRIC' ? t('newOrder.col.ratio') : t('newOrder.col.garments'), t('newOrder.col.onOrder'), t('newOrder.col.left')]}
                      align={['left', 'left', 'right', 'right']}
                      rows={picked.map((cell) => {
                        const garments = cellGarments(draft, group, cell)
                        const label = `${cell.workOrder.number} ${cell.colourway.code} ${cell.size}`
                        return {
                          id: cell.workOrderSizeId,
                          cells: [
                            label,
                            group.kind === 'FABRIC' ? (
                              <Input
                                key="ratio"
                                size="sm"
                                inputMode="numeric"
                                aria-label={t('newOrder.ratioOf', { cell: label })}
                                value={draft.ratio[cell.workOrderSizeId] ?? '1'}
                                onChange={(event) => set({ ratio: { ...draft.ratio, [cell.workOrderSizeId]: event.target.value } })}
                              />
                            ) : (
                              <Input
                                key="quantity"
                                size="sm"
                                inputMode="numeric"
                                aria-label={t('newOrder.garmentsOf', { cell: label })}
                                placeholder={String(cell.left)}
                                value={draft.quantity[cell.workOrderSizeId] ?? ''}
                                onChange={(event) => set({ quantity: { ...draft.quantity, [cell.workOrderSizeId]: event.target.value } })}
                              />
                            ),
                            garments === null ? '—' : String(garments),
                            String(cell.left),
                          ],
                        }
                      })}
                    />
                    {group.kind === 'FABRIC' && <p className="fw-ct-hint">{t('newOrder.ratioLine', { ratio: draftRatio(draft, group) || '—' })}</p>}
                  </section>
                )}
                <div className="fw-ct-form">
                  <Field label={t('newOrder.table')} hint={can.print ? t('newOrder.tableHint') : t('newOrder.tableNoRight')}>
                    <Select size="sm" value={draft.stationId} disabled={!can.print || !model.stations} onChange={(event) => set({ stationId: event.target.value })}>
                      <option value="">{t('newOrder.noTable')}</option>
                      {(model.stations ?? []).map((station) => (
                        <option key={station.id} value={station.id}>
                          {`${station.code} · ${station.name}`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('newOrder.due')} hint={t('newOrder.dueHint')}>
                    <DateField value={draft.dueDate} locale={locale} clearable onChange={(value) => set({ dueDate: value })} />
                  </Field>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
