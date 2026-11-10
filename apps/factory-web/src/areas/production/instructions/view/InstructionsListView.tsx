'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, Download, ListPlus, MoreHorizontal, Plus, RotateCcw, Search } from 'lucide-react'
import { Banner, EmptyState, Field, Menu, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, RadioCard, Select, Spinner, Tag, TokenChip } from '@nexus/ui/primitives'
import { Combobox, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import type { InstructionRow, OperationRow, RevisionHit, StyleHit, TypedSteps } from '../api'
import {
  bulkStatusHeld,
  createHeld,
  isFiltered,
  isPageKey,
  keepLoaded,
  LIST_VIEWS,
  NS,
  previewHref,
  seenPhrase,
  sheetHref,
  TILES,
  type InstructionsCan,
  type ListAddress,
  type ListView,
  type NewDraft,
  type Notice,
} from '../model'
import { Freshness, InstructionsMessages, KeysDialog, LanguageChips, NoticeBanner, PageHead, useSay } from './parts'

/** The pickers' choices of New instruction (each read when the dialog opens). */
export interface Choices<T> {
  readonly items: readonly T[] | null
  readonly problem: string | null
}

export interface NewInstructionModel {
  readonly draft: NewDraft
  readonly operations: Choices<OperationRow>
  readonly styles: Choices<StyleHit> | null
  readonly revisions: Choices<RevisionHit> | null
  /** The instructions in force to copy from (this list's rows with a published version). */
  readonly copies: readonly InstructionRow[]
  readonly busy: boolean
  readonly problem: string | null
}

export interface TypedModel {
  readonly language: string
  readonly answer: TypedSteps | null
  readonly problem: string | null
  readonly busy: boolean
  readonly made: number | null
}

export interface InstructionsListModel {
  readonly prefix: string
  readonly can: InstructionsCan
  readonly address: ListAddress
  readonly rows: { readonly items: readonly InstructionRow[] | null; readonly truncated: boolean; readonly problem: string | null }
  readonly tiles: Readonly<Record<ListView, number | null>>
  readonly asOf: string | null
  readonly updates: number
  readonly busy: boolean
  readonly notice: Notice | null
  readonly creating: NewInstructionModel | null
  readonly typed: TypedModel | null
  readonly selected?: readonly string[]
  readonly dialog?: 'archive' | 'restore' | 'help' | null
}

export interface InstructionsListActions {
  onAddress?: (address: ListAddress) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onStatusMany?: (ids: string[], to: 'ARCHIVED' | 'ACTIVE', reason: string) => Promise<boolean>
  onNew?: (open: boolean) => void
  onNewDraft?: (draft: NewDraft) => void
  onCreate?: () => void
  onTyped?: (open: boolean) => void
  onTypedLanguage?: (language: string) => void
  onBringTyped?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-141 — Work instructions (Production › Floor control; design production.instructions, workspace-list): the photo and
 * video instructions per operation in the shared list frame (select-all, shift range, x; Export N, Archive N, Restore N;
 * keys only in the footer icon). Columns: operation · styles where used · languages (missing marked) · version · status ·
 * media · acknowledgements (a count of people, never names) · last changed. Tiles = saved views. New instruction (`c`) and
 * Bring in the typed steps of the routings. It fetches nothing.
 */
export function InstructionsListView({ model, actions }: { model: InstructionsListModel; actions?: InstructionsListActions }) {
  return (
    <InstructionsMessages>
      <List model={model} actions={actions} />
    </InstructionsMessages>
  )
}

function List({ model, actions }: { model: InstructionsListModel; actions?: InstructionsListActions }) {
  const t = useT(NS)
  const say = useSay()
  const locale = useLocale()
  const [query, setQuery] = useState(model.address.q)
  useEffect(() => setQuery(model.address.q), [model.address.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onAddress?.({ ...latest.current.model.address, q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [dialog, setDialog] = useState<'archive' | 'restore' | 'help' | null>(model.dialog ?? null)
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => keepLoaded(current, items)), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.creating || model.typed || dialog) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNew?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const recordHref = useCallback((row: InstructionRow) => `${model.prefix}/production/instructions/${encodeURIComponent(row.id)}`, [model.prefix])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('list.keyNew') }]

  const columns = useMemo<ColDef<InstructionRow>[]>(() => {
    const OperationCell = ({ data }: ICellRendererParams<InstructionRow>) =>
      data ? (
        <span className="fw-wi-cell">
          <Link className="fw-wi-rowlink" href={recordHref(data)}>
            {data.operation.code}
          </Link>
          <span className="fw-wi-sub">
            {data.operation.name} · {data.number}
          </span>
        </span>
      ) : null
    const StylesCell = ({ data }: ICellRendererParams<InstructionRow>) =>
      data ? (
        <span className="fw-wi-cell">
          <span>{data.style ? t('list.forRevision', { code: data.style.code, revision: data.style.revision }) : t('list.everyStyle')}</span>
          <span className="fw-wi-sub">{t('list.usedIn', { count: data.usedIn })}</span>
        </span>
      ) : null
    const LanguagesCell = ({ data }: ICellRendererParams<InstructionRow>) => (data ? <LanguageChips written={data.current?.languages ?? []} missing={data.current?.missingLanguages ?? []} /> : null)
    const VersionCell = ({ data }: ICellRendererParams<InstructionRow>) =>
      data ? (
        <span className="fw-wi-cell">
          <span>{data.current ? t('list.inForce', { number: data.current.number }) : t('list.noneInForce')}</span>
          <span className="fw-wi-sub">{data.draft ? t('list.draftOpen', { number: data.draft.number }) : data.current?.publishedAt ? t('list.publishedOn', { date: formatDate(data.current.publishedAt, { locale }) }) : ''}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<InstructionRow>) => {
      if (!data) return null
      if (data.status === 'ARCHIVED') return <Pill tone="neutral" size="sm">{t('list.status.ARCHIVED')}</Pill>
      if (data.draft) return <Pill tone="info" size="sm">{t('list.status.DRAFT')}</Pill>
      if (!data.current) return <Pill tone="warning" size="sm">{t('list.status.NONE')}</Pill>
      return <Pill tone="success" size="sm">{t('list.status.IN_FORCE')}</Pill>
    }
    const MediaCell = ({ data }: ICellRendererParams<InstructionRow>) => (data ? <span>{data.current ? formatNumber(data.current.media, locale) : '—'}</span> : null)
    const SeenCell = ({ data }: ICellRendererParams<InstructionRow>) => (data ? <span>{say(seenPhrase(data))}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<InstructionRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('list.open'), href: recordHref(data) },
            { id: 'tab', label: t('list.openNewTab'), href: recordHref(data), target: '_blank' },
            { id: 'versions', label: t('list.openVersions'), href: `${recordHref(data)}?tab=versions` },
            { id: 'acks', label: t('list.openAcks'), href: `${recordHref(data)}?tab=acks` },
            { id: 'sep', separator: true },
            { id: 'preview', label: t('record.preview'), href: previewHref(model.prefix, data.id, data.current?.versionId ?? data.draft?.versionId ?? null), target: '_blank', disabled: !data.current && !data.draft },
            { id: 'pdf', label: t('record.sheet'), href: sheetHref(model.prefix, data.id, data.current?.versionId ?? data.draft?.versionId ?? null), target: '_blank', disabled: !data.current && !data.draft },
            {
              id: 'copy',
              label: t('list.copyNumber'),
              onSelect: () => {
                void navigator.clipboard?.writeText(data.number).catch(() => undefined)
              },
            },
          ]}
        />
      ) : null
    return [
      { colId: 'operation', headerName: t('col.operation'), field: 'operation.code' as never, minWidth: 200, flex: 1.6, cellRenderer: OperationCell },
      { colId: 'styles', headerName: t('col.styles'), minWidth: 150, flex: 1.1, cellRenderer: StylesCell, valueGetter: (params) => params.data?.style?.code ?? '' },
      { colId: 'languages', headerName: t('col.languages'), minWidth: 140, flex: 1, cellRenderer: LanguagesCell, sortable: false },
      { colId: 'version', headerName: t('col.version'), minWidth: 130, flex: 0.9, cellRenderer: VersionCell, valueGetter: (params) => params.data?.current?.number ?? 0 },
      { colId: 'status', headerName: t('col.status'), minWidth: 130, flex: 0.7, cellRenderer: StatusCell, sortable: false },
      { colId: 'media', headerName: t('col.media'), minWidth: 120, flex: 0.5, type: 'rightAligned', cellRenderer: MediaCell, valueGetter: (params) => params.data?.current?.media ?? 0 },
      { colId: 'seen', headerName: t('col.seen'), minWidth: 120, flex: 0.7, cellRenderer: SeenCell, valueGetter: (params) => params.data?.current?.seen ?? -1 },
      { colId: 'changed', headerName: t('col.changed'), field: 'updatedAt', minWidth: 140, flex: 0.6, valueFormatter: (params) => (params.value ? formatDate(params.value as string, { locale }) : '—') },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, say, locale, recordHref, model.prefix])

  const filtered = isFiltered(model.address)
  const problem = model.rows.problem
  const showsState = problem !== null || (items !== null && items.length === 0)
  const state = !showsState ? undefined : problem === 'problem.forbidden' ? (
    <EmptyState title={t('list.forbidden.title')} description={t('list.forbidden.body')} />
  ) : problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : filtered ? (
    <EmptyState
      title={t('list.noMatch.title')}
      description={t('list.noMatch.body')}
      action={
        <Button size="sm" onClick={() => actions?.onAddress?.({ view: 'active', q: '', creating: false, typed: false })}>
          {t('list.clearAll')}
        </Button>
      }
    />
  ) : (
    <EmptyState
      title={t('list.empty.title')}
      description={t(model.can.manage ? 'list.empty.body' : 'list.empty.bodyView')}
      action={
        model.can.manage ? (
          <Button size="sm" variant="primary" onClick={() => actions?.onNew?.(true)}>
            {t('list.new')}
          </Button>
        ) : undefined
      }
    />
  )
  const archiving = picked.length > 0 && picked.every((row) => row.status === 'ARCHIVED')
  const archiveWhy = bulkStatusHeld(picked, 'ARCHIVED', model.can)
  const restoreWhy = bulkStatusHeld(picked, 'ACTIVE', model.can)

  if (!model.can.view)
    return (
      <div className="fw-wi">
        <EmptyState title={t('list.forbidden.title')} description={t('list.forbidden.body')} />
      </div>
    )

  return (
    <div className="fw-wi">
      <PageHead
        intro={t('list.intro')}
        status={<Freshness asOf={model.asOf} />}
        actions={
          <>
            <Button size="sm" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onTyped?.(true)}>
              <ListPlus size={14} aria-hidden /> {t('typed.open')}
            </Button>
            <Button size="sm" variant="primary" heldReason={model.can.manage ? (model.can.pickOperation ? null : t('held.noOperations')) : t('held.noManage')} onClick={() => actions?.onNew?.(true)} aria-keyshortcuts="c">
              <Plus size={14} aria-hidden /> {t('list.new')}
            </Button>
          </>
        }
      />
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {model.rows.truncated && <Banner tone="info" title={t('list.truncated')} />}
      <MetricStrip
        metrics={TILES.map((tile) => {
          const count = model.tiles[tile]
          return {
            label: t(`tile.${tile}`),
            value: count === null || count === undefined ? '—' : String(count),
            hint: t(`tileHint.${tile}`),
            onClick: () => actions?.onAddress?.({ ...model.address, view: model.address.view === tile ? 'active' : tile }),
            active: model.address.view === tile,
          }
        })}
      />
      {filtered && (
        <div className="fw-wi-chips" aria-label={t('list.activeFilters')}>
          {model.address.view !== 'active' && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onAddress?.({ ...model.address, view: 'active' })}>
              {t(`view.${model.address.view}`)}
            </TokenChip>
          )}
          {model.address.q.trim() && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onAddress?.({ ...model.address, q: '' })}>
              {t('list.chipSearch', { q: model.address.q.trim() })}
            </TokenChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onAddress?.({ view: 'active', q: '', creating: false, typed: false })}>
            {t('list.clearAll')}
          </Button>
        </div>
      )}
      <ListFrame<InstructionRow>
        label={t('list.tableLabel')}
        title={t('list.title')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t('list.count', { count: items.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <Select size="sm" aria-label={t('list.viewFilter')} value={model.address.view} onChange={(event) => actions?.onAddress?.({ ...model.address, view: event.target.value as ListView })}>
            {LIST_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`view.${view}`)}
              </option>
            ))}
          </Select>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
              {archiving ? (
                <Button size="sm" aria-label={t('bulk.restore', { count: picked.length })} heldReason={restoreWhy ? say(restoreWhy) : model.busy ? t('held.busy') : null} onClick={() => setDialog('restore')}>
                  <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('bulk.restore', { count: picked.length })}</SelectionLabel>
                </Button>
              ) : (
                <Button size="sm" variant="danger-outline" aria-label={t('bulk.archive', { count: picked.length })} heldReason={archiveWhy ? say(archiveWhy) : model.busy ? t('held.busy') : null} onClick={() => setDialog('archive')}>
                  <Archive size={13} aria-hidden /> <SelectionLabel>{t('bulk.archive', { count: picked.length })}</SelectionLabel>
                </Button>
              )}
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={() => setDialog('help')}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
      />
      {model.creating && <NewInstructionDialog model={model.creating} can={model.can} actions={actions} />}
      {model.typed && <TypedStepsDialog model={model.typed} actions={actions} />}
      {(dialog === 'archive' || dialog === 'restore') && <StatusDialog to={dialog === 'archive' ? 'ARCHIVED' : 'ACTIVE'} rows={picked} busy={model.busy} actions={actions} onDone={() => setSelected([])} onClose={() => setDialog(null)} />}
      {dialog === 'help' && <KeysDialog keys={listKeys(ownKeys, true)} onClose={() => setDialog(null)} />}
    </div>
  )
}

