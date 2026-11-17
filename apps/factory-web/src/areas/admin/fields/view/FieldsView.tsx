'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, ArrowDown, ArrowUp, MoreHorizontal, Plus, RotateCcw, Search, SlidersHorizontal, XCircle } from 'lucide-react'
import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import { Banner, Card, EmptyState, Field as DsField, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, InfoTip, Input, Pill, SegmentedControl, Skeleton, Tag, Toggle } from '@nexus/ui/primitives'
import { AsOf, CellSaveMark, Listbox } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import type { LiveState } from '../../../../shell/live/use-live'
import type { Editor, EditorField, ListValue, RecordKey } from '../api'
import {
  BUILT_TABS,
  draftOfField,
  fieldsOfList,
  FIELDS_NS,
  labelIn,
  markKey,
  moveHeld,
  newDraft,
  portalHeld,
  PORTAL_RECORDS,
  previewSections,
  sectionsOf,
  sectionText,
  shownFields,
  shownList,
  stateHeld,
  TABS,
  type FieldDraft,
  type FieldsTab,
  type ListDraft,
  type Mark,
  type ValueDraft,
} from '../model'
import { FieldDialog, TYPE_ICONS, type FieldDialogActions, type FieldDialogModel } from './FieldDialog'
import { customerChoiceOn, customerLineOf } from '../model' // B-TH-242
import { FormPreview } from './FormPreview'
import { KeysDialog, LookDialog, NewListDialog, NewValueDialog, RenameListDialog } from './ListDialogs'
import { PicklistsPanel, type PicklistsActions } from './PicklistsPanel'
import '../fields.css'

export type FieldsDialogState =
  | { kind: 'field'; mode: 'new' | 'edit'; fieldId: string | null; draft: FieldDraft; fault: string | null }
  | { kind: 'list'; draft: ListDraft; fault: string | null }
  | { kind: 'rename'; listId: string; labelIt: string; labelEn: string; fault: string | null }
  | { kind: 'value'; listId: string; draft: ValueDraft; fault: string | null }
  | { kind: 'look'; listId: string; valueId: string }
  | { kind: 'keys' }

export type FieldCell = 'labelIt' | 'labelEn' | 'required' | 'shownInPortal'

/** The ONE view model of Admin › Fields & lists: what the container read and what is in flight. It fetches nothing. */
export interface FieldsViewModel {
  access: 'open' | 'refused'
  load: { status: 'loading' } | { status: 'error'; fault: string } | { status: 'ready' }
  /** The last answer of GET /fields/editor (kept while a new record type is read). */
  editor: Editor | null
  recordType: RecordKey | null
  tab: 'fields' | 'picklists'
  archived: boolean
  /** The picklist the address names. */
  listId: string | null
  /** When the editor was read (the band's AsOf) and "now" for it. */
  readAt: string | null
  now: number
  live: LiveState
  grains: readonly Grain[]
  /** The companies the person works in (whose a new field or list is). */
  companies: readonly { id: string; name: string }[]
  marks: Readonly<Record<string, Mark>>
  notice: { key: string; tone: 'success' | 'info' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
  busy: boolean
  dialog: FieldsDialogState | null
  /** B-TH-242: the "For: one customer" picker's search while the field dialog is open. */
  customers?: FieldDialogModel['customers']
  /** Design cases: rows selected, the search typed, the "Still loading…" note at once. */
  selected?: readonly string[]
  query?: string
  slow?: boolean
  values?: { selected?: readonly string[]; query?: string }
}

export interface FieldsActions {
  onType?: (type: RecordKey) => void
  onTab?: (tab: 'fields' | 'picklists') => void
  onArchived?: (on: boolean) => void
  onRetry?: () => void
  onDialog?: (dialog: FieldsDialogState | null) => void
  onCell?: (field: EditorField, cell: FieldCell, value: string | boolean) => void
  onStateMany?: (ids: readonly string[], status: 'ACTIVE' | 'ARCHIVED') => void
  onMoveFields?: (ids: readonly string[], delta: -1 | 1) => void
  onDismissNotice?: () => void
  field?: FieldDialogActions
  lists?: PicklistsActions & {
    onListDraft?: (draft: ListDraft) => void
    onCreateList?: () => void
    onRenameDraft?: (labels: { labelIt: string; labelEn: string }) => void
    onSaveRename?: () => void
    onValueDraft?: (draft: ValueDraft) => void
    onCreateValue?: () => void
    onLookChange?: (value: ListValue, change: { icon?: string | null; colour?: string | null }) => void
  }
}

/**
 * SCR-164 — Admin › Platform › Fields & lists (design admin.fields, settings-form; PLT-111, PLT-113, PLT-115). The band
 * (when read, live, ⋯ Export configuration — Later —, Add field), For which record (the record types with how many fields;
 * the choice is in the address), the tabs (Custom fields · Picklists; Statuses, Tags and Validation come later), Custom
 * fields on the shared list frame (labels in place, required and portal switches saved by themselves, a row opens its
 * field, Archive N · Restore N · Move up · Move down within a section) beside the live Form preview, and Picklists. Every
 * part says its loading, error and empty states; a reader without fields.manage reads it all.
 */
export function FieldsView({ model, actions }: { model: FieldsViewModel; actions?: FieldsActions }) {
  return (
    <WithMessages namespaces={[FIELDS_NS, 'lists', 'reasons']}>
      <Fields model={model} actions={actions} />
    </WithMessages>
  )
}

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  return element.closest?.('input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"], .ag-cell-inline-editing, .ag-popup-editor') != null
}

