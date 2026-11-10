'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Lock, MoreHorizontal, Plus, ShieldCheck, Trash2, WifiOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Radio, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { PLACEMENT_LIMITS, PROTECTOR_LEVELS, PROTECTOR_POCKETS, type ProtectorLevel, type ProtectorPocket } from '@nexus/factory-domain/product/protectors/rules'
import { CellSaveMark, Modal } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../../list-frame/model'
import type { StyleView } from '../../../api'
import { draftOf as draftRevisionOf, nextRevisionNumber, startRevisionHeld } from '../../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../../record-model'
import type { PlacementView, ProtectorPlacementView } from '../api'
import {
  choiceLabel,
  draftOf,
  draftProblems,
  findingWords,
  markKey,
  NO_PROTECTORS,
  protectorsHeld,
  shownValue,
  sizesText,
  withProtector,
  type PlacementCell,
  type PlacementDraft,
  type PlacementMark,
  type ProtectorsActions,
  type ProtectorsModel,
} from '../protectors-model'
import '../protectors.css'

/**
 * SCR-287 — Style › Sizes & measurements › Protector placement (design products.styles rec:Style tab style.sizes, section
 * style.sizes.protectors; PRD-074): which protector goes in which pocket of the revision in view, for which sizes, with the
 * standard and level the certified type asks and where the pocket sits — on the shared list frame: each cell saves by
 * itself with its mark (CellSaveMark; waiting while offline), Enter (or a phone card) opens the placement, `n` adds one,
 * ⋯ moves or removes a row, and with rows selected: Remove N. What the BOM and the certificates do not agree on is said
 * above the list, in words, never blocking. Revision-bound: a released revision is frozen (a read-only Banner with "Go to
 * revision N (draft)" or "Start revision N"); a role without the BOM's edit right reads it with its own banner; a role
 * without the BOM does not see the section. It draws the view model and fetches nothing (use-protectors.ts loads it).
 */
export function ProtectorsSection({ style, model, actions, recordActions }: { style: StyleView; model: StyleRecordViewModel; actions?: ProtectorsActions; recordActions?: StyleRecordActions }) {
  const t = useT('products-prepacks')
  const tp = useT('products')
  const protectors = model.protectors ?? NO_PROTECTORS
  const part = protectors.part
  if (part.status === 'ready') return <Section style={style} view={part.value} protectors={protectors} canManage={model.can.bomManage} recordBusy={model.busy} can={model.can} actions={actions} recordActions={recordActions} />
  if (part.status === 'error') {
    return (
      <Banner
        tone="danger"
        title={t('protectors.failed')}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {tp('common.retry')}
          </Button>
        }
      >
        {tp(part.problem)}
      </Banner>
    )
  }
  if (part.status === 'idle' && style.revisions.length === 0) return <Card header={t('protectors.title')} headingLevel={2} description={t('protectors.noRevision')} />
  return (
    <Card header={t('protectors.title')} headingLevel={2} aria-busy="true">
      <p className="fw-st-hint" role="status">
        <Spinner size={14} /> {t('protectors.loading')}
      </p>
      <div className="fw-st-skeleton">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} height={22} />
        ))}
      </div>
    </Card>
  )
}

