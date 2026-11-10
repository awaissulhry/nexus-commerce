'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Download, Image as ImageIcon, MoreHorizontal, Plus, RotateCcw, Search, Trash2, Upload, WifiOff } from 'lucide-react'
import { Banner, DetailPopover, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Spinner, Tag, TokenChip } from '@nexus/ui/primitives'
import { CellSaveMark, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import type { PomRow, PomView } from '../api'
import {
  blankPom,
  depthFiltered,
  markKey,
  NO_DEPTH_FILTERS,
  numberText,
  POM_KINDS,
  POM_UOMS,
  POM_ZONES,
  pomDraftOf,
  pomDraftProblems,
  statusHeld,
  STATUS_VIEWS,
  unitText,
  type CellMark,
  type DepthCan,
  type DepthFilters,
  type DepthProblem,
  type PomCell,
  type PomDraft,
} from '../model'
import { DepthHead, isTypingKey, KeysDialog, ProblemBanner } from './parts'

export type PomDialog = { kind: 'new' } | { kind: 'edit'; id: string } | { kind: 'status'; to: 'ACTIVE' | 'ARCHIVED'; ids: string[] } | { kind: 'help' }

export interface PomsViewModel {
  prefix: string
  can: DepthCan
  filters: DepthFilters
  companies: Array<{ id: string; name: string }>
  companyId: string | null
  locale: 'it' | 'en'
  rows: { items: PomRow[] | null; more: boolean; count: number | null; problem: string | null }
  asOf: string | null
  updates: number
  notice: { key: string; tone: 'info' | 'success' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
  busy: boolean
  marks: Record<string, CellMark>
  dialog: PomDialog | null
  /** The dialog's point (Edit) as read, its write state and the API's refusal. */
  edit: { point: PomView | null; problem: string | null; busy: boolean; refused: DepthProblem | null } | null
  /** The BODY points a garment point may answer to (read when a dialog opens); null not read yet. */
  bodyPoints: Array<{ id: string; code: string; name: string }> | null
  /** A how-to picture looked at (its card open). */
  looks: Record<string, { state: 'loading' | 'ready' | 'error'; url?: string }>
  offline: boolean
  /** Design cases. */
  selected?: string[]
  draft?: PomDraft
  focusRow?: number
}

export interface PomsActions {
  onFilters?: (filters: DepthFilters) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onCell?: (point: PomRow, cell: PomCell, text: string) => void
  onDialog?: (dialog: PomDialog | null) => void
  onCreate?: (draft: PomDraft) => Promise<boolean>
  onSave?: (point: PomView, draft: PomDraft) => Promise<boolean>
  onStatus?: (ids: string[], to: 'ACTIVE' | 'ARCHIVED') => Promise<boolean>
  onExport?: (ids: string[]) => void
  onLook?: (id: string) => void
  onPicture?: (point: PomView, file: File) => Promise<boolean>
  onClearPicture?: (point: PomView) => Promise<boolean>
  onDismissNotice?: () => void
}

/**
 * SCR-345 — Sizes & measurements › Points of measure (B-W2b-240; design products.sizes sec:sizes.poms, PRD-062): the POM
 * library on the shared list frame — code, name, how to measure (text, and its picture in a card), unit, default
 * tolerance, the body point a garment point answers to, state — with the name, how-to, unit and tolerance typed in the
 * list and saved by themselves (CellSaveMark; a refusal is "!" with our words; offline they wait on this page), Archive
 * N / Restore N / Export N of the selection, New point (`c`) and Edit point (Enter or ⋯: every field and the picture).
 * It draws the view model and fetches nothing.
 */
export function PomsView({ model, actions }: { model: PomsViewModel; actions?: PomsActions }) {
  const t = useT('products-sizes-depth')
  const locale = useLocale()
  const [query, setQuery] = useState(model.filters.q)
  useEffect(() => setQuery(model.filters.q), [model.filters.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onFilters?.({ ...latest.current.model.filters, q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => (items ?? []).some((row) => row.id === id))), [rowsKey])
  const manage = model.can.manage
  const marksKey = JSON.stringify(model.marks)
  const looksKey = JSON.stringify(model.looks)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingKey(event) || model.dialog) return
      if (event.key === 'c' && manage) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'new' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const columns = useMemo<ColDef<PomRow>[]>(() => {
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    const mark = (id: string, cell: PomCell): CellMark | undefined => latest.current.model.marks[markKey(id, cell)]
    const shown = (row: PomRow, cell: PomCell): string => {
      const pending = mark(row.id, cell)
      if (pending && pending.state !== 'refused' && pending.value !== undefined) return pending.value
      const value = row[cell]
      if (cell === 'defaultTolerance') return value === null ? '' : locale === 'it' ? String(value).replace('.', ',') : String(value)
      return value === null ? '' : String(value)
    }
    const editableRow = (row: PomRow) => manage && row.status === 'ACTIVE'
    const CodeCell = ({ data }: ICellRendererParams<PomRow>) =>
      data ? (
        <span className="fw-szd-cell">
          <b>{data.code}</b>
          <span className="fw-szd-sub">
            {t(`kind.${data.kind}`)} · {t(`zone.${data.bodyZone}`)}
          </span>
        </span>
      ) : null
    const NameCell = ({ data }: ICellRendererParams<PomRow>) =>
      data ? (
        <span className="fw-szd-edit">
          {editableRow(data) ? <TextCell value={shown(data, 'name')} label={t('poms.cell.name', { code: data.code })} maxLength={200} mark={mark(data.id, 'name')} onCommit={(text) => latest.current.actions?.onCell?.(data, 'name', text)} /> : <span className="fw-szd-text">{data.name}</span>}
          <Mark mark={mark(data.id, 'name')} />
        </span>
      ) : null
    const HowToCell = ({ data }: ICellRendererParams<PomRow>) =>
      data ? (
        <span className="fw-szd-edit">
          {data.hasPicture && <PictureCard point={data} look={latest.current.model.looks[data.id]} onLook={() => latest.current.actions?.onLook?.(data.id)} />}
          {editableRow(data) ? (
            <TextCell value={shown(data, 'howTo')} label={t('poms.cell.howTo', { code: data.code })} maxLength={2000} placeholder={t('poms.howToPlaceholder')} mark={mark(data.id, 'howTo')} onCommit={(text) => latest.current.actions?.onCell?.(data, 'howTo', text)} />
          ) : (
            <span className="fw-szd-text" title={data.howTo ?? undefined}>
              {data.howTo ?? <span className="fw-szd-sub">{t('poms.noHowTo')}</span>}
            </span>
          )}
          <Mark mark={mark(data.id, 'howTo')} />
        </span>
      ) : null
    const UnitCell = ({ data }: ICellRendererParams<PomRow>) =>
      data ? (
        <span className="fw-szd-edit">
          {editableRow(data) ? (
            <Select size="xs" value={shown(data, 'uom')} aria-label={t('poms.cell.uom', { code: data.code })} onChange={(event) => latest.current.actions?.onCell?.(data, 'uom', event.target.value)}>
              {POM_UOMS.map((uom) => (
                <option key={uom} value={uom}>
                  {unitText(uom)}
                </option>
              ))}
            </Select>
          ) : (
            <span>{unitText(data.uom)}</span>
          )}
          <Mark mark={mark(data.id, 'uom')} />
        </span>
      ) : null
    const ToleranceCell = ({ data }: ICellRendererParams<PomRow>) =>
      data ? (
        <span className="fw-szd-edit">
          {editableRow(data) ? (
            <TextCell value={shown(data, 'defaultTolerance')} label={t('poms.cell.tolerance', { code: data.code })} maxLength={12} placeholder={t('poms.tolerancePlaceholder')} inputMode="decimal" mark={mark(data.id, 'defaultTolerance')} onCommit={(text) => latest.current.actions?.onCell?.(data, 'defaultTolerance', text)} />
          ) : (
            <span>{data.defaultTolerance === null ? <span className="fw-szd-sub">{t('poms.perSpec')}</span> : `± ${numberText(data.defaultTolerance, locale)} ${unitText(data.uom)}`}</span>
          )}
          <Mark mark={mark(data.id, 'defaultTolerance')} />
        </span>
      ) : null
    const BodyCell = ({ data }: ICellRendererParams<PomRow>) =>
      data ? data.bodyPoint ? <span title={data.bodyPoint.name}>{data.bodyPoint.code}</span> : <span className="fw-szd-sub">{data.kind === 'BODY' ? t('poms.isBody') : '—'}</span> : null
    const StatusCell = ({ data }: ICellRendererParams<PomRow>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`status.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<PomRow>) => {
      if (!data) return null
      const held = latest.current.model.can.manage ? undefined : t('held.noManage')
      const items: MenuItemDef[] = [
        { id: 'edit', label: t(held ? 'poms.menu.view' : 'poms.menu.edit'), onSelect: () => latest.current.actions?.onDialog?.({ kind: 'edit', id: data.id }) },
        data.status === 'ACTIVE'
          ? { id: 'archive', label: t('poms.menu.archive'), tone: 'danger', disabled: !!held, description: held, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'status', to: 'ARCHIVED', ids: [data.id] }) }
          : { id: 'restore', label: t('poms.menu.restore'), disabled: !!held, description: held, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'status', to: 'ACTIVE', ids: [data.id] }) },
        {
          id: 'copy',
          label: t('poms.menu.copyCode'),
          onSelect: () => {
            void navigator.clipboard?.writeText(data.code).catch(() => undefined)
          },
        },
      ]
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('poms.menu.more', { code: data.code }) }} items={items} />
    }
    return [
      { colId: 'code', headerName: t('poms.col.code'), field: 'code', minWidth: 170, flex: 1, pinned: 'left', cellRenderer: CodeCell, ...plain, sortable: true },
      { colId: 'name', headerName: t('poms.col.name'), field: 'name', minWidth: 200, flex: 1.4, cellRenderer: NameCell, ...plain },
      // The value names the picture too: a picture added to a row redraws its cell.
      { colId: 'howTo', headerName: t('poms.col.howTo'), minWidth: 260, flex: 2, valueGetter: (params) => `${params.data?.howTo ?? ''}${params.data?.hasPicture ? ' ·' : ''}`, cellRenderer: HowToCell, ...plain },
      { colId: 'uom', headerName: t('poms.col.uom'), field: 'uom', minWidth: 96, maxWidth: 120, cellRenderer: UnitCell, ...plain },
      { colId: 'tolerance', headerName: t('poms.col.tolerance'), field: 'defaultTolerance', minWidth: 180, flex: 0.9, cellRenderer: ToleranceCell, ...plain },
      { colId: 'body', headerName: t('poms.col.body'), minWidth: 130, flex: 0.8, valueGetter: (params) => params.data?.bodyPoint?.code ?? '', cellRenderer: BodyCell, ...plain },
      { colId: 'status', headerName: t('poms.col.status'), field: 'status', minWidth: 110, maxWidth: 130, cellRenderer: StatusCell, ...plain },
      { colId: 'more', headerName: t('poms.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', suppressMovable: true, cellRenderer: MoreCell, ...plain },
    ]
  }, [t, locale, manage, marksKey, looksKey])

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const archiveHeld = statusHeld(picked, 'ARCHIVED', manage, model.busy)
  const restoreHeld = statusHeld(picked, 'ACTIVE', manage, model.busy)
  const keys: ListKey[] = [
    { keys: ['c'], does: t('poms.keys.new') },
    { keys: ['↵'], does: t('poms.keys.open') },
  ]
  const filtered = depthFiltered(model.filters)
  const waiting = Object.values(model.marks).filter((entry) => entry.state === 'waiting').length
  const [help, setHelp] = useState(false)
  // Enter typed into a cell's own control (a text, a select, a button) is that control's, never "open the row".
  const keyFrom = useRef<{ control: boolean; at: number } | null>(null)

  const state =
    model.rows.problem !== null ? (
      <EmptyState
        title={t(model.rows.problem === 'problem.read.forbidden' ? 'poms.forbidden.title' : 'poms.error.title')}
        description={t(model.rows.problem === 'problem.read.forbidden' ? 'poms.forbidden.body' : model.rows.problem)}
        action={
          model.rows.problem === 'problem.read.forbidden' ? undefined : (
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          )
        }
      />
    ) : items && items.length === 0 ? (
      filtered ? (
        <EmptyState
          title={t('poms.filteredEmpty.title')}
          description={t('poms.filteredEmpty.body')}
          action={
            <Button size="sm" onClick={() => actions?.onFilters?.(NO_DEPTH_FILTERS)}>
              {t('common.clearFilters')}
            </Button>
          }
        />
      ) : (
        <EmptyState
          title={t('poms.empty.title')}
          description={t(manage ? 'poms.empty.body' : 'poms.empty.bodyView')}
          action={
            manage ? (
              <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ kind: 'new' })}>
                {t('poms.new')}
              </Button>
            ) : undefined
          }
        />
      )
    ) : undefined

  return (
    <div
      className="fw-szd"
      onKeyDownCapture={(event) => {
        keyFrom.current = { control: !!(event.target as HTMLElement | null)?.closest?.('input, select, textarea, button'), at: Date.now() }
      }}
    >
      <DepthHead
        intro={t('poms.intro')}
        status={
          <span className="fw-szd-sub" role="status">
            {model.asOf ? t('common.updated', { time: formatTime(model.asOf, { locale }) }) : t('common.notYet')}
          </span>
        }
        actions={
          <Button size="sm" variant="primary" heldReason={manage ? null : t('held.noManage')} onClick={() => actions?.onDialog?.({ kind: 'new' })} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('poms.new')}
          </Button>
        }
      />
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {(model.offline || waiting > 0) && (
        <Banner
          tone="warning"
          title={
            <span className="fw-szd-inline">
              <WifiOff size={14} aria-hidden /> {t('poms.offline', { count: waiting })}
            </span>
          }
        />
      )}
      {filtered && (
        <div className="fw-szd-chips" aria-label={t('common.activeFilters')}>
          {model.filters.status !== 'open' && (
            <TokenChip removeLabel={t('common.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, status: 'open' })}>
              {t(`statusView.${model.filters.status}`)}
            </TokenChip>
          )}
          {model.filters.kind && (
            <TokenChip removeLabel={t('common.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, kind: null })}>
              {t(`kind.${model.filters.kind}`)}
            </TokenChip>
          )}
          {model.filters.q.trim() && (
            <TokenChip removeLabel={t('common.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, q: '' })}>
              {t('common.chipSearch', { q: model.filters.q.trim() })}
            </TokenChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_DEPTH_FILTERS)}>
            {t('common.clearAll')}
          </Button>
        </div>
      )}
      <ListFrame<PomRow>
        label={t('poms.table')}
        listKey="products.sizes.2"
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'common.countMore' : 'common.count', { count: items.length, total: model.rows.count ?? items.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('poms.search')}
            placeholder={t('poms.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <>
            <Select size="sm" aria-label={t('poms.kindFilter')} value={model.filters.kind ?? ''} onChange={(event) => actions?.onFilters?.({ ...model.filters, kind: (event.target.value || null) as DepthFilters['kind'] })}>
              <option value="">{t('poms.kindAll')}</option>
              {POM_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('common.statusFilter')} value={model.filters.status} onChange={(event) => actions?.onFilters?.({ ...model.filters, status: event.target.value as DepthFilters['status'] })}>
              {STATUS_VIEWS.map((view) => (
                <option key={view} value={view}>
                  {t(`statusView.${view}`)}
                </option>
              ))}
            </Select>
          </>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" aria-label={t('poms.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('poms.bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('poms.bulk.restore', { count: picked.length })} heldReason={restoreHeld ? t(restoreHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'status', to: 'ACTIVE', ids: picked.map((row) => row.id) })}>
                <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('poms.bulk.restore', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" variant="danger-outline" aria-label={t('poms.bulk.archive', { count: picked.length })} heldReason={archiveHeld ? t(archiveHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'status', to: 'ARCHIVED', ids: picked.map((row) => row.id) })}>
                <Archive size={13} aria-hidden /> <SelectionLabel>{t('poms.bulk.archive', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('common.more'), onMore: () => actions?.onMore?.() } : null}
        keys={keys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => {
          const key = keyFrom.current
          if (key && key.control && Date.now() - key.at < 1000) return
          actions?.onDialog?.({ kind: 'edit', id: row.id })
        }}
        state={state}
        focusRow={model.focusRow}
      />
      {(model.dialog?.kind === 'new' || model.dialog?.kind === 'edit') && <PomDialogView model={model} actions={actions} />}
      {model.dialog?.kind === 'status' && <StatusDialog rows={(items ?? []).filter((row) => (model.dialog as { ids: string[] }).ids.includes(row.id))} to={model.dialog.to} busy={model.busy} actions={actions} onDone={() => setSelected([])} />}
      {(help || model.dialog?.kind === 'help') && (
        <KeysDialog
          keys={listKeys(keys, true)}
          onClose={() => {
            setHelp(false)
            if (model.dialog?.kind === 'help') actions?.onDialog?.(null)
          }}
        />
      )}
    </div>
  )
}

/** A text cell: typed freely, saved when it is left or on Enter (Esc puts the stored value back). */
function TextCell({ value, label, maxLength, placeholder, mark, inputMode, onCommit }: { value: string; label: string; maxLength: number; placeholder?: string; mark?: CellMark; inputMode?: 'decimal'; onCommit: (next: string) => void }) {
  return (
    <Input
      size="xs"
      key={`${value}|${mark?.state ?? ''}`}
      defaultValue={value}
      aria-label={label}
      maxLength={maxLength}
      placeholder={placeholder}
      inputMode={inputMode}
      onBlur={(event) => {
        if (event.target.value !== value) onCommit(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        const input = event.currentTarget
        if (event.key === 'Escape') input.value = value
        setTimeout(() => input.blur(), 0)
      }}
    />
  )
}

/** A cell's save mark: saving or waiting (the DS CellSaveMark), refused ("!" with our words); nothing once saved. */
export function Mark({ mark }: { mark: Pick<CellMark, 'state' | 'problem'> | undefined }) {
  const t = useT('products-sizes-depth')
  if (!mark) return null
  if (mark.state === 'refused') {
    const reason = t(mark.problem ?? 'poms.problem.write')
    return (
      <span className="fw-szd-refused" role="img" aria-label={reason} title={reason}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}

/** How to measure (design pop:sizes.howTo "Picture and text"): the picture in a card, read when the card opens. */
export function PictureCard({ point, look, onLook }: { point: Pick<PomRow, 'code' | 'name' | 'howTo'>; look: { state: 'loading' | 'ready' | 'error'; url?: string } | undefined; onLook: () => void }) {
  const t = useT('products-sizes-depth')
  return (
    <DetailPopover
      trigger={<ImageIcon size={14} aria-hidden />}
      triggerLabel={t('poms.picture.open', { code: point.code })}
      triggerClassName="fw-szd-picbtn"
      label={t('poms.picture.title', { code: point.code })}
      hoverDelay={300}
      onOpenChange={(open) => {
        if (open) onLook()
      }}
    >
      <div className="fw-szd-howto">
        <b>
          {point.code} · {point.name}
        </b>
        {look?.state === 'ready' && look.url ? (
          <img className="fw-szd-howto-img" src={look.url} alt={t('poms.picture.alt', { code: point.code })} />
        ) : look?.state === 'error' ? (
          <span className="fw-szd-sub">{t('poms.picture.failed')}</span>
        ) : (
          <span className="fw-szd-sub" role="status">
            <Spinner size={12} /> {t('poms.picture.loading')}
          </span>
        )}
        <span className="fw-szd-sub">{point.howTo ?? t('poms.noHowTo')}</span>
      </div>
    </DetailPopover>
  )
}

function StatusDialog({ rows, to, busy, actions, onDone }: { rows: readonly PomRow[]; to: 'ACTIVE' | 'ARCHIVED'; busy: boolean; actions?: PomsActions; onDone: () => void }) {
  const t = useT('products-sizes-depth')
  const close = () => actions?.onDialog?.(null)
  const verb = to === 'ARCHIVED' ? 'poms.bulk.archive' : 'poms.bulk.restore'
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t(to === 'ARCHIVED' ? 'poms.status.archiveTitle' : 'poms.status.restoreTitle', { count: rows.length })}
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button
            variant={to === 'ARCHIVED' ? 'danger' : 'primary'}
            heldReason={busy ? t('held.busy') : null}
            onClick={() =>
              void actions?.onStatus?.(
                rows.map((row) => row.id),
                to,
              ).then((done) => done && onDone())
            }
          >
            {t(verb, { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-szd-dialog">
        <p className="fw-szd-sub">{t(to === 'ARCHIVED' ? 'poms.status.archiveBody' : 'poms.status.restoreBody')}</p>
        <ul className="fw-szd-list">
          {rows.map((row) => (
            <li key={row.id}>
              <b>{row.code}</b> · {row.name}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}

/** New point · Edit point (every field; the kind and unit change only while nothing names the point: the API says so). */
function PomDialogView({ model, actions }: { model: PomsViewModel; actions?: PomsActions }) {
  const t = useT('products-sizes-depth')
  const dialog = model.dialog
  const editing = dialog?.kind === 'edit'
  const point = editing ? (model.edit?.point ?? null) : null
  const close = () => actions?.onDialog?.(null)
  if (editing && !point)
    return (
      <Modal open onClose={close} size="md" title={t('poms.dialog.editTitle')} footer={<Button onClick={close}>{t('common.back')}</Button>}>
        {model.edit?.problem ? (
          <Banner tone="danger" title={t('poms.dialog.failed')} action={<Button size="sm" onClick={() => dialog && actions?.onDialog?.(dialog)}>{t('common.retry')}</Button>}>
            {t(model.edit.problem)}
          </Banner>
        ) : (
          <p className="fw-szd-sub" role="status">
            <Spinner size={14} /> {t('common.reading')}
          </p>
        )}
      </Modal>
    )
  return <PomForm key={point ? `${point.id}:${point.version}` : 'new'} model={model} point={point} actions={actions} />
}

function PomForm({ model, point, actions }: { model: PomsViewModel; point: PomView | null; actions?: PomsActions }) {
  const t = useT('products-sizes-depth')
  const locale = useLocale()
  const [draft, setDraft] = useState<PomDraft>(() => model.draft ?? (point ? pomDraftOf(point, locale) : blankPom(model.companyId)))
  const set = (patch: Partial<PomDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const file = useRef<HTMLInputElement | null>(null)
  const manage = model.can.manage && (point === null || point.status === 'ACTIVE')
  const taken = (model.rows.items ?? []).map((row) => row.code)
  const problems = pomDraftProblems(draft, taken, point?.code ?? null)
  const first = Object.values(problems)[0]
  const busy = model.edit?.busy ?? false
  const refused = model.edit?.refused ?? null
  const unchanged = point !== null && JSON.stringify(draft) === JSON.stringify(pomDraftOf(point, locale))
  const held = !model.can.manage ? t('held.noManage') : point?.status === 'ARCHIVED' ? t('poms.held.archived') : first ? t(first) : unchanged ? t('held.nothing') : busy ? t('held.busy') : null
  const inUse = point ? point.use.specValues + point.use.gradeSteps + point.use.templatePoints + point.use.garmentPoints.length > 0 : false
  const close = () => actions?.onDialog?.(null)
  const save = () => {
    if (held) return
    if (point) void actions?.onSave?.(point, draft)
    else void actions?.onCreate?.(draft)
  }
  const error = (field: keyof typeof problems) => (problems[field] && (draft.code !== '' || field !== 'code') ? t(problems[field]!) : refused?.paths.some((path) => path === field || path.startsWith(`${field}/`)) ? t('poms.problem.refusedField') : undefined)
  const bodyChoices = model.bodyPoints ?? []
  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={point ? t('poms.dialog.editTitleOf', { code: point.code }) : t('poms.dialog.newTitle')}
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          {(manage || point === null) && (
            <Button variant="primary" heldReason={held} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
              {t(point ? 'common.save' : 'poms.dialog.create')}
            </Button>
          )}
        </>
      }
    >
      <div
        className="fw-szd-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        {!manage && point && <Banner tone="info" title={t(model.can.manage ? 'poms.held.archived' : 'poms.readOnly')} />}
        {refused && <ProblemBanner problem={refused} />}
        {point && <p className="fw-szd-sub">{inUse ? t('poms.dialog.inUse', { specs: point.use.specs, values: point.use.specValues, rules: point.use.gradeRules, templates: point.use.templatePoints }) : t('poms.dialog.unused')}</p>}
        <div className="fw-szd-form">
          {point === null && model.companies.length > 1 && (
            <Field label={t('poms.field.company')} hint={t('poms.field.companyHint')}>
              <Select value={draft.companyId ?? ''} onChange={(event) => set({ companyId: event.target.value || null })}>
                <option value="">{t('common.everyCompany')}</option>
                {model.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('poms.field.code')} required hint={t('poms.field.codeHint')} error={error('code')}>
            <Input value={draft.code} maxLength={40} readOnly={!manage} autoFocus={point === null} onChange={(event) => set({ code: event.target.value })} />
          </Field>
          <Field label={t('poms.field.name')} required error={error('name')}>
            <Input value={draft.name} maxLength={200} readOnly={!manage} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label={t('poms.field.kind')} hint={inUse ? t('poms.field.kindInUse') : t('poms.field.kindHint')} error={error('kind')}>
            <Select value={draft.kind} disabled={!manage || inUse} onChange={(event) => set({ kind: event.target.value as PomDraft['kind'], bodyPointId: null })}>
              {POM_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('poms.field.zone')}>
            <Select value={draft.bodyZone} disabled={!manage} onChange={(event) => set({ bodyZone: event.target.value as PomDraft['bodyZone'] })}>
              {POM_ZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {t(`zone.${zone}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('poms.field.uom')} hint={inUse ? t('poms.field.uomInUse') : undefined} error={error('uom')}>
            <Select value={draft.uom} disabled={!manage || inUse} onChange={(event) => set({ uom: event.target.value as PomDraft['uom'] })}>
              {POM_UOMS.map((uom) => (
                <option key={uom} value={uom}>
                  {unitText(uom)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('poms.field.tolerance')} hint={t('poms.field.toleranceHint')} error={error('defaultTolerance')}>
            <Input value={draft.defaultTolerance} inputMode="decimal" maxLength={12} readOnly={!manage} onChange={(event) => set({ defaultTolerance: event.target.value })} />
          </Field>
          {draft.kind === 'GARMENT' && (
            <Field label={t('poms.field.body')} hint={t('poms.field.bodyHint')} error={error('bodyPointId')}>
              <Select value={draft.bodyPointId ?? ''} disabled={!manage || model.bodyPoints === null} onChange={(event) => set({ bodyPointId: event.target.value || null })}>
                <option value="">{model.bodyPoints === null ? t('common.reading') : t('poms.field.bodyNone')}</option>
                {point?.bodyPoint && !bodyChoices.some((choice) => choice.id === point.bodyPoint!.id) && <option value={point.bodyPoint.id}>{`${point.bodyPoint.code} · ${point.bodyPoint.name}`}</option>}
                {bodyChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {`${choice.code} · ${choice.name}`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="fw-szd-span">
            <Field label={t('poms.field.howTo')} hint={t('poms.field.howToHint')} error={error('howTo')}>
              <Textarea value={draft.howTo} rows={3} maxLength={2000} readOnly={!manage} onChange={(event) => set({ howTo: event.target.value })} />
            </Field>
          </div>
        </div>
        {point && (
          <section className="fw-szd-picture" aria-label={t('poms.picture.section')}>
            <h3 className="fw-szd-h3">{t('poms.picture.section')}</h3>
            {point.picture ? (
              <div className="fw-szd-inline">
                <Tag tone={point.picture.status === 'AVAILABLE' ? 'success' : 'warning'}>{point.picture.status === 'AVAILABLE' ? t('poms.picture.onFile') : t('poms.picture.scanning')}</Tag>
                <span className="fw-szd-sub">{point.picture.originalName}</span>
                {point.hasPicture && <PictureCard point={point} look={model.looks[point.id]} onLook={() => actions?.onLook?.(point.id)} />}
              </div>
            ) : (
              <p className="fw-szd-sub">{t('poms.picture.none')}</p>
            )}
            {manage && (
              <div className="fw-szd-inline">
                <input
                  ref={file}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="fw-szd-file"
                  aria-label={t('poms.picture.choose')}
                  onChange={(event) => {
                    const picked = event.target.files?.[0]
                    event.target.value = ''
                    if (picked) void actions?.onPicture?.(point, picked)
                  }}
                />
                <Button size="sm" heldReason={busy ? t('held.busy') : null} onClick={() => file.current?.click()}>
                  <Upload size={13} aria-hidden /> {t(point.picture ? 'poms.picture.replace' : 'poms.picture.add')}
                </Button>
                {point.picture && (
                  <Button size="sm" variant="danger-outline" heldReason={busy ? t('held.busy') : null} onClick={() => void actions?.onClearPicture?.(point)}>
                    <Trash2 size={13} aria-hidden /> {t('poms.picture.remove')}
                  </Button>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </Modal>
  )
}