const cellKeys = (onEnter?: () => void) => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key === 'Enter' && onEnter) {
    if (event.type === 'keydown') onEnter()
    return true
  }
  return event.key.length === 1 && event.key !== ' '
}

function useSlow(loading: boolean, forced?: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loading) return setSlow(false)
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [loading])
  return forced ?? slow
}

function Fields({ model, actions }: { model: FieldsViewModel; actions?: FieldsActions }) {
  const t = useT(FIELDS_NS)
  const locale = useLocale()
  const editor = model.editor
  const ready = model.load.status === 'ready' && editor !== null
  const slow = useSlow(model.load.status === 'loading', model.slow)
  const canManage = editor?.canManage ?? false
  const record = editor?.records.find((entry) => entry.key === (model.recordType ?? editor.recordType)) ?? editor?.records[0] ?? null
  const recordWord = record ? labelIn(record, locale) : ''
  const [query, setQuery] = useState(model.query ?? '')
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected, model.recordType])
  useEffect(() => setQuery(model.query ?? ''), [model.query, model.recordType])
  const all = editor?.fields ?? []
  const rows = useMemo(() => shownFields(all, { archived: model.archived, query }), [all, model.archived, query])
  const rowsKey = all.map((field) => field.id).join(',')
  useEffect(() => setSelected((current) => current.filter((id) => all.some((field) => field.id === id))), [rowsKey])
  const picked = all.filter((field) => selected.includes(field.id))
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const marksKey = JSON.stringify(model.marks)
  const portalRecord = record ? PORTAL_RECORDS.has(record.key) : false
  const list = editor ? shownList(editor.picklists, model.listId) : null
  const dialog = model.dialog

  // c: Add field (Custom fields) or New value (Picklists); ? the keys. Not while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { model: now, actions: act } = latest.current
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || now.dialog || now.load.status !== 'ready' || !now.editor?.canManage) return
      if (event.key !== 'c') return
      event.preventDefault()
      if (now.tab === 'fields') act?.onDialog?.({ kind: 'field', mode: 'new', fieldId: null, draft: newDraftFor(now), fault: null })
      else act?.lists?.onNewValue?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const columns = useMemo<ColDef<EditorField>[]>(() => {
    const can = latest.current.model.editor?.canManage ?? false
    const Saved = ({ id, cell }: { id: string; cell: FieldCell }) => {
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
    const LabelCell = (cell: 'labelIt' | 'labelEn') =>
      function Label({ data, value }: ICellRendererParams<EditorField>) {
        if (!data) return null
        return (
          <span className="fw-flds-cell">
            <span className={data.status === 'ARCHIVED' ? 'fw-flds-words off' : 'fw-flds-words'}>{typeof value === 'string' ? value : ''}</span>
            <Saved id={data.id} cell={cell} />
          </span>
        )
      }
    const TypeCell = ({ data }: ICellRendererParams<EditorField>) => {
      if (!data) return null
      const Icon = TYPE_ICONS[data.type]
      const detail = data.unit
        ? data.unit
        : data.grain
          ? t(`grain.${data.grain}`)
          : data.picklist
            ? labelIn(data.picklist, locale)
            : data.linkRecordType
              ? t(`recordType.${data.linkRecordType}`)
              : null
      return (
        <span className="fw-flds-cell">
          <Icon size={14} aria-hidden />
          <span>{t(`type.${data.type}`)}</span>
          {detail && <span className="fw-flds-muted fw-flds-words">· {detail}</span>}
        </span>
      )
    }
    const SwitchCell = (cell: 'required' | 'shownInPortal') =>
      function Switch({ data }: ICellRendererParams<EditorField>) {
        if (!data) return null
        const on = data[cell]
        const held = cell === 'shownInPortal' ? portalHeld(data, PORTAL_RECORDS.has((latest.current.model.recordType ?? latest.current.model.editor?.recordType) as RecordKey)) : null
        const word = t(cell === 'required' ? (on ? 'col.requiredOn' : 'col.requiredOff') : on ? 'col.portalOn' : held ? 'col.portalNever' : 'col.portalOff')
        return (
          <span className="fw-flds-cell" title={held && !on ? t(held) : undefined}>
            {can && data.status === 'ACTIVE' && (held === null || on) ? (
              <Toggle size="xs" checked={on} aria-label={t(cell === 'required' ? 'col.requiredLabel' : 'col.portalLabel', { field: data.code })} onChange={(next) => latest.current.actions?.onCell?.(data, cell, next)} />
            ) : null}
            <span className={on ? undefined : 'fw-flds-muted'}>{word}</span>
            <Saved id={data.id} cell={cell} />
          </span>
        )
      }
    const editable = (): Partial<ColDef<EditorField>> =>
      can ? { editable: (params) => params.data?.status === 'ACTIVE', cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 80 } } : {}
    const label = (cell: 'labelIt' | 'labelEn', headerName: string): ColDef<EditorField> => ({
      colId: cell,
      headerName,
      field: cell,
      minWidth: 140,
      flex: 1.4,
      ...editable(),
      cellRenderer: LabelCell(cell),
      suppressKeyboardEvent: cellKeys(),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.onCell?.(params.data, cell, typeof params.newValue === 'string' ? params.newValue : '')
        return false
      },
    })
    const switchColumn = (cell: 'required' | 'shownInPortal', headerName: string): ColDef<EditorField> => ({
      colId: cell,
      headerName,
      field: cell,
      width: 130,
      minWidth: 110,
      maxWidth: 170,
      cellRenderer: SwitchCell(cell),
      suppressKeyboardEvent: (params) => {
        const data = params.data
        if (!can || !data || data.status !== 'ACTIVE') return cellKeys()(params)
        return cellKeys(() => latest.current.actions?.onCell?.(data, cell, !data[cell]))(params)
      },
    })
    return [
      label('labelIt', t('col.labelIt')),
      label('labelEn', t('col.labelEn')),
      { colId: 'code', headerName: t('col.code'), field: 'code', minWidth: 110, flex: 1, cellRenderer: ({ data }: ICellRendererParams<EditorField>) => (data ? <span className="fw-flds-code">{data.code}</span> : null), suppressKeyboardEvent: cellKeys() },
      { colId: 'type', headerName: t('col.type'), field: 'type', minWidth: 140, flex: 1.2, cellRenderer: TypeCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'section', headerName: t('col.section'), field: 'section', minWidth: 110, flex: 1, valueFormatter: (params) => (typeof params.value === 'string' ? (sectionText(params.value) ?? t('section.custom')) : ''), suppressKeyboardEvent: cellKeys() },
      switchColumn('required', t('col.required')),
      {
        colId: 'audience',
        headerName: t('col.audience'),
        field: 'audience',
        minWidth: 140,
        flex: 1.1,
        cellRenderer: ({ data }: ICellRendererParams<EditorField>) =>
          data ? (
            <span className="fw-flds-cell">
              <span className="fw-flds-words">{t(`audience.${data.audience}`)}</span>
              {data.grain && <Tag tone="info">{t(`grain.${data.grain}`)}</Tag>}
            </span>
          ) : null,
        suppressKeyboardEvent: cellKeys(),
      },
      switchColumn('shownInPortal', t('col.portal')),
      // B-TH-242 (X-ADM-FIELDS.dialog-F01): the field's line shows its customer ("Brand Alpha only"), on the record types that take one.
      ...(model.recordType && customerChoiceOn(model.recordType)
        ? [
            {
              colId: 'customer',
              headerName: t('col.customer'),
              minWidth: 140,
              flex: 1.1,
              valueGetter: ({ data }: { data?: EditorField }) => (data ? t(customerLineOf(data).key, customerLineOf(data).params) : ''),
              cellRenderer: ({ data }: ICellRendererParams<EditorField>) => {
                if (!data) return null
                const line = customerLineOf(data)
                return data.partyId ? <Tag tone="info">{t(line.key, line.params)}</Tag> : <span className="fw-flds-muted">{t(line.key)}</span>
              },
              suppressKeyboardEvent: cellKeys(),
            } as ColDef<EditorField>,
          ]
        : []),
      {
        colId: 'status',
        headerName: t('col.state'),
        field: 'status',
        width: 110,
        minWidth: 100,
        maxWidth: 150,
        cellRenderer: ({ data }: ICellRendererParams<EditorField>) => (data ? data.status === 'ACTIVE' ? <span>{t('state.ACTIVE')}</span> : <Pill tone="neutral">{t('state.ARCHIVED')}</Pill> : null),
        suppressKeyboardEvent: cellKeys(),
      },
      { colId: 'used', headerName: t('col.used'), field: 'valueCount', width: 110, minWidth: 100, maxWidth: 160, type: 'rightAligned', valueFormatter: (params) => t('col.usedCount', { count: Number(params.value ?? 0) }), suppressKeyboardEvent: cellKeys() },
    ]
    // The marks repaint the cells; the rest is read through `latest`.
  }, [t, locale, canManage, marksKey, model.recordType])

  if (model.access === 'refused') {
    return (
      <div className="fw-flds">
        <EmptyState icon={<SlidersHorizontal size={24} aria-hidden />} title={t('refused.title')} description={t('refused.body')} />
      </div>
    )
  }

  const searching = query.trim() !== ''
  const archiveHeld = stateHeld(picked, 'ARCHIVED', model.busy)
  const restoreHeld = stateHeld(picked, 'ACTIVE', model.busy)
  const upHeld = moveHeld(all, selected, -1, model.busy, searching)
  const downHeld = moveHeld(all, selected, 1, model.busy, searching)
  const addHeld = !ready ? 'wait.loading' : !canManage ? 'wait.noManage' : null
  const ownKeys: ListKey[] = canManage
    ? [
        { keys: ['c'], does: t('keys.add') },
        { keys: ['↵'], does: t('keys.open') },
        { keys: ['⌘', '↵'], does: t('keys.saveDialog') },
      ]
    : [{ keys: ['↵'], does: t('keys.open') }]
  const openField = (field: EditorField) => actions?.onDialog?.({ kind: 'field', mode: 'edit', fieldId: field.id, draft: draftOfField(field), fault: null })

  let fieldsState: ReactNode = undefined
  if (ready && all.length === 0) {
    fieldsState = (
      <EmptyState
        title={t('fields.emptyTitle', { record: recordWord })}
        description={t(canManage ? 'fields.emptyBody' : 'fields.emptyBodyView')}
        action={
          canManage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ kind: 'field', mode: 'new', fieldId: null, draft: newDraftFor(model), fault: null })}>
              <Plus size={14} aria-hidden /> {t('band.add')}
            </Button>
          ) : undefined
        }
      />
    )
  } else if (ready && rows.length === 0) {
    fieldsState = (
      <EmptyState
        title={searching ? t('fields.noMatch') : t('fields.allArchived')}
        action={searching ? <Button size="sm" onClick={() => setQuery('')}>{t('fields.clearSearch')}</Button> : <Button size="sm" onClick={() => actions?.onArchived?.(true)}>{t('fields.showArchived')}</Button>}
      />
    )
  }

  const fieldDialog = dialog?.kind === 'field' && editor && record ? dialog : null
  const editingField = fieldDialog?.fieldId ? (all.find((field) => field.id === fieldDialog.fieldId) ?? null) : null
  const dialogList = dialog && 'listId' in dialog && editor ? (editor.picklists.find((entry) => entry.id === dialog.listId) ?? null) : null
  const lookValue = dialog?.kind === 'look' && dialogList ? (dialogList.values.find((value) => value.id === dialog.valueId) ?? null) : null

  return (
    <div className="fw-flds">
      <div className="fw-flds-band" role="group" aria-label={t('band.label')}>
        <div className="fw-flds-actions">
          {model.readAt ? <AsOf at={model.readAt} now={model.now} /> : <span className="fw-flds-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </div>
        <div className="fw-flds-actions">
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[{ id: 'export', label: t('band.export'), disabled: true, description: t('later.W3') }]}
          />
          <Button variant="primary" heldReason={addHeld ? t(addHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'field', mode: 'new', fieldId: null, draft: newDraftFor(model), fault: null })} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('band.add')}
          </Button>
        </div>
      </div>

      {model.notice && (
        <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} onDismiss={actions?.onDismissNotice} />
      )}

      <div className="fw-flds-pickbar">
        <section className="fw-flds-pick" aria-label={t('pick.title')}>
          <DsField label={t('pick.title')} hint={t('pick.hint')}>
            {editor ? (
              <Listbox
                options={editor.records.map((entry) => ({
                  value: entry.key,
                  label: labelIn(entry, locale),
                  trailing: t('pick.count', { count: entry.fieldCount }),
                  ...(entry.sharedWith.length > 0 ? { note: t('pick.shared', { other: entry.sharedWith.map((key) => t(`recordType.${key}`)).join(', ') }) } : {}),
                }))}
                value={record?.key ?? ''}
                onChange={(value) => actions?.onType?.(value as RecordKey)}
                width={280}
              />
            ) : (
              <Skeleton height={32} width={280} />
            )}
          </DsField>
        </section>
        <section className="fw-flds-tabs" aria-label={t('tabs.label')}>
          <SegmentedControl
            ariaLabel={t('tabs.label')}
            size="sm"
            wrap
            value={model.tab}
            onChange={(value) => BUILT_TABS.has(value as FieldsTab) && actions?.onTab?.(value as 'fields' | 'picklists')}
            options={TABS.map((tab) => ({ value: tab, label: t(`tabs.${tab}`), disabled: !BUILT_TABS.has(tab), title: BUILT_TABS.has(tab) ? undefined : t('later.W3') }))}
          />
          <InfoTip tip={t('tabs.later')} />
        </section>
      </div>

      {record && record.sharedWith.length > 0 && <Banner tone="info" title={t('shared.title', { record: recordWord, other: record.sharedWith.map((key) => t(`recordType.${key}`)).join(', ') })}>{t('shared.body')}</Banner>}
      {ready && !canManage && <Banner tone="neutral" title={t('readOnly.title')}>{t('readOnly.body')}</Banner>}

      {model.load.status === 'error' ? (
        <EmptyState icon={<XCircle size={20} aria-hidden />} title={t(model.load.fault === 'fault.readForbidden' ? 'error.forbiddenTitle' : 'error.title')} description={t(model.load.fault)} action={model.load.fault === 'fault.readForbidden' ? undefined : <Button size="sm" onClick={() => actions?.onRetry?.()}>{t('error.retry')}</Button>} />
      ) : model.load.status === 'loading' && !editor ? (
        <div className="fw-flds-work" aria-busy="true">
          <div className="fw-flds-skeleton">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} height={28} />
            ))}
            {slow && <span className="fw-flds-muted">{t('state.stillLoading')}</span>}
          </div>
          <Card header={t('preview.title')}>
            <Skeleton height={120} />
          </Card>
        </div>
      ) : model.tab === 'picklists' && editor ? (
        <PicklistsPanel
          model={{ picklists: editor.picklists, list, users: list ? fieldsOfList(all, list.id) : [], recordLabel: recordWord, canManage, busy: model.busy, marks: model.marks, ...(model.values?.selected ? { selected: model.values.selected } : {}), ...(model.values?.query ? { query: model.values.query } : {}) }}
          actions={{ ...actions?.lists, onKeys: () => actions?.onDialog?.({ kind: 'keys' }) }}
        />
      ) : (
        <div className="fw-flds-work">
          <section className="fw-flds-section" aria-label={t('fields.title')}>
            <ListFrame<EditorField>
              label={t('fields.table', { record: recordWord })}
              listKey={null}
              rows={fieldsState ? [] : rows}
              rowId={(row) => row.id}
              columns={columns}
              rowKind="text"
              count={editor ? t('fields.count', { active: all.filter((field) => field.status === 'ACTIVE').length, archived: all.filter((field) => field.status === 'ARCHIVED').length }) : '—'}
              search={<Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} aria-label={t('fields.search')} placeholder={t('fields.search')} value={query} onChange={(event) => setQuery(event.target.value)} />}
              tools={
                <label className="fw-flds-switch small">
                  <Toggle size="xs" checked={model.archived} onChange={(on) => actions?.onArchived?.(on)} aria-label={t('fields.showArchived')} />
                  <span>{t('fields.showArchived')}</span>
                </label>
              }
              selection={
                canManage && ready
                  ? {
                      selected,
                      onChange: setSelected,
                      actions: (
                        <>
                          <Button size="sm" variant="danger-outline" heldReason={archiveHeld ? t(archiveHeld) : null} onClick={() => actions?.onStateMany?.(selected, 'ARCHIVED')}>
                            <Archive size={13} aria-hidden /> <SelectionLabel>{t('fields.archiveMany', { count: picked.length })}</SelectionLabel>
                          </Button>
                          <Button size="sm" heldReason={restoreHeld ? t(restoreHeld) : null} onClick={() => actions?.onStateMany?.(selected, 'ACTIVE')}>
                            <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('fields.restoreMany', { count: picked.length })}</SelectionLabel>
                          </Button>
                          <Button size="sm" heldReason={upHeld ? t(upHeld) : null} onClick={() => actions?.onMoveFields?.(selected, -1)}>
                            <ArrowUp size={13} aria-hidden /> <SelectionLabel>{t('move.up')}</SelectionLabel>
                          </Button>
                          <Button size="sm" heldReason={downHeld ? t(downHeld) : null} onClick={() => actions?.onMoveFields?.(selected, 1)}>
                            <ArrowDown size={13} aria-hidden /> <SelectionLabel>{t('move.down')}</SelectionLabel>
                          </Button>
                        </>
                      ),
                    }
                  : undefined
              }
              keys={ownKeys}
              onHelp={() => actions?.onDialog?.({ kind: 'keys' })}
              onOpen={openField}
              state={fieldsState}
            />
          </section>
          <Card className="fw-flds-preview-card" header={t('preview.title')} description={t('preview.hint', { record: recordWord })}>
            <FormPreview sections={previewSections(all)} recordLabel={recordWord} />
          </Card>
        </div>
      )}

      {fieldDialog && editor && record && (
        <FieldDialog
          model={{
            mode: fieldDialog.mode,
            field: editingField,
            draft: fieldDialog.draft,
            fault: fieldDialog.fault,
            recordType: record,
            picklists: editor.picklists,
            sections: [...new Set([...sectionsOf(all), ...(editingField ? [editingField.section] : [])])],
            codes: all.map((field) => field.code),
            grains: model.grains,
            companies: model.companies,
            portalRecord,
            busy: model.busy,
            canManage,
            customerChoice: customerChoiceOn(record.key), // B-TH-242
            customers: model.customers ?? null,
          }}
          actions={{ ...actions?.field, onDraft: (draft) => actions?.onDialog?.({ ...fieldDialog, draft }), onClose: () => actions?.onDialog?.(null), onPicklists: () => actions?.field?.onPicklists?.() }}
        />
      )}
      {dialog?.kind === 'list' && editor && (
        <NewListDialog draft={dialog.draft} fault={dialog.fault} codes={editor.picklists.map((entry) => entry.code)} companies={model.companies} busy={model.busy} onDraft={actions?.lists?.onListDraft} onSave={actions?.lists?.onCreateList} onClose={() => actions?.onDialog?.(null)} />
      )}
      {dialog?.kind === 'rename' && dialogList && (
        <RenameListDialog list={dialogList} labelIt={dialog.labelIt} labelEn={dialog.labelEn} fault={dialog.fault} busy={model.busy} onChange={actions?.lists?.onRenameDraft} onSave={actions?.lists?.onSaveRename} onClose={() => actions?.onDialog?.(null)} />
      )}
      {dialog?.kind === 'value' && dialogList && (
        <NewValueDialog list={dialogList} draft={dialog.draft} fault={dialog.fault} busy={model.busy} onDraft={actions?.lists?.onValueDraft} onSave={actions?.lists?.onCreateValue} onClose={() => actions?.onDialog?.(null)} />
      )}
      {dialog?.kind === 'look' && lookValue && (
        <LookDialog value={lookValue} mark={model.marks[markKey(lookValue.id, 'look')]} onLook={(change) => actions?.lists?.onLookChange?.(lookValue, change)} onClose={() => actions?.onDialog?.(null)} />
      )}
      {dialog?.kind === 'keys' && <KeysDialog keys={listKeys(ownKeys, canManage)} onClose={() => actions?.onDialog?.(null)} />}
    </div>
  )
}

/** A new field's draft: in the section of the first active field, of every company. */
export const newDraftFor = (model: Pick<FieldsViewModel, 'editor'>): FieldDraft => newDraft(model.editor?.fields.find((field) => field.status === 'ACTIVE')?.section ?? 'custom')
