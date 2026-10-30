'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Plus, RotateCcw, Search, Sparkles, XCircle } from 'lucide-react'
import { Banner, EmptyState, Field, Modal } from '@nexus/ui/components'
import { CellSaveMark, SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, ColorSwatchPicker, IconPicker, Input, Kbd, Pill, SegmentedControl, SWATCHES, TagGlyph, Toggle } from '@nexus/ui/primitives'
import type { ReasonList } from '@nexus/factory-domain/reasons/lists'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { Reason, ReasonListView } from '../api'
import { activeHeld, draftHeld, languageName, markKey, moveHeld, REASON_NAMESPACES, searchRows, standardHeld, typedCode, type CellField, type Mark, type Notice, type ReasonDraft } from '../model'
import '../reasons.css'

export type ReasonDialog = { kind: 'new'; draft: ReasonDraft; problem: string | null } | { kind: 'look'; id: string } | { kind: 'keys' }

/** The ONE view model of the reason list editor: what the container read and what is in flight. It fetches nothing. */
export interface ReasonListsModel {
  /** The host's lists, in the order its switch shows them (one list: no switch). */
  lists: readonly ReasonList[]
  list: ReasonList
  load: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready' }
  /** The shown list as read (null while loading or after a failed read). */
  view: ReasonListView | null
  /** The tenant's other floor languages (their word columns). */
  languages: readonly string[]
  canManage: boolean
  /** Save marks per cell (`markKey(id, field)`). */
  marks: Readonly<Record<string, Mark>>
  notice: Notice | null
  changedElsewhere: boolean
  busy: boolean
  dialog: ReasonDialog | null
  /** Design cases: rows selected, the row with the focus, the search typed. */
  selected?: readonly string[]
  focusRow?: number
  query?: string
}

export interface ReasonListsActions {
  onList?: (list: ReasonList) => void
  onRetry?: () => void
  onReload?: () => void
  /** A word cell typed (Italian, English, another language). */
  onCell?: (row: Reason, field: CellField, value: unknown) => void
  onLook?: (row: Reason, change: { icon?: string | null; colour?: string | null }) => void
  onSwitch?: (row: Reason, field: 'active' | 'needsDetail', next: boolean) => void
  onActiveMany?: (ids: readonly string[], active: boolean) => Promise<boolean>
  onMove?: (ids: readonly string[], delta: -1 | 1) => void
  onStandard?: () => void
  onDialog?: (dialog: ReasonDialog | null) => void
  onDraft?: (draft: ReasonDraft) => void
  onCreate?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-242 — the shared reason list editor (B-W2a-18; design production.settings "Reason codes" fr-reasons with its
 * popup fr-newcode, sales.settings return reasons; PLT-116). A host (Floor rules & codes, Sales settings, …) passes its
 * lists: the list switch (SegmentedControl), then ONE list frame of the list's reasons — code · icon and colour · words
 * in Italian, English and each other floor language · asks for a note · active · used — saved per cell (DS CellSaveMark:
 * saving, saved, refused with its reason, unknown), New reason (`c`), "Add N standard reasons", and with rows selected
 * Set inactive · Set active · Move up · Move down. A code never changes; a reason is set inactive, never deleted. Scrap and
 * rework reasons keep words only (said in a banner; their other cells are not drawn). Keys only in the footer's icon.
 */
export function ReasonListsView({ model, actions }: { model: ReasonListsModel; actions?: ReasonListsActions }) {
  return (
    <WithMessages namespaces={REASON_NAMESPACES}>
      <Editor model={model} actions={actions} />
    </WithMessages>
  )
}

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  return element.closest?.('input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"], .ag-cell-inline-editing, .ag-popup-editor') != null
}

/** A key the cell took for itself (Enter on a switch or the look); printable keys never start an edit (the list's keys). */
const cellKeys = (onEnter?: () => void) => (params: { event: KeyboardEvent; editing: boolean; data?: unknown }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key === 'Enter' && onEnter) {
    if (event.type === 'keydown') onEnter()
    return true
  }
  return event.key.length === 1 && event.key !== ' '
}

