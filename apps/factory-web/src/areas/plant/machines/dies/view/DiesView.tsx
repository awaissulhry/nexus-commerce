'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, Archive, Check, Download, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { WithMessages } from '../../../../../record-panels/i18n'
import { Cost, KeysModal, LiveLine, NoPlantAccess, PlantMessages } from '../../../_shared/parts'
import { DIE_SETTABLE_CONDITIONS, type Die, type DieSettableCondition } from '../api'
import { CONDITION_TONE, DIE_ROWS, diesFiltered, retireHeldOf } from '../model'
import type { DieCellState, DiesActions, DiesModel } from '../view-model'
import { DieDialogs } from './DieDialogs'
import { DIES_NAMESPACES, sayDie, useDieWords } from './words'

export type { DiesActions, DiesModel } from '../view-model'
export { DIES_NAMESPACES }

/**
 * Plant › Machines & tools › Clicking dies (B-W2b-136; QHS-173; design plant.machines/sec:dies "Cutting dies per style,
 * size and piece"): the register on the shared list frame — die number, style, size (or every size), the piece it cuts
 * with its pattern piece, the rack it hangs on (inline), material, supplier (parties.view), cost (the cost grain only) and
 * its condition (inline: good, worn, damaged; retired is Retire's) —, Rows ▾ (in use, worn or damaged, retired, all), a
 * search, New die (`c`), Retire N and Export N on the selected rows. Pattern revision (obsolete mark) and strokes are
 * Later. Owner question Q17 (a clicking press?) is open: this section is its own files.
 */
export function DiesView({ model, actions }: { model: DiesModel; actions?: DiesActions }) {
  return (
    <PlantMessages>
      <WithMessages namespaces={DIES_NAMESPACES}>
        <Dies model={model} actions={actions} />
      </WithMessages>
    </PlantMessages>
  )
}

function CellMark({ cell }: { cell: DieCellState | undefined }) {
  const t = useDieWords()
  if (!cell) return null
  if (cell.state === 'saving') return <Spinner size={12} />
  if (cell.state === 'saved') return <Check size={13} className="fw-pl-success" aria-label={t('cell.saved')} />
  return <AlertCircle size={13} className="fw-pl-danger" aria-label={sayDie(t, cell.words) ?? t('cell.failed')} />
}

/** The rack, typed in its cell: saved on Enter or when the focus leaves, Escape puts it back. */
function RackInput({ die, label, onSave }: { die: Die; label: string; onSave: (typed: string) => void }) {
  const [typed, setTyped] = useState(die.rackLocation ?? '')
  useEffect(() => setTyped(die.rackLocation ?? ''), [die.rackLocation, die.version])
  const commit = () => {
    if (typed.trim() !== (die.rackLocation ?? '')) onSave(typed)
  }
  return (
    <Input
      size="sm"
      aria-label={label}
      value={typed}
      maxLength={120}
      onChange={(event) => setTyped(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
        if (event.key === 'Escape') setTyped(die.rackLocation ?? '')
      }}
    />
  )
}

