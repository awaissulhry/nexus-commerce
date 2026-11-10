'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Copy, Gavel, MoreHorizontal, Plus, X } from 'lucide-react'
import { EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { ListMode } from '../../../../list-frame/w2b/model'
import type { LiveState } from '../../../../shell/live/use-live'
import type { PartyOption, RoundList, RoundRow } from '../api'
import {
  BOARD_LANES,
  boardMoveHeld,
  boardRowsOf,
  decideHeldOfRow,
  DESIGN_TILES,
  dueOf,
  dueShort,
  isFiltered,
  isOpen,
  MANUAL_STAGES,
  ownerPhrase,
  recordHref,
  roundPhrase,
  SAMPLE_KINDS,
  STAGE_TONE,
  type ListAddress,
  type ManualStage,
  type Notice,
  type RoundTile,
  type SampleKind,
  type SamplesCan,
  type SamplesMode,
} from '../model'
import { DecisionTag, Freshness, isPageKey, KindTag, NoAccess, NoticeLine, PageHead, SamplesMessages, StagePill, useWords } from '../parts'
import { DecideDialog, type DecideActions, type DecideModel } from './DecideDialog'
import { NewRoundDialog, type NewRoundActions, type NewRoundModel } from './NewRoundDialog'

/** SCR-110 — Products › Development › Samples & prototypes: tiles, Board · List · Calendar over the same rounds and filters. */
export interface SamplesListModel {
  prefix: string
  me: string
  today: string
  can: SamplesCan
  address: ListAddress
  /** The read: null while it is read; `problem` when it failed (never drawn as an empty list). */
  list: RoundList | null
  problem: string | null
  /** The customers of the filter (null without parties.view or not read). */
  customers: readonly PartyOption[] | null
  asOf: string | null
  live: LiveState
  /** Changes that arrived while the list was on screen (the board reads again by itself). */
  updates: number
  notice: Notice | null
  /** The round being moved (its card says so). */
  moving: string | null
  newRound: NewRoundModel | null
  decide: DecideModel | null
  /** Design cases: the rows selected, the calendar's day open, the keys panel open. */
  selected?: readonly string[]
  day?: string | null
  keysOpen?: boolean
}

export interface SamplesListActions {
  onAddress?: (patch: Partial<ListAddress>) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (roundId: string) => void
  onNew?: () => void
  newRound?: NewRoundActions
  onMove?: (row: RoundRow, to: ManualStage) => Promise<boolean>
  onDecide?: (row: RoundRow) => void
  decide?: DecideActions
  onCopy?: (numbers: readonly string[]) => void
  onDismissNotice?: () => void
}

export function SamplesListView({ model, actions }: { model: SamplesListModel; actions?: SamplesListActions }) {
  return (
    <SamplesMessages>
      <List model={model} actions={actions} />
    </SamplesMessages>
  )
}

const MODE_OF: Readonly<Record<SamplesMode, ListMode>> = { board: 'board', table: 'table', calendar: 'calendar' }

function List({ model, actions }: { model: SamplesListModel; actions?: SamplesListActions }) {
  const { t, say } = useWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [search, setSearch] = useState(model.address.q)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  const all = model.list?.rows ?? null
  const rowsKey = all?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const offline = model.live === 'offline'
  const act = useRef(actions)
  act.current = actions
  const href = (row: Pick<RoundRow, 'id'>) => recordHref(model.prefix, row.id)
  const byId = useMemo(() => new Map((all ?? []).map((row) => [row.id, row])), [all])

  // c: New sample request; d: decide the focused card (or the one selected row) — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newRound || model.decide) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        act.current?.onNew?.()
      } else if (event.key === 'd') {
        const focused = (document.activeElement as HTMLElement | null)?.closest('[data-bv-card]')?.getAttribute('data-bv-card') ?? (selected.length === 1 ? selected[0] : null)
        const row = focused ? byId.get(focused) : null
        if (row && !decideHeldOfRow(row, model.can, offline)) {
          event.preventDefault()
          act.current?.onDecide?.(row)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.newRound, model.decide, model.can, offline, selected, byId])

  const moveItems = (row: RoundRow): MenuItemDef[] =>
    MANUAL_STAGES.filter((stage) => stage !== row.stage).map((stage) => {
      const held = say(boardMoveHeld(row, stage, model.can, offline))
      return { id: `move-${stage}`, label: t('row.moveTo', { stage: t(`stage.${stage}`) }), disabled: !!held, description: held ?? undefined, onSelect: () => void act.current?.onMove?.(row, stage) }
    })

  const columns = useMemo<ColDef<RoundRow>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<RoundRow>) =>
      data ? (
        <span className="fw-smp-cell">
          <Link className="fw-smp-link fw-smp-code" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-smp-hint">{say(roundPhrase(data.kind, data.roundNo))}</span>
        </span>
      ) : null
    const StyleCell = ({ data }: ICellRendererParams<RoundRow>) =>
      data ? (
        <span className="fw-smp-cell">
          <span className="fw-smp-code">{data.style.code}</span>
          <span className="fw-smp-hint">{data.style.name}</span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<RoundRow>) => (data ? <KindTag kind={data.kind} /> : null)
    const StageCell = ({ data }: ICellRendererParams<RoundRow>) => (data ? <StagePill stage={data.stage} /> : null)
    const DueCell = ({ data }: ICellRendererParams<RoundRow>) => {
      if (!data) return null
      const due = dueOf(data, model.today)
      return due ? <Tag tone={due.tone}>{say(due)}</Tag> : <span className="fw-smp-hint">—</span>
    }
    const DecisionCell = ({ data }: ICellRendererParams<RoundRow>) => (data ? data.decision ? <DecisionTag decision={data.decision} /> : <span className="fw-smp-hint">—</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<RoundRow>) => {
      if (!data) return null
      const decideHeld = say(decideHeldOfRow(data, model.can, offline))
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('row.open'), href: href(data) },
            { id: 'tab', label: t('row.openNewTab'), href: href(data), target: '_blank' },
            ...(isOpen(data.stage) ? moveItems(data) : []),
            { id: 'decide', label: t('row.decide'), disabled: !!decideHeld, description: decideHeld ?? undefined, onSelect: () => act.current?.onDecide?.(data) },
            { id: 'copy', label: t('row.copy'), onSelect: () => act.current?.onCopy?.([data.number]) },
          ]}
        />
      )
    }
    return [
      { colId: 'number', headerName: t('col.number'), minWidth: 150, flex: 0.7, valueGetter: (params) => params.data?.number ?? '', cellRenderer: NumberCell },
      { colId: 'style', headerName: t('col.style'), minWidth: 170, flex: 1, valueGetter: (params) => (params.data ? `${params.data.style.code} · ${params.data.style.name}` : ''), cellRenderer: StyleCell },
      { colId: 'kind', headerName: t('col.kind'), minWidth: 130, flex: 0.6, valueGetter: (params) => (params.data ? t(`kind.${params.data.kind}`) : ''), cellRenderer: KindCell },
      { colId: 'round', headerName: t('col.round'), minWidth: 80, flex: 0.3, type: 'rightAligned', valueGetter: (params) => params.data?.roundNo ?? null },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 160, flex: 0.9, valueGetter: (params) => (params.data ? (params.data.party ? params.data.party.name : t('row.internal')) : '') },
      { colId: 'revision', headerName: t('col.revision'), minWidth: 96, flex: 0.35, valueGetter: (params) => (params.data ? t('row.revision', { revision: params.data.revision.revision }) : '') },
      { colId: 'stage', headerName: t('col.stage'), minWidth: 130, flex: 0.55, valueGetter: (params) => (params.data ? t(`stage.${params.data.stage}`) : ''), cellRenderer: StageCell },
      { colId: 'due', headerName: t('col.due'), minWidth: 130, flex: 0.55, valueGetter: (params) => params.data?.dueDate ?? '', cellRenderer: DueCell },
      { colId: 'decision', headerName: t('col.decision'), minWidth: 150, flex: 0.6, valueGetter: (params) => (params.data?.decision ? t(`decision.${params.data.decision}`) : ''), cellRenderer: DecisionCell },
      { colId: 'owner', headerName: t('col.owner'), minWidth: 110, flex: 0.45, valueGetter: (params) => (params.data ? (say(ownerPhrase(params.data.createdById, model.me)) ?? '') : '') },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the model through these values only.
  }, [t, say, model.prefix, model.today, model.me, model.can, offline])

  if (!model.can.view) return <NoAccess />

  const mode = model.address.mode
  const rows = all === null ? null : mode === 'board' ? boardRowsOf(all) : all
  const picked = (all ?? []).filter((row) => selected.includes(row.id))
  const filtered = isFiltered(model.address)
  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.new') },
    { keys: ['m'], does: t('keys.move') },
    { keys: ['d'], does: t('keys.decide') },
  ]
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.manage ? (offline ? t('held.offline') : null) : t('held.noManage')} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const state = model.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows !== null && rows.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        description={t('list.noMatchBody')}
        action={
          <Button size="sm" onClick={() => actions?.onClearFilters?.()}>
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('list.empty')} description={t('list.emptyBody')} action={model.can.manage ? newButton : undefined} />
    )
  ) : undefined

  const styleFilter = model.address.style ? (all?.find((row) => row.style.id === model.address.style)?.style.code ?? t('list.thisStyle')) : null
  const revisionFilter = model.address.revision ? all?.find((row) => row.revision.id === model.address.revision)?.revision.revision ?? null : null
  const customerValue = model.address.internal ? 'internal' : (model.address.party ?? '')
  const tools = (
    <>
      <Select size="sm" aria-label={t('list.kindLabel')} value={model.address.kind ?? ''} onChange={(event) => actions?.onAddress?.({ kind: (event.target.value || null) as SampleKind | null })}>
        <option value="">{t('list.allKinds')}</option>
        {SAMPLE_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`kind.${kind}`)}
          </option>
        ))}
      </Select>
      <Select
        size="sm"
        aria-label={t('list.customerLabel')}
        value={customerValue}
        onChange={(event) => {
          const value = event.target.value
          actions?.onAddress?.(value === 'internal' ? { internal: true, party: null } : { internal: false, party: value || null })
        }}
      >
        <option value="">{t('list.allCustomers')}</option>
        <option value="internal">{t('list.internalOnly')}</option>
        {(model.customers ?? []).map((party) => (
          <option key={party.id} value={party.id}>
            {party.code} · {party.tradeName ?? party.legalName}
          </option>
        ))}
      </Select>
      {styleFilter && (
        <Button size="sm" variant="tonal" onClick={() => actions?.onAddress?.({ style: null, revision: null })} aria-label={t('list.clearStyle', { style: styleFilter })}>
          {revisionFilter !== null ? t('list.styleRevisionChip', { style: styleFilter, revision: revisionFilter }) : t('list.styleChip', { style: styleFilter })} <X size={12} aria-hidden />
        </Button>
      )}
    </>
  )

  const lanes = BOARD_LANES.map((stage) => ({
    id: stage,
    label: t(`stage.${stage}`),
    tone: STAGE_TONE[stage],
    total: model.list?.lanes.find((lane) => lane.stage === stage)?.count ?? null,
    detail: null,
    held: stage === 'DECIDED' ? t('held.decideNotDrag') : null,
  }))
  const card = (row: RoundRow) => {
    return {
      label: row.style.code,
      title: say(roundPhrase(row.kind, row.roundNo)),
      fields: [
        { label: t('col.customer'), value: row.party ? row.party.name : t('row.internal') },
        { label: t('col.revision'), value: t('row.revision', { revision: row.revision.revision }) },
        { label: t('col.owner'), value: say(ownerPhrase(row.createdById, model.me)) ?? '' },
      ],
      marks: [
        ...(row.decision ? [{ label: t(`decision.${row.decision}`), tone: row.decision === 'REJECTED' ? ('danger' as const) : row.decision === 'APPROVED' ? ('success' as const) : ('warning' as const) }] : []),
        ...(row.openComments > 0 ? [{ label: t('row.openComments', { count: row.openComments }), tone: 'warning' as const }] : []),
      ],
      held: model.moving === row.id ? t('common.working') : null,
    }
  }
  const board = {
    lanes,
    laneOf: (row: RoundRow) => row.stage,
    heldReason: offline ? t('held.offline') : model.can.manage ? null : t('board.readOnly'),
    card,
    onMove: async (row: RoundRow, lane: string) => ((MANUAL_STAGES as readonly string[]).includes(lane) ? ((await actions?.onMove?.(row, lane as ManualStage)) ?? false) : false),
    moveHeld: (row: RoundRow, lane: string) => say(boardMoveHeld(row, lane, model.can, offline)),
    aside: (row: RoundRow) => {
      const due = dueShort(row, model.today)
      return due ? <Tag tone={due.tone}>{say(due)}</Tag> : null
    },
    footer: (row: RoundRow) => {
      if (!isOpen(row.stage) || row.stage === 'REQUESTED') return null
      const held = say(decideHeldOfRow(row, model.can, offline))
      return (
        <Button size="sm" variant="quiet" heldReason={held} onClick={() => actions?.onDecide?.(row)} aria-keyshortcuts="d">
          <Gavel size={13} aria-hidden /> {t('row.decide')}
        </Button>
      )
    },
  }

  const tile = (id: RoundTile) => ({
    label: t(`tile.${id}`),
    value: model.list ? String(model.list.counts[id] ?? 0) : '—',
    hint: t(`tile.hint.${id}`),
    onClick: () => actions?.onAddress?.({ tile: model.address.tile === id ? null : id }),
    active: model.address.tile === id,
  })

  return (
    <div className="fw-smp">
      <PageHead intro={t('list.intro')} status={<Freshness asOf={model.asOf} live={model.live} />} actions={newButton} />
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <MetricStrip metrics={DESIGN_TILES.map(tile)} />
      <ListFrame<RoundRow>
        label={t('list.tableLabel')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={model.list ? (model.list.complete ? t('list.count', { count: rows?.length ?? 0 }) : t('list.countMore', { count: rows?.length ?? 0 })) : t('list.countReading')}
        search={
          <Input
            size="sm"
            type="search"
            className="fw-smp-search"
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onAddress?.({ q: search })
            }}
            onBlur={() => search !== model.address.q && actions?.onAddress?.({ q: search })}
          />
        }
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          exportSelected: true,
          actions: (
            <Button size="sm" aria-label={t('list.copyMany', { count: picked.length })} onClick={() => actions?.onCopy?.(picked.map((row) => row.number))}>
              <Copy size={13} aria-hidden /> <SelectionLabel>{t('list.copyMany', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        keysOpen={model.keysOpen}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        title={t('list.tableLabel')}
        modes={{
          mode: MODE_OF[mode],
          onMode: (next) => actions?.onAddress?.({ mode: next === 'table' ? 'table' : next === 'calendar' ? 'calendar' : 'board' }),
          board,
          calendar: { dateOf: (row) => row.dueDate, label: t('col.due') },
        }}
        cards={{ hrefOf: (row) => href(row) }}
        today={model.today}
        design={model.day !== undefined ? { day: model.day } : undefined}
      />
      <p className="fw-smp-hint">{model.list && !model.list.complete ? t('list.footMore') : t('list.foot')}</p>
      {model.newRound && <NewRoundDialog model={model.newRound} can={model.can} actions={actions?.newRound} />}
      {model.decide && <DecideDialog model={model.decide} actions={actions?.decide} />}
    </div>
  )
}