function Editor({ model, actions }: { model: ReasonListsModel; actions?: ReasonListsActions }) {
  const t = useT('reasons')
  const locale = useLocale()
  const view = model.view
  const fields = view?.fields ?? { icon: true, colour: true, languages: true, needsDetail: true }
  const [query, setQuery] = useState(model.query ?? '')
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected, model.list])
  useEffect(() => setQuery(model.query ?? ''), [model.query, model.list])
  const all = view?.reasons ?? null
  const rows = useMemo(() => (all ? searchRows(all, query) : null), [all, query])
  const rowsKey = all?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => all?.some((row) => row.id === id))), [rowsKey])
  const picked = (all ?? []).filter((row) => selected.includes(row.id))
  const codes = useMemo(() => (all ?? []).map((row) => row.code), [all])
  const lookRow = model.dialog?.kind === 'look' ? (all ?? []).find((row) => row.id === (model.dialog as { id: string }).id) ?? null : null

  // The latest model and actions for the cells' handlers (the columns do not change with every keystroke).
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || latest.current.model.dialog) return
      if (event.key === 'c' && latest.current.model.canManage && latest.current.model.load.status === 'ready') {
        event.preventDefault()
        latest.current.actions?.onDialog?.({ kind: 'new', draft: { code: '', labelIt: '', labelEn: '', words: {}, icon: null, colour: null, needsDetail: false }, problem: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const markOf = (id: string, field: CellField): Mark | undefined => model.marks[markKey(id, field)]
  const marksKey = JSON.stringify(model.marks)

  const columns = useMemo<ColDef<Reason>[]>(() => {
    const can = model.canManage
    const mark = (id: string, field: CellField) => latest.current.model.marks[markKey(id, field)]
    const Saved = ({ id, field }: { id: string; field: CellField }) => {
      const state = mark(id, field)
      if (!state || state.state === 'saved') return null
      return state.state === 'refused' ? (
        <span className="fw-reasons-refused" role="img" aria-label={t(state.problem ?? 'problem.failed')} title={t(state.problem ?? 'problem.failed')}>
          !
        </span>
      ) : (
        <CellSaveMark state={state.state} />
      )
    }
    const CodeCell = ({ data }: ICellRendererParams<Reason>) =>
      data ? (
        <span className={data.active ? 'fw-reasons-code' : 'fw-reasons-code off'}>
          <span>{data.code}</span>
        </span>
      ) : null
    const LookCell = ({ data }: ICellRendererParams<Reason>) => {
      if (!data) return null
      const swatch = SWATCHES.find((entry) => entry.hex.toLowerCase() === (data.colour ?? '').toLowerCase())
      const words = `${data.icon ? t(`icon.${data.icon}`) : t('look.noIcon')} · ${swatch ? t(`colour.${swatch.name}`) : t('look.noColour')}`
      const glyph = (
        <span className="fw-reasons-look">
          <TagGlyph icon={data.icon} color={data.colour} size={16} />
          <span className="fw-reasons-sub">{words}</span>
        </span>
      )
      return (
        <span className="fw-reasons-cell">
          {can ? (
            <Button size="sm" variant="quiet" aria-label={t('look.change', { code: data.code, look: words })} onClick={() => latest.current.actions?.onDialog?.({ kind: 'look', id: data.id })}>
              {glyph}
            </Button>
          ) : (
            glyph
          )}
          <Saved id={data.id} field="look" />
        </span>
      )
    }
    const WordsCell = (field: CellField) =>
      function Words({ data, value }: ICellRendererParams<Reason>) {
        if (!data) return null
        const text = typeof value === 'string' ? value : ''
        return (
          <span className="fw-reasons-cell">
            {text ? <span className="fw-reasons-words">{text}</span> : <span className="fw-reasons-sub">{t('words.fallback')}</span>}
            <Saved id={data.id} field={field} />
          </span>
        )
      }
    const SwitchCell = (field: 'active' | 'needsDetail') =>
      function Switch({ data }: ICellRendererParams<Reason>) {
        if (!data) return null
        const on = data[field]
        const word = field === 'active' ? t(on ? 'active.on' : 'active.off') : t(on ? 'detail.on' : 'detail.off')
        return (
          <span className="fw-reasons-cell">
            {can ? (
              <Toggle size="xs" checked={on} aria-label={t(field === 'active' ? 'active.label' : 'detail.label', { code: data.code })} onChange={(next) => latest.current.actions?.onSwitch?.(data, field, next)} />
            ) : null}
            {field === 'active' && !on ? <Pill tone="neutral">{word}</Pill> : <span className={on ? undefined : 'fw-reasons-sub'}>{word}</span>}
            <Saved id={data.id} field={field} />
          </span>
        )
      }
    const UsedCell = ({ data }: ICellRendererParams<Reason>) => (data ? <span title={t(data.usedCount > 0 ? 'used.hint' : 'used.none', { count: data.usedCount })}>{t('used.count', { count: data.usedCount })}</span> : null)

    const editable = () => (can ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 80 } } : {})
    const words = (field: 'labelIt' | 'labelEn', headerName: string): ColDef<Reason> => ({
      colId: field,
      headerName,
      field,
      minWidth: 150,
      flex: 1.4,
      ...editable(),
      cellRenderer: WordsCell(field),
      suppressKeyboardEvent: cellKeys(),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.onCell?.(params.data, field, params.newValue)
        return false
      },
    })
    const languageColumns: ColDef<Reason>[] = fields.languages
      ? model.languages.map((language) => ({
          colId: `lang:${language}`,
          headerName: languageName(language, locale),
          minWidth: 140,
          flex: 1.2,
          valueGetter: (params) => params.data?.labelI18n[language] ?? '',
          ...editable(),
          cellRenderer: WordsCell(`lang:${language}`),
          suppressKeyboardEvent: cellKeys(),
          valueSetter: (params) => {
            if (params.data) latest.current.actions?.onCell?.(params.data, `lang:${language}`, params.newValue)
            return false
          },
        }))
      : []
    const switchColumn = (field: 'active' | 'needsDetail'): ColDef<Reason> => ({
      colId: field,
      headerName: t(field === 'active' ? 'col.active' : 'col.needsDetail'),
      field,
      width: field === 'active' ? 140 : 150,
      minWidth: 120,
      maxWidth: 170,
      cellRenderer: SwitchCell(field),
      suppressKeyboardEvent: can
        ? (params) => cellKeys(() => params.data && latest.current.actions?.onSwitch?.(params.data, field, !params.data[field]))(params)
        : cellKeys(),
    })
    return [
      { colId: 'code', headerName: t('col.code'), field: 'code', minWidth: 150, flex: 1, cellRenderer: CodeCell, suppressKeyboardEvent: cellKeys() },
      ...(fields.icon || fields.colour
        ? [
            {
              colId: 'look',
              headerName: t('col.look'),
              minWidth: 170,
              flex: 1,
              cellRenderer: LookCell,
              suppressKeyboardEvent: can ? (params: { event: KeyboardEvent; editing: boolean; data?: Reason }) => cellKeys(() => params.data && latest.current.actions?.onDialog?.({ kind: 'look', id: params.data.id }))(params) : cellKeys(),
            } satisfies ColDef<Reason>,
          ]
        : []),
      words('labelIt', t('col.it')),
      words('labelEn', t('col.en')),
      ...languageColumns,
      ...(fields.needsDetail ? [switchColumn('needsDetail')] : []),
      switchColumn('active'),
      { colId: 'used', headerName: t('col.used'), field: 'usedCount', width: 130, minWidth: 110, maxWidth: 160, type: 'rightAligned', cellRenderer: UsedCell, suppressKeyboardEvent: cellKeys() },
    ]
    // The marks repaint the cells; the rest of the model is read through `latest`.
  }, [t, locale, model.canManage, model.languages, fields.icon, fields.colour, fields.languages, fields.needsDetail, marksKey])

  const ownKeys: ListKey[] = model.canManage
    ? [
        { keys: ['c'], does: t('keys.new') },
        { keys: ['↵'], does: t('keys.edit') },
        { keys: ['Esc'], does: t('keys.cancel') },
      ]
    : []

  const searching = query.trim() !== ''
  const ready = model.load.status === 'ready' && view !== null
  const count = view ? t('count', { active: view.active, inactive: view.inactive }) : '—'
  const missing = view?.standardMissing.length ?? 0
  const offHeld = activeHeld(picked, false, model.busy)
  const onHeld = activeHeld(picked, true, model.busy)
  const upHeld = all ? moveHeld(all, selected, -1, model.busy, searching) : 'held.busy'
  const downHeld = all ? moveHeld(all, selected, 1, model.busy, searching) : 'held.busy'
  const newDialog = () => actions?.onDialog?.({ kind: 'new', draft: { code: '', labelIt: '', labelEn: '', words: {}, icon: null, colour: null, needsDetail: false }, problem: null })

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
            <span className="fw-reasons-actions">
              <Button size="sm" variant="primary" onClick={newDialog}>
                <Plus size={14} aria-hidden /> {t('state.first')}
              </Button>
              {missing > 0 && (
                <Button size="sm" heldReason={standardHeld(model.canManage, model.busy) ? t(standardHeld(model.canManage, model.busy)!) : null} onClick={() => actions?.onStandard?.()}>
                  <Sparkles size={14} aria-hidden /> {t('standard.add', { count: missing })}
                </Button>
              )}
            </span>
          ) : undefined
        }
      />
    )
  } else if (ready && rows && rows.length === 0) {
    state = <EmptyState title={t('state.noMatch')} action={<Button size="sm" onClick={() => setQuery('')}>{t('state.clearSearch')}</Button>} />
  }

  return (
    <section className="fw-reasons" aria-label={t('title')}>
      {model.lists.length > 1 && (
        <div className="fw-reasons-switch">
          <SegmentedControl size="sm" wrap ariaLabel={t('lists')} value={model.list} options={model.lists.map((list) => ({ value: list, label: t(`list.${list}`) }))} onChange={(value) => actions?.onList?.(value as ReasonList)} />
        </div>
      )}
      <p className="fw-reasons-hint">{t(`listHint.${model.list}`)}</p>
      {model.changedElsewhere && (
        <Banner tone="info" title={t('changed.title')} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('changed.reload')}</Button>}>
          {t('changed.body')}
        </Banner>
      )}
      {model.notice && (
        <Banner tone={model.notice.tone} onDismiss={actions?.onDismissNotice}>
          {t(model.notice.key, model.notice.params)}
        </Banner>
      )}
      {ready && !model.canManage && <Banner tone="neutral" title={t('readOnly.title')}>{t('readOnly.body')}</Banner>}
      {ready && !fields.icon && <Banner tone="info">{t('wordsOnly')}</Banner>}
      <ListFrame<Reason>
        label={t('table', { list: t(`list.${model.list}`) })}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        rowKind="text"
        count={count}
        search={
          <Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} aria-label={t('search')} placeholder={t('search')} value={query} onChange={(event) => setQuery(event.target.value)} />
        }
        right={
          <>
            {missing > 0 && ready && (all?.length ?? 0) > 0 && (
              <Button size="sm" heldReason={standardHeld(model.canManage, model.busy) ? t(standardHeld(model.canManage, model.busy)!) : null} onClick={() => actions?.onStandard?.()}>
                <Sparkles size={13} aria-hidden /> <SelectionLabel>{t('standard.add', { count: missing })}</SelectionLabel>
              </Button>
            )}
            <Button size="sm" variant="primary" heldReason={!ready ? t('held.loading') : model.canManage ? null : t('held.noManage')} onClick={newDialog} aria-keyshortcuts="c">
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
                    <Button size="sm" variant="danger-outline" aria-label={t('bulk.off', { count: picked.length })} heldReason={offHeld ? t(offHeld) : null} onClick={() => void actions?.onActiveMany?.(selected, false)}>
                      <XCircle size={13} aria-hidden /> <SelectionLabel>{t('bulk.off', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" aria-label={t('bulk.on', { count: picked.length })} heldReason={onHeld ? t(onHeld) : null} onClick={() => void actions?.onActiveMany?.(selected, true)}>
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
      {model.dialog?.kind === 'new' && view && <NewReasonDialog dialog={model.dialog} view={view} languages={model.languages} codes={codes} busy={model.busy} actions={actions} />}
      {model.dialog?.kind === 'look' && lookRow && <LookDialog row={lookRow} mark={markOf(lookRow.id, 'look')} actions={actions} />}
      {model.dialog?.kind === 'keys' && <KeysDialog keys={listKeys(ownKeys, model.canManage)} onClose={() => actions?.onDialog?.(null)} />}
    </section>
  )
}

/** New reason code (design fr-newcode): code · icon · colour · words per language · asks for a note. "Add code". */
function NewReasonDialog({ dialog, view, languages, codes, busy, actions }: { dialog: { draft: ReasonDraft; problem: string | null }; view: ReasonListView; languages: readonly string[]; codes: readonly string[]; busy: boolean; actions?: ReasonListsActions }) {
  const t = useT('reasons')
  const locale = useLocale()
  const draft = dialog.draft
  const set = (patch: Partial<ReasonDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  const held = draftHeld(draft, codes, busy)
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  const codeError = dialog.problem === 'problem.codeTaken' || dialog.problem === 'problem.codeTakenInactive' || dialog.problem === 'problem.code' ? t(dialog.problem) : draft.code && codes.includes(draft.code) ? t('held.codeTaken') : undefined
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('newDialog.title', { list: t(`list.${view.list}`) })}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('newDialog.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('newDialog.add')}
          </Button>
        </>
      }
    >
      <div
        className="fw-reasons-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <p className="fw-reasons-hint">{t('newDialog.intro')}</p>
        <div className="fw-reasons-form">
          <Field label={t('col.code')} required hint={t('newDialog.codeHint')} error={codeError}>
            <Input value={draft.code} maxLength={40} autoFocus spellCheck={false} onChange={(event) => set({ code: typedCode(event.target.value) })} />
          </Field>
          <Field label={t('col.it')} required error={dialog.problem === 'problem.labelIt' ? t('problem.labelIt') : undefined}>
            <Input value={draft.labelIt} maxLength={80} lang="it" onChange={(event) => set({ labelIt: event.target.value })} />
          </Field>
          <Field label={t('col.en')} required error={dialog.problem === 'problem.labelEn' ? t('problem.labelEn') : undefined}>
            <Input value={draft.labelEn} maxLength={80} lang="en" onChange={(event) => set({ labelEn: event.target.value })} />
          </Field>
          {view.fields.languages &&
            languages.map((language) => (
              <Field key={language} label={languageName(language, locale)} hint={t('newDialog.languageHint')}>
                <Input value={draft.words[language] ?? ''} maxLength={80} lang={language} onChange={(event) => set({ words: { ...draft.words, [language]: event.target.value } })} />
              </Field>
            ))}
        </div>
        {(view.fields.icon || view.fields.colour) && (
          <div className="fw-reasons-pickers">
            {view.fields.icon && (
              <Field label={t('look.icon')} hint={t('look.iconHint')}>
                <IconPicker value={draft.icon} color={draft.colour} ariaLabel={t('look.icon')} onChange={(icon) => set({ icon })} />
              </Field>
            )}
            {view.fields.colour && (
              <Field label={t('look.colour')} hint={t('look.colourHint')}>
                <span className="fw-reasons-swatches">
                  <ColorSwatchPicker value={draft.colour} ariaLabel={t('look.colour')} onChange={(colour) => set({ colour })} />
                  <Button size="sm" variant="quiet" heldReason={draft.colour ? null : t('look.noColourYet')} onClick={() => set({ colour: null })}>
                    {t('look.clearColour')}
                  </Button>
                </span>
              </Field>
            )}
          </div>
        )}
        {view.fields.needsDetail && (
          <label className="fw-reasons-toggle">
            <Toggle checked={draft.needsDetail} aria-label={t('detail.ask')} onChange={(needsDetail) => set({ needsDetail })} />
            <span>
              <span>{t('detail.ask')}</span>
              <span className="fw-reasons-sub">{t('detail.askHint')}</span>
            </span>
          </label>
        )}
        {dialog.problem && !codeError && dialog.problem !== 'problem.labelIt' && dialog.problem !== 'problem.labelEn' && <p className="fw-reasons-danger">{t(dialog.problem)}</p>}
      </div>
    </Modal>
  )
}