function Section({
  style,
  view,
  protectors,
  canManage,
  recordBusy,
  can,
  actions,
  recordActions,
}: {
  style: StyleView
  view: ProtectorPlacementView
  protectors: ProtectorsModel
  canManage: boolean
  recordBusy: boolean
  can: StyleRecordViewModel['can']
  actions?: ProtectorsActions
  recordActions?: StyleRecordActions
}) {
  const t = useT('products-prepacks')
  const tp = useT('products')
  const held = protectorsHeld(view, canManage)
  const editable = held === null
  const busy = protectors.busy || recordBusy
  const addHeld = held ? t(held) : view.choices.length === 0 ? t('protectors.held.noChoice') : busy ? tp('held.busy') : null
  const keyFrom = useRef<{ control: boolean; at: number } | null>(null)
  const latest = useRef({ actions, marks: protectors.marks, view })
  latest.current = { actions, marks: protectors.marks, view }
  const marksKey = JSON.stringify(protectors.marks)
  const rows = useMemo(() => [...view.placements].sort((a, b) => a.seq - b.seq), [view.placements])
  const range = view.style.sizes
  const draftRevision = draftRevisionOf(style.revisions)
  const startHeld = startRevisionHeld(style, can)
  const next = nextRevisionNumber(style.revisions)

  // `n` adds a placement (never while typing or with a dialog open).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || event.key !== 'n' || protectors.dialog) return
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return
      if (addHeld) return
      event.preventDefault()
      latest.current.actions?.onDialog?.({ kind: 'placement', placementId: null })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const columns = useMemo<ColDef<PlacementView>[]>(() => {
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    const mark = (id: string, cell: PlacementCell) => latest.current.marks[markKey(id, cell)]
    const cellAction = (placement: PlacementView, cell: PlacementCell, value: unknown) => latest.current.actions?.onCell?.(placement, cell, value)
    const shown = (placement: PlacementView, cell: PlacementCell) => shownValue(placement, cell, latest.current.marks)

    const PocketCell = ({ data }: ICellRendererParams<PlacementView>) => {
      if (!data) return null
      const value = String(shown(data, 'pocket'))
      return (
        <span className="fw-ptc-cell">
          {editable ? (
            <Select size="xs" value={value} aria-label={t('protectors.cell.pocket', { seq: data.seq })} onChange={(event) => cellAction(data, 'pocket', event.target.value)}>
              {PROTECTOR_POCKETS.map((pocket) => (
                <option key={pocket} value={pocket}>
                  {t(`protectors.pocket.${pocket}`)}
                </option>
              ))}
            </Select>
          ) : (
            <span>{t(`protectors.pocket.${value}`)}</span>
          )}
          <Mark mark={mark(data.id, 'pocket')} />
        </span>
      )
    }
    const ProtectorCell = ({ data }: ICellRendererParams<PlacementView>) => {
      if (!data) return null
      const value = String(shown(data, 'protectorItemId'))
      const choices = latest.current.view.choices
      const listed = choices.some((choice) => choice.id === data.protector.id)
      return (
        <span className="fw-ptc-cell">
          {editable ? (
            <Select size="xs" value={value} aria-label={t('protectors.cell.protector', { seq: data.seq })} onChange={(event) => cellAction(data, 'protectorItemId', event.target.value)}>
              {!listed && <option value={data.protector.id}>{choiceLabel(data.protector)}</option>}
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {`${choiceLabel(choice)}${choice.inBom ? ` · ${t('protectors.inBom')}` : ''}`}
                </option>
              ))}
            </Select>
          ) : (
            <span className="fw-ptc-text" title={data.protector.name}>
              {choiceLabel(data.protector)}
            </span>
          )}
          <Mark mark={mark(data.id, 'protectorItemId')} />
        </span>
      )
    }
    const StandardCell = ({ data }: ICellRendererParams<PlacementView>) => {
      if (!data) return null
      return (
        <span className="fw-ptc-cell">
          {editable ? (
            <TextCell value={String(shown(data, 'standard') ?? '')} label={t('protectors.cell.standard', { seq: data.seq })} maxLength={PLACEMENT_LIMITS.standard} mark={mark(data.id, 'standard')} onCommit={(value) => cellAction(data, 'standard', value)} />
          ) : (
            <span>{data.standard}</span>
          )}
          <Mark mark={mark(data.id, 'standard')} />
        </span>
      )
    }
    const LevelCell = ({ data }: ICellRendererParams<PlacementView>) => {
      if (!data) return null
      const value = String(shown(data, 'level'))
      return (
        <span className="fw-ptc-cell">
          {editable ? (
            <Select size="xs" value={value} aria-label={t('protectors.cell.level', { seq: data.seq })} onChange={(event) => cellAction(data, 'level', event.target.value)}>
              {PROTECTOR_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t('protectors.level', { level })}
                </option>
              ))}
            </Select>
          ) : (
            <span>{t('protectors.level', { level: value })}</span>
          )}
          <Mark mark={mark(data.id, 'level')} />
        </span>
      )
    }
    const SizesCell = ({ data }: ICellRendererParams<PlacementView>) => {
      if (!data) return null
      const words = sizesText(shown(data, 'sizes') as string[], range)
      return (
        <span className="fw-ptc-cell">
          <span className="fw-ptc-text">{t(words.key, words.params)}</span>
          {editable && (
            <Button size="xs" variant="quiet" aria-label={t('protectors.sizes.change', { seq: data.seq })} onClick={() => latest.current.actions?.onDialog?.({ kind: 'sizes', placementId: data.id })}>
              {t('protectors.sizes.changeShort')}
            </Button>
          )}
          <Mark mark={mark(data.id, 'sizes')} />
        </span>
      )
    }
    const PositionCell = ({ data }: ICellRendererParams<PlacementView>) => {
      if (!data) return null
      return (
        <span className="fw-ptc-cell">
          {editable ? (
            <TextCell value={String(shown(data, 'positionNote') ?? '')} label={t('protectors.cell.position', { seq: data.seq })} maxLength={PLACEMENT_LIMITS.positionNote} placeholder={t('protectors.position.placeholder')} mark={mark(data.id, 'positionNote')} onCommit={(value) => cellAction(data, 'positionNote', value)} />
          ) : (
            <span className="fw-ptc-text">{data.positionNote ?? '—'}</span>
          )}
          <Mark mark={mark(data.id, 'positionNote')} />
        </span>
      )
    }
    const MoreCell = ({ data, node }: ICellRendererParams<PlacementView>) => {
      if (!data) return null
      const index = node?.rowIndex ?? 0
      const why = held ? t(held) : undefined
      const items: MenuItemDef[] = [
        { id: 'open', label: t(editable ? 'protectors.row.edit' : 'protectors.row.open'), onSelect: () => latest.current.actions?.onDialog?.({ kind: 'placement', placementId: data.id }) },
        { id: 'up', label: t('protectors.row.up'), disabled: !editable || index === 0, description: why, onSelect: () => latest.current.actions?.onMove?.(data.id, -1) },
        { id: 'down', label: t('protectors.row.down'), disabled: !editable || index === latest.current.view.placements.length - 1, description: why, onSelect: () => latest.current.actions?.onMove?.(data.id, 1) },
        { id: 'remove', label: t('protectors.row.remove'), tone: 'danger', disabled: !editable, description: why, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'remove', ids: [data.id] }) },
      ]
      return <Menu label={<MoreHorizontal size={16} aria-label={t('protectors.row.more', { seq: data.seq })} />} items={items} align="right" triggerProps={{ 'aria-label': t('protectors.row.more', { seq: data.seq }) }} />
    }
    return [
      { colId: 'seq', headerName: t('protectors.col.seq'), minWidth: 64, maxWidth: 72, valueGetter: (params) => params.data?.seq ?? '', ...plain },
      { colId: 'pocket', headerName: t('protectors.col.pocket'), minWidth: 140, flex: 0.8, cellRenderer: PocketCell, valueGetter: (params) => (params.data ? t(`protectors.pocket.${params.data.pocket}`) : ''), ...plain },
      { colId: 'protector', headerName: t('protectors.col.protector'), minWidth: 220, flex: 1.5, cellRenderer: ProtectorCell, valueGetter: (params) => (params.data ? choiceLabel(params.data.protector) : ''), ...plain },
      { colId: 'standard', headerName: t('protectors.col.standard'), minWidth: 160, flex: 1, cellRenderer: StandardCell, valueGetter: (params) => params.data?.standard ?? '', ...plain },
      { colId: 'level', headerName: t('protectors.col.level'), minWidth: 120, flex: 0.6, cellRenderer: LevelCell, valueGetter: (params) => (params.data ? t('protectors.level', { level: params.data.level }) : ''), ...plain },
      {
        colId: 'sizes',
        headerName: t('protectors.col.sizes'),
        minWidth: 170,
        flex: 1,
        cellRenderer: SizesCell,
        valueGetter: (params) => {
          if (!params.data) return ''
          const words = sizesText(params.data.sizes, range)
          return t(words.key, words.params)
        },
        ...plain,
      },
      { colId: 'position', headerName: t('protectors.col.position'), minWidth: 200, flex: 1.4, cellRenderer: PositionCell, valueGetter: (params) => params.data?.positionNote ?? '', ...plain },
      { colId: 'more', headerName: t('protectors.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', suppressMovable: true, cellRenderer: MoreCell, ...plain },
    ]
    // The cells read the marks through `latest`; a change of them redraws the cells.
  }, [t, editable, held, range.join(','), marksKey, view.choices])

  const selected = protectors.selected
  const removeHeld = held ? t(held) : busy ? tp('held.busy') : null
  const bulk = (
    <Button size="sm" variant="danger-outline" aria-label={t('protectors.bulk.remove', { count: selected.length })} heldReason={removeHeld} onClick={() => actions?.onDialog?.({ kind: 'remove', ids: [...selected] })}>
      <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('protectors.bulk.remove', { count: selected.length })}</SelectionLabel>
    </Button>
  )
  const addButton = (
    <Button size="sm" variant="primary" heldReason={addHeld} onClick={() => actions?.onDialog?.({ kind: 'placement', placementId: null })} aria-keyshortcuts="n">
      <Plus size={13} aria-hidden /> {t('protectors.add')}
    </Button>
  )
  const keys: ListKey[] = [
    { keys: ['n'], does: t('protectors.keys.add') },
    { keys: ['↵'], does: t('protectors.keys.open') },
  ]
  const waiting = Object.values(protectors.marks).filter((entry) => entry.state === 'waiting').length
  const frozen = view.revision.status !== 'DRAFT'

  return (
    <section
      className="fw-st-stack"
      aria-label={t('protectors.title')}
      onKeyDownCapture={(event) => {
        keyFrom.current = { control: !!(event.target as HTMLElement | null)?.closest?.('input, select, textarea, button'), at: Date.now() }
      }}
    >
      <Card header={t('protectors.title')} headingLevel={2} description={t('protectors.intro', { revision: view.revision.revision })} headerAction={addButton}>
        <p className="fw-st-hint">{t('protectors.rule')}</p>
      </Card>
      {frozen && (
        <Banner
          tone="info"
          title={
            <span className="fw-st-inline">
              <Lock size={14} aria-hidden /> {t(view.revision.status === 'RELEASED' ? 'protectors.frozen.released' : 'protectors.frozen.obsolete', { revision: view.revision.revision })}
            </span>
          }
          action={
            draftRevision && draftRevision.id !== view.revision.id ? (
              <Button size="sm" onClick={() => recordActions?.onRevision?.(draftRevision.id)}>
                {tp('record.goToDraft', { revision: draftRevision.revision })}
              </Button>
            ) : !startHeld ? (
              <Button size="sm" onClick={() => recordActions?.onDialog?.({ kind: 'startRevision' })}>
                {tp('action.startRevision', { revision: next })}
              </Button>
            ) : undefined
          }
        />
      )}
      {held === 'protectors.held.noManage' && <Banner tone="info" title={t('protectors.readOnly.noManage')} />}
      {held === 'protectors.held.rule' && <Banner tone="info" title={t('protectors.readOnly.rule')} />}
      {held === 'protectors.held.archived' && <Banner tone="info" title={t('protectors.held.archived')} />}
      {protectors.notice && (
        <Banner
          tone={protectors.notice.tone}
          title={t(protectors.notice.key, protectors.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {tp('common.dismiss')}
            </Button>
          }
        />
      )}
      {(protectors.offline || waiting > 0) && (
        <Banner
          tone="warning"
          title={
            <span className="fw-st-inline">
              <WifiOff size={14} aria-hidden /> {t('protectors.offline', { count: waiting })}
            </span>
          }
        />
      )}
      {view.findings.length > 0 ? (
        <Banner tone="warning" title={t('protectors.findings.title', { count: view.findings.length })}>
          <ul className="fw-ptc-findings">
            {view.findings.map((finding, index) => {
              const words = findingWords(finding)
              return <li key={`${finding.code}-${index}`}>{t(words.key, { ...words.params, pocket: words.pocket ? t(`protectors.pocketWord.${words.pocket}`) : '' })}</li>
            })}
          </ul>
        </Banner>
      ) : rows.length > 0 ? (
        <Banner
          tone="success"
          title={
            <span className="fw-st-inline">
              <ShieldCheck size={14} aria-hidden /> {t('protectors.findings.none')}
            </span>
          }
        />
      ) : null}
      <ListFrame<PlacementView>
        label={t('protectors.table')}
        listKey={null}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('protectors.count', { count: rows.length, pockets: new Set(rows.map((row) => row.pocket)).size })}
        selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        keys={keys}
        onOpen={(row) => {
          // Enter typed into a cell's own control (a select, a text, a button) is that control's, never "open the row".
          const key = keyFrom.current
          if (key && key.control && Date.now() - key.at < 1000) return
          actions?.onDialog?.({ kind: 'placement', placementId: row.id })
        }}
        focusRow={protectors.focusRow}
        state={rows.length === 0 ? <EmptyState title={t('protectors.empty.title')} description={t(editable ? 'protectors.empty.body' : 'protectors.empty.frozen')} action={editable && !addHeld ? addButton : undefined} /> : undefined}
      />
      <ProtectorDialogs view={view} protectors={protectors} editable={editable} busy={busy} actions={actions} />
    </section>
  )
}

