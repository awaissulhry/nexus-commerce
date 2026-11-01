'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowRightLeft, Check, Download, IdCard, MoreHorizontal, Plus, Search, Upload, Users } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { siteColumn } from '../../../../shell/scope/scope-context'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { Employee } from '../../_shared/api'
import { currentNotice, employeesAddressText, hoursText, isFiltered, LIST_TILES, noticeKey, ROW_CHOICES, type RowChoice } from '../../_shared/model'
import { KeysModal, KindTag, languageText, LifecyclePill, LiveLine, NoPeopleAccess, NoticeBanner, PeopleMessages, PeoplePrivacyNote, say, useWords } from '../../_shared/parts'
import { personOf, type CellState, type EmployeesListActions, type EmployeesListModel } from '../view-model'
import { EmployeeDialogs } from './EmployeeDialogs'
import { LeaversPanel } from './LeaversPanel'
import { TeamOnlyList, TeamsPanel } from './TeamsPanel'
import { UnlinkedPanel } from './UnlinkedPanel'

export type { EmployeesListActions, EmployeesListModel } from '../view-model'

/**
 * SCR-084 — Employees (People › Main; design people.employees, a workspace list): staff, floor workers and agency workers
 * with their team, line and lead; leavers handled step by step. Top to bottom: the band's state and actions (Import, New
 * employee, ⋯ Print staff list, Print badges, Keyboard shortcuts) with the privacy note said before any person is read;
 * the most serious data problem, one at a time; the tiles (named saved filters: they put their chip in the filter row);
 * the register on the shared list frame (People | Teams), or the floor workers with no record (that tile); leavers in
 * progress. No pay, attendance, health or per-person work column exists on this page (Statuto dei Lavoratori art. 4).
 */
export function EmployeesView({ model, actions, extra }: { model: EmployeesListModel; actions?: EmployeesListActions; extra?: ReactNode }) {
  return (
    <PeopleMessages>
      <Employees model={model} actions={actions} extra={extra} />
    </PeopleMessages>
  )
}

function CellMark({ cell }: { cell: CellState | undefined }) {
  const t = useWords()
  if (!cell) return null
  if (cell.state === 'saving') return <Spinner size={12} />
  if (cell.state === 'saved') return <Check size={13} className="fw-pp-success" aria-label={t('cell.saved')} />
  return <AlertCircle size={13} className="fw-pp-danger" aria-label={say(t, cell.words) ?? t('cell.failed')} />
}

