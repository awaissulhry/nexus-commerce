'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRightLeft, MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Card, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { isListKey, type ListKey } from '../../../../list-frame/model'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { Team } from '../../_shared/api'
import { useWords } from '../../_shared/parts'
import type { EmployeesListActions, EmployeesListModel, MemberRow, Person } from '../view-model'

/**
 * The Teams view of Employees (design people.employees sec:teams, MES-210): lines, teams and leads with today's loans.
 * One card per team (its line, its lead — Set lead —, its members, who is lent out today and who is lent in), side by side
 * on a wide screen; under them every member on the shared list frame, sorted site › line › team, to move people: select
 * → "Move 3 to…" → the review (old → new team and lead per person, conflicts) → Apply. Keys: x selects, m moves.
 */

const personOfMember = (row: MemberRow): Person => ({
  id: row.employeeId,
  name: row.name,
  displayName: row.displayName,
  employeeCode: null,
  siteId: row.team.site.id,
  siteCode: row.team.site.code,
  homeLine: null,
  team: { id: row.team.id, code: row.team.code, name: row.team.name },
  version: 0,
})

/** Every member as a row, sorted site › line › team › lead first › name. */
export function memberRows(teams: readonly Team[]): MemberRow[] {
  const sorted = [...teams].sort((a, b) => a.site.code.localeCompare(b.site.code) || (a.line?.code ?? '~').localeCompare(b.line?.code ?? '~') || a.code.localeCompare(b.code))
  return sorted.flatMap((team) => team.members.map((member) => ({ ...member, rowId: `${team.id}:${member.employeeId}`, team })))
}

function useTeamColumns(model: Pick<EmployeesListModel, 'prefix' | 'timeZone'>): ColDef<MemberRow>[] {
  const t = useWords()
  const locale = useLocale()
  return useMemo<ColDef<MemberRow>[]>(() => {
    const TeamCell = ({ data }: ICellRendererParams<MemberRow>) =>
      data ? (
        <span className="fw-pp-cell">
          <span className="fw-pp-ellipsis">{`${data.team.code} · ${data.team.name}`}</span>
          <span className="fw-pp-sub">{[data.team.site.code, data.team.line ? `${data.team.line.code} · ${data.team.line.name}` : t('line.none')].join(' › ')}</span>
        </span>
      ) : null
    const NameCell = ({ data }: ICellRendererParams<MemberRow>) =>
      data ? (
        <span className="fw-pp-cell">
          <Link className="fw-pp-link fw-pp-ellipsis" href={`${model.prefix}/people/employees/${encodeURIComponent(data.employeeId)}`}>
            {data.name}
          </Link>
          <span className="fw-pp-sub">{data.displayName}</span>
        </span>
      ) : null
    const LoanCell = ({ data }: ICellRendererParams<MemberRow>) =>
      data ? data.onLoan ? <Tag tone="warning">{t('teams.onLoanTo', { line: data.onLoan.toLine.code, time: formatTime(data.onLoan.until, { locale, timeZone: model.timeZone }) })}</Tag> : <span className="fw-pp-sub">—</span> : null
    return [
      { colId: 'team', headerName: t('col.team'), minWidth: 220, flex: 1, cellRenderer: TeamCell },
      { colId: 'name', headerName: t('col.name'), minWidth: 200, flex: 1, cellRenderer: NameCell },
      { colId: 'lead', headerName: t('col.lead'), minWidth: 110, flex: 0.4, cellRenderer: ({ data }: ICellRendererParams<MemberRow>) => (data?.isLead ? <Tag tone="info">{t('team.isLead')}</Tag> : null) },
      { colId: 'loan', headerName: t('col.onLoanToday'), minWidth: 200, flex: 0.8, cellRenderer: LoanCell },
    ]
  }, [t, locale, model.prefix, model.timeZone])
}

