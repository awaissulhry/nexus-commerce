'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Lock, Plus, RotateCcw, Search, ShieldOff, Sparkles, XCircle } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Kbd, Pill, Select, Tag, Toggle } from '@nexus/ui/primitives'
import { CellSaveMark, Modal } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { iconOf } from '../../../../lib/plant/symptom-icons'
import { WithMessages } from '../../../../record-panels/i18n'
import { labelOf } from '../../_shared/model'
import type { ClassRow, SymptomRow } from '../api'
import {
  activeHeld,
  ALL,
  classWords,
  draftHeld,
  EVERY,
  markKey,
  moveHeld,
  offeredFor,
  PLANT_SETTINGS_NAMESPACES,
  typedCode,
  visibleRows,
  type CellField,
  type Mark,
  type Notice,
  type SymptomDraft,
} from '../model'
import { SymptomIconPicker } from './SymptomIconPicker'
import '../settings.css'

export type SymptomDialog = { kind: 'new'; draft: SymptomDraft; problem: string | null } | { kind: 'icon'; id: string } | { kind: 'unsafeOff'; id: string } | { kind: 'keys' }

/** The ONE view model of Plant settings (SCR-241): what the page read and what is in flight. It fetches nothing. */
export interface PlantSettingsModel {
  /** plant.view (the person's): without it the page says so and reads nothing. */
  canView: boolean
  load: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready' }
  /** Every symptom of the group as read, in the list's order (null while loading or after a failed read). */
  symptoms: readonly SymptomRow[] | null
  /** Every machine class of the group (a retired one still names its symptoms). */
  classes: readonly ClassRow[]
  /** Starter codes (classes and symptoms) the group does not have yet. */
  starterMissing: readonly string[]
  /** plant.machines.manage over every company (the API's word): the lists are the whole group's. */
  canManage: boolean
  /** `all`, `every`, or a class id (`?class=`). */
  classFilter: string
  marks: Readonly<Record<string, Mark>>
  notice: Notice | null
  changedElsewhere: boolean
  busy: boolean
  dialog: SymptomDialog | null
  /** Design cases: rows selected, the row with the focus, the search typed. */
  selected?: readonly string[]
  focusRow?: number
  query?: string
}

export interface PlantSettingsActions {
  onRetry?: () => void
  onReload?: () => void
  onClass?: (filter: string) => void
  /** A word cell typed (Italian or English). */
  onCell?: (row: SymptomRow, field: 'labelIt' | 'labelEn', value: unknown) => void
  onIcon?: (row: SymptomRow, icon: string | null) => void
  /** A switch: turning "Locks the machine" off goes through the confirm (onDialog unsafeOff) first. */
  onSwitch?: (row: SymptomRow, field: 'unsafe' | 'needsDetail' | 'active', next: boolean) => void
  onActiveMany?: (ids: readonly string[], active: boolean) => void
  onMove?: (ids: readonly string[], delta: -1 | 1) => void
  onStarter?: () => void
  onDialog?: (dialog: SymptomDialog | null) => void
  onDraft?: (draft: SymptomDraft) => void
  onCreate?: () => void
  onDismissNotice?: () => void
}

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/**
 * SCR-241 — Plant › Settings › Plant settings, its W2a section "Symptoms on the floor" (design plant.settings sec:symptoms;
 * QHS-178; W2A-PLAN §10: a W2a section on the W2b page, so the page holds only it — routing, the unsafe lock and the
 * statutory checks come with W2b). The icons operators pick, per machine class: ONE list frame of the group's symptoms —
 * code · icon · words in Italian and English · what it is for (a class, or every machine) · whether reporting it locks
 * the machine at once (Owner answer H1) · whether it asks for words · offered on the floor · used — with a class filter
 * that shows what a station of that class offers, "Add N from the starter set", New symptom (`c`), and with rows
 * selected Stop offering · Offer again · Move up · Move down.
 *
 * Decision against the design: the section's interaction is the design's EditModeBar, but the shared reason code
 * editor (SCR-242) — the other list of floor tiles with icons — saves per cell; the factory keeps ONE edit model for its
 * code lists, so every cell here saves on its own with its DS CellSaveMark too. Turning "Locks the machine" off asks first
 * (a loosening of a safety rule); turning it on saves at once. A symptom's code and class never change; a used symptom is
 * taken off the floor, never deleted. Keys only in the footer's icon. Fetches nothing.
 */
