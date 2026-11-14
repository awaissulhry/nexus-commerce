'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArrowDown, ArrowUp, Pencil, Plus, RotateCcw, Search, XCircle } from 'lucide-react'
import { Banner, EmptyState, Field as DsField } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SWATCHES, TagGlyph, Toggle } from '@nexus/ui/primitives'
import { CellSaveMark, Listbox } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { Field, ListValue, Picklist } from '../api'
import { archiveListHeld, FIELDS_NS, labelIn, markKey, valueMoveHeld, valuesActiveHeld, type Mark } from '../model'

export type ValueCell = 'labelIt' | 'labelEn' | 'description' | 'active' | 'look'

export interface PicklistsModel {
  picklists: readonly Picklist[]
  /** The list shown (null: none yet). */
  list: Picklist | null
  /** The fields of the record type shown that pick from it. */
  users: readonly Field[]
  recordLabel: string
  canManage: boolean
  busy: boolean
  marks: Readonly<Record<string, Mark>>
  /** Design cases: rows selected, the search typed. */
  selected?: readonly string[]
  query?: string
}

export interface PicklistsActions {
  onList?: (id: string) => void
  onNewList?: () => void
  onRenameList?: () => void
  onListState?: (status: 'ACTIVE' | 'ARCHIVED') => void
  onNewValue?: () => void
  onLook?: (value: ListValue) => void
  onValueCell?: (value: ListValue, cell: 'labelIt' | 'labelEn' | 'description', text: string) => void
  onValueActive?: (value: ListValue, active: boolean) => void
  onValuesActive?: (ids: readonly string[], active: boolean) => void
  onMoveValues?: (ids: readonly string[], delta: -1 | 1) => void
  onKeys?: () => void
}

const editableKeys = (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  return event.key.length === 1 && event.key !== ' '
}

/**
 * Picklists (design admin.fields sec:picklists, PLT-115): which list (every list of the tenant, with the fields of this
 * record type that pick from it), then ONE list frame of its values — value · look (icon and colour: DS IconPicker and
 * ColorSwatchPicker in a pop-up) · labels in Italian and English · description · active — each cell saved by itself
 * (DS CellSaveMark), New value (`c`), and with values selected Deactivate · Activate · Move up · Move down. A value keeps
 * its code; a deactivated value is no longer offered and stays readable on the records that hold it.
 */
