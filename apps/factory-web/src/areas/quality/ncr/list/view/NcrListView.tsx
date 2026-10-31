'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, Kanban, List, MoreHorizontal, Plus, UserPlus } from 'lucide-react'
import { EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { BoardView, type BoardCard, type BoardLane } from '@nexus/ui/grid/views/board/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, SegmentedControl, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { ListKeysInfo } from '../../../../../list-frame/ListKeysInfo'
import type { ListKey } from '../../../../../list-frame/model'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useBoardViewWords } from '../../../../_shared/board-view/words'
import { isPageKey } from '../../../_shared/hooks'
import { Freshness, NoAccess } from '../../../_shared/parts'
import { BOARD_LANES, type NcrCard, type NcrSummary } from '../../api'
import { cardHeld, laneHeld, NCR_TILES, NCR_VIEWS, nameOf, STAGE_TONE, type NcrView } from '../../model'
import { zoneWords, ContainmentDue, DecidedBar, KeysDialog, NcrMessages, NcrStepUp, NoticeLine, QuantityText, SeverityTag, StagePill, useNcrWords } from '../../parts'
import { CloseNcrDialog } from '../../view/CloseNcrDialog'
import type { NcrListActions, NcrListModel } from '../view-model'
import { AssignDialog } from './AssignDialog'
import { NewNcrDialog } from './NewNcrDialog'

export type { NcrListActions, NcrListModel } from '../view-model'

/**
 * SCR-144 — Quality › Problems › Nonconformances (design quality.ncr, a workspace list): every NCR of the person's sites,
 * raised from anywhere. The tiles are saved rows (Open, Containment overdue, Waiting disposition, Critical open, Closed
 * this month); the rows (Open, Mine, Critical, Supplier NCRs, Waiting disposition, Containment overdue, Closed, All) are
 * the API's own filters. A list on the shared list frame — NCR, title, source, stage, severity, defect, style and size,
 * lot or serial, supplier, quantity with its "decided" bar, owner, containment due, age — or the same rows as a board by
 * stage (D19: drag or keys; a move whose rule is not met is refused with the reason; a drop on Closed opens the closing
 * signature). New NCR (`c`, also raised from a record by address), Assign owner N, Export N (CSV).
 */
export function NcrListView({ model, actions }: { model: NcrListModel; actions?: NcrListActions }) {
  return (
    <NcrMessages>
      <NcrList model={model} actions={actions} />
    </NcrMessages>
  )
}

const MODES = [
  { value: 'list', icon: List },
  { value: 'board', icon: Kanban },
] as const