export function PlantSettingsView({ model, actions }: { model: PlantSettingsModel; actions?: PlantSettingsActions }) {
  return (
    <WithMessages namespaces={PLANT_SETTINGS_NAMESPACES}>
      <Settings model={model} actions={actions} />
    </WithMessages>
  )
}

function Settings({ model, actions }: { model: PlantSettingsModel; actions?: PlantSettingsActions }) {
  const t = useT('plant-settings')
  if (!model.canView)
    return (
      <div className="fw-pls">
        <Card padded>
          <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  return (
    <div className="fw-pls">
      <Card header={t('title')} description={t('hint')} headingLevel={2}>
        <Editor model={model} actions={actions} />
      </Card>
    </div>
  )
}

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  return element.closest?.('input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"], .ag-cell-inline-editing, .ag-popup-editor') != null
}

/** A key the cell took for itself (Enter on a switch or the icon); printable keys never start an edit (the list's keys). */
const cellKeys = (onEnter?: () => void) => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key === 'Enter' && onEnter) {
    if (event.type === 'keydown') onEnter()
    return true
  }
  return event.key.length === 1 && event.key !== ' '
}

const newDraft = (filter: string): SymptomDraft => ({ code: '', classId: filter !== ALL && filter !== EVERY ? filter : null, labelIt: '', labelEn: '', icon: null, unsafe: false, needsDetail: false })

