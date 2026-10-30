'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, Download, MoreHorizontal, Plus, RotateCcw, Search } from 'lucide-react'
import { Field, Menu, MetricStrip, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Textarea, TokenChip } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { minutesText } from '../../styles/model'
import { isPageKey, keepLoaded, type LibraryCan, type Notice } from '../../library/model'
import { Freshness, KeysDialog, LibraryMessages, listState, NoticeBanner, PageHead, showsState } from '../../library/parts'
import type { OperationRow } from '../api'
import { archiveHeld, createHeld, isFiltered, NO_FILTERS, OPERATION_TILES, OPERATION_VIEWS, reactivateHeld, STATUS_TONE, WORK_CENTRE_KINDS, type OperationDraft, type OperationFilters, type OperationTile, type WorkCentreKind } from '../model'

export interface NewOperationModel {
  draft: OperationDraft
  companies: Array<{ id: string; name: string }>
  busy: boolean
  problem: string | null
  refused: string[]
}

export interface OperationsListViewModel {
  prefix: string
  can: LibraryCan
  filters: OperationFilters
  rows: { items: OperationRow[] | null; more: boolean; count: number | null; problem: string | null }
  tiles: Partial<Record<OperationTile, number | null>>
  asOf: string | null
  updates: number
  newOperation: NewOperationModel | null
  busy: boolean
  notice: Notice | null
  selected?: string[]
  focusRow?: number
  dialog?: 'archive' | 'help' | null
}

