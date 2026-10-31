'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { Download, ImageOff, MoreHorizontal, RotateCcw, Search, XCircle } from 'lucide-react'
import { EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, TagGlyph, Toggle } from '@nexus/ui/primitives'
import { DEFECT_CLASSES } from '@nexus/factory-domain/quality/defects/rules'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { zoneWords } from '../zones/zones'
import { addUnderHeld, bulkActiveHeld, deleteHeld, LIBRARY_VIEWS, markKey, stagesOf, type LibraryRow, type LibraryView, type Mark } from '../model'
import { SaveMark } from './parts'

export interface LibraryTableActions {
  onOpen?: (id: string) => void
  onCell?: (row: LibraryRow, field: 'labelIt' | 'labelEn' | 'severity' | 'active', value: unknown) => void
  onDelete?: (row: LibraryRow) => void
  onAddUnder?: (row: LibraryRow) => void
  onSelect?: (ids: readonly string[]) => void
  onBulkActive?: (active: boolean) => void
  onExport?: (ids: readonly string[]) => void
  onView?: (view: LibraryView) => void
  onSearch?: (q: string) => void
  onShowUpdates?: () => void
  onKeys?: () => void
  onStarter?: () => void
  onNew?: () => void
  onRetry?: () => void
}

/** A key a cell takes for itself (Enter on a switch); printable keys never start an edit (the list's keys). */
const cellKeys = (onEnter?: () => void) => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key === 'Enter' && onEnter) {
    if (event.type === 'keydown') onEnter()
    return true
  }
  return event.key.length === 1 && event.key !== ' '
}

/**
 * The defect library (design df-library; QHS-001) in the ONE list frame: each category, its defects indented under it;
 * code (icon and colour), words in Italian and English (autosaved per cell, CellSaveMark), picture, default class,
 * garment zone, stages, how often it is used, Active / Retired (retiring asks first). Row verbs ⋯, and with rows
 * selected Retire N · Restore N · Export N. Keys only in the footer's icon. Fetches nothing.
 */
