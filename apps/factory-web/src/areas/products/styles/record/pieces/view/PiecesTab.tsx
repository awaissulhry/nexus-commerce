'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Layers, MoreHorizontal, Plus, Trash2, WifiOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Radio, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { MAX_PIECE_NAME, MAX_PIECE_NOTE, PATTERN_GRAINS } from '@nexus/factory-domain/product/pieces/rules'
import { CellSaveMark, Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../../list-frame/model'
import type { StyleView } from '../../../api'
import type { StyleRecordActions, StyleRecordViewModel } from '../../record-model'
import type { Piece, PiecesView } from '../api'
import {
  bulkGradeHeld,
  draftOf,
  draftPatch,
  draftProblems,
  gradeName,
  issueWords,
  lineLabel,
  markKey,
  NO_PIECES,
  pickedSizes,
  piecesCount,
  piecesHeld,
  shownValue,
  sizesText,
  type PieceCell,
  type PieceDraft,
  type PieceMark,
  type PiecesActions,
  type PiecesModel,
} from '../pieces-model'
import '../pieces.css'

/**
 * SCR-271 — Style › Files & patterns (design products.styles rec:Style tab style.files): the Pattern pieces section
 * (style.files.pieces; PRD-219, MES-055) — the pieces a garment of this revision is cut from, how many of each, the BOM
 * line each is cut from, the lowest hide grade each may be cut from (quality where it shows, yield where it does not),
 * the grain, the sizes it is in — on the shared list frame: each cell saves by itself with its mark (CellSaveMark;
 * waiting while offline), Enter (or a phone card) opens the piece, `n` adds one, ⋯ moves or removes a row, and with rows
 * selected: Minimum grade… · Remove N. A frozen revision draws everything as text (the band says why and where to go); a
 * role without the BOM's edit right too, with its own banner. Documents and files (style.files.files, W1) are not built:
 * the tab says so. It draws the view model and fetches nothing (use-pieces.ts loads it).
 */
export function PiecesTab({ model, actions }: { style?: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const pieces = model.pieces ?? NO_PIECES
  const act = actions?.pieces
  const part = pieces.part
  return (
    <div className="fw-st-stack">
      {part.status === 'ready' ? (
        <PiecesSection view={part.value} pieces={pieces} canManage={model.can.bomManage} recordBusy={model.busy} actions={act} />
      ) : part.status === 'error' ? (
        <Banner
          tone="danger"
          title={t('pieces.failed')}
          action={
            <Button size="sm" onClick={() => act?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(part.problem)}
        </Banner>
      ) : (
        <Card header={t('pieces.title')} aria-busy="true">
          <p className="fw-st-hint" role="status">
            <Spinner size={14} /> {t('pieces.loading')}
          </p>
          <div className="fw-st-skeleton">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} height={22} />
            ))}
          </div>
        </Card>
      )}
      <Card header={t('pieces.files.title')} description={t('pieces.files.notBuilt')} />
    </div>
  )
}

