'use client'

import { useMemo, useRef } from 'react'
import { MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Card, EmptyState, Menu } from '@nexus/ui/components'
import { NexusGrid, SHEET_GRID_OPTIONS, switchColumn, type ColDef, type ICellRendererParams, type SwitchHandlers, type ValueSetterParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { movedSeq, OPTION_LIMITS, STATUS_TONE, surchargeEditText, surchargeOf, surchargeText, valuesInOrder, type GroupRecord, type OptionValue } from '../../model'
import type { GroupRecordActions, GroupRecordModel } from '../../view-model'
import { manageHeld } from './GroupRecordView'
import { cellRules, cellTip } from './cells'

/**
 * Option group › Options (design rec tab option.options; PRD-206, PRD-211, PRD-208; autosave per cell): the choices in the
 * group in the configurator's order — code, name, the price surcharge (an amount or a percent; only with the price grain,
 * changed with the pricing right), whether the customer types a text (a name to embroider) with its length and pattern,
 * and whether it takes the garment outside its certificate (a note says what the certificate no longer covers). Each cell
 * saves alone at the option's version; a refused cell keeps its mark with our words and the stored value again.
 */
export function OptionsTab({ group, model, actions }: { group: GroupRecord; model: GroupRecordModel; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const held = manageHeld(group, model, t)
  const priceHeld = group.status === 'ARCHIVED' ? t('held.archived') : !group.may.price ? t('held.noPrice') : model.offline ? t('held.offline') : null
  const values = useMemo(() => valuesInOrder(group.values), [group.values])
  const handlers = useRef<SwitchHandlers<OptionValue>>({})
  handlers.current = {
    onSwitch: (row, next, field) => {
      if (field === 'freeText') actions?.onFreeText?.(row.id, next)
      else if (field === 'outsideCertificate') actions?.onCertificate?.(row.id, next)
    },
  }

  const columns = useMemo<ColDef<OptionValue>[]>(() => {
    const valueHeld = (row: OptionValue | undefined) => (!row ? held : held ?? (row.status === 'ARCHIVED' ? t('held.valueArchived') : null))
    const text = (field: 'code' | 'name', header: string, width: number, max: number): ColDef<OptionValue> => ({
      colId: field,
      headerName: header,
      minWidth: width,
      flex: field === 'name' ? 1.6 : 1,
      sortable: false,
      editable: (params) => !valueHeld(params.data),
      valueGetter: (params) => params.data?.[field] ?? '',
      valueSetter: (params: ValueSetterParams<OptionValue>) => {
        if (!params.data) return false
        const value = String(params.newValue ?? '').trim().slice(0, max)
        if (value === params.data[field] || value === '') return false
        actions?.onValueCell?.(params.data.id, field, value)
        return false
      },
      cellClassRules: cellRules(model.cells, field),
      tooltipValueGetter: (params) => cellTip(model.cells, params.data?.id, field, tl, t) ?? valueHeld(params.data as OptionValue | undefined) ?? undefined,
    })
    const PriceCell = ({ data }: ICellRendererParams<OptionValue>) => {
      if (!data) return null
      const surcharge = surchargeOf(group.effects, data.id)
      return <span className={surcharge ? 'fw-opt-num' : 'fw-lib-hint'}>{surchargeText(surcharge, model.locale)}</span>
    }
    const UsedCell = ({ data }: ICellRendererParams<OptionValue>) => {
      if (!data) return null
      const { lines, steps } = data.usedBy
      return lines + steps === 0 ? <span className="fw-lib-hint">—</span> : <span className="fw-opt-wrap">{[lines > 0 ? t('options.usedLines', { count: lines }) : null, steps > 0 ? t('options.usedSteps', { count: steps }) : null].filter(Boolean).join(' · ')}</span>
    }
    const StatusCell = ({ data }: ICellRendererParams<OptionValue>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{tl(`status.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<OptionValue>) => {
      if (!data) return null
      const up = data.status === 'ACTIVE' ? movedSeq(group.values, data.id, -1) : null
      const down = data.status === 'ACTIVE' ? movedSeq(group.values, data.id, 1) : null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': tl('list.rowMenu', { code: data.code }) }}
          items={[
            { id: 'up', label: t('options.up'), disabled: !!held || up === null, description: held ?? (up === null ? t('options.atEnd') : undefined), onSelect: () => actions?.onMoveValue?.(data.id, -1) },
            { id: 'down', label: t('options.down'), disabled: !!held || down === null, description: held ?? (down === null ? t('options.atEnd') : undefined), onSelect: () => actions?.onMoveValue?.(data.id, 1) },
            data.status === 'ACTIVE'
              ? { id: 'archive', label: t('options.archive'), tone: 'danger' as const, disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'archiveValue', valueId: data.id }) }
              : { id: 'restore', label: t('options.restore'), disabled: !!(group.status === 'ARCHIVED' ? t('held.archived') : held), description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'restoreValue', valueId: data.id }) },
            {
              id: 'copy',
              label: tl('list.copyCode'),
              onSelect: () => {
                void navigator.clipboard?.writeText(data.code).catch(() => undefined)
              },
            },
          ]}
        />
      )
    }
    const switchHeld = (row: OptionValue) => valueHeld(row) ?? (model.cells[`${row.id}/freeText`]?.state === 'saving' ? tl('held.busy') : null)
    const freeTextColumn: ColDef<OptionValue> = {
      ...switchColumn<OptionValue>('freeText', {
        header: t('options.col.freeText'),
        label: (row) => t('options.freeTextOf', { code: row.code }),
        words: { on: tl('common.yes'), off: tl('common.no') },
        disabledReason: (row) => switchHeld(row) ?? (group.kind === 'FREE_TEXT' && row.freeText ? t('options.held.freeTextGroup') : null),
      }),
      colId: 'freeText',
      minWidth: 150,
      flex: 0.8,
      sortable: false,
      cellClassRules: cellRules(model.cells, 'freeText'),
    }
    const maxLength: ColDef<OptionValue> = {
      colId: 'freeTextMaxLength',
      headerName: t('options.col.maxLength'),
      minWidth: 150,
      flex: 0.6,
      sortable: false,
      type: 'rightAligned',
      editable: (params) => !!params.data?.freeText && !valueHeld(params.data),
      valueGetter: (params) => (params.data?.freeText ? (params.data.freeTextMaxLength ?? '') : ''),
      valueFormatter: (params) => (params.data?.freeText ? String(params.value ?? '—') : '—'),
      valueSetter: (params: ValueSetterParams<OptionValue>) => {
        if (!params.data) return false
        const typed = String(params.newValue ?? '').trim()
        const value = /^\d{1,3}$/.test(typed) ? Number(typed) : NaN
        if (value === params.data.freeTextMaxLength) return false
        actions?.onValueCell?.(params.data.id, 'freeTextMaxLength', Number.isInteger(value) && value >= 1 && value <= OPTION_LIMITS.freeTextLength ? value : null)
        return false
      },
      cellClassRules: cellRules(model.cells, 'freeTextMaxLength'),
      tooltipValueGetter: (params) => cellTip(model.cells, params.data?.id, 'freeTextMaxLength', tl, t) ?? (params.data && !params.data.freeText ? t('options.held.noText') : undefined),
    }
    const pattern: ColDef<OptionValue> = {
      colId: 'freeTextPattern',
      headerName: t('options.col.pattern'),
      minWidth: 140,
      flex: 0.9,
      sortable: false,
      editable: (params) => !!params.data?.freeText && !valueHeld(params.data),
      valueGetter: (params) => (params.data?.freeText ? (params.data.freeTextPattern ?? '') : ''),
      valueFormatter: (params) => (params.data?.freeText ? String(params.value || '—') : '—'),
      cellClass: 'fw-lib-mono',
      valueSetter: (params: ValueSetterParams<OptionValue>) => {
        if (!params.data) return false
        const value = String(params.newValue ?? '')
        if (value === (params.data.freeTextPattern ?? '')) return false
        actions?.onValueCell?.(params.data.id, 'freeTextPattern', value === '' ? null : value)
        return false
      },
      cellClassRules: cellRules(model.cells, 'freeTextPattern'),
      tooltipValueGetter: (params) => cellTip(model.cells, params.data?.id, 'freeTextPattern', tl, t) ?? (params.data?.freeText ? t('options.patternHint') : t('options.held.noText')),
    }
    const outside: ColDef<OptionValue> = {
      ...switchColumn<OptionValue>('outsideCertificate', {
        header: t('options.col.outside'),
        label: (row) => t('options.outsideOf', { code: row.code }),
        words: { on: tl('common.yes'), off: tl('common.no') },
        disabledReason: (row) => valueHeld(row) ?? (model.cells[`${row.id}/outsideCertificate`]?.state === 'saving' ? tl('held.busy') : null),
      }),
      colId: 'outsideCertificate',
      minWidth: 190,
      flex: 0.9,
      sortable: false,
      cellClassRules: cellRules(model.cells, 'outsideCertificate'),
    }
    const price: ColDef<OptionValue> = {
      colId: 'price',
      headerName: t('options.col.price'),
      headerTooltip: t('options.priceHint'),
      minWidth: 200,
      flex: 1,
      sortable: false,
      type: 'rightAligned',
      editable: (params) => !priceHeld && params.data?.status === 'ACTIVE',
      valueGetter: (params) => (params.data ? surchargeEditText(surchargeOf(group.effects, params.data.id)) : ''),
      valueSetter: (params: ValueSetterParams<OptionValue>) => {
        if (!params.data) return false
        const typed = String(params.newValue ?? '').trim()
        if (typed === surchargeEditText(surchargeOf(group.effects, params.data.id))) return false
        actions?.onPrice?.(params.data.id, typed)
        return false
      },
      cellRenderer: PriceCell,
      cellClassRules: cellRules(model.cells, 'price'),
      tooltipValueGetter: (params) => cellTip(model.cells, params.data?.id, 'price', tl, t) ?? priceHeld ?? t('options.priceHint'),
    }
    return [
      text('code', t('options.col.code'), 130, OPTION_LIMITS.code),
      text('name', t('options.col.name'), 170, OPTION_LIMITS.name),
      ...(model.can.seesPrice ? [price] : []),
      freeTextColumn,
      maxLength,
      pattern,
      outside,
      { colId: 'used', headerName: t('options.col.used'), minWidth: 200, flex: 1.1, sortable: false, wrapText: true, autoHeight: true, cellRenderer: UsedCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 110, flex: 0.6, sortable: false, cellRenderer: StatusCell },
      { colId: 'more', headerName: tl('list.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [group, model.cells, model.can.seesPrice, model.locale, held, priceHeld, actions, t, tl])

  const addHeld = held ?? (model.busy ? tl('held.busy') : null)
  return (
    <Card padded>
      <div className="fw-opt-cardhead">
        <h2 className="fw-lib-h3">{t('options.title')}</h2>
        {values.length > 0 && <span className="fw-lib-hint">{t('options.intro')}</span>}
      </div>
      {held && values.length > 0 && <Banner tone="info" title={t(model.can.seesPrice && !priceHeld ? 'options.priceOnly' : 'readOnly', { reason: held })} />}
      {!model.can.seesPrice && <p className="fw-lib-hint">{t('options.noPriceGrain')}</p>}
      {values.length === 0 ? (
        <EmptyState
          title={t('options.empty.title')}
          description={t(held ? 'options.empty.bodyView' : 'options.empty.body')}
          action={
            !held ? (
              <Button size="sm" variant="primary" heldReason={addHeld} onClick={() => actions?.onDialog?.({ kind: 'addValue', draft: { code: '', name: '', freeText: group.kind === 'FREE_TEXT', maxLength: group.kind === 'FREE_TEXT' ? '30' : '', pattern: '' }, busy: false, problem: null, refused: [], messages: [] })}>
                <Plus size={14} aria-hidden /> {t('options.addMany')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="fw-opt-grid" role="region" aria-label={t('options.title')}>
          <NexusGrid<OptionValue> {...SHEET_GRID_OPTIONS} rowData={values} columnDefs={columns} getRowId={(params) => params.data.id} context={handlers} domLayout="autoHeight" />
        </div>
      )}
      <p className="fw-lib-hint">{t('options.hint')}</p>
    </Card>
  )
}