export function PicklistsPanel({ model, actions }: { model: PicklistsModel; actions?: PicklistsActions }) {
  const t = useT(FIELDS_NS)
  // The icons' and colours' names are the shared reason lists' (the same closed sets: factory-domain fields/rules).
  const looks = useT('reasons')
  const locale = useLocale()
  const list = model.list
  const [query, setQuery] = useState(model.query ?? '')
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected, list?.id])
  useEffect(() => setQuery(model.query ?? ''), [model.query, list?.id])
  const all = useMemo(() => (list ? [...list.values].sort((a, b) => a.sortOrder - b.sortOrder) : []), [list])
  const words = query.trim().toLowerCase()
  const rows = words ? all.filter((value) => [value.code, value.labelIt, value.labelEn, value.description ?? ''].some((text) => text.toLowerCase().includes(words))) : all
  const picked = all.filter((value) => selected.includes(value.id))
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const marksKey = JSON.stringify(model.marks)
  const can = model.canManage && list?.status === 'ACTIVE'

  const columns = useMemo<ColDef<ListValue>[]>(() => {
    const Saved = ({ id, cell }: { id: string; cell: ValueCell }) => {
      const mark = latest.current.model.marks[markKey(id, cell)]
      if (!mark || mark.state === 'saved') return null
      return mark.state === 'refused' ? (
        <span className="fw-flds-refused" role="img" aria-label={t(mark.fault)} title={t(mark.fault)}>
          !
        </span>
      ) : (
        <CellSaveMark state={mark.state} />
      )
    }
    const LookCell = ({ data }: ICellRendererParams<ListValue>) => {
      if (!data) return null
      const swatch = SWATCHES.find((entry) => entry.hex.toLowerCase() === (data.colour ?? '').toLowerCase())
      const look = `${data.icon ? looks(`icon.${data.icon}`) : t('look.noIcon')} · ${swatch ? looks(`colour.${swatch.name}`) : t('look.noColour')}`
      const glyph = (
        <span className="fw-flds-cell">
          <TagGlyph icon={data.icon} color={data.colour} size={16} />
          <span className="fw-flds-muted">{look}</span>
        </span>
      )
      return (
        <span className="fw-flds-cell">
          {can ? (
            <Button size="sm" variant="quiet" aria-label={t('look.change', { code: data.code, look })} onClick={() => latest.current.actions?.onLook?.(data)}>
              {glyph}
            </Button>
          ) : (
            glyph
          )}
          <Saved id={data.id} cell="look" />
        </span>
      )
    }
    const TextCell = (cell: 'labelIt' | 'labelEn' | 'description') =>
      function Text({ data, value }: ICellRendererParams<ListValue>) {
        if (!data) return null
        const text = typeof value === 'string' ? value : ''
        return (
          <span className="fw-flds-cell">
            {text ? <span className="fw-flds-words">{text}</span> : <span className="fw-flds-muted">{t(cell === 'description' ? 'values.noDescription' : 'values.noWords')}</span>}
            <Saved id={data.id} cell={cell} />
          </span>
        )
      }
    const ActiveCell = ({ data }: ICellRendererParams<ListValue>) =>
      data ? (
        <span className="fw-flds-cell">
          {can && <Toggle size="xs" checked={data.active} aria-label={t('values.activeLabel', { code: data.code })} onChange={(next) => latest.current.actions?.onValueActive?.(data, next)} />}
          {data.active ? <span>{t('values.on')}</span> : <Pill tone="neutral">{t('values.off')}</Pill>}
          <Saved id={data.id} cell="active" />
        </span>
      ) : null
    const text = (cell: 'labelIt' | 'labelEn' | 'description', headerName: string, flex: number): ColDef<ListValue> => ({
      colId: cell,
      headerName,
      field: cell,
      minWidth: 150,
      flex,
      ...(can ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: cell === 'description' ? 500 : 80 } } : {}),
      cellRenderer: TextCell(cell),
      suppressKeyboardEvent: editableKeys,
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.onValueCell?.(params.data, cell, typeof params.newValue === 'string' ? params.newValue : '')
        return false
      },
    })
    return [
      { colId: 'order', headerName: t('values.col.order'), width: 90, minWidth: 80, maxWidth: 110, type: 'rightAligned', valueGetter: (params) => (params.data ? all.findIndex((value) => value.id === params.data!.id) + 1 : null) },
      { colId: 'code', headerName: t('values.col.code'), field: 'code', minWidth: 140, flex: 1, cellRenderer: ({ data }: ICellRendererParams<ListValue>) => (data ? <span className={data.active ? 'fw-flds-code' : 'fw-flds-code off'}>{data.code}</span> : null) },
      { colId: 'look', headerName: t('values.col.look'), minWidth: 180, flex: 1.1, cellRenderer: LookCell, suppressKeyboardEvent: (params) => {
          if (params.editing || params.event.key !== 'Enter' || !can || !params.data) return editableKeys(params)
          if (params.event.type === 'keydown') latest.current.actions?.onLook?.(params.data)
          return true
        } },
      text('labelIt', t('values.col.it'), 1.3),
      text('labelEn', t('values.col.en'), 1.3),
      text('description', t('values.col.description'), 1.6),
      {
        colId: 'active',
        headerName: t('values.col.active'),
        field: 'active',
        width: 150,
        minWidth: 130,
        maxWidth: 170,
        cellRenderer: ActiveCell,
        suppressKeyboardEvent: (params) => {
          if (params.editing || params.event.key !== 'Enter' || !can || !params.data) return editableKeys(params)
          if (params.event.type === 'keydown') latest.current.actions?.onValueActive?.(params.data, !params.data.active)
          return true
        },
      },
    ]
    // The marks repaint the cells; the rest is read through `latest`.
  }, [t, looks, can, marksKey, all])

  if (model.picklists.length === 0 || !list) {
    return (
      <section className="fw-flds-section" aria-label={t('lists.title')}>
        <EmptyState
          title={t('lists.emptyTitle')}
          description={t(model.canManage ? 'lists.emptyBody' : 'lists.emptyBodyView')}
          action={
            model.canManage ? (
              <Button variant="primary" size="sm" heldReason={model.busy ? t('wait.busy') : null} onClick={() => actions?.onNewList?.()}>
                <Plus size={14} aria-hidden /> {t('lists.new')}
              </Button>
            ) : undefined
          }
        />
      </section>
    )
  }

  const searching = words !== ''
  const archiveHeld = archiveListHeld(list, model.busy)
  const offHeld = valuesActiveHeld(picked, false, model.busy)
  const onHeld = valuesActiveHeld(picked, true, model.busy)
  const upHeld = valueMoveHeld(all, selected, -1, model.busy, searching)
  const downHeld = valueMoveHeld(all, selected, 1, model.busy, searching)
  const keys: ListKey[] = can
    ? [
        { keys: ['c'], does: t('keys.newValue') },
        { keys: ['↵'], does: t('keys.editCell') },
        { keys: ['Esc'], does: t('keys.cancel') },
      ]
    : []
  const usedBy = model.users.map((field) => labelIn(field, locale)).join(', ')

  return (
    <section className="fw-flds-section" aria-label={t('lists.title')}>
      <div className="fw-flds-listbar">
        <DsField label={t('lists.which')}>
          <Listbox
            options={model.picklists.map((entry) => ({
              value: entry.id,
              label: labelIn(entry, locale),
              note: entry.status === 'ARCHIVED' ? t('lists.archivedNote') : t('lists.note', { values: entry.values.length, fields: entry.fieldCount }),
            }))}
            value={list.id}
            searchable={model.picklists.length > 8}
            onChange={(id) => actions?.onList?.(id)}
          />
        </DsField>
        <div className="fw-flds-actions">
          {model.canManage && (
            <>
              <Button size="sm" heldReason={model.busy ? t('wait.busy') : null} onClick={() => actions?.onRenameList?.()}>
                <Pencil size={13} aria-hidden /> {t('lists.rename')}
              </Button>
              {list.status === 'ACTIVE' ? (
                <Button size="sm" variant="danger-outline" heldReason={archiveHeld ? t(archiveHeld, { count: list.fieldCount }) : null} onClick={() => actions?.onListState?.('ARCHIVED')}>
                  <Archive size={13} aria-hidden /> {t('lists.archive')}
                </Button>
              ) : (
                <Button size="sm" heldReason={model.busy ? t('wait.busy') : null} onClick={() => actions?.onListState?.('ACTIVE')}>
                  <RotateCcw size={13} aria-hidden /> {t('lists.restore')}
                </Button>
              )}
              <Button size="sm" heldReason={model.busy ? t('wait.busy') : null} onClick={() => actions?.onNewList?.()}>
                <Plus size={13} aria-hidden /> {t('lists.new')}
              </Button>
            </>
          )}
        </div>
      </div>
      <p className="fw-flds-muted">
        {model.users.length > 0 ? t('lists.usedBy', { record: model.recordLabel, fields: usedBy }) : list.fieldCount > 0 ? t('lists.usedElsewhere', { record: model.recordLabel, count: list.fieldCount }) : t('lists.unused')}
        {' '}
        <span>{t('lists.shared')}</span>
      </p>
      {list.status === 'ARCHIVED' && <Banner tone="neutral" title={t('lists.archivedTitle')}>{t('lists.archivedBody')}</Banner>}
      <ListFrame<ListValue>
        label={t('values.table', { list: labelIn(list, locale) })}
        listKey={null}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        rowKind="text"
        count={t('values.count', { active: all.filter((value) => value.active).length, inactive: all.filter((value) => !value.active).length })}
        search={<Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} aria-label={t('values.search')} placeholder={t('values.search')} value={query} onChange={(event) => setQuery(event.target.value)} />}
        right={
          <Button size="sm" variant="primary" heldReason={!model.canManage ? t('wait.noManage') : list.status !== 'ACTIVE' ? t('wait.listArchived') : model.busy ? t('wait.busy') : null} onClick={() => actions?.onNewValue?.()} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('values.new')}
          </Button>
        }
        selection={
          can
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <>
                    <Button size="sm" variant="danger-outline" heldReason={offHeld ? t(offHeld) : null} onClick={() => actions?.onValuesActive?.(selected, false)}>
                      <XCircle size={13} aria-hidden /> <SelectionLabel>{t('values.offMany', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" heldReason={onHeld ? t(onHeld) : null} onClick={() => actions?.onValuesActive?.(selected, true)}>
                      <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('values.onMany', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" heldReason={upHeld ? t(upHeld) : null} onClick={() => actions?.onMoveValues?.(selected, -1)}>
                      <ArrowUp size={13} aria-hidden /> <SelectionLabel>{t('move.up')}</SelectionLabel>
                    </Button>
                    <Button size="sm" heldReason={downHeld ? t(downHeld) : null} onClick={() => actions?.onMoveValues?.(selected, 1)}>
                      <ArrowDown size={13} aria-hidden /> <SelectionLabel>{t('move.down')}</SelectionLabel>
                    </Button>
                  </>
                ),
              }
            : undefined
        }
        keys={keys}
        onHelp={() => actions?.onKeys?.()}
        state={
          all.length === 0 ? (
            <EmptyState title={t('values.emptyTitle')} description={t(can ? 'values.emptyBody' : 'values.emptyBodyView')} />
          ) : rows.length === 0 ? (
            <EmptyState title={t('values.noMatch')} action={<Button size="sm" onClick={() => setQuery('')}>{t('values.clearSearch')}</Button>} />
          ) : undefined
        }
      />
    </section>
  )
}
