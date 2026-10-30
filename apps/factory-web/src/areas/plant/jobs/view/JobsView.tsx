'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Check, Download, Kanban, List, MoreHorizontal, Plus, UserPlus } from 'lucide-react'
import { EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { BoardView, type BoardCard, type BoardLane } from '@nexus/ui/grid/views/board/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { useBoardViewWords } from '../../../_shared/board-view/words'
import { PRIORITIES, type MaintenanceJob } from '../../_shared/api'
import { ageWords, assigneeValue, assigneeWords, BOARD_LANES, dueWords, instantOf, JOB_TONE, JOB_VIEWS, labelOf, laneHeld, localOf, moveToLane, type JobsAddress } from '../../_shared/model'
import { JobPill, KeysModal, LiveLine, MachinePill, NoPlantAccess, NoticeBanner, PlantMessages, PriorityTag, say, useWords } from '../../_shared/parts'
import type { CellState, JobsListActions, JobsListModel } from '../view-model'
import { JobDialogs } from './JobDialogs'

export type { JobsListActions, JobsListModel } from '../view-model'

const TILES = [
  { view: 'open', tile: 'OPEN' },
  { view: 'overdue', tile: 'OVERDUE' },
  { view: 'unsafe', tile: 'UNSAFE' },
  { view: 'waiting', tile: 'WAITING_PARTS' },
  { view: 'closedWeek', tile: 'CLOSED_THIS_WEEK' },
] as const

/**
 * SCR-149 — Maintenance jobs (Plant › Maintenance; design plant.jobs, a workspace list): corrective, preventive,
 * inspection, improvement and safety work. The tiles are saved filters (open, overdue, unsafe machines waiting, waiting
 * parts, closed this week). A list on the shared list frame — number, type, the machine with its live status, the
 * problem, the priority, the line, the technician (an office user by name; a floor technician without a name: Owner W1),
 * the due time, the state, the source and the age — with inline priority, due and technician (autosaved with the job's
 * version, a mark per cell), or the same rows as a board by state (drag or keys; a hand-back opens the job's close form;
 * Closed only after the hand-back). New job (`c`), Assign N, Export N.
 */
export function JobsView({ model, actions }: { model: JobsListModel; actions?: JobsListActions }) {
  return (
    <PlantMessages>
      <Jobs model={model} actions={actions} />
    </PlantMessages>
  )
}

function CellMark({ cell }: { cell: CellState | undefined }) {
  const t = useWords()
  if (!cell) return null
  if (cell.state === 'saving') return <Spinner size={12} />
  if (cell.state === 'saved') return <Check size={13} className="fw-pl-success" aria-label={t('cell.saved')} />
  return <AlertCircle size={13} className="fw-pl-danger" aria-label={say(t, cell.words) ?? t('cell.failed')} />
}

function Jobs({ model, actions }: { model: JobsListModel; actions?: JobsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const boardWords = useBoardViewWords()
  const place = { locale, timeZone: model.timeZone }
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const rowsKey = model.rows.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const allSites = model.sites.length > 1 && model.address.siteId === null
  const canEdit = model.can.manageJobs

  // c: a new job; b: list ⇄ board (design kb) — never while typing, in a dialog or a menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manageJobs) {
        event.preventDefault()
        actions?.onNew?.()
      } else if (event.key === 'b') {
        event.preventDefault()
        actions?.onMode?.(model.address.mode === 'board' ? 'list' : 'board')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.can.manageJobs, model.address.mode, help, actions])

  // The cells call the page's latest actions (the grid keeps its columns between renders).
  const act = useRef(actions)
  act.current = actions
  const columns = useMemo<ColDef<MaintenanceJob>[]>(() => {
    const href = (row: MaintenanceJob) => `${model.prefix}/plant/jobs/${encodeURIComponent(row.id)}`
    const NumberCell = ({ data }: ICellRendererParams<MaintenanceJob>) =>
      data ? (
        <span className="fw-pl-cell">
          <Link className="fw-pl-link fw-pl-code" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-pl-sub">{t(`jobType.${data.type}`)}</span>
        </span>
      ) : null
    const MachineCell = ({ data }: ICellRendererParams<MaintenanceJob>) =>
      data ? (
        <span className="fw-pl-cell">
          <Link className="fw-pl-link fw-pl-code" href={`${model.prefix}/plant/machines/${encodeURIComponent(data.machine.id)}`}>
            {data.machine.assetNumber}
          </Link>
          <span title={data.machine.line ? `${data.machine.line.code} · ${data.machine.line.name}` : (data.machine.station?.code ?? undefined)}>
            <MachinePill status={data.machine.status} locked={data.machine.locked} />
          </span>
        </span>
      ) : null
    const ProblemCell = ({ data }: ICellRendererParams<MaintenanceJob>) =>
      data ? (
        <span className="fw-pl-cell" title={data.problem}>
          <span className="fw-pl-ellipsis">{data.problem}</span>
          <span className="fw-pl-sub">{[labelOf(data.machine.class, locale), data.machine.line?.code ?? data.machine.station?.code].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const PriorityCell = ({ data }: ICellRendererParams<MaintenanceJob>) => {
      if (!data) return null
      if (!canEdit || !data.open) return <PriorityTag priority={data.priority} />
      return (
        <span className="fw-pl-row">
          <Select size="sm" aria-label={t('cell.priority', { number: data.number })} value={data.priority} onChange={(event) => act.current?.onEdit?.(data, { priority: event.target.value as MaintenanceJob['priority'] }, 'priority')}>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority} title={t(`priority.${priority}`)}>
                {priority}
              </option>
            ))}
          </Select>
          <CellMark cell={model.cells[`${data.id}:priority`]} />
        </span>
      )
    }
    const AssigneeCell = ({ data }: ICellRendererParams<MaintenanceJob>) => {
      if (!data) return null
      if (!canEdit || !data.open) return <span className="fw-pl-ellipsis">{assigneeWords(t, data)}</span>
      const found = model.technicians[data.siteId]
      const current = assigneeValue(data)
      const unnamedFloor = data.assignee?.kind === 'WORKER' && !data.assignee.id
      return (
        <span className="fw-pl-row">
          <Select
            size="sm"
            aria-label={t('cell.assignee', { number: data.number })}
            value={unnamedFloor ? 'WORKER:' : current}
            onFocus={() => found === undefined && act.current?.onNeedTechnicians?.(data.siteId)}
            onChange={(event) => event.target.value !== 'WORKER:' && act.current?.onEdit?.(data, assigneeChange(event.target.value), 'assignee')}
          >
            <option value="">{t('person.nobody')}</option>
            {unnamedFloor && <option value="WORKER:">{t('person.aWorker')}</option>}
            {current && !found?.technicians.some((entry) => `${entry.kind}:${entry.id}` === current) && <option value={current}>{assigneeWords(t, data)}</option>}
            {(found?.technicians ?? []).map((entry) => (
              <option key={`${entry.kind}:${entry.id}`} value={`${entry.kind}:${entry.id}`}>
                {entry.me ? t('field.assigneeMe', { name: entry.name }) : entry.kind === 'WORKER' ? t('field.assigneeFloorName', { name: entry.name }) : entry.name}
              </option>
            ))}
          </Select>
          <CellMark cell={model.cells[`${data.id}:assignee`]} />
        </span>
      )
    }
    const DueCell = ({ data }: ICellRendererParams<MaintenanceJob>) => {
      if (!data) return null
      const words = dueWords(t, data.dueAt, model.now, !data.open || data.status === 'HANDED_BACK')
      if (!canEdit || !data.open) return <span className="fw-pl-num">{data.dueAt ? formatDateTime(data.dueAt, place) : '—'}</span>
      return (
        <span className="fw-pl-cell">
          <span className="fw-pl-row">
            <Input
              size="sm"
              type="datetime-local"
              aria-label={t('cell.due', { number: data.number })}
              defaultValue={localOf(data.dueAt, model.timeZone)}
              key={`${data.id}:${data.version}`}
              onBlur={(event) => {
                const next = instantOf(event.target.value, model.timeZone)
                if ((next ?? null) !== (data.dueAt ?? null) && !(next && data.dueAt && new Date(next).getTime() === new Date(data.dueAt).getTime())) act.current?.onEdit?.(data, { dueAt: next }, 'due')
              }}
            />
            <CellMark cell={model.cells[`${data.id}:due`]} />
          </span>
          {words && <span className={`fw-pl-sub${data.overdue ? ' fw-pl-danger' : ''}`}>{words}</span>}
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<MaintenanceJob>) =>
      data ? (
        <span className="fw-pl-cell">
          <span>
            <JobPill status={data.status} />
          </span>
          {data.overdue ? <span className="fw-pl-sub fw-pl-danger">{t('jobs.overdue')}</span> : <span className="fw-pl-sub" title={formatDateTime(data.createdAt, place)}>{`${t(`jobSource.${data.source}`)} · ${ageWords(t, data.ageMinutes)}`}</span>}
        </span>
      ) : null
    const SiteCell = ({ data }: ICellRendererParams<MaintenanceJob>) => <span className="fw-pl-code">{data ? (model.sites.find((site) => site.id === data.siteId)?.code ?? '—') : ''}</span>
    const MoreCell = ({ data }: ICellRendererParams<MaintenanceJob>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('jobs.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('jobs.open'), href: href(data) },
            { id: 'tab', label: t('common.openNewTab'), href: href(data), target: '_blank' },
            { id: 'handback', label: t('jobTab.handback'), href: `${href(data)}?tab=handback` },
            { id: 'sheet', label: t('jobs.sheet'), href: `${href(data)}/sheet`, target: '_blank' },
            { id: 'machine', label: t('list.machineRecord'), href: `${model.prefix}/plant/machines/${encodeURIComponent(data.machine.id)}`, target: '_blank' },
          ]}
        />
      ) : null
    const list: ColDef<MaintenanceJob>[] = [
      { colId: 'number', headerName: t('col.number'), minWidth: 118, flex: 0.6, cellRenderer: NumberCell },
      { colId: 'machine', headerName: t('col.machine'), minWidth: 164, flex: 0.8, cellRenderer: MachineCell },
      { colId: 'problem', headerName: t('col.problem'), minWidth: 200, flex: 1.6, cellRenderer: ProblemCell },
      { colId: 'priority', headerName: t('col.priority'), minWidth: canEdit ? 104 : 120, flex: 0.4, cellRenderer: PriorityCell },
      { colId: 'assignee', headerName: t('col.assignee'), minWidth: canEdit ? 186 : 140, flex: 0.9, cellRenderer: AssigneeCell },
      { colId: 'due', headerName: t('col.due'), minWidth: canEdit ? 204 : 140, flex: 0.9, cellRenderer: DueCell },
      { colId: 'state', headerName: t('col.state'), minWidth: 156, flex: 0.7, cellRenderer: StateCell },
      { colId: 'more', headerName: t('col.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    if (allSites) list.splice(1, 0, { colId: 'site', headerName: t('col.site'), minWidth: 84, flex: 0.3, cellRenderer: SiteCell })
    return list
  }, [t, locale, model.prefix, model.timeZone, model.sites, model.technicians, model.cells, model.now, allSites, canEdit])

  if (!model.can.view) {
    return (
      <div className="fw-pl">
        <NoPlantAccess />
      </div>
    )
  }

  const items = model.rows.items ?? []
  const picked = items.filter((row) => selected.includes(row.id))
  const pickedOpen = picked.filter((row) => row.open)
  const pickedSites = new Set(pickedOpen.map((row) => row.siteId))
  const filtered = model.address.view !== 'open' || model.address.siteId !== null || model.address.machineId !== null
  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.newJob') },
    { keys: ['b'], does: t('keys.board') },
  ]
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.manageJobs ? null : t('held.noManageJobs')} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('jobs.new')}
    </Button>
  )

  const state = model.rows.problem ? (
    <EmptyState title={t('jobs.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : model.rows.items && model.rows.items.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('jobs.noMatch')}
        description={t('jobs.noMatchBody')}
        action={
          <Button
            size="sm"
            onClick={() => {
              actions?.onView?.('open')
              actions?.onSite?.(null)
              actions?.onMachine?.(null)
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('jobs.empty')} description={t('jobs.emptyBody')} action={model.can.manageJobs ? newButton : undefined} />
    )
  ) : undefined

  const tools = (
    <>
      <Select size="sm" aria-label={t('list.rowsLabel')} value={model.address.view} onChange={(event) => actions?.onView?.(event.target.value as JobsAddress['view'])}>
        {JOB_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`jobView.${view}`)}
          </option>
        ))}
      </Select>
      {model.sites.length > 1 && (
        <Select size="sm" aria-label={t('common.site')} value={model.address.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value || null)}>
          <option value="">{t('common.allSites')}</option>
          {model.sites.map((site) => (
            <option key={site.id} value={site.id}>
              {`${site.code} · ${site.name}`}
            </option>
          ))}
        </Select>
      )}
      {model.address.machineId && (
        <Tag tone="info">
          {t('jobs.thisMachine', { machine: model.machine?.assetNumber ?? '…' })}{' '}
          <Button size="sm" variant="quiet" aria-label={t('jobs.clearMachine')} onClick={() => actions?.onMachine?.(null)}>
            ×
          </Button>
        </Tag>
      )}
    </>
  )

  const lanes: BoardLane[] = BOARD_LANES.map((lane) => ({ id: lane, label: t(`jobStatus.${lane}`), tone: JOB_TONE[lane] }))
  const cards: BoardCard[] = items
    .filter((row) => row.status !== 'CANCELLED')
    .map((row) => ({
      id: row.id,
      laneId: row.status,
      label: row.number,
      title: row.problem,
      href: `${model.prefix}/plant/jobs/${encodeURIComponent(row.id)}`,
      fields: [
        { label: t('col.machine'), value: row.machine.assetNumber },
        { label: t('col.assignee'), value: assigneeWords(t, row) },
        ...(row.dueAt ? [{ label: t('col.due'), value: formatDate(row.dueAt, place) }] : []),
      ],
      marks: [
        { label: t(`priority.${row.priority}`), tone: row.priority === 'P1' ? ('danger' as const) : row.priority === 'P2' ? ('warning' as const) : ('neutral' as const) },
        ...(row.machine.locked ? [{ label: t('machineStatus.LOCKED'), tone: 'danger' as const }] : []),
        ...(row.overdue ? [{ label: t('jobs.overdue'), tone: 'danger' as const }] : []),
      ],
      held: row.status === 'CLOSED' ? t('held.board.closed') : model.moving === row.id ? t('held.busy') : null,
    }))
  const byId = new Map(items.map((row) => [row.id, row]))

  return (
    <div className="fw-pl">
      <div className="fw-pl-head">
        <LiveLine asOf={model.asOf} live={model.live} />
        <span className="fw-pl-actions">
          <SegmentedControl
            size="sm"
            ariaLabel={t('jobs.mode')}
            value={model.address.mode}
            onChange={(value) => actions?.onMode?.(value as JobsAddress['mode'])}
            options={[
              { value: 'list', label: t('jobs.modeList'), icon: <List size={13} aria-hidden /> },
              { value: 'board', label: t('jobs.modeBoard'), icon: <Kanban size={13} aria-hidden /> },
            ]}
          />
          {newButton}
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('jobs.more') }} items={[{ id: 'keys', label: t('keys.title'), onSelect: () => setHelp(true) }]} />
        </span>
      </div>

      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />

      <MetricStrip
        metrics={TILES.map((entry) => ({
          label: t(`jobTile.${entry.tile}`),
          value: model.tiles ? String(model.tiles[entry.tile]) : '—',
          hint: t(`jobTileHint.${entry.tile}`),
          onClick: () => actions?.onView?.(model.address.view === entry.view && entry.view !== 'open' ? 'open' : entry.view),
          active: model.address.view === entry.view,
        }))}
      />

      {model.address.mode === 'board' ? (
        <div className="fw-pl-stack tight">
          <span className="fw-pl-row">{tools}</span>
          {state ?? (
            <BoardView
              label={t('jobs.boardLabel')}
              lanes={lanes}
              cards={cards}
              loading={model.rows.items === null}
              words={boardWords}
              locale={INTL_LOCALE[locale]}
              heldReason={model.can.manageJobs || model.can.work ? null : t('held.board.readOnly')}
              moveHeld={(card, laneId) => {
                const job = byId.get(card.id)
                if (!job) return null
                const why = laneHeld(job, laneId as (typeof BOARD_LANES)[number], model.can)
                return why ? t(why) : null
              }}
              onMove={async (move) => {
                const job = byId.get(move.cardId)
                const kind = job ? moveToLane(job.status, move.to as (typeof BOARD_LANES)[number]) : null
                if (!job || !kind) return false
                return (await actions?.onBoardMove?.(job, kind)) ?? false
              }}
              renderAside={(card) => {
                const job = byId.get(card.id)
                if (!job?.dueAt || !job.open) return null
                const words = dueWords(t, job.dueAt, model.now, job.status === 'HANDED_BACK')
                return words ? <span className={job.overdue ? 'fw-pl-danger' : undefined}>{words}</span> : null
              }}
            />
          )}
          {model.rows.more && <Button size="sm" onClick={() => actions?.onMore?.()}>{t('list.showMore')}</Button>}
          <p className="fw-pl-hint">{t('jobs.boardHint')}</p>
        </div>
      ) : (
        <ListFrame<MaintenanceJob>
          label={t('jobs.tableLabel')}
          rows={state ? [] : model.rows.items}
          rowId={(row) => row.id}
          columns={columns}
          count={model.rows.items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: model.rows.items.length }) : '—'}
          tools={tools}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <>
                <Button
                  size="sm"
                  aria-label={t('jobs.assignMany', { count: pickedOpen.length })}
                  heldReason={!model.can.manageJobs ? t('held.noManageJobs') : pickedOpen.length === 0 ? t('held.noneOpen') : pickedSites.size > 1 ? t('held.oneSite') : pickedOpen.length > 50 ? t('held.max50') : null}
                  onClick={() => actions?.onAssign?.(pickedOpen)}
                >
                  <UserPlus size={13} aria-hidden /> <SelectionLabel>{t('jobs.assignMany', { count: pickedOpen.length })}</SelectionLabel>
                </Button>
                <Button size="sm" aria-label={t('common.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                  <Download size={13} aria-hidden /> <SelectionLabel>{t('common.export', { count: picked.length })}</SelectionLabel>
                </Button>
              </>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          more={model.rows.more && items.length > 0 ? { label: t('list.showMore'), onMore: () => actions?.onMore?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(row) => actions?.onOpen?.(row.id)}
          state={state}
        />
      )}
      {model.address.mode === 'list' && <p className="fw-pl-hint">{t(model.can.manageJobs ? 'jobs.footEdit' : 'jobs.foot')}</p>}

      <JobDialogs model={model} actions={actions} />
      {help && <KeysModal own={ownKeys} onClose={() => setHelp(false)} />}
    </div>
  )
}

const assigneeChange = (value: string) => {
  const [kind, id] = value.split(':') as [string, string | undefined]
  return { assigneeId: kind === 'USER' && id ? id : null, assigneeWorkerId: kind === 'WORKER' && id ? id : null }
}