/** Archive N / Restore N: what it does on the floor, the instructions, a reason kept with each. */
function StatusDialog({ to, rows, busy, actions, onDone, onClose }: { to: 'ARCHIVED' | 'ACTIVE'; rows: readonly InstructionRow[]; busy: boolean; actions?: InstructionsListActions; onDone: () => void; onClose: () => void }) {
  const t = useT(NS)
  const [reason, setReason] = useState('')
  const shown = rows.filter((row) => (to === 'ARCHIVED' ? row.status === 'ACTIVE' : row.status === 'ARCHIVED'))
  const go = () => {
    if (busy) return
    void actions?.onStatusMany?.(shown.map((row) => row.id), to, reason.trim()).then((done) => {
      if (done) {
        onDone()
        onClose()
      }
    })
  }
  const verb = to === 'ARCHIVED' ? 'bulk.archive' : 'bulk.restore'
  return (
    <Modal
      open
      onClose={onClose}
      title={t(to === 'ARCHIVED' ? 'archive.title' : 'restore.title', { count: shown.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant={to === 'ARCHIVED' ? 'danger' : 'primary'} heldReason={busy ? t('held.busy') : shown.length === 0 ? t('held.pickRows') : null} onClick={go}>
            {busy ? <Spinner size={14} /> : null} {t(verb, { count: shown.length })}
          </Button>
        </>
      }
    >
      <div className="fw-wi-dialog">
        <ul className="fw-wi-list">
          {(to === 'ARCHIVED' ? ['archive.floor', 'archive.kept', 'archive.back'] : ['restore.floor', 'restore.twin']).map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
        <ul className="fw-wi-list">
          {shown.map((row) => (
            <li key={row.id}>
              <b>{row.number}</b> · {row.operation.code} {row.operation.name}
            </li>
          ))}
        </ul>
        <Field label={t('dialog.reason')} hint={t('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

/**
 * New instruction (design: New instruction, the page's primary): the library operation; for every style, or for one style
 * revision (that revision's work orders show it first); blank or a copy of an instruction in force (its steps, photos and
 * videos). It makes the instruction and its version 1 as a draft, then opens it.
 */
export function NewInstructionDialog({ model, can, actions }: { model: NewInstructionModel; can: InstructionsCan; actions?: InstructionsListActions }) {
  const t = useT(NS)
  const say = useSay()
  const draft = model.draft
  const set = (patch: Partial<NewDraft>) => actions?.onNewDraft?.({ ...draft, ...patch })
  const held = createHeld(draft, can, model.busy)
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  const operationOptions = (model.operations.items ?? []).map((row) => ({ value: row.id, label: `${row.code} · ${row.nameI18n?.it ?? row.name}` }))
  const styleOptions = (model.styles?.items ?? []).map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` }))
  const copies = model.copies.filter((row) => row.current !== null)
  return (
    <Modal
      open
      onClose={() => actions?.onNew?.(false)}
      title={t('new.title')}
      subtitle={t('new.subtitle')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onNew?.(false)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={say(held) || null} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={14} /> : null} {t('new.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-wi-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
        <Field label={t('new.operation')} required hint={t('new.operationHint')}>
          {model.operations.problem ? (
            <p className="fw-wi-hint fw-wi-warn">{t(model.operations.problem === 'problem.forbidden' ? 'held.noOperations' : model.operations.problem)}</p>
          ) : model.operations.items === null ? (
            <p className="fw-wi-hint fw-wi-inline" role="status">
              <Spinner size={12} /> {t('common.loading')}
            </p>
          ) : (
            <Combobox options={operationOptions} value={draft.operationId} onChange={(operationId) => set({ operationId })} placeholder={t('new.operationPlaceholder')} />
          )}
        </Field>
        <fieldset className="fw-wi-choices">
          <legend className="fw-wi-strong">{t('new.scope')}</legend>
          <div className="fw-wi-cards">
            <RadioCard name="wi-scope" value="every" checked={draft.scope === 'every'} selected={draft.scope === 'every'} onChange={() => set({ scope: 'every', styleId: '', revisionId: '' })} title={t('new.every')} description={t('new.everyHint')} />
            <RadioCard name="wi-scope" value="revision" checked={draft.scope === 'revision'} selected={draft.scope === 'revision'} disabled={!can.pickStyle} onChange={() => set({ scope: 'revision' })} title={t('new.revision')} description={can.pickStyle ? t('new.revisionHint') : t('held.noStyles')} />
          </div>
        </fieldset>
        {draft.scope === 'revision' && (
          <div className="fw-wi-form-grid">
            <Field label={t('new.style')} required>
              {model.styles?.problem ? (
                <p className="fw-wi-hint fw-wi-warn">{t(model.styles.problem)}</p>
              ) : !model.styles || model.styles.items === null ? (
                <p className="fw-wi-hint fw-wi-inline" role="status">
                  <Spinner size={12} /> {t('common.loading')}
                </p>
              ) : (
                <Combobox options={styleOptions} value={draft.styleId} onChange={(styleId) => set({ styleId, revisionId: '' })} placeholder={t('new.stylePlaceholder')} />
              )}
            </Field>
            <Field label={t('new.revisionPick')} required>
              <Select value={draft.revisionId} disabled={!draft.styleId || !model.revisions?.items} onChange={(event) => set({ revisionId: event.target.value })}>
                <option value="">{draft.styleId ? (model.revisions?.items ? t('new.revisionChoose') : t('common.loading')) : t('new.styleFirst')}</option>
                {(model.revisions?.items ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {t('new.revisionOption', { revision: row.revision, status: t(`revisionStatus.${row.status}`) })}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <Field label={t('new.copy')} hint={t('new.copyHint')}>
          <Select value={draft.copyFrom} onChange={(event) => set({ copyFrom: event.target.value })}>
            <option value="">{t('new.blank')}</option>
            {copies.map((row) => (
              <option key={row.id} value={row.current!.versionId}>
                {t('new.copyOption', { number: row.number, code: row.operation.code, version: row.current!.number })}
              </option>
            ))}
          </Select>
        </Field>
        <p className="fw-wi-hint">{t('new.after')}</p>
      </div>
    </Modal>
  )
}

/**
 * Bring in the typed steps (B-W2b-214 WI1:01): the `[ ] CODE words` lines typed in the routings become the first version of
 * an instruction per operation and revision — a draft, so nothing changes on the floor before a second person approves it.
 * The dry run first, then once.
 */
export function TypedStepsDialog({ model, actions }: { model: TypedModel; actions?: InstructionsListActions }) {
  const t = useT(NS)
  const answer = model.answer
  const toMake = answer?.toMake ?? 0
  return (
    <Modal
      open
      onClose={() => actions?.onTyped?.(false)}
      title={t('typed.title')}
      subtitle={t('typed.subtitle')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onTyped?.(false)}>{t('common.close')}</Button>
          <Button variant="primary" heldReason={model.busy ? t('held.busy') : !answer ? t('typed.held.reading') : toMake === 0 ? t('typed.held.nothing') : null} onClick={() => actions?.onBringTyped?.()}>
            {model.busy ? <Spinner size={14} /> : null} {t('typed.bring', { count: toMake })}
          </Button>
        </>
      }
    >
      <div className="fw-wi-dialog">
        {model.made !== null && <Banner tone="success" title={t('typed.made', { count: model.made })} />}
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
        <Field label={t('typed.language')} hint={t('typed.languageHint')}>
          <Select value={model.language} onChange={(event) => actions?.onTypedLanguage?.(event.target.value)}>
            <option value="it">{t('typed.lang.it')}</option>
            <option value="en">{t('typed.lang.en')}</option>
          </Select>
        </Field>
        {!answer && !model.problem ? (
          <p className="fw-wi-hint fw-wi-inline" role="status">
            <Spinner size={12} /> {t('common.loading')}
          </p>
        ) : answer && answer.rows.length === 0 ? (
          <p className="fw-wi-hint">{t('typed.none')}</p>
        ) : answer ? (
          <SummaryTable
            label={t('typed.tableLabel')}
            columns={[t('typed.col.style'), t('typed.col.step'), t('typed.col.lines'), t('typed.col.instruction')]}
            rows={answer.rows.map((row) => ({
              id: row.routingOperationId,
              cells: [
                t('list.forRevision', { code: row.style.code, revision: row.revision.revision }),
                `${row.step.seq} · ${row.step.code}`,
                <span key="lines" className="fw-wi-cell">
                  {row.steps.map((step) => (
                    <span key={step.code} className="fw-wi-sub">
                      {step.requiredTick ? t('typed.required', { code: step.code }) : t('typed.optional', { code: step.code })} {step.words}
                    </span>
                  ))}
                </span>,
                row.existing ? (
                  <Tag key="existing" tone="neutral">
                    {t('typed.existing', { number: row.existing.number })}
                  </Tag>
                ) : (
                  <Tag key="make" tone="info">
                    {t('typed.toMake')}
                  </Tag>
                ),
              ],
            }))}
            stackOnPhone
          />
        ) : null}
      </div>
    </Modal>
  )
}