export function TeamsPanel({ model, actions, viewSwitch, onHelp }: { model: EmployeesListModel; actions?: EmployeesListActions; viewSwitch: ReactNode; onHelp: () => void }) {
  const t = useWords()
  const locale = useLocale()
  const can = model.can
  const teams = (model.teams.items ?? []).filter((team) => team.status === 'ACTIVE' && (!model.address.lineId || team.line?.id === model.address.lineId) && (!model.address.teamId || team.id === model.address.teamId))
  const rows = useMemo(() => memberRows(teams), [teams])
  const columns = useTeamColumns(model)
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const picked = rows.filter((row) => selected.includes(row.rowId))
  const latest = useRef({ picked, actions, can })
  latest.current = { picked, actions, can }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'm' || !isListKey(event, event.target as HTMLElement | null)) return
      const { picked: now, actions: act, can: rights } = latest.current
      if (now.length === 0 || !rights.manageTeams) return
      event.preventDefault()
      act?.onTeamChange?.(now.map(personOfMember))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const place = { locale, timeZone: model.timeZone }
  const filterLine = model.address.lineId ? (model.lines.find((line) => line.id === model.address.lineId) ?? null) : null
  const filterTeam = model.address.teamId ? ((model.teams.items ?? []).find((team) => team.id === model.address.teamId) ?? null) : null
  const ownKeys: ListKey[] = [
    { keys: ['m'], does: t('keys.move') },
    { keys: ['t'], does: t('keys.teams') },
  ]

  const addButton = (
    <Button size="sm" heldReason={can.manageTeams ? null : t('held.noManageTeams')} onClick={() => actions?.onAddTeam?.()}>
      <Plus size={14} aria-hidden /> {t('teams.add')}
    </Button>
  )

  let body: ReactNode
  if (model.teams.problem) {
    body = <EmptyState title={t('teams.failed')} description={t(model.teams.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  } else if (!model.teams.items) {
    body = (
      <div className="fw-pp-cards" aria-busy="true">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} height={140} />
        ))}
      </div>
    )
  } else if (teams.length === 0) {
    body = <EmptyState title={t('teams.empty')} description={t('teams.emptyBody')} action={can.manageTeams ? addButton : undefined} />
  } else {
    body = (
      <>
        <div className="fw-pp-cards">
          {teams.map((team) => {
            const away = team.members.filter((member) => member.onLoan)
            const empty = team.members.length === 0
            return (
              <Card
                key={team.id}
                padded
                header={`${team.code} · ${team.name}`}
                headingLevel={3}
                headerAction={
                  <Menu
                    label={<MoreHorizontal size={16} aria-hidden />}
                    align="right"
                    triggerProps={{ 'aria-label': t('teams.menu', { team: team.code }) }}
                    items={[
                      { id: 'archive', label: t('teams.archive'), disabled: !can.manageTeams || !empty, description: !can.manageTeams ? t('held.noManageTeams') : !empty ? t('held.teamNotEmpty') : undefined, onSelect: () => actions?.onArchiveTeam?.(team) },
                    ]}
                  />
                }
              >
                <div className="fw-pp-card-body">
                  <span className="fw-pp-chips">
                    <Tag tone="neutral">{team.site.code}</Tag>
                    <Tag tone="neutral">{team.line ? `${team.line.code} · ${team.line.name}` : t('line.none')}</Tag>
                  </span>
                  {can.manageTeams && team.members.length > 0 ? (
                    <label className="fw-pp-row">
                      <span className="fw-pp-hint">{t('teams.lead')}</span>
                      <Select size="sm" aria-label={t('teams.setLead', { team: team.code })} value={team.lead?.employeeId ?? ''} onChange={(event) => actions?.onSetLead?.(team, event.target.value || null)}>
                        <option value="">{t('teams.noLead')}</option>
                        {team.members.map((member) => (
                          <option key={member.employeeId} value={member.employeeId}>
                            {member.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ) : (
                    <p className="fw-pp-text">{t('teams.leadIs', { name: team.lead?.name ?? t('teams.noLead') })}</p>
                  )}
                  <p className="fw-pp-hint">{t('teams.members', { count: team.members.length })}</p>
                  {away.length > 0 && (
                    <p className="fw-pp-hint fw-pp-warning">
                      {t('teams.awaySummary', { count: away.length, line: away[0]!.onLoan!.toLine.code, time: formatTime(away[0]!.onLoan!.until, place) })}
                    </p>
                  )}
                  {team.loansIn.length > 0 && (
                    <ul className="fw-pp-plain">
                      {team.loansIn.map((loan) => (
                        <li key={loan.loanId} className="fw-pp-hint">
                          {t('teams.loanIn', { name: loan.name, line: loan.fromLine?.code ?? t('line.none'), time: formatTime(loan.until, place) })}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
        <ListFrame<MemberRow>
          label={t('teams.tableLabel')}
          listKey="people.employees.teams"
          rows={rows}
          rowId={(row) => row.rowId}
          columns={columns}
          count={t('teams.count', { count: rows.length })}
          tools={<ScopeSiteChip model={model.scope} />}
          selection={
            can.manageTeams
              ? {
                  selected,
                  onChange: setSelected,
                  actions: (
                    <Button size="sm" aria-label={t('teams.moveCount', { count: picked.length })} aria-keyshortcuts="m" onClick={() => actions?.onTeamChange?.(picked.map(personOfMember))}>
                      <ArrowRightLeft size={13} aria-hidden /> <SelectionLabel>{t('teams.moveCount', { count: picked.length })}</SelectionLabel>
                    </Button>
                  ),
                }
              : undefined
          }
          keys={ownKeys}
          onHelp={onHelp}
          onOpen={(row) => actions?.onOpen?.(row.employeeId)}
          cards={{ hrefOf: (row) => `${model.prefix}/people/employees/${encodeURIComponent(row.employeeId)}` }}
          state={rows.length === 0 ? <EmptyState title={t('teams.noMembers')} description={t('teams.noMembersBody')} /> : undefined}
        />
      </>
    )
  }

  return (
    <section className="fw-pp-stack" aria-label={t('teams.title')}>
      <div className="fw-pp-head">
        <span className="fw-pp-actions">
          {viewSwitch}
          {filterLine && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onView?.('teams')} aria-label={t('teams.clearLine', { line: filterLine.code })}>
              <Tag tone="info">{`${filterLine.code} · ${filterLine.name} ✕`}</Tag>
            </Button>
          )}
          {filterTeam && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onView?.('teams')} aria-label={t('teams.clearTeam', { team: filterTeam.code })}>
              <Tag tone="info">{`${filterTeam.code} · ${filterTeam.name} ✕`}</Tag>
            </Button>
          )}
        </span>
        <span className="fw-pp-actions">
          <p className="fw-pp-hint">{t('teams.linesFrom')}</p>
          {addButton}
        </span>
      </div>
      {body}
    </section>
  )
}

/** A lead with My team only: their own teams' members, read only, said as a scope note (design noPermission). */
export function TeamOnlyList({ model }: { model: EmployeesListModel }) {
  const t = useWords()
  const teams = model.teamOnly?.teams ?? []
  const rows = useMemo(() => memberRows(teams), [teams])
  const columns = useTeamColumns(model)
  if (teams.length === 0) return <EmptyState title={t('teamOnly.none')} description={t('teamOnly.noneBody')} />
  return (
    <>
      <Banner tone="info" title={t('teamOnly.note', { count: rows.length })} />
      <ListFrame<MemberRow> label={t('teams.tableLabel')} listKey={null} rows={rows} rowId={(row) => row.rowId} columns={columns} count={t('teams.count', { count: rows.length })} cards={{}} />
    </>
  )
}
