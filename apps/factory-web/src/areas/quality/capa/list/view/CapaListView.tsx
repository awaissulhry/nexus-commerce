'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Copy, MoreHorizontal, Plus } from 'lucide-react'
import { EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import { CAPA_PRIORITIES, CAPA_TYPES, CAPA_VIEWS } from '@nexus/factory-domain/quality/capa/rules'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { isPageKey } from '../../../_shared/hooks'
import { Freshness, NoAccess, PageHead } from '../../../_shared/parts'
import type { CapaPriority, CapaRow, CapaType, CapaView } from '../../api'
import { boardLanesOf, boardMoveHeld, boardRowsOf, boardTypeOf, CAPA_TILES, dueSay, editHeld, isFiltered, recordHref, reportHref, stageTone } from '../../model'
import { CapaMessages, KeysDialog, NoticeLine, personWords, PriorityTag, StagePill, TypeTag, useCapaWords } from '../../parts'
import { CloseCapaDialog } from '../../view/CloseCapaDialog'
import type { CapaListActions, CapaListModel } from '../view-model'
import { NewCapaDialog } from './NewCapaDialog'

export type { CapaListActions, CapaListModel } from '../view-model'

/**
 * SCR-146 — Quality › Problems › Corrective actions (design quality.capa, a workspace list): every CAPA and 8D the person
 * may see. The tiles are saved rows (Open, Actions overdue, Mine; the W3 tiles stay out); the rows (Open, Mine, Actions
 * overdue, Closed, Cancelled, All), the type and the priority are the API's own filters. The shared list frame — CAPA, title,
 * type, sources (links to the NCRs and complaints), customer, owner, team, stage, next due, actions open / overdue,
 * priority, age — or the same rows as a board by stage (one type at a time: their stages differ; a drop is the CAPA's own
 * stage step, a drop on Closed opens the close). New CAPA (`c`), the row verbs Open · Add action · Print 8D · Copy number,
 * the selection's Copy N numbers and the frame's Export N.
 */
export function CapaListView({ model, actions }: { model: CapaListModel; actions?: CapaListActions }) {
  return (
    <CapaMessages>
      <CapaList model={model} actions={actions} />
    </CapaMessages>
  )
}

function CapaList({ model, actions }: { model: CapaListModel; actions?: CapaListActions }) {
  const { t, say } = useCapaWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [keysOpen, setKeysOpen] = useState(!!model.keysOpen)
  const [search, setSearch] = useState(model.address.q)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  const rowsKey = model.rows.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const offline = model.live === 'offline'

  // c: New CAPA (design kb) — never while typing, in a dialog or a menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.dialog || model.close || keysOpen) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNew?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.close, model.can.manage, keysOpen, actions])

  const act = useRef(actions)
  act.current = actions
  const href = (row: Pick<CapaRow, 'id'>) => recordHref(model.prefix, row.id)
  const columns = useMemo<ColDef<CapaRow>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<CapaRow>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name fw-q-code" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-q-hint">{data.customer ? data.customer.code : t('row.internal')}</span>
        </span>
      ) : null
    const TitleCell = ({ data }: ICellRendererParams<CapaRow>) => (data ? <span title={data.title}>{data.title}</span> : null)
    const TypeCell = ({ data }: ICellRendererParams<CapaRow>) => (data ? <TypeTag type={data.type} /> : null)
    const SourcesCell = ({ data }: ICellRendererParams<CapaRow>) => {
      if (!data) return null
      if (data.sources.count === 0) return <span className="fw-q-hint">{t('row.noSources')}</span>
      const shown = data.sources.items.slice(0, 2)
      return (
        <span className="fw-capa-links" title={t('row.sources', { count: data.sources.count })}>
          {shown.map((item, index) => (
            <span key={item.id}>
              {item.label ? (
                <Link className="fw-q-link fw-q-code" href={`${model.prefix}${recordAddress({ type: item.recordType, id: item.recordId, label: item.label, companyId: data.companyId }, OFFICE_PAGES)}`}>
                  {item.label}
                </Link>
              ) : (
                <span className="fw-q-hint">{t('row.hiddenSource')}</span>
              )}
              {index < shown.length - 1 ? ', ' : ''}
            </span>
          ))}
          {data.sources.count > shown.length && <span className="fw-q-hint">{` ${t('row.moreSources', { count: data.sources.count - shown.length })}`}</span>}
        </span>
      )
    }
    const CustomerCell = ({ data }: ICellRendererParams<CapaRow>) => (data ? <span>{data.customer ? data.customer.name : '—'}</span> : null)
    const OwnerCell = ({ data }: ICellRendererParams<CapaRow>) => (data ? <span>{personWords(model.people, data.ownerId, model.me, t)}</span> : null)
    const TeamCell = ({ data }: ICellRendererParams<CapaRow>) => (data ? <span className="fw-q-num">{data.team.length === 0 ? '—' : t('row.team', { count: data.team.length })}</span> : null)
    const StageCell = ({ data }: ICellRendererParams<CapaRow>) => (data ? <StagePill stage={data.status} /> : null)
    const NextDueCell = ({ data }: ICellRendererParams<CapaRow>) => {
      if (!data) return null
      const words = dueSay(data.nextDue, model.today)
      if (!words) return <span className="fw-q-hint">—</span>
      return words.key === 'due.late' ? <Tag tone="danger">{say(words)}</Tag> : <span className="fw-q-num">{say(words)}</span>
    }
    const ActionsCell = ({ data }: ICellRendererParams<CapaRow>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-num">{t('row.actions', { open: data.actions.open, count: data.actions.count })}</span>
          {data.actions.overdue > 0 && <span className="fw-capa-bad fw-q-hint">{t('row.overdue', { count: data.actions.overdue })}</span>}
        </span>
      ) : null
    const PriorityCell = ({ data }: ICellRendererParams<CapaRow>) => (data ? <PriorityTag priority={data.priority} /> : null)
    const AgeCell = ({ data }: ICellRendererParams<CapaRow>) => (data ? <span className="fw-q-num">{data.ageDays === 0 ? t('age.today') : t('age.days', { count: data.ageDays })}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<CapaRow>) => {
      if (!data) return null
      const addHeld = say(editHeld(data, model.can))
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('row.open'), href: href(data) },
            { id: 'tab', label: t('row.openNewTab'), href: href(data), target: '_blank' },
            { id: 'add', label: t('row.addAction'), disabled: !!addHeld, description: addHeld ?? undefined, href: recordHref(model.prefix, data.id, 'actions', 'add=1') },
            { id: 'print', label: t('row.print8D'), href: reportHref(model.prefix, data.id), target: '_blank' },
            { id: 'copy', label: t('row.copy'), onSelect: () => act.current?.onCopy?.([data.number]) },
          ]}
        />
      )
    }
    return [
      // The value of the number and the title: the phone card's title and the sort read them (the cell draws the link).
      { colId: 'number', headerName: t('col.number'), minWidth: 150, flex: 0.6, valueGetter: (params) => params.data?.number ?? '', cellRenderer: NumberCell },
      { colId: 'title', headerName: t('col.title'), minWidth: 220, flex: 1.5, valueGetter: (params) => params.data?.title ?? '', cellRenderer: TitleCell },
      { colId: 'stage', headerName: t('col.stage'), minWidth: 150, flex: 0.6, cellRenderer: StageCell },
      { colId: 'type', headerName: t('col.type'), minWidth: 84, flex: 0.3, cellRenderer: TypeCell },
      { colId: 'sources', headerName: t('col.sources'), minWidth: 190, flex: 0.9, cellRenderer: SourcesCell },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 150, flex: 0.7, cellRenderer: CustomerCell },
      { colId: 'owner', headerName: t('col.owner'), minWidth: 150, flex: 0.7, cellRenderer: OwnerCell },
      { colId: 'team', headerName: t('col.team'), minWidth: 96, flex: 0.35, cellRenderer: TeamCell },
      { colId: 'nextDue', headerName: t('col.nextDue'), minWidth: 130, flex: 0.5, cellRenderer: NextDueCell },
      { colId: 'actions', headerName: t('col.actions'), minWidth: 130, flex: 0.5, cellRenderer: ActionsCell },
      { colId: 'priority', headerName: t('col.priority'), minWidth: 100, flex: 0.35, cellRenderer: PriorityCell },
      { colId: 'age', headerName: t('col.age'), minWidth: 84, flex: 0.3, cellRenderer: AgeCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, say, model.prefix, model.people, model.me, model.today, model.can])

  if (!model.can.view) return <NoAccess title={t('list.noAccessTitle')} body={t('list.noAccessBody')} />

  const board = model.address.mode === 'board'
  const boardType = boardTypeOf(model.address)
  const all = model.rows.items ?? []
  const rows = board ? boardRowsOf(all, boardType) : all
  const picked = all.filter((row) => selected.includes(row.id))
  const filtered = isFiltered(model.address)
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.manage ? (offline ? t('held.offline') : null) : t('held.noManage')} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const state = model.rows.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : model.rows.items !== null && rows.length === 0 ? (
    filtered || (board && all.length > 0) ? (
      <EmptyState
        title={t('list.noMatch')}
        description={board && all.length > 0 && !filtered ? t('list.noMatchBoard', { type: t(`type.${boardType}`) }) : t('list.noMatchBody')}
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

  const tools = (
    <>
      <Select size="sm" aria-label={t('list.rowsLabel')} value={model.address.view} onChange={(event) => actions?.onView?.(event.target.value as CapaView)}>
        {CAPA_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`view.${view}`)}
          </option>
        ))}
      </Select>
      {board ? (
        <SegmentedControl size="sm" ariaLabel={t('list.boardType')} value={boardType} onChange={(value) => actions?.onType?.(value as CapaType)} options={CAPA_TYPES.map((type) => ({ value: type, label: t(`type.${type}`) }))} />
      ) : (
        <Select size="sm" aria-label={t('list.typeLabel')} value={model.address.type ?? ''} onChange={(event) => actions?.onType?.((event.target.value || null) as CapaType | null)}>
          <option value="">{t('list.allTypes')}</option>
          {CAPA_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`type.${type}`)}
            </option>
          ))}
        </Select>
      )}
      <Select size="sm" aria-label={t('list.priorityLabel')} value={model.address.priority ?? ''} onChange={(event) => actions?.onPriority?.((event.target.value || null) as CapaPriority | null)}>
        <option value="">{t('list.allPriorities')}</option>
        {CAPA_PRIORITIES.map((priority) => (
          <option key={priority} value={priority}>
            {t(`priority.${priority}`)}
          </option>
        ))}
      </Select>
    </>
  )

  const lanes = boardLanesOf(boardType).map((stage) => ({
    id: stage,
    label: t(`stage.${stage}`),
    tone: stageTone(stage),
    total: rows.filter((row) => row.status === stage).length,
    detail: stage === 'CLOSED' ? t('board.closedLane') : null,
    held: model.can.manage ? null : t('held.noManage'),
  }))
  const boardMode = {
    lanes,
    laneOf: (row: CapaRow) => row.status,
    heldReason: offline ? t('held.offline') : model.can.manage ? null : t('board.readOnly'),
    card: (row: CapaRow) => {
      const due = dueSay(row.nextDue, model.today)
      return {
        label: row.number,
        title: row.title,
        fields: [
          { label: t('col.owner'), value: personWords(model.people, row.ownerId, model.me, t) },
          { label: t('col.actions'), value: t('row.actions', { open: row.actions.open, count: row.actions.count }) },
          ...(row.customer ? [{ label: t('col.customer'), value: row.customer.name }] : []),
        ],
        marks: [
          ...(row.priority === 'HIGH' ? [{ label: t('priority.HIGH'), tone: 'danger' as const }] : []),
          ...(row.actions.overdue > 0 ? [{ label: t('row.overdue', { count: row.actions.overdue }), tone: 'danger' as const }] : due ? [{ label: say(due) ?? '', tone: 'neutral' as const }] : []),
        ],
        held: model.moving === row.id ? t('common.working') : null,
      }
    },
    onMove: async (row: CapaRow, lane: string) => (await actions?.onBoardMove?.(row, lane)) ?? false,
    moveHeld: (row: CapaRow, lane: string) => say(boardMoveHeld(row, lane, model.can, offline)),
  }

  const menu = (
    <Menu
      label={<MoreHorizontal size={16} aria-hidden />}
      align="right"
      triggerProps={{ 'aria-label': t('list.more') }}
      items={[
        { id: 'print', label: t('list.print'), onSelect: () => actions?.onPrint?.() },
        { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
      ]}
    />
  )

  return (
    <div className="fw-q fw-capa">
      <PageHead
        intro={t('list.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            {menu}
            {newButton}
          </>
        }
      />
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <MetricStrip
        metrics={CAPA_TILES.map((tile) => ({
          label: t(`tile.${tile.id}`),
          value: model.counts ? String(model.counts[tile.id]) : '—',
          hint: t(`tile.hint.${tile.id}`),
          onClick: () => actions?.onView?.(model.address.view === tile.view && tile.view !== 'open' ? 'open' : tile.view),
          active: model.address.view === tile.view,
        }))}
      />
      {board && <p className="fw-q-hint">{t('board.oneType')}</p>}
      <ListFrame<CapaRow>
        label={t('list.tableLabel')}
        rows={state ? [] : model.rows.items === null ? null : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.items ? (model.rows.more ? t('list.countMore', { count: rows.length }) : t('list.count', { count: rows.length })) : t('list.countReading')}
        search={
          <Input
            size="sm"
            type="search"
            className="fw-capa-search"
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onSearch?.(search)
            }}
            onBlur={() => search !== model.address.q && actions?.onSearch?.(search)}
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
        more={model.rows.more ? { label: t('list.showMore'), onMore: () => actions?.onMore?.(), held: offline ? t('held.offline') : null } : null}
        keys={ownKeys}
        onHelp={() => setKeysOpen(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
        title={t('list.tableLabel')}
        modes={{ mode: model.address.mode, onMode: (mode) => actions?.onMode?.(mode), board: boardMode }}
        cards={{ hrefOf: (row) => href(row) }}
      />
      <p className="fw-q-hint">{t('list.foot')}</p>

      {model.dialog?.kind === 'new' && <NewCapaDialog dialog={model.dialog} can={model.can} today={model.today} me={model.me} offline={offline} actions={actions} />}
      {model.close && <CloseCapaDialog model={model.close} actions={actions?.close} />}
      {keysOpen && <KeysDialog own={ownKeys} onClose={() => setKeysOpen(false)} />}
    </div>
  )
}