function Employees({ model, actions, extra }: { model: EmployeesListModel; actions?: EmployeesListActions; extra?: ReactNode }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
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
  const scope = model.scope
  const can = model.can

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'c' && can.manageEmployees && can.view) {
        event.preventDefault()
        latest.current?.onNew?.()
      } else if (event.key === 't' && can.view) {
        event.preventDefault()
        latest.current?.onView?.(model.address.view === 'people' ? 'teams' : 'people')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.address.view, can.manageEmployees, can.view, help])

  const act = useRef(actions)
  act.current = actions
  const columns = useMemo<ColDef<Employee>[]>(() => {
    const href = (row: Employee) => `${model.prefix}/people/employees/${encodeURIComponent(row.id)}`
    const NameCell = ({ data }: ICellRendererParams<Employee>) =>
      data ? (
        <span className="fw-pp-cell">
          <Link className="fw-pp-link fw-pp-ellipsis" href={href(data)}>
            {data.name}
          </Link>
          <span className="fw-pp-sub">{data.displayName}</span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<Employee>) =>
      data ? (
        <span className="fw-pp-cell">
          <span>
            <KindTag kind={data.kind} />
          </span>
          {data.agency && <span className="fw-pp-sub">{data.agency.name}</span>}
        </span>
      ) : null
    const LineCell = ({ data }: ICellRendererParams<Employee>) => {
      if (!data) return null
      const lines = model.lines.filter((line) => line.siteId === data.site.id)
      if (!can.manageEmployees || data.status === 'LEFT' || lines.length === 0) return <span className="fw-pp-ellipsis">{data.homeLine ? `${data.homeLine.code} · ${data.homeLine.name}` : '—'}</span>
      return (
        <span className="fw-pp-row">
          <Select size="sm" aria-label={t('cell.homeLine', { name: data.name })} value={data.homeLine?.id ?? ''} onChange={(event) => act.current?.onCell?.(data, { homeLineId: event.target.value || null })}>
            <option value="">{t('line.none')}</option>
            {lines.map((line) => (
              <option key={line.id} value={line.id}>
                {`${line.code} · ${line.name}`}
              </option>
            ))}
          </Select>
          <CellMark cell={model.cells[`${data.id}:homeLineId`]} />
        </span>
      )
    }
    const TeamCell = ({ data }: ICellRendererParams<Employee>) => {
      if (!data) return null
      const teams = (model.teams.items ?? []).filter((team) => team.status === 'ACTIVE' && team.site.id === data.site.id)
      if (!can.manageTeams || data.status === 'LEFT' || teams.length === 0)
        return (
          <span className="fw-pp-cell">
            <span className="fw-pp-ellipsis">{data.team ? `${data.team.code} · ${data.team.name}` : t('team.none')}</span>
            {data.isLead && <span className="fw-pp-sub">{t('team.isLead')}</span>}
          </span>
        )
      return (
        <span className="fw-pp-row">
          <Select size="sm" aria-label={t('cell.team', { name: data.name })} value={data.team?.id ?? ''} onChange={(event) => act.current?.onCell?.(data, { teamId: event.target.value || null })}>
            <option value="">{t('team.none')}</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {`${team.code} · ${team.name}`}
              </option>
            ))}
          </Select>
          <CellMark cell={model.cells[`${data.id}:teamId`]} />
        </span>
      )
    }
    const LeadCell = ({ data }: ICellRendererParams<Employee>) => (data ? data.isLead ? <Tag tone="info">{t('team.isLead')}</Tag> : <span className="fw-pp-ellipsis">{data.lead?.name ?? '—'}</span> : null)
    const ContractCell = ({ data }: ICellRendererParams<Employee>) => {
      if (!data) return null
      const hours = hoursText(data.weeklyMinutes, locale)
      return (
        <span className="fw-pp-cell">
          <span className="fw-pp-ellipsis">{data.contract ? t(`contract.${data.contract}`) : '—'}</span>
          {hours && <span className="fw-pp-sub">{t('contract.hours', { hours })}</span>}
        </span>
      )
    }
    const day = (value: string | null) => (value ? formatDate(`${value}T12:00:00Z`, place) : '—')
    const BadgeCell = ({ data }: ICellRendererParams<Employee>) => (data ? <span>{data.floor.signIns === 0 ? t('badge.noSignIn') : t(`badgeState.${data.floor.badge}`)}</span> : null)
    const NoticeCell = ({ data }: ICellRendererParams<Employee>) =>
      data ? data.floor.notice === null ? <span className="fw-pp-sub">—</span> : <Tag tone={data.floor.notice === 'MISSING' ? 'warning' : 'neutral'}>{t(`noticeState.${data.floor.notice}`)}</Tag> : null
    const StatusCell = ({ data }: ICellRendererParams<Employee>) =>
      data ? (
        <span className="fw-pp-cell">
          <span>
            <LifecyclePill lifecycle={data.lifecycle} />
          </span>
          {data.leaving && <span className="fw-pp-sub">{t('status.lastDay', { day: day(data.leaving.lastWorkingDay), count: data.leaving.openSteps })}</span>}
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<Employee>) => {
      if (!data) return null
      const left = data.status === 'LEFT'
      const loanHeld = !can.manageLoans ? t('held.noManageLoans') : left ? t('held.left') : null
      const leaverHeld = !can.manageLeavers ? t('held.noManageLeavers') : left ? t('held.left') : data.leaving ? t('held.alreadyLeaving') : null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { name: data.name }) }}
          items={[
            { id: 'open', label: t('list.open'), href: href(data) },
            { id: 'tab', label: t('common.openNewTab'), href: href(data), target: '_blank' },
            { id: 'badge', label: t('list.printBadge'), onSelect: () => act.current?.onBadges?.([personOf(data)]) },
            { id: 'loan', label: t('list.loan'), disabled: loanHeld !== null, description: loanHeld ?? undefined, onSelect: () => act.current?.onLoan?.(personOf(data)) },
            { id: 'leaver', label: t('list.leaver'), disabled: leaverHeld !== null, description: leaverHeld ?? undefined, onSelect: () => act.current?.onLeaver?.(personOf(data)) },
          ]}
        />
      )
    }
    const list: ColDef<Employee>[] = [
      { colId: 'name', headerName: t('col.name'), minWidth: 200, flex: 1.3, cellRenderer: NameCell },
      { colId: 'code', headerName: t('col.code'), minWidth: 110, flex: 0.5, valueGetter: (params) => params.data?.employeeCode ?? '—', cellClass: 'fw-pp-code' },
      { colId: 'kind', headerName: t('col.kind'), minWidth: 130, flex: 0.6, cellRenderer: KindCell },
      { colId: 'company', headerName: t('col.company'), minWidth: 100, flex: 0.4, valueGetter: (params) => params.data?.companyCode ?? '' },
      { colId: 'department', headerName: t('col.department'), minWidth: 130, flex: 0.6, valueGetter: (params) => params.data?.department ?? '—' },
      { colId: 'homeLine', headerName: t('col.homeLine'), minWidth: can.manageEmployees ? 190 : 140, flex: 0.8, cellRenderer: LineCell },
      { colId: 'team', headerName: t('col.team'), minWidth: can.manageTeams ? 200 : 150, flex: 0.9, cellRenderer: TeamCell },
      { colId: 'lead', headerName: t('col.lead'), minWidth: 140, flex: 0.7, cellRenderer: LeadCell },
      { colId: 'role', headerName: t('col.role'), minWidth: 140, flex: 0.7, valueGetter: (params) => params.data?.jobRole ?? '—' },
      { colId: 'contract', headerName: t('col.contract'), minWidth: 130, flex: 0.6, cellRenderer: ContractCell },
      { colId: 'start', headerName: t('col.start'), minWidth: 110, flex: 0.5, valueGetter: (params) => day(params.data?.startDate ?? null) },
      { colId: 'end', headerName: t('col.end'), minWidth: 110, flex: 0.5, valueGetter: (params) => day(params.data?.endDate ?? null) },
      { colId: 'language', headerName: t('col.language'), minWidth: 100, flex: 0.4, valueGetter: (params) => (params.data ? languageText(t, params.data.locale) : '') },
      { colId: 'badge', headerName: t('col.badge'), minWidth: 110, flex: 0.5, cellRenderer: BadgeCell },
      { colId: 'notice', headerName: t('col.notice'), minWidth: 150, flex: 0.6, cellRenderer: NoticeCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 160, flex: 0.7, cellRenderer: StatusCell },
      { colId: 'more', headerName: t('col.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    const site = siteColumn<Employee>(scope, (row) => row.site.id, t('col.site'))
    if (site) list.splice(4, 0, site)
    return list
  }, [t, locale, model.prefix, model.timeZone, model.lines, model.teams.items, model.cells, can.manageEmployees, can.manageTeams, can.manageLoans, can.manageLeavers, scope])

  // A lead with My team only (people.team.view): their own teams, said as a scope note (design noPermission), not an error.
  if (!can.view) {
    if (can.team && model.teamOnly) {
      return (
        <div className="fw-pp">
          <div className="fw-pp-head">
            <LiveLine asOf={model.asOf} live={model.live} />
            <PeoplePrivacyNote sight={model.sight} />
          </div>
          <TeamOnlyList model={model} />
        </div>
      )
    }
    return (
      <div className="fw-pp">
        <NoPeopleAccess />
      </div>
    )
  }

  const items = model.rows.items ?? []
  const picked = items.filter((row) => selected.includes(row.id))
  const filtered = isFiltered(model.address)
  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.new') },
    { keys: ['t'], does: t('keys.teams') },
  ]
  const unlinkedTile = model.address.tile === 'UNLINKED_WORKERS'
  const newButton = (
    <Button size="sm" variant="primary" heldReason={can.manageEmployees ? null : t('held.noManageEmployees')} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const importHeld = !can.manageEmployees ? t('held.noManageEmployees') : !can.runImport ? t('held.noImport') : null
  const importButton = (
    <Button size="sm" heldReason={importHeld} onClick={() => actions?.onImport?.()}>
      <Upload size={14} aria-hidden /> {t('list.import')}
    </Button>
  )
  const printHref = `${model.prefix}/people/employees/print${employeesAddressText({ ...model.address, isNew: false, isImport: false })}`
  const badgeIds = (picked.length > 0 ? picked : items).filter((row) => row.status !== 'LEFT')

  const state = model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : model.rows.items && model.rows.items.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        description={t('list.noMatchBody')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onSearch?.('')
              actions?.onTile?.(null)
              actions?.onRows?.('ACTIVE')
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<Users size={22} aria-hidden />}
        title={t('list.empty')}
        description={(model.counts?.tiles.UNLINKED_WORKERS ?? 0) > 0 ? t('list.emptyUnlinked', { count: model.counts!.tiles.UNLINKED_WORKERS }) : t('list.emptyBody')}
        action={
          <span className="fw-pp-actions">
            {importButton}
            {can.manageEmployees ? newButton : null}
            {(model.counts?.tiles.UNLINKED_WORKERS ?? 0) > 0 && (
              <Button size="sm" onClick={() => actions?.onTile?.('UNLINKED_WORKERS')}>
                {t('list.linkThem')}
              </Button>
            )}
          </span>
        }
      />
    )
  ) : undefined

  const search = (
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
  )
  const viewSwitch = (
    <SegmentedControl
      size="sm"
      ariaLabel={t('list.viewLabel')}
      value={model.address.view}
      onChange={(value) => actions?.onView?.(value as EmployeesListModel['address']['view'])}
      options={[
        { value: 'people', label: t('view.people') },
        { value: 'teams', label: t('view.teams') },
      ]}
    />
  )
  const rowChoices = ROW_CHOICES.filter((choice) => choice !== 'MY_TEAM' || model.myTeam !== null)
  const tools = (
    <>
      {viewSwitch}
      <Select size="sm" aria-label={t('list.rowsLabel')} value={model.address.rows} onChange={(event) => actions?.onRows?.(event.target.value as RowChoice)}>
        {rowChoices.map((choice) => (
          <option key={choice} value={choice}>
            {choice === 'MY_TEAM' && model.myTeam ? t('rows.MY_TEAM_named', { team: model.myTeam.code }) : t(`rows.${choice}`)}
          </option>
        ))}
      </Select>
      {model.address.tile && model.address.tile !== 'UNLINKED_WORKERS' && (
        <Button size="sm" variant="quiet" aria-label={t('list.tileChipClear', { tile: t(`tile.${model.address.tile}`) })} onClick={() => actions?.onTile?.(null)}>
          <Tag tone="info">{t(`tile.${model.address.tile}`)} ✕</Tag>
        </Button>
      )}
      <ScopeSiteChip model={scope} />
    </>
  )

  const problem = model.counts ? currentNotice(model.counts.problems, model.dismissed, model.noticeIndex) : null

  return (
    <div className="fw-pp">
      <div className="fw-pp-head">
        <LiveLine asOf={model.asOf} live={model.live} />
        <span className="fw-pp-actions">
          {importButton}
          {newButton}
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('list.more') }}
            items={[
              { id: 'print', label: t('list.printStaff'), href: printHref, target: '_blank' },
              { id: 'badges', label: picked.length > 0 ? t('list.printBadgesCount', { count: badgeIds.length }) : t('list.printBadges'), disabled: badgeIds.length === 0, description: badgeIds.length === 0 ? t('held.noneForBadges') : undefined, onSelect: () => actions?.onBadges?.(badgeIds.map(personOf)) },
              { id: 'keys', label: t('keys.title'), onSelect: () => setHelp(true) },
            ]}
          />
        </span>
      </div>
      <PeoplePrivacyNote sight={model.sight} />

      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {extra}

      {problem && (
        <Banner
          tone={problem.problem.code === 'NOTICE_NOT_ACKNOWLEDGED' ? 'warning' : 'info'}
          title={t(`dataProblem.${problem.problem.code}`, { count: problem.problem.count })}
          action={
            <span className="fw-pp-actions">
              {problem.problem.code === 'NOTICE_NOT_ACKNOWLEDGED' ? (
                <Button size="sm" asChild>
                  <Link href={`${model.prefix}/admin/privacy`}>{t('dataProblem.openNotices')}</Link>
                </Button>
              ) : problem.problem.code === 'NO_EMPLOYEE_CODE' ? (
                <Button size="sm" onClick={() => actions?.onRows?.('MISSING_DATA')}>
                  {t('dataProblem.show')}
                </Button>
              ) : (
                <Button size="sm" onClick={() => actions?.onTile?.('UNLINKED_WORKERS')}>
                  {t('list.linkThem')}
                </Button>
              )}
              {problem.more > 0 && (
                <Button size="sm" variant="quiet" onClick={() => actions?.onNoticeNext?.()}>
                  {t('dataProblem.more', { count: problem.more })}
                </Button>
              )}
              <Button size="sm" variant="quiet" onClick={() => actions?.onNoticeDismiss?.(noticeKey(problem.problem))}>
                {t('dataProblem.dismiss')}
              </Button>
            </span>
          }
        />
      )}

      <MetricStrip
        metrics={LIST_TILES.map((tile) => ({
          label: t(`tile.${tile}`),
          value: model.counts ? String(model.counts.tiles[tile]) : '—',
          hint: t(`tileHint.${tile}`),
          onClick: () => actions?.onTile?.(model.address.tile === tile ? null : tile),
          active: model.address.tile === tile,
        }))}
      />

      {unlinkedTile ? (
        <UnlinkedPanel model={model} actions={actions} />
      ) : model.address.view === 'teams' ? (
        <TeamsPanel model={model} actions={actions} viewSwitch={viewSwitch} onHelp={() => setHelp(true)} />
      ) : (
        <>
          <ListFrame<Employee>
            label={t('list.tableLabel')}
            rows={state ? [] : model.rows.items}
            rowId={(row) => row.id}
            columns={columns}
            count={model.rows.items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: model.rows.items.length }) : '—'}
            search={search}
            tools={tools}
            selection={{
              selected,
              onChange: setSelected,
              actions: (
                <>
                  <Button
                    size="sm"
                    aria-label={t('list.changeTeamCount', { count: picked.length })}
                    heldReason={!can.manageTeams ? t('held.noManageTeams') : picked.every((row) => row.status === 'LEFT') ? t('held.left') : null}
                    onClick={() => actions?.onTeamChange?.(picked.filter((row) => row.status !== 'LEFT').map(personOf))}
                  >
                    <ArrowRightLeft size={13} aria-hidden /> <SelectionLabel>{t('list.changeTeamCount', { count: picked.length })}</SelectionLabel>
                  </Button>
                  <Button size="sm" aria-label={t('list.printBadgesCount', { count: badgeIds.length })} heldReason={badgeIds.length === 0 ? t('held.noneForBadges') : null} onClick={() => actions?.onBadges?.(badgeIds.map(personOf))}>
                    <IdCard size={13} aria-hidden /> <SelectionLabel>{t('list.printBadgesCount', { count: badgeIds.length })}</SelectionLabel>
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
            cards={{ hrefOf: (row) => `${model.prefix}/people/employees/${encodeURIComponent(row.id)}` }}
          />
          <p className="fw-pp-hint">{t('list.foot')}</p>
          <LeaversPanel model={model} actions={actions} />
        </>
      )}

      <EmployeeDialogs
        model={{ dialog: model.dialog, can, prefix: model.prefix, origin: model.origin, companyName: scope.company?.name ?? '', sites: model.sites, lines: model.lines, teams: model.teams.items ?? [], today: model.today, timeZone: model.timeZone }}
        actions={actions?.dialog}
      />
      {help && <KeysModal own={[...ownKeys, { keys: ['m'], does: t('keys.move') }]} onClose={() => setHelp(false)} />}
    </div>
  )
}