function Editor({ model, actions }: { model: PlantSettingsModel; actions?: PlantSettingsActions }) {
  const t = useT('plant-settings') as Translate
  const locale = useLocale()
  const [query, setQuery] = useState(model.query ?? '')
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  useEffect(() => setQuery(model.query ?? ''), [model.query])
  const all = model.symptoms
  const rows = useMemo(() => (all ? visibleRows(all, model.classFilter, query) : null), [all, model.classFilter, query])
  const rowsKey = all?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => all?.some((row) => row.id === id))), [rowsKey])
  const picked = (all ?? []).filter((row) => selected.includes(row.id))
  const codes = useMemo(() => (all ?? []).map((row) => row.code), [all])
  const dialogRow = model.dialog && (model.dialog.kind === 'icon' || model.dialog.kind === 'unsafeOff') ? ((all ?? []).find((row) => row.id === (model.dialog as { id: string }).id) ?? null) : null

  // The latest model and actions for the cells' handlers (the columns do not change with every keystroke).
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || latest.current.model.dialog) return
      if (event.key === 'c' && latest.current.model.canManage && latest.current.model.load.status === 'ready') {
        event.preventDefault()
        latest.current.actions?.onDialog?.({ kind: 'new', draft: newDraft(latest.current.model.classFilter), problem: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const marksKey = JSON.stringify(model.marks)
  const classesKey = model.classes.map((entry) => `${entry.id}:${entry.active}:${entry.labelIt}:${entry.labelEn}`).join(',')

  const columns = useMemo<ColDef<SymptomRow>[]>(() => {
    const can = model.canManage
    const mark = (id: string, field: CellField) => latest.current.model.marks[markKey(id, field)]
    const Saved = ({ id, field }: { id: string; field: CellField }) => {
      const state = mark(id, field)
      if (!state || state.state === 'saved') return null
      return state.state === 'refused' ? (
        <span className="fw-pls-refused" role="img" aria-label={t(state.problem ?? 'problem.failed')} title={t(state.problem ?? 'problem.failed')}>
          !
        </span>
      ) : (
        <CellSaveMark state={state.state} />
      )
    }
    const CodeCell = ({ data }: ICellRendererParams<SymptomRow>) => (data ? <span className={data.active ? 'fw-pls-code' : 'fw-pls-code off'}>{data.code}</span> : null)
    const IconCell = ({ data }: ICellRendererParams<SymptomRow>) => {
      if (!data) return null
      const Icon = iconOf(data.icon)
      const words = iconWords(t, data.icon)
      const glyph = (
        <span className="fw-pls-look">
          <Icon size={16} aria-hidden />
          <span className="fw-pls-sub">{words}</span>
        </span>
      )
      return (
        <span className="fw-pls-cell">
          {can ? (
            <Button size="sm" variant="quiet" aria-label={t('iconDialog.change', { code: data.code, icon: words })} onClick={() => latest.current.actions?.onDialog?.({ kind: 'icon', id: data.id })}>
              {glyph}
            </Button>
          ) : (
            glyph
          )}
          <Saved id={data.id} field="icon" />
        </span>
      )
    }
    const WordsCell = (field: 'labelIt' | 'labelEn') =>
      function Words({ data, value }: ICellRendererParams<SymptomRow>) {
        if (!data) return null
        return (
          <span className="fw-pls-cell">
            <span className="fw-pls-words">{typeof value === 'string' ? value : ''}</span>
            <Saved id={data.id} field={field} />
          </span>
        )
      }
    const ForCell = ({ data }: ICellRendererParams<SymptomRow>) => {
      if (!data) return null
      const found = classWords(data.classId, latest.current.model.classes, locale)
      return <span className={found.key === 'for.every' ? 'fw-pls-sub' : undefined}>{'words' in found ? t(found.key, { class: found.words }) : t(found.key)}</span>
    }
    const SwitchCell = (field: 'unsafe' | 'needsDetail' | 'active') =>
      function Switch({ data }: ICellRendererParams<SymptomRow>) {
        if (!data) return null
        const on = data[field]
        const word = t(`${field === 'needsDetail' ? 'detail' : field}.${on ? 'on' : 'off'}`)
        const label = t(`${field === 'needsDetail' ? 'detail' : field}.label`, { code: data.code })
        const shown =
          field === 'active' && !on ? (
            <Pill tone="neutral">{word}</Pill>
          ) : field === 'unsafe' && on ? (
            <Tag tone="danger">
              <Lock size={11} aria-hidden /> {word}
            </Tag>
          ) : (
            <span className={on ? undefined : 'fw-pls-sub'}>{word}</span>
          )
        return (
          <span className="fw-pls-cell">
            {can ? <Toggle size="xs" checked={on} aria-label={label} onChange={(next) => switchTo(data, field, next)} /> : null}
            {shown}
            <Saved id={data.id} field={field} />
          </span>
        )
      }
    const switchTo = (row: SymptomRow, field: 'unsafe' | 'needsDetail' | 'active', next: boolean) => {
      if (field === 'unsafe' && !next) latest.current.actions?.onDialog?.({ kind: 'unsafeOff', id: row.id })
      else latest.current.actions?.onSwitch?.(row, field, next)
    }
    const UsedCell = ({ data }: ICellRendererParams<SymptomRow>) => (data ? <span title={t(data.requests > 0 ? 'used.hint' : 'used.none', { count: data.requests })}>{t('used.count', { count: data.requests })}</span> : null)

    const editable = () => (can ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 80 } } : {})
    const words = (field: 'labelIt' | 'labelEn', headerName: string): ColDef<SymptomRow> => ({
      colId: field,
      headerName,
      field,
      minWidth: 140,
      flex: 1.4,
      ...editable(),
      cellRenderer: WordsCell(field),
      suppressKeyboardEvent: cellKeys(),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.onCell?.(params.data, field, params.newValue)
        return false
      },
    })
    const switchColumn = (field: 'unsafe' | 'needsDetail' | 'active', headerName: string, width: number): ColDef<SymptomRow> => ({
      colId: field,
      headerName,
      field,
      width,
      minWidth: 110,
      maxWidth: 200,
      cellRenderer: SwitchCell(field),
      suppressKeyboardEvent: can ? (params) => cellKeys(() => params.data && switchTo(params.data, field, !params.data[field]))(params) : cellKeys(),
    })
    return [
      { colId: 'code', headerName: t('col.code'), field: 'code', minWidth: 150, flex: 1, cellRenderer: CodeCell, suppressKeyboardEvent: cellKeys() },
      {
        colId: 'icon',
        headerName: t('col.icon'),
        minWidth: 140,
        flex: 1,
        cellRenderer: IconCell,
        suppressKeyboardEvent: can ? (params) => cellKeys(() => params.data && latest.current.actions?.onDialog?.({ kind: 'icon', id: params.data.id }))(params) : cellKeys(),
      },
      words('labelIt', t('col.it')),
      words('labelEn', t('col.en')),
      { colId: 'for', headerName: t('col.for'), minWidth: 120, flex: 1, cellRenderer: ForCell, suppressKeyboardEvent: cellKeys() },
      switchColumn('unsafe', t('col.unsafe'), 150),
      switchColumn('needsDetail', t('col.needsDetail'), 130),
      switchColumn('active', t('col.active'), 130),
      { colId: 'used', headerName: t('col.used'), field: 'requests', width: 100, minWidth: 90, maxWidth: 160, type: 'rightAligned', cellRenderer: UsedCell, suppressKeyboardEvent: cellKeys() },
    ]
    // The marks and classes repaint the cells; the rest of the model is read through `latest`.
  }, [t, locale, model.canManage, marksKey, classesKey])

  const ownKeys: ListKey[] = model.canManage
    ? [
        { keys: ['c'], does: t('keys.new') },
        { keys: ['↵'], does: t('keys.edit') },
        { keys: ['Esc'], does: t('keys.cancel') },
      ]
    : []

  const narrowed = query.trim() !== '' || model.classFilter !== ALL
  const ready = model.load.status === 'ready' && all !== null
  const offered = (all ?? []).filter((row) => row.active).length
  const count = all ? t('count', { offered, off: all.length - offered }) : '—'
  const missing = model.starterMissing.length
  const offHeld = activeHeld(picked, false, model.busy)
  const onHeld = activeHeld(picked, true, model.busy)
  const upHeld = all ? moveHeld(all, selected, -1, model.busy, narrowed) : 'held.busy'
  const downHeld = all ? moveHeld(all, selected, 1, model.busy, narrowed) : 'held.busy'
  const starterHeld = !model.canManage ? 'held.noManage' : model.busy ? 'held.busy' : null
  const openNew = () => actions?.onDialog?.({ kind: 'new', draft: newDraft(model.classFilter), problem: null })
  const chosenClass = model.classes.find((entry) => entry.id === model.classFilter) ?? null
  const activeClasses = model.classes.filter((entry) => entry.active || entry.id === model.classFilter)

  let state: ReactNode = undefined
  if (model.load.status === 'error') {
    const forbidden = model.load.problem === 'problem.readForbidden'
    state = (
      <EmptyState
        icon={<XCircle size={20} aria-hidden />}
        title={t(forbidden ? 'state.forbiddenTitle' : 'state.errorTitle')}
        description={t(model.load.problem)}
        action={forbidden ? undefined : <Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>}
      />
    )
  } else if (ready && all && all.length === 0) {
    state = (
      <EmptyState
        title={t('state.emptyTitle')}
        description={t(model.canManage ? 'state.emptyBody' : 'state.emptyBodyView')}
        action={
          model.canManage ? (
            <span className="fw-pls-actions">
              {missing > 0 && (
                <Button size="sm" variant="primary" heldReason={starterHeld ? t(starterHeld) : null} onClick={() => actions?.onStarter?.()}>
                  <Sparkles size={14} aria-hidden /> {t('starter.add', { count: missing })}
                </Button>
              )}
              <Button size="sm" variant={missing > 0 ? 'secondary' : 'primary'} onClick={openNew}>
                <Plus size={14} aria-hidden /> {t('state.first')}
              </Button>
            </span>
          ) : undefined
        }
      />
    )
  } else if (ready && rows && rows.length === 0) {
    state = (
      <EmptyState
        title={t('state.noMatch')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onClass?.(ALL)
            }}
          >
            {t('state.clear')}
          </Button>
        }
      />
    )
  }

  return (
    <section className="fw-pls-editor" aria-label={t('title')}>
      {model.changedElsewhere && (
        <Banner tone="info" title={t('changed.title')} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('changed.reload')}</Button>}>
          {t('changed.body')}
        </Banner>
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('close')}
            </Button>
          }
        />
      )}
      {ready && !model.canManage && <Banner tone="neutral" title={t('readOnly.title')}>{t('readOnly.body')}</Banner>}
      {chosenClass && all && (
        <p className="fw-pls-hint" role="status">
          {t('classHint', { class: labelOf(chosenClass, locale), count: offeredFor(all, chosenClass.id) })}
        </p>
      )}
      <ListFrame<SymptomRow>
          label={t('table')}
          rows={state ? [] : rows}
          rowId={(row) => row.id}
          columns={columns}
          rowKind="text"
          count={count}
          search={<Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} aria-label={t('search')} placeholder={t('search')} value={query} onChange={(event) => setQuery(event.target.value)} />}
          tools={
            <Select size="sm" aria-label={t('classFilter.label')} value={model.classFilter} onChange={(event) => actions?.onClass?.(event.target.value)}>
              <option value={ALL}>{t('classFilter.all')}</option>
              <option value={EVERY}>{t('classFilter.every')}</option>
              {activeClasses.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {labelOf(entry, locale)}
                </option>
              ))}
            </Select>
          }
          right={
            <>
              {missing > 0 && ready && (all?.length ?? 0) > 0 && (
                <Button size="sm" heldReason={starterHeld ? t(starterHeld) : null} onClick={() => actions?.onStarter?.()}>
                  <Sparkles size={13} aria-hidden /> <SelectionLabel>{t('starter.add', { count: missing })}</SelectionLabel>
                </Button>
              )}
              <Button size="sm" variant="primary" heldReason={!ready ? t('held.loading') : model.canManage ? null : t('held.noManage')} onClick={openNew} aria-keyshortcuts="c">
                <Plus size={14} aria-hidden /> {t('new')}
              </Button>
            </>
          }
          selection={
            model.canManage && ready
              ? {
                  selected,
                  onChange: setSelected,
                  actions: (
                    <>
                      <Button size="sm" variant="danger-outline" aria-label={t('bulk.off', { count: picked.length })} heldReason={offHeld ? t(offHeld) : null} onClick={() => actions?.onActiveMany?.(selected, false)}>
                        <XCircle size={13} aria-hidden /> <SelectionLabel>{t('bulk.off', { count: picked.length })}</SelectionLabel>
                      </Button>
                      <Button size="sm" aria-label={t('bulk.on', { count: picked.length })} heldReason={onHeld ? t(onHeld) : null} onClick={() => actions?.onActiveMany?.(selected, true)}>
                        <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('bulk.on', { count: picked.length })}</SelectionLabel>
                      </Button>
                      <Button size="sm" aria-label={t('bulk.up')} heldReason={upHeld ? t(upHeld) : null} onClick={() => actions?.onMove?.(selected, -1)}>
                        <ArrowUp size={13} aria-hidden /> <SelectionLabel>{t('bulk.up')}</SelectionLabel>
                      </Button>
                      <Button size="sm" aria-label={t('bulk.down')} heldReason={downHeld ? t(downHeld) : null} onClick={() => actions?.onMove?.(selected, 1)}>
                        <ArrowDown size={13} aria-hidden /> <SelectionLabel>{t('bulk.down')}</SelectionLabel>
                      </Button>
                    </>
                  ),
                }
              : undefined
          }
          keys={ownKeys}
          onHelp={() => actions?.onDialog?.({ kind: 'keys' })}
          state={state}
          focusRow={model.focusRow}
        />
      {model.dialog?.kind === 'new' && <NewSymptomDialog dialog={model.dialog} classes={model.classes} codes={codes} busy={model.busy} actions={actions} />}
      {model.dialog?.kind === 'icon' && dialogRow && <IconDialog row={dialogRow} mark={model.marks[markKey(dialogRow.id, 'icon')]} actions={actions} />}
      {model.dialog?.kind === 'unsafeOff' && dialogRow && <UnsafeOffDialog row={dialogRow} busy={model.busy} actions={actions} />}
      {model.dialog?.kind === 'keys' && <KeysDialog keys={listKeys(ownKeys, model.canManage)} onClose={() => actions?.onDialog?.(null)} />}
    </section>
  )
}