function NcrList({ model, actions }: { model: NcrListModel; actions?: NcrListActions }) {
  const { t, say, locale } = useNcrWords()
  const lang = useLocale()
  const boardWords = useBoardViewWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [keysOpen, setKeysOpen] = useState(!!model.keysOpen)
  const [search, setSearch] = useState(model.address.q)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  const rowsKey = model.rows.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const sites = model.sites ?? []
  const allSites = sites.length > 1 && model.address.siteId === null

  // c: New NCR; b: list ⇄ board (design kb); ? on the board: its keys — never while typing, in a dialog or a menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.dialog || model.close || keysOpen) return
      if (event.key === 'c' && model.can.raise) {
        event.preventDefault()
        actions?.onNew?.()
      } else if (event.key === 'b') {
        event.preventDefault()
        actions?.onMode?.(model.address.mode === 'board' ? 'list' : 'board')
      } else if (event.key === '?' && model.address.mode === 'board') {
        // The list frame answers ? itself; the board has no frame.
        event.preventDefault()
        setKeysOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.close, model.can.raise, model.address.mode, keysOpen, actions])

  const act = useRef(actions)
  act.current = actions
  const href = (row: Pick<NcrSummary, 'id'>) => `${model.prefix}/quality/ncr/${encodeURIComponent(row.id)}`
  const columns = useMemo<ColDef<NcrSummary>[]>(() => {
    const sourceHref = (row: NcrSummary) => (row.sourceType && row.sourceId ? `${model.prefix}${recordAddress({ type: row.sourceType, id: row.sourceId, companyId: row.companyId, siteId: row.siteId }, OFFICE_PAGES)}` : null)
    const NumberCell = ({ data }: ICellRendererParams<NcrSummary>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name fw-q-code" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-q-hint">{t(`foundAt.${data.foundAt}`)}</span>
        </span>
      ) : null
    const TitleCell = ({ data }: ICellRendererParams<NcrSummary>) => (data ? <span title={data.title}>{data.title}</span> : null)
    const SourceCell = ({ data }: ICellRendererParams<NcrSummary>) => {
      if (!data) return null
      const link = sourceHref(data)
      return (
        <span className="fw-q-cell">
          <span>{t(`source.${data.source}`)}</span>
          {data.sourceType && (link ? <a className="fw-q-link fw-q-hint" href={link}>{t(`recordType.${data.sourceType}`)}</a> : <span className="fw-q-hint">{t(`recordType.${data.sourceType}`)}</span>)}
        </span>
      )
    }
    const StageCell = ({ data }: ICellRendererParams<NcrSummary>) => (data ? <StagePill stage={data.stage} /> : null)
    const SeverityCell = ({ data }: ICellRendererParams<NcrSummary>) => (data ? <SeverityTag severity={data.severity} /> : null)
    const DefectCell = ({ data }: ICellRendererParams<NcrSummary>) =>
      data ? (
        data.defect ? (
          <span className="fw-q-cell">
            <span className="fw-q-code">{data.defect.code}</span>
            <span className="fw-q-hint">{[lang === 'it' ? data.defect.labelIt : data.defect.labelEn, zoneWords(t, data.zone)].filter(Boolean).join(' · ')}</span>
          </span>
        ) : (
          <span className="fw-q-hint">{zoneWords(t, data.zone) ?? '—'}</span>
        )
      ) : null
    const StyleCell = ({ data }: ICellRendererParams<NcrSummary>) =>
      data ? (
        data.style ? (
          <span className="fw-q-cell">
            <span className="fw-q-code">{data.style.code}</span>
            <span className="fw-q-hint">{[data.colourway?.code, data.size].filter(Boolean).join(' · ') || '—'}</span>
          </span>
        ) : (
          <span className="fw-q-hint">—</span>
        )
      ) : null
    const LotCell = ({ data }: ICellRendererParams<NcrSummary>) =>
      data ? <span className="fw-q-code">{data.lot ? data.lot.code : data.serial ? data.serial : '—'}</span> : null
    const SupplierCell = ({ data }: ICellRendererParams<NcrSummary>) => (data ? <span>{data.supplier ? data.supplier.name : '—'}</span> : null)
    const QuantityCell = ({ data }: ICellRendererParams<NcrSummary>) =>
      data ? (
        <span className="fw-q-cell">
          <QuantityText ncr={data} />
          <DecidedBar ncr={data} compact />
        </span>
      ) : null
    const OwnerCell = ({ data }: ICellRendererParams<NcrSummary>) => {
      if (!data) return null
      if (!data.ownerId) return <span className="fw-q-hint">{t('common.nobody')}</span>
      const name = nameOf(model.people, data.ownerId)
      return <span>{name ?? (model.people ? t('common.unknownPerson') : '—')}</span>
    }
    const DueCell = ({ data }: ICellRendererParams<NcrSummary>) => (data ? <ContainmentDue ncr={data} now={model.now} /> : null)
    const AgeCell = ({ data }: ICellRendererParams<NcrSummary>) => (data ? <span className="fw-q-num">{data.ageDays === 0 ? t('age.today') : t('age.days', { count: data.ageDays })}</span> : null)
    const SiteCell = ({ data }: ICellRendererParams<NcrSummary>) => <span className="fw-q-code">{data ? (sites.find((site) => site.id === data.siteId)?.code ?? '—') : ''}</span>
    const MoreCell = ({ data }: ICellRendererParams<NcrSummary>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('list.open'), href: href(data) },
            { id: 'tab', label: t('common.openNewTab'), href: href(data), target: '_blank' },
            { id: 'copy', label: t('common.copyNumber'), onSelect: () => act.current?.onCopy?.(data.number) },
          ]}
        />
      ) : null
    const list: ColDef<NcrSummary>[] = [
      { colId: 'number', headerName: t('col.number'), minWidth: 140, flex: 0.6, cellRenderer: NumberCell },
      { colId: 'title', headerName: t('col.title'), minWidth: 200, flex: 1.4, cellRenderer: TitleCell },
      { colId: 'stage', headerName: t('col.stage'), minWidth: 112, flex: 0.45, cellRenderer: StageCell },
      { colId: 'severity', headerName: t('col.severity'), minWidth: 100, flex: 0.4, cellRenderer: SeverityCell },
      { colId: 'quantity', headerName: t('col.quantity'), minWidth: 190, flex: 0.9, cellRenderer: QuantityCell },
      { colId: 'due', headerName: t('col.due'), minWidth: 160, flex: 0.6, cellRenderer: DueCell },
      { colId: 'owner', headerName: t('col.owner'), minWidth: 130, flex: 0.6, cellRenderer: OwnerCell },
      { colId: 'source', headerName: t('col.source'), minWidth: 124, flex: 0.55, cellRenderer: SourceCell },
      { colId: 'defect', headerName: t('col.defect'), minWidth: 150, flex: 0.7, cellRenderer: DefectCell },
      { colId: 'style', headerName: t('col.style'), minWidth: 124, flex: 0.6, cellRenderer: StyleCell },
      { colId: 'lot', headerName: t('col.lot'), minWidth: 124, flex: 0.55, cellRenderer: LotCell },
      { colId: 'supplier', headerName: t('col.supplier'), minWidth: 124, flex: 0.55, cellRenderer: SupplierCell },
      { colId: 'age', headerName: t('col.age'), minWidth: 84, flex: 0.3, cellRenderer: AgeCell },
      { colId: 'more', headerName: t('col.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    if (allSites) list.splice(1, 0, { colId: 'site', headerName: t('col.site'), minWidth: 90, flex: 0.3, cellRenderer: SiteCell })
    return list
  }, [t, lang, model.prefix, model.people, model.now, sites, allSites])

  if (!model.can.view) return <NoAccess title={t('list.noAccessTitle')} body={t('list.noAccessBody')} />

  const items = model.rows.items ?? []
  const picked = items.filter((row) => selected.includes(row.id))
  const pickedOpen = picked.filter((row) => row.stage !== 'CLOSED' && row.stage !== 'CANCELLED')
  const pickedSites = new Set(pickedOpen.map((row) => row.siteId))
  const filtered = model.address.view !== 'open' || model.address.siteId !== null || model.address.q.trim() !== ''
  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.new') },
    { keys: ['b'], does: t('keys.board') },
  ]
  // The board's own keys (the DS board view's), in ONE information icon under it, never as a line of text (Owner rule
  // 2026-10-29).
  const boardKeys: ListKey[] = [
    { keys: ['click'], does: t('board.keyDrag') },
    { keys: ['Space', 'M'], does: t('board.keyLift') },
    { keys: ['←', '→'], does: t('board.keyLane') },
    { keys: ['Enter'], does: t('board.keyDrop') },
    { keys: ['Esc'], does: t('board.keyCancel') },
  ]
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.raise ? null : t('held.noRaise')} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const clearButton = (
    <Button size="sm" onClick={() => actions?.onClearFilters?.()}>
      {t('common.clearFilters')}
    </Button>
  )
  const retryButton = (
    <Button size="sm" onClick={() => actions?.onRetry?.()}>
      {t('common.retry')}
    </Button>
  )

  const board = model.address.mode === 'board'
  const readProblem = board ? model.lanes.problem : model.rows.problem
  const boardEmpty = board && model.lanes.items !== null && model.lanes.items.every((lane) => lane.count === 0)
  const listEmpty = !board && model.rows.items !== null && model.rows.items.length === 0
  const state = readProblem ? (
    <EmptyState title={t('list.failed')} description={t(readProblem)} action={retryButton} />
  ) : listEmpty || boardEmpty ? (
    filtered ? (
      <EmptyState title={t('list.noMatch')} description={t('list.noMatchBody')} action={clearButton} />
    ) : (
      <EmptyState title={board ? t('list.emptyBoard') : t('list.empty')} description={t('list.emptyBody')} action={model.can.raise ? newButton : undefined} />
    )
  ) : undefined

  const searchField = (
    <Input
      size="sm"
      className="fw-ncr-search"
      type="search"
      aria-label={t('list.search')}
      placeholder={t('list.search')}
      value={search}
      onChange={(event) => setSearch(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') actions?.onSearch?.(search)
      }}
      onBlur={() => search !== model.address.q && actions?.onSearch?.(search)}
    />
  )
  const tools = (
    <>
      <Select size="sm" aria-label={t('list.rowsLabel')} value={model.address.view} onChange={(event) => actions?.onView?.(event.target.value as NcrView)}>
        {NCR_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`view.${view}`)}
          </option>
        ))}
      </Select>
      {sites.length > 1 && (
        <Select size="sm" aria-label={t('common.site')} value={model.address.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value || null)}>
          <option value="">{t('common.allSites')}</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {`${site.code} · ${site.name}`}
            </option>
          ))}
        </Select>
      )}
    </>
  )

  const lanes: BoardLane[] = BOARD_LANES.map((stage) => {
    const lane = model.lanes.items?.find((entry) => entry.stage === stage)
    const oldest = lane && lane.cards.length > 0 && stage !== 'CLOSED' ? Math.max(...lane.cards.map((card) => card.ageDays)) : null
    return {
      id: stage,
      label: t(`stage.${stage}`),
      tone: STAGE_TONE[stage],
      total: lane?.count ?? null,
      detail: stage === 'CLOSED' ? t('board.closedLane') : oldest !== null && oldest > 0 ? t('board.oldest', { count: oldest }) : null,
      held: stage === 'CLOSED' ? (model.can.close ? null : t('board.held.noClose')) : stage === 'OPEN' ? null : model.can.manage ? null : t('board.held.noManage'),
    }
  })
  const allCards: NcrCard[] = (model.lanes.items ?? []).flatMap((lane) => lane.cards)
  const byId = new Map(allCards.map((card) => [card.id, card]))
  const cards: BoardCard[] = allCards.map((card) => ({
    id: card.id,
    laneId: card.stage,
    label: card.number,
    title: card.title,
    href: href(card),
    fields: [
      { label: t('col.severity'), value: t(`severity.${card.severity}`) },
      { label: t('col.owner'), value: card.ownerId ? (nameOf(model.people, card.ownerId) ?? t('common.unknownPerson')) : t('common.nobody') },
      { label: t('col.source'), value: t(`source.${card.source}`) },
    ],
    marks: [
      ...(card.severity === 'CRITICAL' ? [{ label: t('severity.CRITICAL'), tone: 'danger' as const }] : []),
    ],
    held: say(cardHeld(card, model.moving === card.id)),
  }))
  const boardHeld = model.live === 'offline' ? t('board.held.offline') : model.can.manage || model.can.close ? null : t('board.held.readOnly')

  return (
    <div className="fw-q">
      <div className="fw-ncr-head">
        <div className="fw-q-head-text">
          <p className="fw-q-intro">{t('list.intro')}</p>
          <Freshness asOf={model.asOf} live={model.live} />
        </div>
        <span className="fw-q-actions fw-q-noprint">
          <SegmentedControl
            size="sm"
            ariaLabel={t('list.mode')}
            value={model.address.mode}
            onChange={(value) => actions?.onMode?.(value as 'list' | 'board')}
            options={MODES.map((mode) => ({ value: mode.value, label: t(mode.value === 'list' ? 'list.modeList' : 'list.modeBoard'), icon: <mode.icon size={13} aria-hidden /> }))}
          />
          {newButton}
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('list.more') }}
            items={[
              { id: 'print', label: t('list.print'), onSelect: () => actions?.onPrint?.() },
              { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
            ]}
          />
        </span>
      </div>

      <p className="fw-ncr-printonly">
        {t('list.printFilters', { rows: t(`view.${model.address.view}`), site: sites.find((site) => site.id === model.address.siteId)?.code ?? t('common.allSites'), search: model.address.q || '—' })}
      </p>
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />

      <MetricStrip
        metrics={NCR_TILES.map((tile) => ({
          label: t(`tile.${tile.count}`),
          value: model.counts ? String(model.counts[tile.count]) : '—',
          hint: t(`tile.hint.${tile.count}`),
          onClick: () => actions?.onView?.(model.address.view === tile.view && tile.view !== 'open' ? 'open' : tile.view),
          active: model.address.view === tile.view,
        }))}
      />

      {board ? (
        <div className="fw-q-stack">
          <span className="fw-ncr-tools">
            {searchField}
            {tools}
          </span>
          {state ?? (
            <BoardView
              label={t('board.label')}
              lanes={lanes}
              cards={cards}
              loading={model.lanes.items === null}
              words={boardWords}
              locale={locale}
              heldReason={boardHeld}
              moveHeld={(card, laneId) => {
                const ncr = byId.get(card.id)
                return ncr ? say(laneHeld(ncr, laneId as (typeof BOARD_LANES)[number], model.can)) : null
              }}
              onMove={async (move) => {
                const ncr = byId.get(move.cardId)
                if (!ncr || (move.to !== 'CONTAINED' && move.to !== 'DECIDED' && move.to !== 'CLOSED')) return false
                return (await actions?.onBoardMove?.(ncr, move.to)) ?? false
              }}
              renderAside={(card) => {
                const ncr = byId.get(card.id)
                return ncr && ncr.stage === 'OPEN' && ncr.containmentDueAt ? <ContainmentDue ncr={ncr} now={model.now} /> : null
              }}
              renderFooter={(card) => {
                const ncr = byId.get(card.id)
                return ncr ? <DecidedBar ncr={ncr} compact /> : null
              }}
            />
          )}
          <div className="fw-ncr-boardfoot">
            <p className="fw-q-hint">{t('list.boardFoot')}</p>
            <ListKeysInfo keys={[...ownKeys, ...boardKeys]} onHelp={() => setKeysOpen(true)} />
          </div>
        </div>
      ) : (
        <ListFrame<NcrSummary>
          label={t('list.tableLabel')}
          rows={state ? [] : model.rows.items}
          rowId={(row) => row.id}
          columns={columns}
          count={model.rows.items ? (model.rows.truncated ? t('list.countMax', { count: model.rows.items.length }) : t('list.count', { count: model.rows.items.length })) : '—'}
          search={searchField}
          tools={tools}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <>
                <Button
                  size="sm"
                  aria-label={t('list.assign', { count: pickedOpen.length })}
                  heldReason={!model.can.manage ? t('held.noManage') : !model.can.people ? t('held.noPeople') : pickedOpen.length === 0 ? t('list.heldAssignNone') : pickedSites.size > 1 ? t('list.heldAssignSites') : pickedOpen.length > 50 ? t('list.heldAssignMax') : null}
                  onClick={() => actions?.onAssign?.(pickedOpen.map((row) => row.id))}
                >
                  <UserPlus size={13} aria-hidden /> <SelectionLabel>{t('list.assign', { count: pickedOpen.length })}</SelectionLabel>
                </Button>
                <Button size="sm" aria-label={t('common.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                  <Download size={13} aria-hidden /> <SelectionLabel>{t('common.export', { count: picked.length })}</SelectionLabel>
                </Button>
              </>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          keys={ownKeys}
          onHelp={() => setKeysOpen(true)}
          onOpen={(row) => actions?.onOpen?.(row.id)}
          state={state}
          focusRow={model.focusRow}
          title={t('list.tableLabel')}
        />
      )}
      {!board && <p className="fw-q-hint">{t('list.foot')}</p>}

      {model.dialog?.kind === 'new' && <NewNcrDialog prefix={model.prefix} dialog={model.dialog} sites={model.sites} people={model.people} can={model.can} actions={actions} />}
      {model.dialog?.kind === 'assign' && <AssignDialog dialog={model.dialog} people={model.people} actions={actions} />}
      {model.close && <CloseNcrDialog model={model.close} actions={actions?.close} />}
      <NcrStepUp state={model.stepUp} onSubmit={(code) => actions?.onStepUpSubmit?.(code)} onCancel={() => actions?.onStepUpCancel?.()} />
      {keysOpen && <KeysDialog own={board ? [...ownKeys, ...boardKeys] : ownKeys} frame={!board} onClose={() => setKeysOpen(false)} />}
    </div>
  )
}