export interface OperationsListActions {
  onFilters?: (filters: OperationFilters) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onStatusMany?: (ids: string[], to: 'ARCHIVED' | 'ACTIVE', reason: string) => Promise<boolean>
  onNew?: (open: boolean) => void
  onDraft?: (draft: OperationDraft) => void
  onCreate?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-049 — Operations (Products › Libraries; design products.operations, 00 §2.1 list frame): the library routings pick
 * from, with standard minutes (SMV), department, machine and skill. Tiles = saved views (used in no routing; minutes
 * that differ in some routings), the shared list frame (select-all, shift range, x; Export N, Archive N, Reactivate N;
 * keys only in the footer icon), each code a real link to the operation record, and New operation (`c`). No money. It
 * fetches nothing.
 */
export function OperationsListView({ model, actions }: { model: OperationsListViewModel; actions?: OperationsListActions }) {
  return (
    <LibraryMessages>
      <OperationsList model={model} actions={actions} />
    </LibraryMessages>
  )
}

function OperationsList({ model, actions }: { model: OperationsListViewModel; actions?: OperationsListActions }) {
  const t = useT('library')
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
  const [dialog, setDialog] = useState<'archive' | 'help' | null>(model.dialog ?? null)
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => keepLoaded(current, items)), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newOperation || dialog) return
      if (event.key === 'c' && model.can.operationsManage) {
        event.preventDefault()
        actions?.onNew?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const recordHref = useCallback((row: OperationRow) => `${model.prefix}/products/operations/${row.id}`, [model.prefix])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('operations.list.keyNew') }]

  const columns = useMemo<ColDef<OperationRow>[]>(() => {
    const CodeCell = ({ data }: ICellRendererParams<OperationRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <Link className="fw-lib-rowlink" href={recordHref(data)}>
            {data.code}
          </Link>
          <span className="fw-lib-sub">{data.nameI18n?.[locale] ?? data.name}</span>
        </span>
      ) : null
    const MachineCell = ({ data }: ICellRendererParams<OperationRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <span>{data.machineType ?? '—'}</span>
          <span className="fw-lib-sub">{data.skill ? t('operations.list.skill', { skill: data.skill }) : t('operations.list.noSkill')}</span>
        </span>
      ) : null
    const UsedCell = ({ data }: ICellRendererParams<OperationRow>) =>
      data ? (
        <span className="fw-lib-cell fw-lib-right">
          <span>{t('operations.list.usedIn', { count: data.usedIn })}</span>
          {data.differing > 0 ? <span className="fw-lib-sub fw-lib-warn">{t('operations.list.differing', { count: data.differing })}</span> : <span className="fw-lib-sub">{data.usedIn === 0 ? t('operations.list.unused') : t('operations.list.allSame')}</span>}
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<OperationRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<OperationRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { code: data.code }) }}
          items={[
            { id: 'open', label: t('list.open'), href: recordHref(data) },
            { id: 'tab', label: t('list.openNewTab'), href: recordHref(data), target: '_blank' },
            { id: 'used', label: t('operations.list.openUsed'), href: `${recordHref(data)}?tab=whereused` },
            {
              id: 'copy',
              label: t('list.copyCode'),
              onSelect: () => {
                void navigator.clipboard?.writeText(data.code).catch(() => undefined)
              },
            },
          ]}
        />
      ) : null
    return [
      { colId: 'code', headerName: t('operations.col.operation'), field: 'code', minWidth: 200, flex: 2, cellRenderer: CodeCell },
      { colId: 'kind', headerName: t('operations.col.department'), field: 'workCentreKind', minWidth: 130, flex: 1, valueFormatter: (params) => t(`department.${params.value as string}`) },
      { colId: 'machine', headerName: t('operations.col.machine'), field: 'machineType', minWidth: 160, flex: 1.2, cellRenderer: MachineCell },
      { colId: 'smv', headerName: t('operations.col.smv'), field: 'standardMinutes', minWidth: 110, flex: 0.8, type: 'rightAligned', valueFormatter: (params) => t('operations.list.minutes', { minutes: minutesText(params.value as string, locale) }) },
      { colId: 'used', headerName: t('operations.col.used'), field: 'usedIn', minWidth: 150, flex: 1, type: 'rightAligned', cellRenderer: UsedCell },
      { colId: 'status', headerName: t('operations.col.status'), field: 'status', minWidth: 100, maxWidth: 130, cellRenderer: StatusCell },
      { colId: 'more', headerName: t('list.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, recordHref])

  const filtered = isFiltered(model.filters)
  const state = showsState(model.rows.problem, items)
    ? listState({
        problem: model.rows.problem,
        rows: items,
        filtered,
        forbidden: { title: t('operations.forbidden.title'), body: t('operations.forbidden.body') },
        empty: {
          title: t('operations.empty.title'),
          body: t(model.can.operationsManage ? 'operations.empty.body' : 'operations.empty.bodyView'),
          action: model.can.operationsManage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onNew?.(true)}>
              {t('operations.empty.create')}
            </Button>
          ) : undefined,
        },
        onRetry: () => actions?.onRetry?.(),
        onClear: () => actions?.onFilters?.(NO_FILTERS),
      })
    : undefined
  const archiveReason = archiveHeld(picked, model.can)
  const reactivateReason = reactivateHeld(picked, model.can)

  return (
    <div className="fw-lib">
      <PageHead
        intro={t('operations.list.intro')}
        status={<Freshness asOf={model.asOf} />}
        actions={
          <Button size="sm" variant="primary" heldReason={model.can.operationsManage ? null : t('held.noManage')} onClick={() => actions?.onNew?.(true)} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('operations.list.new')}
          </Button>
        }
      />
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <MetricStrip
        metrics={OPERATION_TILES.map((tile) => {
          const count = model.tiles[tile]
          return {
            label: t(`operations.tile.${tile}`),
            value: count === null || count === undefined ? '—' : String(count),
            hint: t(`operations.tileHint.${tile}`),
            onClick: () => actions?.onFilters?.({ ...model.filters, view: model.filters.view === tile ? 'open' : tile }),
            active: model.filters.view === tile,
          }
        })}
      />
      {filtered && (
        <div className="fw-lib-chips" aria-label={t('list.activeFilters')}>
          {model.filters.view !== 'open' && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, view: 'open' })}>
              {t(`operations.view.${model.filters.view}`)}
            </TokenChip>
          )}
          {model.filters.kind && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, kind: '' })}>
              {t(`department.${model.filters.kind}`)}
            </TokenChip>
          )}
          {model.filters.q.trim() && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, q: '' })}>
              {t('list.chipSearch', { q: model.filters.q.trim() })}
            </TokenChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
            {t('list.clearAll')}
          </Button>
        </div>
      )}
      <ListFrame<OperationRow>
        label={t('operations.list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: items.length, total: model.rows.count ?? items.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('operations.list.search')}
            placeholder={t('operations.list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <>
            <Select size="sm" aria-label={t('list.viewFilter')} value={model.filters.view} onChange={(event) => actions?.onFilters?.({ ...model.filters, view: event.target.value as OperationFilters['view'] })}>
              {OPERATION_VIEWS.map((view) => (
                <option key={view} value={view}>
                  {t(`operations.view.${view}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('operations.list.departmentFilter')} value={model.filters.kind} onChange={(event) => actions?.onFilters?.({ ...model.filters, kind: event.target.value as OperationFilters['kind'] })}>
              <option value="">{t('operations.list.allDepartments')}</option>
              {WORK_CENTRE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`department.${kind}`)}
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
              <Button size="sm" aria-label={t('list.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
              {picked.length > 0 && picked.every((row) => row.status === 'ARCHIVED') ? (
                <Button size="sm" aria-label={t('list.bulk.reactivate', { count: picked.length })} heldReason={reactivateReason ? t(reactivateReason) : model.busy ? t('held.busy') : null} onClick={() => void actions?.onStatusMany?.(picked.map((row) => row.id), 'ACTIVE', '').then((done) => done && setSelected([]))}>
                  <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.reactivate', { count: picked.length })}</SelectionLabel>
                </Button>
              ) : (
                <Button size="sm" variant="danger-outline" aria-label={t('list.bulk.archive', { count: picked.length })} heldReason={archiveReason ? t(archiveReason) : null} onClick={() => setDialog('archive')}>
                  <Archive size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.archive', { count: picked.length })}</SelectionLabel>
                </Button>
              )}
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setDialog('help')}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />
      {model.newOperation && <NewOperationDialog model={model.newOperation} actions={actions} />}
      {dialog === 'archive' && <ArchiveDialog rows={picked} busy={model.busy} actions={actions} onDone={() => setSelected([])} onClose={() => setDialog(null)} />}
      {dialog === 'help' && <KeysDialog keys={listKeys(ownKeys, true)} onClose={() => setDialog(null)} />}
    </div>
  )
}

function ArchiveDialog({ rows, busy, actions, onDone, onClose }: { rows: readonly OperationRow[]; busy: boolean; actions?: OperationsListActions; onDone: () => void; onClose: () => void }) {
  const t = useT('library')
  const [reason, setReason] = useState('')
  const go = () => {
    if (busy) return
    void actions?.onStatusMany?.(rows.map((row) => row.id), 'ARCHIVED', reason.trim()).then((done) => {
      if (done) {
        onDone()
        onClose()
      }
    })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('operations.archive.title', { count: rows.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={busy ? t('held.busy') : null} onClick={go}>
            {t('list.bulk.archive', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <ul className="fw-lib-list">
          <li>{t('operations.archive.reach')}</li>
          <li>{t('operations.archive.kept')}</li>
          <li>{t('operations.archive.back')}</li>
        </ul>
        <ul className="fw-lib-list">
          {rows.map((row) => (
            <li key={row.id}>
              <b>{row.code}</b> · {row.name}
              {row.usedIn > 0 ? ` — ${t('operations.list.usedIn', { count: row.usedIn })}` : ''}
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

/** New operation (design operations.new): code, name per language, department, machine type, skill, SMV, instructions. */
export function NewOperationDialog({ model, actions }: { model: NewOperationModel; actions?: OperationsListActions }) {
  const t = useT('library')
  const draft = model.draft
  const set = (patch: Partial<OperationDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  const held = createHeld(draft, model.busy)
  const refused = (field: string) => (model.refused.some((path) => path === field || path.startsWith(`${field}/`)) ? t('newMaterial.refused') : undefined)
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onNew?.(false)}
      title={t('newOperation.title')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onNew?.(false)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('newOperation.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-lib-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <p className="fw-lib-hint">{t('newOperation.intro')}</p>
        <OperationFields draft={draft} set={set} refused={refused} companies={model.companies} withCode />
        {model.problem && <p className="fw-lib-danger fw-lib-hint">{t(model.problem)}</p>}
      </div>
    </Modal>
  )
}

/** The fields of an operation (New operation and the record's Definition). */
export function OperationFields({
  draft,
  set,
  refused,
  companies = [],
  withCode,
  codeHeld,
}: {
  draft: OperationDraft
  set: (patch: Partial<OperationDraft>) => void
  refused: (field: string) => string | undefined
  companies?: ReadonlyArray<{ id: string; name: string }>
  withCode?: boolean
  /** Why the code no longer changes (a routing copied it). */
  codeHeld?: string | null
}) {
  const t = useT('library')
  return (
    <div className="fw-lib-form-grid">
      {companies.length > 1 && (
        <Field label={t('newMaterial.company')} hint={t('newOperation.companyHint')}>
          <Select value={draft.companyId ?? ''} onChange={(event) => set({ companyId: event.target.value || null })}>
            <option value="">{t('newMaterial.everyCompany')}</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {withCode && (
        <Field label={t('operation.code')} required hint={codeHeld ?? t('material.codeHint')} error={refused('code')}>
          <Input value={draft.code} maxLength={40} autoFocus disabled={!!codeHeld} onChange={(event) => set({ code: event.target.value.toUpperCase() })} />
        </Field>
      )}
      <Field label={t('operation.name')} required error={refused('name')}>
        <Input value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} />
      </Field>
      <Field label={t('material.nameIt')} hint={t('operation.floorNameHint')} error={refused('nameI18n')}>
        <Input value={draft.nameIt} maxLength={200} onChange={(event) => set({ nameIt: event.target.value })} />
      </Field>
      <Field label={t('material.nameEn')} hint={t('operation.floorNameHint')}>
        <Input value={draft.nameEn} maxLength={200} onChange={(event) => set({ nameEn: event.target.value })} />
      </Field>
      <Field label={t('operation.department')} hint={t('operation.departmentHint')} error={refused('workCentreKind')}>
        <Select value={draft.workCentreKind} onChange={(event) => set({ workCentreKind: event.target.value as WorkCentreKind })}>
          {WORK_CENTRE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`department.${kind}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('operation.machine')} hint={t('operation.machineHint')} error={refused('machineType')}>
        <Input value={draft.machineType} maxLength={60} onChange={(event) => set({ machineType: event.target.value })} />
      </Field>
      <Field label={t('operation.skill')} error={refused('skill')}>
        <Input value={draft.skill} maxLength={60} onChange={(event) => set({ skill: event.target.value })} />
      </Field>
      <Field label={t('operation.smv')} required hint={t('operation.smvHint')} error={refused('standardMinutes')}>
        <Input inputMode="decimal" value={draft.minutes} onChange={(event) => set({ minutes: event.target.value })} />
      </Field>
      <div className="fw-lib-span">
        <Field label={t('operation.instructions')} hint={t('operation.instructionsHint')} error={refused('instructions')}>
          <Textarea value={draft.instructions} rows={3} maxLength={4000} onChange={(event) => set({ instructions: event.target.value })} />
        </Field>
      </div>
    </div>
  )
}