/** An icon's words (`icon.<id>`), "No icon" for none. */
function iconWords(t: Translate, id: string | null): string {
  if (id === null) return t('icon.none')
  const key = `icon.${id}`
  const words = t(key)
  return words === key ? t('icon.other') : words
}

/** New symptom: code · Italian · English · what it is for · icon · locks the machine · asks for words. "Add symptom". */
function NewSymptomDialog({ dialog, classes, codes, busy, actions }: { dialog: { draft: SymptomDraft; problem: string | null }; classes: readonly ClassRow[]; codes: readonly string[]; busy: boolean; actions?: PlantSettingsActions }) {
  const t = useT('plant-settings') as Translate
  const locale = useLocale()
  const draft = dialog.draft
  const set = (patch: Partial<SymptomDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  const held = draftHeld(draft, codes, busy)
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  const codeError =
    dialog.problem === 'problem.codeTaken' || dialog.problem === 'problem.codeTakenRetired' || dialog.problem === 'problem.code' ? t(dialog.problem) : draft.code && codes.includes(draft.code.trim()) ? t('held.codeTaken') : undefined
  const fieldError = (field: string) => (dialog.problem === `problem.${field}` ? t(dialog.problem) : undefined)
  const shownBelow = dialog.problem && !codeError && !['problem.labelIt', 'problem.labelEn', 'problem.classId', 'problem.icon'].includes(dialog.problem) ? dialog.problem : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('newDialog.title')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('newDialog.back')}</Button>
          <Button variant={draft.unsafe ? 'danger' : 'primary'} heldReason={held ? t(held) : null} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('newDialog.add')}
          </Button>
        </>
      }
    >
      <div
        className="fw-pls-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <p className="fw-pls-hint">{t('newDialog.intro')}</p>
        <div className="fw-pls-form">
          <Field label={t('col.code')} required hint={t('newDialog.codeHint')} error={codeError}>
            <Input value={draft.code} maxLength={40} autoFocus spellCheck={false} onChange={(event) => set({ code: typedCode(event.target.value) })} />
          </Field>
          <Field label={t('col.for')} hint={t('newDialog.forHint')} error={fieldError('classId')}>
            <Select value={draft.classId ?? ''} onChange={(event) => set({ classId: event.target.value || null })}>
              <option value="">{t('for.every')}</option>
              {classes
                .filter((entry) => entry.active)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {labelOf(entry, locale)}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('col.it')} required error={fieldError('labelIt')}>
            <Input value={draft.labelIt} maxLength={80} lang="it" onChange={(event) => set({ labelIt: event.target.value })} />
          </Field>
          <Field label={t('col.en')} required error={fieldError('labelEn')}>
            <Input value={draft.labelEn} maxLength={80} lang="en" onChange={(event) => set({ labelEn: event.target.value })} />
          </Field>
        </div>
        <Field label={t('iconDialog.label')} hint={t('iconDialog.hint')} error={fieldError('icon')}>
          <SymptomIconPicker value={draft.icon} label={t('iconDialog.label')} words={(id) => iconWords(t, id)} onChange={(icon) => set({ icon })} />
        </Field>
        <label className="fw-pls-toggle">
          <Toggle checked={draft.unsafe} aria-label={t('unsafe.ask')} onChange={(unsafe) => set({ unsafe })} />
          <span>
            <span>{t('unsafe.ask')}</span>
            <span className="fw-pls-sub">{t('unsafe.askHint')}</span>
          </span>
        </label>
        <label className="fw-pls-toggle">
          <Toggle checked={draft.needsDetail} aria-label={t('detail.ask')} onChange={(needsDetail) => set({ needsDetail })} />
          <span>
            <span>{t('detail.ask')}</span>
            <span className="fw-pls-sub">{t('detail.askHint')}</span>
          </span>
        </label>
        {draft.unsafe && <Banner tone="danger" title={t('unsafe.newTitle')}>{t('unsafe.newBody')}</Banner>}
        {shownBelow && <p className="fw-pls-danger">{t(shownBelow)}</p>}
      </div>
    </Modal>
  )
}