function PiecesSection({ view, pieces, canManage, recordBusy, actions }: { view: PiecesView; pieces: PiecesModel; canManage: boolean; recordBusy: boolean; actions?: PiecesActions }) {
  const t = useT('products')
  const locale = useLocale()
  const held = piecesHeld(view, canManage)
  const editable = held === null
  const busy = pieces.busy || recordBusy
  const addHeld = held ? t(held) : busy ? t('held.busy') : null
  const keyFrom = useRef<{ control: boolean; at: number } | null>(null)
  const latest = useRef({ actions, marks: pieces.marks, view })
  latest.current = { actions, marks: pieces.marks, view }
  const marksKey = JSON.stringify(pieces.marks)
  const rows = useMemo(() => [...view.pieces].sort((a, b) => a.seq - b.seq), [view.pieces])
  const lines = useMemo(() => new Map(view.lines.map((line) => [line.id, line])), [view.lines])
  const grades = useMemo(() => new Map(view.grades.map((grade) => [grade.id, grade])), [view.grades])
  const range = view.sizes.map((size) => size.code)

  // `n` adds a piece (never while typing or with a dialog open).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || event.key !== 'n' || pieces.dialog) return
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return
      if (addHeld) return
      event.preventDefault()
      latest.current.actions?.onDialog?.({ kind: 'piece', pieceId: null })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const columns = useMemo<ColDef<Piece>[]>(() => {
    const mark = (id: string, cell: PieceCell) => latest.current.marks[markKey(id, cell)]
    const cellAction = (piece: Piece, cell: PieceCell, value: unknown) => latest.current.actions?.onCell?.(piece, cell, value)
    const shown = (piece: Piece, cell: PieceCell) => shownValue(piece, cell, latest.current.marks)

    const NameCell = ({ data }: ICellRendererParams<Piece>) => {
      if (!data) return null
      const value = String(shown(data, 'name') ?? '')
      return (
        <span className="fw-pp-cell">
          {editable ? (
            <TextCell value={value} label={t('pieces.cell.name', { piece: data.name })} maxLength={MAX_PIECE_NAME} mark={mark(data.id, 'name')} onCommit={(next) => cellAction(data, 'name', next)} />
          ) : (
            <b className="fw-pp-text">{data.name}</b>
          )}
          <Mark mark={mark(data.id, 'name')} />
        </span>
      )
    }
    const QuantityCell = ({ data }: ICellRendererParams<Piece>) => {
      if (!data) return null
      return (
        <span className="fw-pp-cell">
          {editable ? <TextCell value={String(shown(data, 'quantity') ?? '')} label={t('pieces.cell.quantity', { piece: data.name })} maxLength={2} numeric mark={mark(data.id, 'quantity')} onCommit={(next) => cellAction(data, 'quantity', next)} /> : <span>{data.quantity}</span>}
          <Mark mark={mark(data.id, 'quantity')} />
        </span>
      )
    }
    const LineCell = ({ data }: ICellRendererParams<Piece>) => {
      if (!data) return null
      const lineId = (shown(data, 'bomLineId') as string | null) ?? ''
      const line = lineId ? lines.get(lineId) : undefined
      return (
        <span className="fw-pp-cell">
          {editable ? (
            <Select size="xs" aria-label={t('pieces.cell.line', { piece: data.name })} value={lineId} onChange={(event) => cellAction(data, 'bomLineId', event.target.value)}>
              <option value="">{t('pieces.line.none')}</option>
              {view.lines.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${lineLabel(entry)}${entry.placement ? ` · ${entry.placement}` : ''}${entry.leather ? ` · ${t('pieces.line.leatherShort')}` : ''}`}
                </option>
              ))}
            </Select>
          ) : line ? (
            <span className="fw-pp-text">
              {lineLabel(line)}
              {line.placement ? <span className="fw-pp-sub"> · {line.placement}</span> : null}
            </span>
          ) : (
            <span className="fw-pp-sub">{t('pieces.line.none')}</span>
          )}
          {/* The select's option already says "leather"; as text the tag does. */}
          {!editable && line?.leather && <Tag tone="neutral">{t('pieces.line.leather')}</Tag>}
          <Mark mark={mark(data.id, 'bomLineId')} />
        </span>
      )
    }
    const GradeCell = ({ data }: ICellRendererParams<Piece>) => {
      if (!data) return null
      const gradeId = (shown(data, 'minGradeId') as string | null) ?? ''
      const lineId = (shown(data, 'bomLineId') as string | null) ?? null
      const leather = lineId !== null && lines.get(lineId)?.leather === true
      const grade = gradeId ? grades.get(gradeId) : undefined
      const text = grade ? t('pieces.grade.orBetter', { code: grade.code, name: gradeName(grade, locale) }) : leather ? t('pieces.grade.any') : t('pieces.grade.notLeather')
      return (
        <span className="fw-pp-cell">
          {editable && leather ? (
            <Select size="xs" aria-label={t('pieces.cell.grade', { piece: data.name })} value={gradeId} onChange={(event) => cellAction(data, 'minGradeId', event.target.value)}>
              <option value="">{t('pieces.grade.any')}</option>
              {view.grades
                .filter((entry) => entry.active || entry.id === gradeId)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {t('pieces.grade.option', { code: entry.code, name: gradeName(entry, locale) })}
                  </option>
                ))}
            </Select>
          ) : (
            <span className={grade ? 'fw-pp-text' : 'fw-pp-sub'}>{text}</span>
          )}
          {grade && !grade.active && <Tag tone="warning">{t('pieces.grade.retired')}</Tag>}
          <Mark mark={mark(data.id, 'minGradeId')} />
        </span>
      )
    }
    const GrainCell = ({ data }: ICellRendererParams<Piece>) => {
      if (!data) return null
      const grain = String(shown(data, 'grain'))
      return (
        <span className="fw-pp-cell">
          {editable ? (
            <Select size="xs" aria-label={t('pieces.cell.grain', { piece: data.name })} value={grain} onChange={(event) => cellAction(data, 'grain', event.target.value)}>
              {PATTERN_GRAINS.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`pieces.grain.${entry}`)}
                </option>
              ))}
            </Select>
          ) : (
            <span>{t(`pieces.grain.${grain}`)}</span>
          )}
          <Mark mark={mark(data.id, 'grain')} />
        </span>
      )
    }
    const SizesCell = ({ data }: ICellRendererParams<Piece>) => {
      if (!data) return null
      const sizes = (shown(data, 'sizes') as string[]) ?? []
      const words = sizesText(sizes, range)
      return (
        <span className="fw-pp-cell">
          <span className={sizes.length === 0 ? 'fw-pp-sub' : 'fw-pp-text'}>{t(words.key, words.params)}</span>
          {editable && (
            <Button size="sm" variant="quiet" aria-label={t('pieces.cell.sizes', { piece: data.name })} onClick={() => latest.current.actions?.onDialog?.({ kind: 'sizes', pieceId: data.id })}>
              {t('pieces.sizes.change')}
            </Button>
          )}
          <Mark mark={mark(data.id, 'sizes')} />
        </span>
      )
    }
    const NoteCell = ({ data }: ICellRendererParams<Piece>) => {
      if (!data) return null
      const value = String(shown(data, 'note') ?? '')
      return (
        <span className="fw-pp-cell">
          {editable ? (
            <TextCell value={value} label={t('pieces.cell.note', { piece: data.name })} maxLength={MAX_PIECE_NOTE} placeholder={t('pieces.note.placeholder')} mark={mark(data.id, 'note')} onCommit={(next) => cellAction(data, 'note', next)} />
          ) : (
            <span className={data.note ? 'fw-pp-text' : 'fw-pp-sub'}>{data.note ?? '—'}</span>
          )}
          <Mark mark={mark(data.id, 'note')} />
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<Piece>) => {
      if (!data) return null
      const index = rows.findIndex((row) => row.id === data.id)
      const why = held ? t(held) : undefined
      const items: MenuItemDef[] = [
        { id: 'open', label: t(editable ? 'pieces.row.edit' : 'pieces.row.open'), onSelect: () => latest.current.actions?.onDialog?.({ kind: 'piece', pieceId: data.id }) },
        { id: 'up', label: t('pieces.row.up'), disabled: !editable || index === 0, description: why, onSelect: () => latest.current.actions?.onMove?.(data.id, -1) },
        { id: 'down', label: t('pieces.row.down'), disabled: !editable || index === rows.length - 1, description: why, onSelect: () => latest.current.actions?.onMove?.(data.id, 1) },
        { id: 'sep', separator: true },
        { id: 'remove', label: t('pieces.row.remove'), tone: 'danger', disabled: !editable, description: why, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'remove', ids: [data.id] }) },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('pieces.row.menu', { piece: data.name }) }} items={items} />
    }
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    return [
      { colId: 'name', headerName: t('pieces.col.name'), minWidth: 200, flex: 1.6, cellRenderer: NameCell, valueGetter: (params) => params.data?.name ?? '', ...plain },
      { colId: 'quantity', headerName: t('pieces.col.quantity'), minWidth: 110, flex: 0.6, cellRenderer: QuantityCell, valueGetter: (params) => params.data?.quantity ?? '', ...plain },
      {
        colId: 'line',
        headerName: t('pieces.col.line'),
        minWidth: 240,
        flex: 1.8,
        cellRenderer: LineCell,
        valueGetter: (params) => {
          const line = params.data?.bomLineId ? lines.get(params.data.bomLineId) : undefined
          return line ? lineLabel(line) : t('pieces.line.none')
        },
        ...plain,
      },
      {
        colId: 'grade',
        headerName: t('pieces.col.grade'),
        minWidth: 190,
        flex: 1.3,
        cellRenderer: GradeCell,
        valueGetter: (params) => {
          const grade = params.data?.minGradeId ? grades.get(params.data.minGradeId) : undefined
          return grade ? t('pieces.grade.orBetter', { code: grade.code, name: gradeName(grade, locale) }) : t('pieces.grade.any')
        },
        ...plain,
      },
      { colId: 'grain', headerName: t('pieces.col.grain'), minWidth: 150, flex: 1, cellRenderer: GrainCell, valueGetter: (params) => (params.data ? t(`pieces.grain.${params.data.grain}`) : ''), ...plain },
      {
        colId: 'sizes',
        headerName: t('pieces.col.sizes'),
        minWidth: 180,
        flex: 1.1,
        cellRenderer: SizesCell,
        valueGetter: (params) => {
          if (!params.data) return ''
          const words = sizesText(params.data.sizes, range)
          return t(words.key, words.params)
        },
        ...plain,
      },
      { colId: 'note', headerName: t('pieces.col.note'), minWidth: 180, flex: 1.4, cellRenderer: NoteCell, valueGetter: (params) => params.data?.note ?? '', ...plain },
      { colId: 'more', headerName: t('pieces.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', suppressMovable: true, cellRenderer: MoreCell, ...plain },
    ]
    // The cells read the marks through `latest`; a change of them redraws the cells.
  }, [t, locale, editable, held, lines, grades, rows, marksKey, view.lines, view.grades, range.join(',')])

  const selected = pieces.selected
  const count = piecesCount(view)
  const gradeHeld = held ? { key: held } : busy ? { key: 'held.busy' } : bulkGradeHeld(view, selected)
  const removeHeld = held ? t(held) : busy ? t('held.busy') : null
  const bulk = (
    <>
      <Button size="sm" aria-label={t('pieces.bulk.grade', { count: selected.length })} heldReason={gradeHeld ? t(gradeHeld.key, gradeHeld.params) : null} onClick={() => actions?.onDialog?.({ kind: 'grade', ids: [...selected] })}>
        <Layers size={13} aria-hidden /> <SelectionLabel>{t('pieces.bulk.grade', { count: selected.length })}</SelectionLabel>
      </Button>
      <Button size="sm" variant="danger-outline" aria-label={t('pieces.bulk.remove', { count: selected.length })} heldReason={removeHeld} onClick={() => actions?.onDialog?.({ kind: 'remove', ids: [...selected] })}>
        <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('pieces.bulk.remove', { count: selected.length })}</SelectionLabel>
      </Button>
    </>
  )
  const addButton = (
    <Button size="sm" variant="primary" heldReason={addHeld} onClick={() => actions?.onDialog?.({ kind: 'piece', pieceId: null })} aria-keyshortcuts="n">
      <Plus size={13} aria-hidden /> {t('pieces.add')}
    </Button>
  )
  const keys: ListKey[] = [
    { keys: ['n'], does: t('pieces.keys.add') },
    { keys: ['↵'], does: t('pieces.keys.open') },
  ]
  const waiting = Object.values(pieces.marks).filter((entry) => entry.state === 'waiting').length

  return (
    <section
      className="fw-st-stack"
      aria-label={t('pieces.title')}
      onKeyDownCapture={(event) => {
        // Where the last key was typed, seen before the grid sees it (the list opens a row on Enter).
        keyFrom.current = { control: !!(event.target as HTMLElement | null)?.closest?.('input, select, textarea, button'), at: Date.now() }
      }}
    >
      <Card header={t('pieces.title')} headingLevel={2} description={t('pieces.intro', { revision: view.revision.revision })} headerAction={addButton}>
        <p className="fw-st-hint">{t('pieces.rule')}</p>
      </Card>
      {held === 'pieces.held.noManage' && <Banner tone="info" title={t('pieces.readOnly.noManage')} />}
      {(pieces.offline || waiting > 0) && (
        <Banner
          tone="warning"
          title={
            <span className="fw-st-inline">
              <WifiOff size={14} aria-hidden /> {t('pieces.offline', { count: waiting })}
            </span>
          }
        />
      )}
      {view.issues.length > 0 && (
        <Banner tone="warning" title={t('pieces.issues.title', { count: view.issues.length })}>
          <ul className="fw-pp-issues">
            {view.issues.map((issue, index) => {
              const words = issueWords(issue, view)
              return <li key={`${issue.code}-${index}`}>{t(words.key, words.params)}</li>
            })}
          </ul>
        </Banner>
      )}
      <ListFrame<Piece>
        label={t('pieces.table')}
        listKey={null}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('pieces.count', { count: count.pieces, perGarment: count.perGarment })}
        selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        keys={keys}
        onOpen={(row) => {
          // Enter typed into a cell's own control (a name, a select, a button) is that control's, never "open the row".
          const key = keyFrom.current
          if (key && key.control && Date.now() - key.at < 1000) return
          actions?.onDialog?.({ kind: 'piece', pieceId: row.id })
        }}
        focusRow={pieces.focusRow}
        state={
          rows.length === 0 ? (
            <EmptyState title={t('pieces.empty.title')} description={t(editable ? 'pieces.empty.body' : 'pieces.empty.frozen')} action={editable ? addButton : undefined} />
          ) : undefined
        }
      />
      <PiecesDialogs view={view} pieces={pieces} editable={editable} busy={busy} actions={actions} />
    </section>
  )
}

/** A text cell: typed freely, saved when it is left or on Enter (Esc puts the stored value back). */
function TextCell({ value, label, maxLength, numeric, placeholder, mark, onCommit }: { value: string; label: string; maxLength: number; numeric?: boolean; placeholder?: string; mark?: PieceMark; onCommit: (next: string) => void }) {
  return (
    <Input
      size="xs"
      // A refusal puts the stored value back in the field (the mark says why).
      key={`${value}|${mark?.state ?? ''}`}
      defaultValue={value}
      aria-label={label}
      maxLength={maxLength}
      placeholder={placeholder}
      inputMode={numeric ? 'numeric' : undefined}
      onBlur={(event) => {
        if (event.target.value !== value) onCommit(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return
        event.preventDefault()
        const input = event.currentTarget
        if (event.key === 'Escape') input.value = value
        // Left after the grid has seen the key: while the field holds the focus, the list does not open the row.
        setTimeout(() => input.blur(), 0)
      }}
    />
  )
}

/** A cell's save mark: saving / waiting (the DS CellSaveMark), refused ("!" with our words); nothing once saved. */
function Mark({ mark }: { mark: PieceMark | undefined }) {
  const t = useT('products')
  if (!mark) return null
  if (mark.state === 'refused') {
    const reason = t(mark.problem ?? 'problem.write.invalid')
    return (
      <span className="fw-pp-refused" role="img" aria-label={reason} title={reason}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}

function PiecesDialogs({ view, pieces, editable, busy, actions }: { view: PiecesView; pieces: PiecesModel; editable: boolean; busy: boolean; actions?: PiecesActions }) {
  const dialog = pieces.dialog
  if (!dialog) return null
  if (dialog.kind === 'piece') return <PieceDialog key={dialog.pieceId ?? 'new'} view={view} piece={dialog.pieceId ? (view.pieces.find((entry) => entry.id === dialog.pieceId) ?? null) : null} draft={pieces.draft} editable={editable} busy={busy} actions={actions} />
  if (dialog.kind === 'sizes') {
    const piece = view.pieces.find((entry) => entry.id === dialog.pieceId)
    return piece ? <SizesDialog view={view} piece={piece} actions={actions} /> : null
  }
  if (dialog.kind === 'remove') return <RemoveDialog view={view} ids={dialog.ids} busy={busy} actions={actions} />
  return <GradeDialog view={view} ids={dialog.ids} busy={busy} actions={actions} />
}

/** Add a piece, or see and change every field of one (Enter on a row, a card on a phone); explicit Save. */
function PieceDialog({ view, piece, draft: preset, editable, busy, actions }: { view: PiecesView; piece: Piece | null; draft?: PieceDraft; editable: boolean; busy: boolean; actions?: PiecesActions }) {
  const t = useT('products')
  const locale = useLocale()
  const [draft, setDraft] = useState<PieceDraft>(() => preset ?? draftOf(piece))
  const [only, setOnly] = useState(draft.sizes.length > 0)
  const problems = { ...draftProblems(draft, view, piece?.id ?? null), ...(only && draft.sizes.length === 0 ? { sizes: 'pieces.sizes.pickOne' } : {}) }
  const first = Object.values(problems)[0]
  const leather = draft.bomLineId !== '' && view.lines.some((line) => line.id === draft.bomLineId && line.leather)
  const held = !editable ? t('pieces.held.frozen') : first ? t(first) : busy ? t('held.busy') : null
  const close = () => actions?.onDialog?.(null)
  const set = <K extends keyof PieceDraft>(field: K, value: PieceDraft[K]) =>
    setDraft((current) => {
      const next = { ...current, [field]: value }
      // A line that is not leather takes no grade: the field says so and the grade goes.
      if (field === 'bomLineId' && !view.lines.some((line) => line.id === value && line.leather)) next.minGradeId = ''
      return next
    })
  const go = () => {
    if (held) return
    void actions?.onSave?.(piece?.id ?? null, draftPatch(draft, piece))
  }
  const range = view.sizes
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={piece ? t('pieces.dialog.editTitle', { piece: piece.name }) : t('pieces.dialog.addTitle', { revision: view.revision.revision })}
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          {editable && (
            <Button variant="primary" heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
              {piece ? t('pieces.dialog.save') : t('pieces.dialog.add')}
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
          <Field label={t('pieces.col.name')} required hint={t('pieces.dialog.nameHint')} error={problems.name ? t(problems.name) : undefined}>
            <Input value={draft.name} maxLength={MAX_PIECE_NAME} autoFocus disabled={!editable} onChange={(event) => set('name', event.target.value)} />
          </Field>
          <Field label={t('pieces.col.quantity')} required hint={t('pieces.dialog.quantityHint')} error={problems.quantity ? t(problems.quantity) : undefined}>
            <Input value={draft.quantity} inputMode="numeric" maxLength={2} disabled={!editable} onChange={(event) => set('quantity', event.target.value)} />
          </Field>
          <Field label={t('pieces.col.line')} hint={t('pieces.dialog.lineHint')}>
            <Select value={draft.bomLineId} disabled={!editable} onChange={(event) => set('bomLineId', event.target.value)}>
              <option value="">{t('pieces.line.none')}</option>
              {view.lines.map((line) => (
                <option key={line.id} value={line.id}>
                  {`${lineLabel(line)} · ${line.name}${line.leather ? ` · ${t('pieces.line.leatherShort')}` : ''}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('pieces.col.grade')} hint={leather ? t('pieces.dialog.gradeHint') : t('pieces.dialog.gradeNotLeather')} error={problems.minGradeId ? t(problems.minGradeId) : undefined}>
            <Select value={draft.minGradeId} disabled={!editable || !leather} onChange={(event) => set('minGradeId', event.target.value)}>
              <option value="">{t('pieces.grade.any')}</option>
              {view.grades
                .filter((grade) => grade.active || grade.id === draft.minGradeId)
                .map((grade) => (
                  <option key={grade.id} value={grade.id}>
                    {t('pieces.grade.option', { code: grade.code, name: gradeName(grade, locale) })}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('pieces.col.grain')}>
            <Select value={draft.grain} disabled={!editable} onChange={(event) => set('grain', event.target.value as PieceDraft['grain'])}>
              {PATTERN_GRAINS.map((grain) => (
                <option key={grain} value={grain}>
                  {t(`pieces.grain.${grain}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('pieces.col.sizes')} hint={t('pieces.sizes.hint')} error={problems.sizes ? t(problems.sizes) : undefined}>
          <SizesPicker
            range={range}
            sizes={draft.sizes}
            only={only}
            disabled={!editable}
            name={`piece-sizes-${piece?.id ?? 'new'}`}
            onOnly={(next) => {
              setOnly(next)
              if (!next) set('sizes', [])
            }}
            onChange={(sizes) => set('sizes', sizes)}
          />
        </Field>
        <Field label={t('pieces.col.note')} error={problems.note ? t(problems.note) : undefined}>
          <Textarea value={draft.note} maxLength={MAX_PIECE_NOTE} rows={2} disabled={!editable} onChange={(event) => set('note', event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/** Every size (it follows the range), or only the sizes ticked. */
function SizesPicker({ range, sizes, only, disabled, name, onOnly, onChange }: { range: PiecesView['sizes']; sizes: readonly string[]; only: boolean; disabled?: boolean; name: string; onOnly: (only: boolean) => void; onChange: (sizes: string[]) => void }) {
  const t = useT('products')
  const codes = range.map((size) => size.code)
  return (
    <div className="fw-pp-choices">
      <Radio name={name} label={t('pieces.sizes.every')} checked={!only} disabled={disabled} onChange={() => onOnly(false)} />
      <Radio name={name} label={t('pieces.sizes.only')} checked={only} disabled={disabled} onChange={() => onOnly(true)} />
      {only && (
        <div className="fw-pp-sizes" role="group" aria-label={t('pieces.sizes.only')}>
          {range.map((size) => (
            <Checkbox
              key={size.code}
              label={size.label}
              disabled={disabled}
              checked={sizes.includes(size.code)}
              onChange={() => onChange(pickedSizes(sizes.includes(size.code) ? sizes.filter((code) => code !== size.code) : [...sizes, size.code], codes))}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** The sizes of one piece: saved with the button (a cell's change, autosaved like the others). */
function SizesDialog({ view, piece, actions }: { view: PiecesView; piece: Piece; actions?: PiecesActions }) {
  const t = useT('products')
  const [sizes, setSizes] = useState<string[]>([...piece.sizes])
  const [only, setOnly] = useState(piece.sizes.length > 0)
  const close = () => actions?.onDialog?.(null)
  const held = only && sizes.length === 0 ? t('pieces.sizes.pickOne') : null
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('pieces.sizes.title', { piece: piece.name })}
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button
            variant="primary"
            heldReason={held}
            onClick={() => {
              actions?.onCell?.(piece, 'sizes', only ? sizes : [])
              close()
            }}
          >
            {t('pieces.sizes.apply')}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog">
        <p className="fw-st-hint">{t('pieces.sizes.hint')}</p>
        <SizesPicker range={view.sizes} sizes={sizes} only={only} name={`sizes-${piece.id}`} onOnly={setOnly} onChange={setSizes} />
      </div>
    </Modal>
  )
}

/** Remove one piece or the selection (reversible only by adding them again: said). */
function RemoveDialog({ view, ids, busy, actions }: { view: PiecesView; ids: string[]; busy: boolean; actions?: PiecesActions }) {
  const t = useT('products')
  const names = view.pieces.filter((piece) => ids.includes(piece.id)).map((piece) => piece.name)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('pieces.remove.title', { count: names.length })}
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={busy ? t('held.busy') : null} onClick={() => void actions?.onRemove?.(ids)}>
            {t('pieces.remove.confirm', { count: names.length })}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog">
        <p>{names.join(', ')}</p>
        <p className="fw-st-hint">{t('pieces.remove.body', { revision: view.revision.revision })}</p>
      </div>
    </Modal>
  )
}

/** One minimum grade for the selected pieces (all of a leather line): one write, all or none. */
function GradeDialog({ view, ids, busy, actions }: { view: PiecesView; ids: string[]; busy: boolean; actions?: PiecesActions }) {
  const t = useT('products')
  const locale = useLocale()
  const [gradeId, setGradeId] = useState('')
  const names = view.pieces.filter((piece) => ids.includes(piece.id)).map((piece) => piece.name)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('pieces.bulk.gradeTitle', { count: names.length })}
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={busy ? t('held.busy') : null} onClick={() => void actions?.onBulkGrade?.(ids, gradeId || null)}>
            {t('pieces.bulk.gradeApply', { count: names.length })}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog">
        <p className="fw-st-hint">{names.join(', ')}</p>
        <Field label={t('pieces.col.grade')} hint={t('pieces.dialog.gradeHint')}>
          <Select value={gradeId} autoFocus onChange={(event) => setGradeId(event.target.value)}>
            <option value="">{t('pieces.grade.any')}</option>
            {view.grades
              .filter((grade) => grade.active)
              .map((grade) => (
                <option key={grade.id} value={grade.id}>
                  {t('pieces.grade.option', { code: grade.code, name: gradeName(grade, locale) })}
                </option>
              ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

