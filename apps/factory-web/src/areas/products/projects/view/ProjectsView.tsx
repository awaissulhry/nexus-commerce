'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { BellOff, MoreHorizontal, Pause, Play, Plus, UserPlus, X, XCircle } from 'lucide-react'
import { Banner, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Kbd, SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import { formatTime } from '../../../../lib/i18n/format'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { LiveState } from '../../../../shell/live/use-live'
import type { ProjectRow } from '../api'
import type { PartyOption, SeasonOption } from '../list-api'
import {
  BULK_CLOSE_HELD,
  bulkHeld,
  doorsOf,
  hiddenBy,
  isFiltered,
  newMarkOf,
  PAGE_VIEWS,
  partyGroupsOf,
  partyNameOf,
  TARGET_FILTERS,
  targetDoorOf,
  viewOfStatus,
  addressText,
  type BulkStatus,
  type ListAddress,
  type ListNotice,
} from '../list-model'
import { isPageKey, NO_MANAGE, OFFLINE, partyHref, type ProjectsCan } from '../model'
import { ProjectsMessages, StatusPill, TargetDate, useWords } from '../parts'
import { BulkColleagueDialog, type BulkColleagueActions, type BulkColleagueModel } from './BulkColleagueDialog'
import { NewProjectDialog, type NewProjectActions, type NewProjectModel } from './NewProjectDialog'
import '../projects.css'

/**
 * SCR-700 — Products › Development › Projects (B-TH-248; design PROJ.list, PROJ.new): the projects on the ONE list frame, full width,
 * every cell a door; the views My projects (default) · Active · By outside company · On hold · Closed · All; the filters as chips in
 * the address; the bulk bar (Put on hold, Resume, Add a colleague, Export N — never Close, said why); New project. Open to every
 * office person who reads threads (decision 14), said on the page.
 */
export interface ProjectsListModel {
  prefix: string
  me: string
  /** The site's day (YYYY-MM-DD). */
  today: string
  can: ProjectsCan
  address: ListAddress
  /** Every row read so far (pages of 50); null while the first page is read. */
  rows: readonly ProjectRow[] | null
  /** The rows the view holds (the API's exact count up to 1,000). */
  count: number | null
  /** False: more than 1,000 match (the count is the first 1,000). */
  complete: boolean
  /** Another page to read (Show more). */
  hasMore: boolean
  moreBusy: boolean
  /** A failed read (never drawn as an empty list). */
  problem: string | null
  /** The outside companies of the filter (null without parties.view or not read). */
  parties: readonly PartyOption[] | null
  seasons: readonly SeasonOption[] | null
  asOf: string | null
  live: LiveState
  /** Changes that arrived while the list was on screen ("N updates · Show"). */
  updates: number
  notice: ListNotice | null
  /** A bulk run is going (the bar's buttons wait). */
  bulkBusy: boolean
  newProject: NewProjectModel | null
  colleague: BulkColleagueModel | null
  /** Design cases: the rows selected, the keys panel open. */
  selected?: readonly string[]
  keysOpen?: boolean
}

export interface ProjectsListActions {
  onAddress?: (patch: Partial<ListAddress>) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpen?: (projectId: string, newTab?: boolean) => void
  onNew?: () => void
  newProject?: NewProjectActions
  onBulkStatus?: (ids: readonly string[], to: BulkStatus) => void
  onBulkColleague?: (ids: readonly string[]) => void
  colleague?: BulkColleagueActions
  onCopy?: (numbers: readonly string[]) => void
  onDismissNotice?: () => void
}

export function ProjectsView({ model, actions }: { model: ProjectsListModel; actions?: ProjectsListActions }) {
  return (
    <ProjectsMessages>
      <List model={model} actions={actions} />
    </ProjectsMessages>
  )
}

function List({ model, actions }: { model: ProjectsListModel; actions?: ProjectsListActions }) {
  const { t, say, when, locale } = useWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [search, setSearch] = useState(model.address.q)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  const all = model.rows
  const rowsKey = all?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const offline = model.live === 'offline'
  const act = useRef(actions)
  act.current = actions
  const href = (terms: Partial<ListAddress>) => `${model.prefix}/products/projects${addressText({ ...model.address, isNew: false, link: null, ...terms })}`

  // n: New project — never while typing, in a dialog or a menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newProject || model.colleague) return
      if (event.key === 'n' && model.can.manage) {
        event.preventDefault()
        act.current?.onNew?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.newProject, model.colleague, model.can.manage])

  const columns = useMemo<ColDef<ProjectRow>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<ProjectRow>) =>
      data ? (
        <Link className="fw-prj-link fw-prj-code" href={doorsOf(model.prefix, data).project}>
          {data.number}
        </Link>
      ) : null
    const NameCell = ({ data }: ICellRendererParams<ProjectRow>) =>
      data ? (
        <span className="fw-prj-cell">
          <Link className="fw-prj-link" href={doorsOf(model.prefix, data).project}>
            {data.name}
          </Link>
          {data.seasonCode && <span className="fw-prj-hint">{t('row.season', { code: data.seasonCode })}</span>}
        </span>
      ) : null
    const PartyCell = ({ data }: ICellRendererParams<ProjectRow>) => {
      if (!data) return null
      if (!data.party) return <Tag tone="neutral">{t('common.officeOnly')}</Tag>
      return (
        <Link className="fw-prj-link" href={partyHref(model.prefix, data.party.id)} title={t('row.openParty', { name: data.party.name })}>
          {data.party.name || data.party.code}
        </Link>
      )
    }
    const LeadCell = ({ data }: ICellRendererParams<ProjectRow>) =>
      data ? (
        <Link className="fw-prj-link" href={href({ lead: data.lead.id })} title={t('row.byLead', { name: data.lead.name })}>
          {data.lead.id === model.me ? t('common.you', { name: data.lead.name }) : data.lead.name}
        </Link>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<ProjectRow>) =>
      data ? (
        <Link className="fw-prj-door" href={href({ view: viewOfStatus(data.status) })} aria-label={t('row.byStatus', { status: t(`status.${data.status}`) })}>
          <StatusPill status={data.status} />
        </Link>
      ) : null
    const TargetCell = ({ data }: ICellRendererParams<ProjectRow>) => {
      if (!data) return null
      const door = targetDoorOf(data, model.today)
      const inner = <TargetDate targetDate={data.targetDate} target={data.target} />
      return door ? (
        <Link className="fw-prj-door" href={href({ target: door })} aria-label={t(`row.byTarget.${door}`)}>
          {inner}
        </Link>
      ) : (
        <Link className="fw-prj-door" href={doorsOf(model.prefix, data).project}>
          {inner}
        </Link>
      )
    }
    const LastCell = ({ data }: ICellRendererParams<ProjectRow>) =>
      data ? (
        <Link className="fw-prj-link fw-prj-num" href={doorsOf(model.prefix, data).thread}>
          {data.lastMessageAt ? when(data.lastMessageAt) : t('row.noMessages')}
        </Link>
      ) : null
    const NewCell = ({ data }: ICellRendererParams<ProjectRow>) => {
      if (!data) return null
      const mark = newMarkOf(data)
      if (mark.kind === 'muted')
        return (
          <Link className="fw-prj-door fw-prj-muted" href={doorsOf(model.prefix, data).thread} aria-label={t('row.mutedLabel')} title={t('row.mutedLabel')}>
            <BellOff size={14} aria-hidden />
          </Link>
        )
      if (mark.kind === 'none')
        return (
          <Link className="fw-prj-link fw-prj-hint" href={doorsOf(model.prefix, data).thread}>
            {t('row.nothingNew')}
          </Link>
        )
      return (
        <Link className="fw-prj-link fw-prj-new" href={doorsOf(model.prefix, data).thread} aria-label={t('row.newLabel', { count: mark.count })}>
          <span className="fw-prj-dot" aria-hidden />
          {t('row.new', { count: mark.count })}
        </Link>
      )
    }
    const LinkedCell = ({ data }: ICellRendererParams<ProjectRow>) =>
      data ? (
        <Link className="fw-prj-link fw-prj-num" href={doorsOf(model.prefix, data).linked} aria-label={t('row.linkedLabel', { count: data.linked })}>
          {data.linked}
        </Link>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<ProjectRow>) => {
      if (!data) return null
      const held = say(bulkHeld('status', model.can, offline, model.bulkBusy))
      const move: BulkStatus | null = data.status === 'ACTIVE' ? 'ON_HOLD' : data.status === 'ON_HOLD' ? 'ACTIVE' : null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('common.open'), href: doorsOf(model.prefix, data).project },
            { id: 'tab', label: t('common.openNewTab'), href: doorsOf(model.prefix, data).project, target: '_blank' },
            ...(move
              ? [{ id: 'move', label: t(move === 'ON_HOLD' ? 'row.hold' : 'row.resume'), disabled: !!held, description: held ?? undefined, onSelect: () => act.current?.onBulkStatus?.([data.id], move) }]
              : []),
            { id: 'copy', label: t('row.copy'), onSelect: () => act.current?.onCopy?.([data.number]) },
          ]}
        />
      )
    }
    return [
      { colId: 'number', headerName: t('col.number'), minWidth: 130, flex: 0.5, valueGetter: (params) => params.data?.number ?? '', cellRenderer: NumberCell },
      { colId: 'name', headerName: t('col.name'), minWidth: 200, flex: 1.4, valueGetter: (params) => params.data?.name ?? '', cellRenderer: NameCell },
      { colId: 'party', headerName: t('col.party'), minWidth: 160, flex: 0.9, valueGetter: (params) => (params.data ? (params.data.party ? params.data.party.name : t('common.officeOnly')) : ''), cellRenderer: PartyCell },
      { colId: 'lead', headerName: t('col.lead'), minWidth: 130, flex: 0.7, valueGetter: (params) => params.data?.lead.name ?? '', cellRenderer: LeadCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: StatusCell },
      { colId: 'target', headerName: t('col.target'), minWidth: 160, flex: 0.7, valueGetter: (params) => params.data?.targetDate ?? '', cellRenderer: TargetCell },
      { colId: 'last', headerName: t('col.last'), minWidth: 140, flex: 0.6, valueGetter: (params) => params.data?.lastMessageAt ?? '', cellRenderer: LastCell },
      { colId: 'new', headerName: t('col.new'), minWidth: 100, flex: 0.4, valueGetter: (params) => (params.data ? (params.data.muted ? -1 : params.data.newForMe) : 0), cellRenderer: NewCell },
      { colId: 'linked', headerName: t('col.linked'), minWidth: 84, flex: 0.3, type: 'rightAligned', valueGetter: (params) => params.data?.linked ?? 0, cellRenderer: LinkedCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the model through these values only.
  }, [t, say, when, model.prefix, model.me, model.today, model.can, model.address, model.bulkBusy, offline])

  if (!model.can.view) {
    return (
      <div className="fw-prj">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const rows = all
  const picked = (all ?? []).filter((row) => selected.includes(row.id))
  const filtered = isFiltered(model.address)
  const pickedParty = model.address.party ? (model.parties ?? []).find((party) => party.id === model.address.party) : undefined
  const partyName = model.address.party ? (pickedParty ? partyNameOf(pickedParty) : (all?.find((row) => row.party?.id === model.address.party)?.party?.name ?? null)) : null
  const leadName = model.address.lead ? (all?.find((row) => row.lead.id === model.address.lead)?.lead.name ?? null) : null
  const ownKeys: ListKey[] = [{ keys: ['n'], does: t('keys.new') }]
  const newHeld = model.can.manage ? (offline ? say(OFFLINE) : null) : say(NO_MANAGE)
  const newButton = (
    <Button size="sm" variant="primary" heldReason={newHeld} onClick={() => actions?.onNew?.()} aria-keyshortcuts="n">
      <Plus size={14} aria-hidden /> {t('list.new')}
      <span className="fw-prj-keys" aria-hidden>
        <Kbd>N</Kbd>
      </span>
    </Button>
  )

  const state = model.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={say({ key: model.problem })}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows !== null && rows.length === 0 ? (
    filtered || model.address.view !== 'mine' ? (
      <EmptyState
        title={t('list.noMatch')}
        description={t('list.hiddenBy', { filters: hiddenBy(model.address, { party: partyName, lead: leadName }).map((phrase) => say(phrase)).join(' · ') })}
        action={
          filtered ? (
            <Button size="sm" onClick={() => actions?.onClearFilters?.()}>
              {t('list.clearFilters')}
            </Button>
          ) : model.can.manage ? (
            newButton
          ) : undefined
        }
      />
    ) : (
      <EmptyState title={t('list.empty')} description={t('list.emptyBody')} action={model.can.manage ? newButton : undefined} />
    )
  ) : undefined

  const groups = partyGroupsOf(model.parties ?? [])
  const partyValue = model.address.office ? 'office' : (model.address.party ?? '')
  const tools = (
    <>
      <Select
        size="sm"
        aria-label={t('filter.party')}
        value={partyValue}
        onChange={(event) => {
          const value = event.target.value
          actions?.onAddress?.(value === 'office' ? { office: true, party: null } : { office: false, party: value || null })
        }}
      >
        <option value="">{t('filter.anyParty')}</option>
        <option value="office">{t('filter.officeOnly')}</option>
        {model.address.party && !(model.parties ?? []).some((party) => party.id === model.address.party) && <option value={model.address.party}>{partyName ?? t('filter.thisParty')}</option>}
        {groups.customers.length > 0 && (
          <optgroup label={t('filter.customers')}>
            {groups.customers.map((party) => (
              <option key={party.id} value={party.id}>
                {party.code} · {partyNameOf(party)}
              </option>
            ))}
          </optgroup>
        )}
        {groups.suppliers.length > 0 && (
          <optgroup label={t('filter.suppliers')}>
            {groups.suppliers.map((party) => (
              <option key={party.id} value={party.id}>
                {party.code} · {partyNameOf(party)}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      <Select size="sm" aria-label={t('filter.targetLabel')} value={model.address.target ?? ''} onChange={(event) => actions?.onAddress?.({ target: (event.target.value || null) as ListAddress['target'] })}>
        <option value="">{t('filter.anyTarget')}</option>
        {TARGET_FILTERS.map((target) => (
          <option key={target} value={target}>
            {t(`filter.target.${target}`)}
          </option>
        ))}
      </Select>
      {model.seasons && model.seasons.length > 0 && (
        <Select size="sm" aria-label={t('filter.season')} value={model.address.season ?? ''} onChange={(event) => actions?.onAddress?.({ season: event.target.value || null })}>
          <option value="">{t('filter.anySeason')}</option>
          {model.address.season && !model.seasons.some((season) => season.code === model.address.season) && <option value={model.address.season}>{model.address.season}</option>}
          {model.seasons.map((season) => (
            <option key={season.id} value={season.code}>
              {season.code} · {season.name}
            </option>
          ))}
        </Select>
      )}
      {model.address.lead && (
        <Button size="sm" variant="tonal" onClick={() => actions?.onAddress?.({ lead: null })} aria-label={t('filter.clearLead', { name: leadName ?? t('filter.thisLead') })}>
          {say(leadName ? { key: 'filter.leadChip', params: { name: leadName } } : { key: 'filter.leadChipPlain' })} <X size={12} aria-hidden />
        </Button>
      )}
      {model.address.season && !(model.seasons && model.seasons.length > 0) && (
        <Button size="sm" variant="tonal" onClick={() => actions?.onAddress?.({ season: null })} aria-label={t('filter.clearSeason', { code: model.address.season })}>
          {t('filter.seasonChip', { code: model.address.season })} <X size={12} aria-hidden />
        </Button>
      )}
    </>
  )

  const statusHeld = say(bulkHeld('status', model.can, offline, model.bulkBusy))
  const colleagueHeld = say(bulkHeld('colleague', model.can, offline, model.bulkBusy))
  const count =
    model.rows === null || model.count === null
      ? t('list.countReading')
      : !model.complete
        ? t('list.countMore', { count: model.count })
        : model.hasMore
          ? t('list.countOf', { shown: model.rows.length, count: model.count })
          : t('list.count', { count: model.count })

  return (
    <div className="fw-prj">
      <div className="fw-prj-head">
        <div className="fw-prj-head-text">
          <p className="fw-prj-intro">{t('list.intro')}</p>
          <p className="fw-prj-intro">{t('common.openToOffice')}</p>
          <span className="fw-prj-asof" role="status">
            {model.asOf ? <time dateTime={model.asOf}>{t('list.updated', { time: formatTime(model.asOf, { locale }) })}</time> : t('list.notYet')}
            {' · '}
            {t(`live.${model.live}`)}
          </span>
        </div>
        <div className="fw-prj-actions">{newButton}</div>
      </div>
      <SegmentedControl
        className="fw-prj-views"
        size="sm"
        wrap
        ariaLabel={t('view.label')}
        value={model.address.view}
        onChange={(value) => actions?.onAddress?.({ view: value as ListAddress['view'] })}
        options={PAGE_VIEWS.map((view) => ({ value: view, label: t(`view.${view}`), title: t(`view.hint.${view}`) }))}
      />
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(model.notice.lines[0])}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        >
          {model.notice.lines.length > 1 ? (
            <ul className="fw-prj-lines">
              {model.notice.lines.slice(1).map((line, index) => (
                <li key={index}>{say(line)}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      )}
      <ListFrame<ProjectRow>
        label={t('list.tableLabel')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={count}
        search={
          <Input
            size="sm"
            type="search"
            className="fw-prj-search"
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
          exportSelected: model.can.exportRows,
          actions: (
            <>
              <Button size="sm" heldReason={statusHeld} aria-label={t('bulk.holdMany', { count: picked.length })} onClick={() => actions?.onBulkStatus?.(selected, 'ON_HOLD')}>
                <Pause size={13} aria-hidden /> <SelectionLabel>{t('bulk.holdMany', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" heldReason={statusHeld} aria-label={t('bulk.resumeMany', { count: picked.length })} onClick={() => actions?.onBulkStatus?.(selected, 'ACTIVE')}>
                <Play size={13} aria-hidden /> <SelectionLabel>{t('bulk.resumeMany', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" heldReason={colleagueHeld} aria-label={t('bulk.colleagueMany', { count: picked.length })} onClick={() => actions?.onBulkColleague?.(selected)}>
                <UserPlus size={13} aria-hidden /> <SelectionLabel>{t('bulk.colleagueMany', { count: picked.length })}</SelectionLabel>
              </Button>
              {/* Close is never a bulk action: each close needs its own outcome line (PROJ.list-F03). The button says why. */}
              <Button size="sm" variant="quiet" heldReason={say(BULK_CLOSE_HELD)} aria-label={t('bulk.close')}>
                <XCircle size={13} aria-hidden /> <SelectionLabel>{t('bulk.close')}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.hasMore && !state ? { label: t('list.more'), onMore: () => actions?.onMore?.(), held: model.moreBusy ? t('common.working') : null } : null}
        keys={ownKeys}
        keysOpen={model.keysOpen}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        onRowClick={(row, event) => actions?.onOpen?.(row.id, event.metaKey || event.ctrlKey)}
        state={state}
        title={t('list.tableLabel')}
        cards={{ hrefOf: (row) => doorsOf(model.prefix, row).project }}
        today={model.today}
      />
      <p className="fw-prj-hint">{model.complete ? t('list.foot') : t('list.footMore')}</p>
      {model.newProject && <NewProjectDialog model={model.newProject} actions={actions?.newProject} />}
      {model.colleague && <BulkColleagueDialog model={model.colleague} actions={actions?.colleague} />}
    </div>
  )
}