/** The icon of one symptom: each pick saves at once (autosave), the footer says how it went. */
function IconDialog({ row, mark, actions }: { row: SymptomRow; mark: Mark | undefined; actions?: PlantSettingsActions }) {
  const t = useT('plant-settings') as Translate
  const locale = useLocale()
  const Icon = iconOf(row.icon)
  const status = !mark ? null : mark.state === 'refused' || mark.state === 'unknown' ? t(mark.problem ?? 'problem.failed') : t(`mark.${mark.state}`)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('iconDialog.title', { code: row.code })}
      size="md"
      footer={
        <>
          {status && (
            <span className={mark?.state === 'refused' ? 'fw-pls-danger' : 'fw-pls-sub'} role="status">
              {status}
            </span>
          )}
          <Button variant="primary" onClick={() => actions?.onDialog?.(null)}>
            {t('iconDialog.done')}
          </Button>
        </>
      }
    >
      <div className="fw-pls-dialog">
        <p className="fw-pls-preview">
          <Icon size={28} aria-hidden />
          <span>{labelOf(row, locale)}</span>
        </p>
        <Field label={t('iconDialog.label')} hint={t('iconDialog.hint')}>
          <SymptomIconPicker value={row.icon} label={t('iconDialog.label')} words={(id) => iconWords(t, id)} onChange={(icon) => actions?.onIcon?.(row, icon)} />
        </Field>
      </div>
    </Modal>
  )
}