/** The icon and colour of one reason: each pick saves at once (autosave), the mark says how it went. */
function LookDialog({ row, mark, actions }: { row: Reason; mark: Mark | undefined; actions?: ReasonListsActions }) {
  const t = useT('reasons')
  const status = !mark ? null : mark.state === 'refused' ? t(mark.problem ?? 'problem.failed') : t(`mark.${mark.state}`)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('look.title', { code: row.code })}
      size="md"
      footer={
        <>
          {status && (
            <span className={mark?.state === 'refused' ? 'fw-reasons-danger' : 'fw-reasons-sub'} role="status">
              {status}
            </span>
          )}
          <Button variant="primary" onClick={() => actions?.onDialog?.(null)}>
            {t('look.done')}
          </Button>
        </>
      }
    >
      <div className="fw-reasons-dialog">
        <p className="fw-reasons-preview">
          <TagGlyph icon={row.icon} color={row.colour} size={28} />
          <span>{row.labelEn}</span>
        </p>
        <Field label={t('look.icon')} hint={t('look.iconHint')}>
          <IconPicker value={row.icon} color={row.colour} ariaLabel={t('look.icon')} onChange={(icon) => actions?.onLook?.(row, { icon })} />
        </Field>
        <Field label={t('look.colour')} hint={t('look.colourHint')}>
          <span className="fw-reasons-swatches">
            <ColorSwatchPicker value={row.colour} ariaLabel={t('look.colour')} onChange={(colour) => actions?.onLook?.(row, { colour })} />
            <Button size="sm" variant="quiet" heldReason={row.colour ? null : t('look.noColourYet')} onClick={() => actions?.onLook?.(row, { colour: null })}>
              {t('look.clearColour')}
            </Button>
          </span>
        </Field>
      </div>
    </Modal>
  )
}

function KeysDialog({ keys, onClose }: { keys: readonly ListKey[]; onClose: () => void }) {
  const t = useT('reasons')
  const tl = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-reasons-keys">
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