function Dies({ model, actions }: { model: DiesModel; actions?: DiesActions }) {
  const t = useDieWords()
  const [query, setQuery] = useState(model.address.q)
  useEffect(() => setQuery(model.address.q), [model.address.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const rowsKey = model.rows.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const allSites = model.sites.length > 1 && model.siteId === null
  const canEdit = model.can.manage

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        latest.current?.onNew?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.can.manage, help])

  // The cells call the section's latest actions (the grid keeps its columns between renders).
  const act = useRef(actions)
  act.current = actions
  const columns = useMemo<ColDef<Die>[]>(() => {
    const CodeCell = ({ data }: ICellRendererParams<Die>) =>
      data ? (
        <span className="fw-pl-cell">
          <span className="fw-pl-code">{data.code}</span>
          {data.note ? <span className="fw-pl-sub fw-pl-ellipsis" title={data.note}>{data.note}</span> : null}
        </span>
      ) : null
    const StyleCell = ({ data }: ICellRendererParams<Die>) =>
      data ? (
        <span className="fw-pl-cell">
          <span className="fw-pl-code">{data.style.code}</span>
          <span className="fw-pl-sub fw-pl-ellipsis">{data.style.name}</span>
        </span>
      ) : null
    const SizeCell = ({ data }: ICellRendererParams<Die>) => (data ? <span className={data.size ? 'fw-pl-code' : 'fw-pl-sub'}>{data.size ?? t('die.everySize')}</span> : null)
    const PieceCell = ({ data }: ICellRendererParams<Die>) =>
      data ? (
        <span className="fw-pl-cell">
          <span className="fw-pl-ellipsis">{data.piece}</span>
          <span className="fw-pl-sub">{data.patternPiece ? t('die.patternPiece', { piece: data.patternPiece.name, revision: data.patternPiece.revision }) : t('die.noPatternPiece')}</span>
        </span>
      ) : null
    const RackCell = ({ data }: ICellRendererParams<Die>) => {
      if (!data) return null
      if (!canEdit || data.condition === 'RETIRED') return <span className="fw-pl-ellipsis">{data.rackLocation ?? '—'}</span>
      return (
        <span className="fw-pl-row">
          <RackInput die={data} label={t('cell.rack', { die: data.code })} onSave={(next) => act.current?.onRack?.(data, next)} />
          <CellMark cell={model.cells[`${data.id}:rackLocation`]} />
        </span>
      )
    }
    const ConditionCell = ({ data }: ICellRendererParams<Die>) => {
      if (!data) return null
      if (!canEdit || data.condition === 'RETIRED') {
        return (
          <Pill tone={CONDITION_TONE[data.condition]} dot>
            {t(`condition.${data.condition}`)}
          </Pill>
        )
      }
      return (
        <span className="fw-pl-row">
          <Select size="sm" aria-label={t('cell.condition', { die: data.code })} value={data.condition} onChange={(event) => act.current?.onCondition?.(data, event.target.value as DieSettableCondition)}>
            {DIE_SETTABLE_CONDITIONS.map((condition) => (
              <option key={condition} value={condition}>
                {t(`condition.${condition}`)}
              </option>
            ))}
          </Select>
          <CellMark cell={model.cells[`${data.id}:condition`]} />
        </span>
      )
    }
    const SupplierCell = ({ data }: ICellRendererParams<Die>) => (data ? <span className="fw-pl-ellipsis" title={data.supplier?.name}>{data.supplier ? data.supplier.code : '—'}</span> : null)
    const CostCell = ({ data }: ICellRendererParams<Die>) => (data ? <Cost minor={data.purchaseCost} /> : null)
    const SiteCell = ({ data }: ICellRendererParams<Die>) => <span className="fw-pl-code">{data?.siteCode ?? ''}</span>
    const MoreCell = ({ data }: ICellRendererParams<Die>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('dies.rowMenu', { die: data.code }) }}
          items={[
            {
              id: 'retire',
              label: t('dies.retireOne'),
              disabled: !canEdit || data.condition === 'RETIRED',
              ...(!canEdit ? { description: t('held.noManage') } : data.condition === 'RETIRED' ? { description: t('held.alreadyRetired') } : {}),
              onSelect: () => act.current?.onRetire?.([data]),
            },
          ]}
        />
      ) : null
    const list: ColDef<Die>[] = [
      { colId: 'code', headerName: t('col.code'), minWidth: 140, flex: 0.7, cellRenderer: CodeCell },
      { colId: 'style', headerName: t('col.style'), minWidth: 150, flex: 0.9, cellRenderer: StyleCell },
      { colId: 'size', headerName: t('col.size'), minWidth: 96, flex: 0.4, cellRenderer: SizeCell },
      { colId: 'piece', headerName: t('col.piece'), minWidth: 170, flex: 1, cellRenderer: PieceCell },
      { colId: 'rack', headerName: t('col.rack'), minWidth: canEdit ? 200 : 140, flex: 1, cellRenderer: RackCell },
      { colId: 'material', headerName: t('col.material'), minWidth: 120, flex: 0.6, valueGetter: (params) => params.data?.material ?? '—' },
      ...(model.can.parties ? [{ colId: 'supplier', headerName: t('col.supplier'), minWidth: 110, flex: 0.5, cellRenderer: SupplierCell } satisfies ColDef<Die>] : []),
      ...(model.can.cost ? [{ colId: 'cost', headerName: t('col.cost'), minWidth: 110, flex: 0.5, type: 'rightAligned', cellRenderer: CostCell } satisfies ColDef<Die>] : []),
      { colId: 'condition', headerName: t('col.condition'), minWidth: canEdit ? 170 : 130, flex: 0.7, cellRenderer: ConditionCell },
      { colId: 'more', headerName: t('col.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    if (allSites) list.splice(1, 0, { colId: 'site', headerName: t('col.site'), minWidth: 84, flex: 0.3, cellRenderer: SiteCell })
    return list
  }, [t, model.cells, model.can.cost, model.can.parties, allSites, canEdit])

  if (!model.can.view) return <NoPlantAccess />

  const items = model.rows.items ?? []
  const picked = items.filter((row) => selected.includes(row.id))
  // Retired dies stay selectable for Export; Retire N counts the others and says why it waits when none is left.
  const retirable = picked.filter((row) => retireHeldOf(row) === null)
  const filtered = diesFiltered(model.address)
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.newDie') }]
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('dies.new')}
    </Button>
  )

  let state: ReactNode = undefined
  if (model.rows.problem) {
    state = <EmptyState title={t('dies.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  } else if (model.rows.items && model.rows.items.length === 0) {
    state = filtered ? (
      <EmptyState
        title={t('dies.noMatch')}
        description={t('dies.noMatchBody')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onClearFilters?.()
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('dies.empty')} description={t('dies.emptyBody')} action={model.can.manage ? newButton : undefined} />
    )
  }

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('dies.search')}
      placeholder={t('dies.search')}
      value={query}
      onChange={(event) => {
        typed.current = true
        setQuery(event.target.value)
      }}
    />
  )
  const tools = (
    <Select size="sm" aria-label={t('dies.rowsLabel')} value={model.address.rows} onChange={(event) => actions?.onRows?.(event.target.value as DiesModel['address']['rows'])}>
      {DIE_ROWS.map((rows) => (
        <option key={rows} value={rows}>
          {t(`rows.${rows}`)}
        </option>
      ))}
    </Select>
  )

  return (
    <div className="fw-pl">
      <div className="fw-pl-head">
        <LiveLine asOf={model.asOf} live={model.live} />
        <span className="fw-pl-actions">
          {newButton}
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('dies.more') }} items={[{ id: 'keys', label: t('keys.title'), onSelect: () => setHelp(true) }]} />
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={sayDie(t, model.notice.words) ?? ''}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={() => actions.onDismissNotice?.()}>
                {t('common.close')}
              </Button>
            ) : undefined
          }
        >
          {model.notice.detail ? sayDie(t, model.notice.detail) : null}
        </Banner>
      )}
      {model.slow && !model.rows.items && !model.rows.problem && (
        <p className="fw-pl-hint" role="status">
          <Spinner size={12} /> {t('dies.stillLoading')}
        </p>
      )}

      <ListFrame<Die>
        label={t('dies.tableLabel')}
        listKey="plant.machines.dies"
        rows={state ? [] : model.rows.items}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.items ? t(model.rows.more ? 'dies.countMore' : 'dies.count', { count: model.rows.items.length }) : '—'}
        search={search}
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button
                size="sm"
                variant="danger-outline"
                aria-label={t('dies.retireMany', { count: retirable.length })}
                heldReason={!model.can.manage ? t('held.noManage') : retirable.length === 0 ? t(picked.length > 0 ? 'held.alreadyRetired' : 'held.noneToRetire') : null}
                onClick={() => actions?.onRetire?.(retirable)}
              >
                <Archive size={13} aria-hidden /> <SelectionLabel>{t('dies.retireMany', { count: retirable.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('dies.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('dies.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items.length > 0 ? { label: t('dies.showMore'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        state={state}
      />
      <p className="fw-pl-hint">{t(model.can.cost ? 'dies.footCost' : 'dies.foot')}</p>

      <DieDialogs model={model} actions={actions} />
      {help && <KeysModal own={ownKeys} onClose={() => setHelp(false)} />}
    </div>
  )
}