/** "Locks the machine" off: a loosening of a safety rule, said in words before it is saved (Owner answer H1 stays). */
function UnsafeOffDialog({ row, busy, actions }: { row: SymptomRow; busy: boolean; actions?: PlantSettingsActions }) {
  const t = useT('plant-settings') as Translate
  const locale = useLocale()
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('unsafeOff.title', { symptom: labelOf(row, locale) })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('unsafeOff.keep')}</Button>
          <Button
            variant="danger"
            heldReason={busy ? t('held.busy') : null}
            onClick={() => {
              actions?.onDialog?.(null)
              actions?.onSwitch?.(row, 'unsafe', false)
            }}
          >
            {t('unsafeOff.stop')}
          </Button>
        </>
      }
    >
      <div className="fw-pls-dialog">
        <p className="fw-pls-text">{t('unsafeOff.body', { code: row.code })}</p>
        <p className="fw-pls-hint">{t('unsafeOff.still')}</p>
      </div>
    </Modal>
  )
}

function KeysDialog({ keys, onClose }: { keys: readonly ListKey[]; onClose: () => void }) {
  const t = useT('plant-settings')
  const tl = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-pls-keys">
        {keys.map((entry) => (
          <div key={entry.keys.join('+')}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key === 'click' ? tl('keys.click') : key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does.startsWith('keys.') ? tl(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