/** A text cell: typed freely, saved when it is left or on Enter (Esc puts the stored value back). */
function TextCell({ value, label, maxLength, placeholder, mark, onCommit }: { value: string; label: string; maxLength: number; placeholder?: string; mark?: PlacementMark; onCommit: (next: string) => void }) {
  return (
    <Input
      size="xs"
      key={`${value}|${mark?.state ?? ''}`}
      defaultValue={value}
      aria-label={label}
      maxLength={maxLength}
      placeholder={placeholder}
      onBlur={(event) => {
        if (event.target.value !== value) onCommit(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return
        event.preventDefault()
        const input = event.currentTarget
        if (event.key === 'Escape') input.value = value
        setTimeout(() => input.blur(), 0)
      }}
    />
  )
}

function Mark({ mark }: { mark: PlacementMark | undefined }) {
  const t = useT('products-prepacks')
  if (!mark) return null
  if (mark.state === 'refused') {
    const reason = t(mark.problem ?? 'protectors.problem.write')
    return (
      <span className="fw-ptc-refused" role="img" aria-label={reason} title={reason}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}

function ProtectorDialogs({ view, protectors, editable, busy, actions }: { view: ProtectorPlacementView; protectors: ProtectorsModel; editable: boolean; busy: boolean; actions?: ProtectorsActions }) {
  const dialog = protectors.dialog
  if (!dialog) return null
  if (dialog.kind === 'placement') {
    const placement = dialog.placementId ? (view.placements.find((entry) => entry.id === dialog.placementId) ?? null) : null
    return <PlacementDialog key={dialog.placementId ?? 'new'} view={view} placement={placement} preset={protectors.draft} editable={editable} busy={busy} actions={actions} />
  }
  if (dialog.kind === 'sizes') {
    const placement = view.placements.find((entry) => entry.id === dialog.placementId)
    return placement ? <SizesDialog view={view} placement={placement} actions={actions} /> : null
  }
  return <RemoveDialog view={view} ids={dialog.ids} busy={busy} actions={actions} />
}

/** Add a placement, or see and change every field of one; explicit Save. */
function PlacementDialog({ view, placement, preset, editable, busy, actions }: { view: ProtectorPlacementView; placement: PlacementView | null; preset?: PlacementDraft; editable: boolean; busy: boolean; actions?: ProtectorsActions }) {
  const t = useT('products-prepacks')
  const tp = useT('products')
  const [draft, setDraft] = useState<PlacementDraft>(() => preset ?? draftOf(placement, view))
  const [only, setOnly] = useState(draft.sizes.length > 0)
  const problems = draftProblems(draft, view, placement?.id ?? null, only)
  const first = Object.values(problems)[0]
  const held = !editable ? t(protectorsHeld(view, true) ?? 'protectors.held.noManage') : first ? t(first) : busy ? tp('held.busy') : null
  const close = () => actions?.onDialog?.(null)
  const go = () => {
    if (held) return
    void actions?.onSave?.(placement?.id ?? null, { ...draft, sizes: only ? draft.sizes : [] })
  }
  const choice = view.choices.find((entry) => entry.id === draft.protectorItemId)
  // Keep the edited placement's protector listed even when it is no longer offered (archived, blocked).
  const listed = placement && !view.choices.some((entry) => entry.id === placement.protector.id) ? [{ ...placement.protector, inBom: false }, ...view.choices] : view.choices
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={placement ? t('protectors.dialog.editTitle', { seq: placement.seq }) : t('protectors.dialog.addTitle', { revision: view.revision.revision })}
      footer={
        <>
          <Button onClick={close}>{tp('common.back')}</Button>
          {editable && (
            <Button variant="primary" heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
              {placement ? t('protectors.dialog.save') : t('protectors.dialog.add')}
            </Button>
          )}
        </>
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            go()
          }
        }}
      >
        <div className="fw-st-form-grid">
          <Field label={t('protectors.col.pocket')} required>
            <Select value={draft.pocket} autoFocus disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, pocket: event.target.value as ProtectorPocket }))}>
              {PROTECTOR_POCKETS.map((pocket) => (
                <option key={pocket} value={pocket}>
                  {t(`protectors.pocket.${pocket}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('protectors.col.protector')} required hint={choice?.inBom ? t('protectors.dialog.inBom') : choice ? t('protectors.dialog.notInBom') : undefined} error={problems.protectorItemId ? t(problems.protectorItemId) : undefined}>
            <Select value={draft.protectorItemId} disabled={!editable} onChange={(event) => setDraft((current) => withProtector(current, listed.find((entry) => entry.id === event.target.value) ?? null))}>
              {!choice && <option value="">{t('protectors.dialog.pick')}</option>}
              {listed.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${choiceLabel(entry)}${entry.inBom ? ` · ${t('protectors.inBom')}` : ''}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('protectors.col.standard')} required hint={t('protectors.dialog.standardHint')} error={problems.standard ? t(problems.standard) : undefined}>
            <Input value={draft.standard} maxLength={PLACEMENT_LIMITS.standard} disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, standard: event.target.value }))} />
          </Field>
          <Field label={t('protectors.col.level')} required hint={t('protectors.dialog.levelHint')}>
            <Select value={draft.level} disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, level: event.target.value as ProtectorLevel }))}>
              {PROTECTOR_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t('protectors.level', { level })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('protectors.col.sizes')} hint={t('protectors.sizes.hint')} error={problems.sizes ? t(problems.sizes) : undefined}>
          <SizesPicker range={view.style.sizes} sizes={draft.sizes} only={only} disabled={!editable} name={`placement-sizes-${placement?.id ?? 'new'}`} onOnly={(next) => setOnly(next)} onChange={(sizes) => setDraft((current) => ({ ...current, sizes }))} />
        </Field>
        <Field label={t('protectors.col.position')} hint={t('protectors.dialog.positionHint')} error={problems.positionNote ? t(problems.positionNote) : undefined}>
          <Input value={draft.positionNote} maxLength={PLACEMENT_LIMITS.positionNote} disabled={!editable} placeholder={t('protectors.position.placeholder')} onChange={(event) => setDraft((current) => ({ ...current, positionNote: event.target.value }))} />
        </Field>
      </div>
    </Modal>
  )
}

/** Every size (it follows the range), or only the sizes ticked. */
function SizesPicker({ range, sizes, only, disabled, name, onOnly, onChange }: { range: readonly string[]; sizes: readonly string[]; only: boolean; disabled?: boolean; name: string; onOnly: (only: boolean) => void; onChange: (sizes: string[]) => void }) {
  const t = useT('products-prepacks')
  return (
    <div className="fw-ptc-choices">
      <Radio name={name} label={t('protectors.sizes.every')} checked={!only} disabled={disabled} onChange={() => onOnly(false)} />
      <Radio name={name} label={t('protectors.sizes.only')} checked={only} disabled={disabled} onChange={() => onOnly(true)} />
      {only && (
        <div className="fw-ptc-sizes" role="group" aria-label={t('protectors.sizes.only')}>
          {range.map((size) => (
            <Checkbox key={size} label={size} disabled={disabled} checked={sizes.includes(size)} onChange={() => onChange(range.filter((code) => (code === size ? !sizes.includes(size) : sizes.includes(code))))} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The sizes of one placement: saved with the button (a cell's change, autosaved like the others). */
function SizesDialog({ view, placement, actions }: { view: ProtectorPlacementView; placement: PlacementView; actions?: ProtectorsActions }) {
  const t = useT('products-prepacks')
  const tp = useT('products')
  const [sizes, setSizes] = useState<string[]>([...placement.sizes])
  const [only, setOnly] = useState(placement.sizes.length > 0)
  const close = () => actions?.onDialog?.(null)
  const held = only && sizes.length === 0 ? t('protectors.sizes.pickOne') : null
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('protectors.sizes.title', { seq: placement.seq, pocket: t(`protectors.pocketWord.${placement.pocket}`) })}
      footer={
        <>
          <Button onClick={close}>{tp('common.back')}</Button>
          <Button
            variant="primary"
            heldReason={held}
            onClick={() => {
              actions?.onCell?.(placement, 'sizes', only ? sizes : [])
              close()
            }}
          >
            {t('protectors.sizes.apply')}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog">
        <p className="fw-st-hint">{t('protectors.sizes.hint')}</p>
        <SizesPicker range={view.style.sizes} sizes={sizes} only={only} name={`sizes-${placement.id}`} onOnly={setOnly} onChange={setSizes} />
      </div>
    </Modal>
  )
}

/** Remove one placement or the selection (back only by adding them again: said). */
function RemoveDialog({ view, ids, busy, actions }: { view: ProtectorPlacementView; ids: string[]; busy: boolean; actions?: ProtectorsActions }) {
  const t = useT('products-prepacks')
  const tp = useT('products')
  const names = view.placements.filter((placement) => ids.includes(placement.id)).map((placement) => `${placement.seq} · ${t(`protectors.pocket.${placement.pocket}`)} · ${placement.protector.code}`)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('protectors.remove.title', { count: names.length })}
      footer={
        <>
          <Button onClick={close}>{tp('common.back')}</Button>
          <Button variant="danger" heldReason={busy ? tp('held.busy') : null} onClick={() => void actions?.onRemove?.(ids)}>
            {t('protectors.remove.confirm', { count: names.length })}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog">
        <ul className="fw-ptc-findings">
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
        <p className="fw-st-hint">{t('protectors.remove.body', { revision: view.revision.revision })}</p>
      </div>
    </Modal>
  )
}
