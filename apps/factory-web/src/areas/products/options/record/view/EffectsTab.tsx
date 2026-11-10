'use client'

import { useMemo } from 'react'
import { MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu } from '@nexus/ui/components'
import { NexusGrid, SHEET_GRID_OPTIONS, type ColDef, type ColGroupDef, type ICellRendererParams, type ValueSetterParams } from '@nexus/ui/grid'
import { sizeColumnGroup } from '@nexus/ui/grid/size-columns/index'
import { Button, Select, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { effectDraftFrom, effectsInOrder, surchargeEditText, surchargeOf, surchargeText, type GroupRecord, type OptionEffect } from '../../model'
import type { GroupRecordActions, GroupRecordModel } from '../../view-model'
import { manageHeld } from './GroupRecordView'
import { cellRules, cellTip } from './cells'

/**
 * Option group › Price & BOM effects (design rec tab option.effects, PRD-208, PRD-081; autosave per cell): what each option
 * does to the garment — BOM lines added (material, quantity, unit, per size), replaced or left out, an operation and its
 * minutes, minutes on the garment, "outside the certificate", and its price surcharge (only with the price grain). The cost
 * of an option comes with costing (W2b-6, FIN-018): its column is listed for the cost grain, "—" until then. Each cell
 * saves alone at the option's version; the kind never changes (another kind is another effect). Quantities per size are
 * the DS SizeColumns over a size scale the person picks.
 */
export function EffectsTab({ group, model, actions }: { group: GroupRecord; model: GroupRecordModel; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const ds = useDsWords()
  const held = manageHeld(group, model, t)
  const priceHeld = group.status === 'ARCHIVED' ? t('held.archived') : !group.may.price ? t('held.noPrice') : model.offline ? t('held.offline') : null
  const rows = useMemo(() => [...effectsInOrder(group), ...group.effects.filter((effect) => effect.kind === 'PRICE')], [group])
  const valueOf = useMemo(() => new Map(group.values.map((value) => [value.id, value])), [group.values])
  const scale = (model.scales.items ?? []).find((entry) => entry.id === model.scales.chosen) ?? null
  const anyBySize = rows.some((row) => row.kind === 'BOM_ADD')

  const decimalSign = model.locale.startsWith('it') ? ',' : '.'
  /** A plain decimal written in the page's language ("0,22"); signed for minutes taken away or added ("+2"). */
  const number = (value: string, signed = false): string => `${signed && !value.startsWith('-') ? '+' : ''}${value.replace('-', '−').replace('.', decimalSign)}`
  const cellRulesOf = (field: string) => cellRules<OptionEffect>(model.cells, field)
  /** What an effect does, in this page's words (the API's own words name its codes in English: never shown here). */
  const effectText = (effect: OptionEffect): string => {
    const ref = (entry: { code: string; name: string } | null) => (entry ? `${entry.code} · ${entry.name}` : '?')
    const qty = effect.qty !== null ? `${number(effect.qty)}${effect.uom ? ` ${tl(`uom.${effect.uom}`)}` : ''}` : null
    const sizes = effect.sizeQuantities ? Object.keys(effect.sizeQuantities).length : 0
    const section = effect.section ? t(`section.${effect.section}`) : null
    switch (effect.kind) {
      case 'BOM_ADD':
        return [t('what.add', { item: ref(effect.item) }), qty, sizes > 0 ? t('what.perSize', { count: sizes }) : null, section].filter(Boolean).join(' · ')
      case 'BOM_REPLACE':
        return [t('what.replace', { item: ref(effect.item), target: ref(effect.targetItem) }), qty].filter(Boolean).join(' · ')
      case 'BOM_REMOVE':
        return t('what.remove', { target: ref(effect.targetItem) })
      case 'OPERATION_ADD':
        return effect.minutes ? t('what.operation', { operation: ref(effect.operation), minutes: number(effect.minutes) }) : t('what.operationStandard', { operation: ref(effect.operation) })
      case 'MINUTES':
        return effect.operation ? t('what.minutesAt', { minutes: number(effect.minutes ?? '0', true), operation: ref(effect.operation) }) : t('what.minutes', { minutes: number(effect.minutes ?? '0', true) })
      case 'PRICE':
        return t('what.price')
      case 'CERTIFICATE':
        return t('what.certificate')
    }
  }

  const columns = useMemo<Array<ColDef<OptionEffect> | ColGroupDef<OptionEffect>>>(() => {
    const rowHeld = (row: OptionEffect | undefined) => (!row ? held : held ?? (valueOf.get(row.valueId)?.status === 'ARCHIVED' ? t('held.valueArchived') : null))
    const OptionCell = ({ data }: ICellRendererParams<OptionEffect>) => {
      if (!data) return null
      const value = valueOf.get(data.valueId)
      return (
        <span className="fw-lib-cell">
          <span className="fw-lib-mono">{value?.code ?? '—'}</span>
          <span className="fw-lib-sub">{value?.name ?? ''}</span>
        </span>
      )
    }
    const WhatCell = ({ data }: ICellRendererParams<OptionEffect>) =>
      data ? (
        <span className="fw-opt-wrap">
          {data.kind === 'CERTIFICATE' || data.kind === 'PRICE' ? <Tag tone={data.kind === 'CERTIFICATE' ? 'warning' : 'info'}>{effectText(data)}</Tag> : effectText(data)}
        </span>
      ) : null
    /** Which field the Amount cell edits: a BOM line's quantity, an operation's minutes; null: none. */
    const amountField = (row: OptionEffect | undefined): 'qty' | 'minutes' | null => {
      if (!row || row.kind === 'PRICE' || row.kind === 'CERTIFICATE' || row.kind === 'BOM_REMOVE') return null
      if (row.kind === 'OPERATION_ADD' || row.kind === 'MINUTES') return 'minutes'
      return row.kind === 'BOM_REPLACE' && row.uom === null ? null : 'qty'
    }
    const amount: ColDef<OptionEffect> = {
      colId: 'amount',
      headerName: t('effects.col.amount'),
      headerTooltip: t('effects.amountHint'),
      minWidth: 120,
      flex: 0.7,
      sortable: false,
      type: 'rightAligned',
      editable: (params) => !rowHeld(params.data) && amountField(params.data) !== null,
      valueGetter: (params) => {
        const field = amountField(params.data)
        return field && params.data ? (params.data[field] ?? '') : ''
      },
      valueFormatter: (params) => {
        const row = params.data
        const field = amountField(row)
        if (!row || !field || params.value === '' || params.value === null) return row?.kind === 'OPERATION_ADD' ? t('effects.standardMinutes') : '—'
        return field === 'minutes' ? t('effects.minutes', { minutes: number(String(params.value), row.kind === 'MINUTES') }) : `${number(String(params.value))}${row.uom ? ` ${tl(`uom.${row.uom}`)}` : ''}`
      },
      valueSetter: (params: ValueSetterParams<OptionEffect>) => {
        const field = amountField(params.data)
        if (!params.data || !field) return false
        const text = String(params.newValue ?? '').trim()
        if (text === (params.data[field] ?? '')) return false
        actions?.onEffectCell?.(params.data.id, field, text)
        return false
      },
      cellClassRules: { ...cellRules<OptionEffect>(model.cells, 'qty'), ...cellRulesOf('minutes') },
      tooltipValueGetter: (params) => cellTip(model.cells, params.data?.id, 'qty', tl, t) ?? cellTip(model.cells, params.data?.id, 'minutes', tl, t) ?? rowHeld(params.data as OptionEffect | undefined) ?? undefined,
    }
    const note: ColDef<OptionEffect> = {
      colId: 'note',
      headerName: t('effects.col.note'),
      minWidth: 140,
      flex: 1,
      sortable: false,
      wrapText: true,
      autoHeight: true,
      editable: (params) => !rowHeld(params.data) && params.data?.kind !== 'PRICE',
      valueGetter: (params) => params.data?.note ?? '',
      valueFormatter: (params) => (params.value ? String(params.value) : '—'),
      valueSetter: (params: ValueSetterParams<OptionEffect>) => {
        if (!params.data) return false
        const text = String(params.newValue ?? '').trim()
        if (text === (params.data.note ?? '')) return false
        actions?.onEffectCell?.(params.data.id, 'note', text)
        return false
      },
      cellClassRules: cellRules<OptionEffect>(model.cells, 'note'),
      tooltipValueGetter: (params) => cellTip(model.cells, params.data?.id, 'note', tl, t) ?? rowHeld(params.data as OptionEffect | undefined) ?? undefined,
    }
    const PriceCell = ({ data }: ICellRendererParams<OptionEffect>) => (data ? <span className={data.kind === 'PRICE' ? 'fw-opt-num' : 'fw-lib-hint'}>{data.kind === 'PRICE' ? surchargeText(surchargeOf(group.effects, data.valueId), model.locale) : '—'}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<OptionEffect>) => {
      if (!data) return null
      const hold = data.kind === 'PRICE' ? priceHeld : rowHeld(data)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('effects.rowMenu', { code: valueOf.get(data.valueId)?.code ?? '' }) }}
          items={[
            ...(data.kind === 'PRICE'
              ? []
              : [
                  {
                    id: 'edit',
                    label: t('effects.edit'),
                    disabled: !!hold,
                    description: hold ?? undefined,
                    onSelect: () =>
                      actions?.onDialog?.({
                        kind: 'effect',
                        mode: 'edit',
                        effectId: data.id,
                        draft: effectDraftFrom(data),
                        material: { q: '', results: null },
                        target: { q: '', results: null },
                        operation: { q: '', results: null },
                        busy: false,
                        problem: null,
                        refused: [],
                        messages: [],
                      }),
                  },
                ]),
            { id: 'remove', label: t('effects.remove'), tone: 'danger' as const, disabled: !!hold, description: hold ?? undefined, onSelect: () => (data.kind === 'PRICE' ? actions?.onPrice?.(data.valueId, '') : actions?.onDialog?.({ kind: 'removeEffect', effectId: data.id })) },
          ]}
        />
      )
    }
    const price: ColDef<OptionEffect> = {
      colId: 'price',
      headerName: t('effects.col.price'),
      headerTooltip: t('effects.priceHint'),
      minWidth: 150,
      flex: 0.8,
      sortable: false,
      type: 'rightAligned',
      editable: (params) => params.data?.kind === 'PRICE' && !priceHeld,
      valueGetter: (params) => (params.data?.kind === 'PRICE' ? surchargeEditText(surchargeOf(group.effects, params.data.valueId)) : ''),
      valueSetter: (params: ValueSetterParams<OptionEffect>) => {
        if (!params.data || params.data.kind !== 'PRICE') return false
        const text = String(params.newValue ?? '').trim()
        if (text === surchargeEditText(surchargeOf(group.effects, params.data.valueId))) return false
        actions?.onPrice?.(params.data.valueId, text)
        return false
      },
      cellRenderer: PriceCell,
      cellClassRules: cellRules(model.cells, 'price'),
      tooltipValueGetter: (params) => cellTip(model.cells, params.data?.id, 'price', tl, t) ?? (params.data?.kind === 'PRICE' ? (priceHeld ?? t('options.priceHint')) : undefined),
    }
    const cost: ColDef<OptionEffect> = {
      colId: 'cost',
      headerName: t('effects.col.cost'),
      headerTooltip: t('effects.costLater'),
      minWidth: 130,
      flex: 0.6,
      sortable: false,
      type: 'rightAligned',
      valueGetter: () => '—',
      tooltipValueGetter: () => t('effects.costLater'),
    }
    const sizes: ColGroupDef<OptionEffect>[] =
      scale && anyBySize
        ? [
            sizeColumnGroup<OptionEffect>({
              sizes: scale.codes,
              headerName: t('effects.col.perSize', { scale: scale.code }),
              value: (row, size) => (row.kind === 'BOM_ADD' ? (row.sizeQuantities?.[size] ?? null) : null),
              editable: (row) => row.kind === 'BOM_ADD' && !rowHeld(row),
              required: false,
              onChange: (row, size, value) => actions?.onEffectSize?.(row.id, size, value),
              onRefused: (_row, size, text) => actions?.onSizeRefused?.(size, text),
              locale: model.locale,
              cellLabel: (row, size) => t('effects.sizeCell', { code: valueOf.get(row.valueId)?.code ?? '', size }),
              labels: ds.sizeColumns,
            }),
          ]
        : []
    return [
      { colId: 'option', headerName: t('effects.col.option'), minWidth: 150, flex: 0.8, sortable: false, cellRenderer: OptionCell },
      { colId: 'what', headerName: t('effects.col.what'), minWidth: 240, flex: 2, sortable: false, wrapText: true, autoHeight: true, cellRenderer: WhatCell },
      amount,
      note,
      ...(model.can.seesPrice ? [price] : []),
      ...(model.can.seesCost ? [cost] : []),
      ...sizes,
      { colId: 'more', headerName: tl('list.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [group, model.cells, model.can.seesPrice, model.can.seesCost, model.locale, held, priceHeld, valueOf, scale, anyBySize, actions, t, tl, ds.sizeColumns])

  const addHeld = held ?? (group.values.every((value) => value.status !== 'ACTIVE') ? t('effects.held.noOptions') : null)
  return (
    <Card padded>
      <div className="fw-opt-cardhead">
        <h2 className="fw-lib-h3">{t('effects.title')}</h2>
        {anyBySize && (
          <Field label={t('effects.scale')} hint={scale ? undefined : t('effects.scaleHint')}>
            <Select size="sm" value={model.scales.chosen ?? ''} onChange={(event) => actions?.onScale?.(event.target.value || null)}>
              <option value="">{model.scales.items ? t('effects.noScale') : t('rules.reading')}</option>
              {(model.scales.items ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} · {entry.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {held && rows.length > 0 && <Banner tone="info" title={t('readOnly', { reason: held })} />}
      {rows.length === 0 ? (
        <EmptyState
          title={t('effects.empty.title')}
          description={t(held ? 'effects.empty.bodyView' : 'effects.empty.body')}
          action={
            !held ? (
              <Button
                size="sm"
                variant="primary"
                heldReason={addHeld}
                onClick={() => {
                  const first = group.values.find((value) => value.status === 'ACTIVE')
                  if (first) actions?.onDialog?.({ kind: 'effect', mode: 'new', effectId: null, draft: { valueId: first.id, kind: 'BOM_ADD', item: null, target: null, qty: '', uom: '', section: '', operation: null, minutes: '', note: '' }, material: { q: '', results: null }, target: { q: '', results: null }, operation: { q: '', results: null }, busy: false, problem: null, refused: [], messages: [] })
                }}
              >
                <Plus size={14} aria-hidden /> {t('effects.add')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="fw-opt-grid" role="region" aria-label={t('effects.title')}>
          <NexusGrid<OptionEffect> {...SHEET_GRID_OPTIONS} rowData={rows} columnDefs={columns} getRowId={(params) => params.data.id} cellSelection domLayout="autoHeight" />
        </div>
      )}
      <p className="fw-lib-hint">{t('effects.hint')}</p>
      {!model.can.seesPrice && <p className="fw-lib-hint">{t('effects.noPriceGrain')}</p>}
    </Card>
  )
}