export function LibraryTable({
  rows,
  read,
  canManage,
  marks,
  thumbs,
  selected,
  view,
  q,
  updates,
  starterMissing,
  busy,
  focusRow,
  actions,
}: {
  rows: readonly LibraryRow[]
  read: { loaded: boolean; problem: string | null; empty: boolean }
  canManage: boolean
  marks: Readonly<Record<string, Mark>>
  thumbs: Readonly<Record<string, string>>
  selected: readonly string[]
  view: LibraryView
  q: string
  updates: number
  starterMissing: number
  busy: boolean
  focusRow?: number
  actions?: LibraryTableActions
}) {
  const t = useT('defects')
  const tr = useT('reasons')
  const locale = useLocale()
  const latest = useRef({ actions, marks, thumbs, canManage })
  latest.current = { actions, marks, thumbs, canManage }
  const marksKey = JSON.stringify(marks)
  const thumbsKey = Object.keys(thumbs).join(',')

  const columns = useMemo<ColDef<LibraryRow>[]>(() => {
    const can = canManage
    const mark = (id: string, field: string) => latest.current.marks[markKey(id, field)]
    const CodeCell = ({ data }: ICellRendererParams<LibraryRow>) => {
      if (!data) return null
      const code = data.code
      const look = `${code.icon ? tr(`icon.${code.icon}`) : tr('look.noIcon')}`
      return (
        <span className={data.kind === 'category' ? 'fw-df-code is-category' : 'fw-df-code is-defect'}>
          <TagGlyph icon={code.icon} color={code.colour} size={16} />
          <span className="fw-df-cell">
            <button type="button" className="fw-df-name" tabIndex={-1} onClick={() => latest.current.actions?.onOpen?.(data.id)} aria-label={t('row.openNamed', { code: code.code })}>
              {code.code}
            </button>
            <span className="fw-df-sub">{data.kind === 'category' ? t('row.categoryOf', { count: data.defects }) : t('row.lookWords', { look })}</span>
          </span>
        </span>
      )
    }
    const WordsCell = (field: 'labelIt' | 'labelEn') =>
      function Words({ data }: ICellRendererParams<LibraryRow>) {
        if (!data) return null
        return (
          <span className="fw-df-cell-row">
            <span className={data.kind === 'category' ? 'fw-df-words is-category' : 'fw-df-words'}>{data.code[field]}</span>
            <SaveMark mark={mark(data.id, field)} />
          </span>
        )
      }
    const PictureCell = ({ data }: ICellRendererParams<LibraryRow>) => {
      if (!data) return null
      const fileId = data.code.pictureFileId
      const src = fileId ? latest.current.thumbs[fileId] : undefined
      if (!fileId) {
        return (
          <span className="fw-df-cell-row fw-df-sub">
            <ImageOff size={14} aria-hidden /> {t('picture.none')}
          </span>
        )
      }
      return src ? <img className="fw-df-thumb" src={src} alt={t('picture.alt', { code: data.code.code })} /> : <span className="fw-df-sub">{t('picture.has')}</span>
    }
    const SeverityCell = ({ data }: ICellRendererParams<LibraryRow>) => {
      if (!data) return null
      if (data.kind === 'category') return <span className="fw-df-sub">{t('severity.category')}</span>
      const severity = data.code.severity
      return (
        <span className="fw-df-cell-row">
          {can ? (
            <Select
              size="sm"
              aria-label={t('col.severityOf', { code: data.code.code })}
              value={severity ?? ''}
              onChange={(event) => latest.current.actions?.onCell?.(data, 'severity', event.target.value)}
            >
              {DEFECT_CLASSES.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`severity.${entry}`)}
                </option>
              ))}
            </Select>
          ) : (
            <Pill tone={severity === 'CRITICAL' ? 'danger' : severity === 'MAJOR' ? 'warning' : 'neutral'}>{severity ? t(`severity.${severity}`) : t('severity.none')}</Pill>
          )}
          <SaveMark mark={mark(data.id, 'severity')} />
        </span>
      )
    }
    const ZoneCell = ({ data }: ICellRendererParams<LibraryRow>) => {
      if (!data) return null
      if (data.kind === 'category') return <span className="fw-df-sub">{t('zone.category')}</span>
      return <span className={data.code.zone ? undefined : 'fw-df-sub'}>{data.code.zone ? zoneWords(data.code.zone, locale) : t('zone.none')}</span>
    }
    const StagesCell = ({ data }: ICellRendererParams<LibraryRow>) => {
      if (!data) return null
      const stages = stagesOf(data.code)
      return <span className={stages.length === 0 ? 'fw-df-sub' : undefined}>{stages.length === 0 ? t('stages.every') : stages.map((stage) => t(`stage.${stage}`)).join(' · ')}</span>
    }
    const UsedCell = ({ data }: ICellRendererParams<LibraryRow>) =>
      data ? <span className={data.code.usedCount === 0 ? 'fw-df-sub' : undefined}>{data.code.usedCount === 0 ? t('used.none') : t('used.count', { count: data.code.usedCount })}</span> : null
    const StatusCell = ({ data }: ICellRendererParams<LibraryRow>) => {
      if (!data) return null
      const on = data.code.active
      return (
        <span className="fw-df-cell-row">
          {can && <Toggle size="xs" checked={on} aria-label={t(on ? 'status.retireOf' : 'status.restoreOf', { code: data.code.code })} onChange={(next) => latest.current.actions?.onCell?.(data, 'active', next)} />}
          {on ? <span>{t('status.active')}</span> : <Pill tone="neutral">{t('status.retired')}</Pill>}
          <SaveMark mark={mark(data.id, 'active')} />
        </span>
      )
    }
    const ActionsCell = ({ data }: ICellRendererParams<LibraryRow>) => {
      if (!data) return null
      const held = deleteHeld(data, can)
      const under = data.kind === 'category' ? addUnderHeld(data.code, can) : null
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), onSelect: () => latest.current.actions?.onOpen?.(data.id) },
        {
          id: 'active',
          label: t(data.code.active ? 'row.retire' : 'row.restore'),
          disabled: !can,
          description: can ? undefined : t('held.noManage'),
          onSelect: () => latest.current.actions?.onCell?.(data, 'active', !data.code.active),
        },
        ...(data.kind === 'category'
          ? [{ id: 'under', label: t('row.addUnder'), disabled: under !== null, description: under ? t(under) : undefined, onSelect: () => latest.current.actions?.onAddUnder?.(data) }]
          : []),
        { id: 'delete', label: t('row.delete'), disabled: held !== null, description: held ? t(held.key, held.params) : undefined, onSelect: () => latest.current.actions?.onDelete?.(data) },
        { id: 'sep', separator: true },
        { id: 'copy', label: t('row.copyCode'), onSelect: () => void navigator.clipboard?.writeText(data.code.code) },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { code: data.code.code }) }} items={items} />
    }
    const editable = (field: 'labelIt' | 'labelEn'): ColDef<LibraryRow> => ({
      colId: field,
      headerName: t(field === 'labelIt' ? 'col.it' : 'col.en'),
      minWidth: 160,
      flex: 1.4,
      valueGetter: (params) => params.data?.code[field] ?? '',
      ...(can ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 80 } } : {}),
      cellRenderer: WordsCell(field),
      suppressKeyboardEvent: cellKeys(),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.onCell?.(params.data, field, params.newValue)
        return false
      },
    })
    return [
      { colId: 'code', headerName: t('col.code'), minWidth: 200, flex: 1.4, cellRenderer: CodeCell, suppressKeyboardEvent: cellKeys() },
      editable('labelIt'),
      editable('labelEn'),
      { colId: 'picture', headerName: t('col.picture'), minWidth: 150, flex: 0.9, cellRenderer: PictureCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'severity', headerName: t('col.severity'), minWidth: 150, flex: 1, cellRenderer: SeverityCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'zone', headerName: t('col.zone'), minWidth: 140, flex: 1, cellRenderer: ZoneCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'stages', headerName: t('col.stages'), minWidth: 170, flex: 1.3, cellRenderer: StagesCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'used', headerName: t('col.used'), minWidth: 120, flex: 0.8, cellRenderer: UsedCell, suppressKeyboardEvent: cellKeys() },
      {
        colId: 'status',
        headerName: t('col.status'),
        minWidth: 150,
        flex: 0.9,
        cellRenderer: StatusCell,
        suppressKeyboardEvent: can
          ? (params: { event: KeyboardEvent; editing: boolean; data?: LibraryRow }) => cellKeys(() => params.data && latest.current.actions?.onCell?.(params.data, 'active', !params.data.code.active))(params)
          : cellKeys(),
      },
      { colId: 'actions', headerName: t('col.actions'), width: 72, minWidth: 72, cellRenderer: ActionsCell, suppressHeaderMenuButton: true, sortable: false },
    ]
    // The cells read the marks and pictures through `latest`; a change of either redraws them.
  }, [t, tr, locale, canManage, marksKey, thumbsKey])

  const picked = rows.filter((row) => selected.includes(row.id)).map((row) => row.code)
  const retireHeld = bulkActiveHeld(picked, false, canManage, busy)
  const restoreHeld = bulkActiveHeld(picked, true, canManage, busy)
  const count = selected.length
  const bulk = (
    <>
      <Button size="sm" heldReason={retireHeld ? t(retireHeld) : null} onClick={() => actions?.onBulkActive?.(false)} aria-label={t('bulk.retire', { count })}>
        <XCircle size={13} aria-hidden /> <SelectionLabel>{t('bulk.retire', { count })}</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={restoreHeld ? t(restoreHeld) : null} onClick={() => actions?.onBulkActive?.(true)} aria-label={t('bulk.restore', { count })}>
        <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('bulk.restore', { count })}</SelectionLabel>
      </Button>
      <Button size="sm" onClick={() => actions?.onExport?.(selected)} aria-label={t('bulk.export', { count })}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count })}</SelectionLabel>
      </Button>
    </>
  )
  const viewItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('library.rowsHeading') },
    ...LIBRARY_VIEWS.map((entry) => ({ id: entry, label: t(`library.view.${entry}`), checked: view === entry, onSelect: () => actions?.onView?.(entry) })),
  ]
  const search = (
    <span className="fw-df-search">
      <Search size={14} aria-hidden />
      <Input size="sm" type="search" value={q} placeholder={t('library.search')} aria-label={t('library.search')} onChange={(event) => actions?.onSearch?.(event.target.value)} />
    </span>
  )
  const state: ReactNode = read.problem ? (
    <EmptyState
      title={t('library.failed')}
      description={t(read.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : read.loaded && read.empty ? (
    <EmptyState
      title={t('library.empty.title')}
      description={t('library.empty.body', { count: starterMissing })}
      action={
        <span className="fw-df-actions">
          <Button size="sm" variant="primary" heldReason={canManage ? null : t('held.noManage')} onClick={() => actions?.onStarter?.()}>
            {t('starter.add')}
          </Button>
          <Button size="sm" heldReason={canManage ? null : t('held.noManage')} onClick={() => actions?.onNew?.()}>
            {t('head.addDefect')}
          </Button>
        </span>
      }
    />
  ) : read.loaded && rows.length === 0 ? (
    <EmptyState
      title={t('library.none')}
      action={
        <Button
          size="sm"
          onClick={() => {
            actions?.onSearch?.('')
            actions?.onView?.('all')
          }}
        >
          {t('library.clear')}
        </Button>
      }
    />
  ) : undefined
  const keys: ListKey[] = [
    { keys: ['c'], does: t('keys.add') },
    { keys: ['↵'], does: t('keys.open') },
  ]
  return (
    <ListFrame<LibraryRow>
      label={t('library.table')}
      title={t('library.title')}
      listKey="quality.defects"
      rows={read.problem ? [] : read.loaded ? rows : null}
      rowId={(row) => row.id}
      columns={columns}
      count={!read.loaded ? t('library.countReading') : t('library.count', { count: rows.filter((row) => row.kind === 'defect').length, categories: rows.filter((row) => row.kind === 'category').length })}
      search={search}
      tools={<Menu label={t('library.rows', { view: t(`library.view.${view}`) })} items={viewItems} />}
      selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
      updates={updates > 0 ? { count: updates, onShow: () => actions?.onShowUpdates?.() } : null}
      keys={keys}
      onHelp={() => actions?.onKeys?.()}
      onOpen={(row) => actions?.onOpen?.(row.id)}
      state={state}
      focusRow={focusRow}
    />
  )
}
