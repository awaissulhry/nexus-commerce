'use client'

import { useMemo } from 'react'
import { MoreHorizontal, UserMinus, UserPlus, Users } from 'lucide-react'
// F-CP-153: the team's other acts (pause, give back, add to a project).
import { FolderPlus, PauseCircle, PlayCircle } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { useT } from '../../../../lib/i18n/provider'
import { colleagueHeld, STATUS_TONE, type ColleagueRow } from '../model'
import { teamActHeld, type TeamAct, type TeamFacts } from '../model' // F-CP-153
import { AccountCard, type CardState } from './AccountCard'

/**
 * The organisation's colleagues on the shared list frame (lifted from the customer's Account, B-W2b-196, by B-W2b-193 for
 * the supplier's Profile; SAL-059, SAL-060, SAL-069, SCM-092; Owner rule 2026-10-29: select-all, shift range, x / Space,
 * bulk actions while rows are selected, the keys in the footer's one icon; cards on a phone): name · e-mail · role
 * (· sees prices, for a customer) · last sign-in · status. The admin invites, changes a role (⋯), deactivates (⋯, or
 * Deactivate N); everyone else reads names and roles and "Your admin is …". A supplier or workshop never sees a price
 * (C2): `prices` false leaves the column out.
 *
 * F-CP-153 (customer page plan C6, D13; review G2, F4): "Your team" — a customer's admin also sends an invitation again or
 * withdraws it, pauses access or gives it back (held while every seat is taken), and adds colleagues to one of its own projects;
 * every act sends the row's version. Bulk: Pause · Give access back · Add to a project · Deactivate (who is left out is said
 * first). The Projects column names only the reader's own projects (customers only). A supplier's or workshop's admin shares this
 * one section: the customer's acts show held with why, never hidden.
 */

export interface ColleaguesModel {
  state: CardState
  rows: readonly (ColleagueRow & { lastSignIn: string | null; invitationEnds: string | null })[]
  canManage: boolean
  /** "Your admin is …" (non-admins), the names. */
  admins: readonly string[]
  seats: { taken: number; max: number | null } | null
  selected: readonly string[]
  readOnly: boolean
  // ---- F-CP-153
  /** The organisation is a customer: its admin's own acts (else held, review F4). */
  customer?: boolean
  /** Every seat is taken: Give access back is held. */
  seatsFull?: boolean
  /** How many projects the reader is in (Add to a project needs one). */
  projectCount?: number
  /** The Projects column (the reader's own projects each colleague is in); null: no column (not a customer's admin). */
  projects?: Readonly<Record<string, readonly string[]>> | null
  // ---- end F-CP-153
}

export interface ColleaguesActions {
  onSelected?: (ids: string[]) => void
  onInvite?: () => void
  onChangeRole?: (row: ColleagueRow) => void
  onDeactivate?: (rows: readonly ColleagueRow[]) => void
  onRetry?: () => void
  onHelp?: () => void
  // ---- F-CP-153
  onResend?: (row: ColleagueRow) => void
  onRevoke?: (row: ColleagueRow) => void
  onPause?: (rows: readonly ColleagueRow[]) => void
  onGiveBack?: (rows: readonly ColleagueRow[]) => void
  onAddToProject?: (rows: readonly ColleagueRow[]) => void
  // ---- end F-CP-153
}

type ColleagueLine = ColleaguesModel['rows'][number]

export function ColleaguesSection({ model, slow, actions, inviteHeld, prices = true, title, hint }: { model: ColleaguesModel; slow?: boolean; actions?: ColleaguesActions | undefined; inviteHeld: string | null; prices?: boolean; title?: string; hint?: string }) {
  const t = useT('portal-account')
  const roles = useT('portal')
  const roleOf = (row: ColleagueRow) => (row.roleKey ? roles(`role.${row.roleKey}`) : (row.roleName ?? '—'))
  const manage = model.canManage && !model.readOnly
  // F-CP-153: what holds each act for a row (a customer's own acts, the seats, the projects, a preview).
  const facts: TeamFacts = { customer: model.customer ?? false, seatsFull: model.seatsFull ?? false, projects: model.projectCount ?? 0, readOnly: model.readOnly }
  const projects = model.projects ?? null
  const columns = useMemo<ColDef<ColleagueLine>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<ColleagueLine>) =>
      data ? (
        <span className="fw-pacc-cell">
          <span className="fw-pacc-strong">{data.name}</span>
          {data.you ? <Pill tone="info">{t('users.you')}</Pill> : null}
          {data.admin ? <Pill tone="neutral">{t('users.admin')}</Pill> : null}
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<ColleagueLine>) =>
      data ? (
        <span className="fw-pacc-cell">
          <Pill tone={STATUS_TONE[data.status]}>{t(`users.status.${data.status}`)}</Pill>
          {data.status === 'INVITED' && data.invitationEnds ? <span className="fw-pacc-muted">{t('users.invitationEnds', { date: data.invitationEnds })}</span> : null}
        </span>
      ) : null
    const PricesCell = ({ data }: ICellRendererParams<ColleagueLine>) => (data ? <span>{t(data.seesPrices ? 'users.prices.yes' : 'users.prices.no')}</span> : null)
    // F-CP-153: every act of the row, each held with why (never hidden); the row's version goes with each.
    const ACT_LABEL: Readonly<Record<TeamAct, string>> = { role: t('users.changeRole'), resend: t('team.act.resend'), revoke: t('team.act.revoke'), pause: t('team.act.pause'), giveBack: t('team.act.giveBack'), addToProject: t('team.act.addToProject'), deactivate: t('users.deactivate') }
    const run = (act: TeamAct, row: ColleagueLine) => {
      if (act === 'role') actions?.onChangeRole?.(row)
      else if (act === 'resend') actions?.onResend?.(row)
      else if (act === 'revoke') actions?.onRevoke?.(row)
      else if (act === 'pause') actions?.onPause?.([row])
      else if (act === 'giveBack') actions?.onGiveBack?.([row])
      else if (act === 'addToProject') actions?.onAddToProject?.([row])
      else actions?.onDeactivate?.([row])
    }
    const MoreCell = ({ data }: ICellRendererParams<ColleagueLine>) => {
      if (!data) return null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('users.rowMenu', { name: data.name }) }}
          items={(['role', 'resend', 'revoke', 'pause', 'giveBack', 'addToProject', 'deactivate'] as const).map((act) => {
            const held = teamActHeld(act, data, facts)
            const words = held ? (held === 'team.seatsFull' ? t(held, { max: model.seats?.max ?? 0 }) : t(held)) : null
            return { id: act, label: ACT_LABEL[act], ...(act === 'deactivate' ? { tone: 'danger' as const } : {}), disabled: words !== null, ...(words ? { description: words } : {}), onSelect: () => run(act, data) }
          })}
        />
      )
    }
    const ProjectsCell = ({ data }: ICellRendererParams<ColleagueLine>) => (data ? <span className="fw-pacc-muted">{(projects?.[data.id] ?? []).join(', ') || '—'}</span> : null)
    const list: ColDef<ColleagueLine>[] = [
      { colId: 'name', headerName: t('users.col.name'), minWidth: 200, flex: 1.4, valueGetter: (params) => params.data?.name ?? '', cellRenderer: NameCell },
    ]
    if (manage) list.push({ colId: 'email', headerName: t('users.col.email'), minWidth: 200, flex: 1.4, valueGetter: (params) => params.data?.email ?? '—' })
    list.push({ colId: 'role', headerName: t('users.col.role'), minWidth: 130, flex: 0.9, valueGetter: (params) => (params.data ? roleOf(params.data) : '') })
    if (prices) list.push({ colId: 'prices', headerName: t('users.col.prices'), minWidth: 120, flex: 0.6, valueGetter: (params) => (params.data ? t(params.data.seesPrices ? 'users.prices.yes' : 'users.prices.no') : ''), cellRenderer: PricesCell })
    if (manage) list.push({ colId: 'lastSignIn', headerName: t('users.col.lastSignIn'), minWidth: 150, flex: 0.8, valueGetter: (params) => params.data?.lastSignIn ?? t('users.never') })
    list.push({ colId: 'status', headerName: t('users.col.status'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data ? t(`users.status.${params.data.status}`) : ''), cellRenderer: StatusCell })
    // F-CP-153: the reader's own projects each colleague is in (a customer's admin only; no column otherwise).
    if (projects) list.push({ colId: 'projects', headerName: t('team.col.projects'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? (projects[params.data.id] ?? []).join(', ') : ''), cellRenderer: ProjectsCell })
    if (manage) list.push({ colId: 'more', headerName: t('users.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell })
    return list
    // roleOf reads `roles` only.
  }, [t, roles, manage, actions, prices, facts.customer, facts.seatsFull, facts.projects, facts.readOnly, projects, model.seats?.max])
  const picked = model.rows.filter((row) => model.selected.includes(row.id))
  const onlyYou = model.state === 'ready' && model.rows.length === 1 && model.rows[0]?.you === true
  const state = onlyYou ? (
    <EmptyState
      icon={<Users size={22} aria-hidden />}
      title={t('users.onlyYou')}
      description={manage ? (hint ?? t('users.onlyYouHint')) : undefined}
      action={
        manage ? (
          <Button size="sm" variant="primary" heldReason={inviteHeld} onClick={() => actions?.onInvite?.()}>
            <UserPlus size={14} aria-hidden /> {t('users.invite')}
          </Button>
        ) : undefined
      }
    />
  ) : undefined
  const seats = model.seats ? (model.seats.max === null ? t('users.seatsOpen', { count: model.seats.taken }) : t('users.seats', { taken: model.seats.taken, max: model.seats.max })) : null
  return (
    <AccountCard
      id="users"
      title={title ?? t('team.title') /* F-CP-153: Account's users section is "Your team" */}
      description={manage ? t('users.subtitleAdmin') : model.admins.length > 0 ? t('users.yourAdmin', { names: model.admins.join(', ') }) : t('users.subtitle')}
      state={model.state}
      slow={slow}
      failed={t('users.failed')}
      onRetry={actions?.onRetry}
      action={
        manage ? (
          <Button size="sm" heldReason={inviteHeld} onClick={() => actions?.onInvite?.()}>
            <UserPlus size={14} aria-hidden /> {t('users.invite')}
          </Button>
        ) : undefined
      }
    >
      <ListFrame<ColleagueLine>
        label={title ?? t('team.title')}
        listKey={null}
        rows={model.rows}
        rowId={(row) => row.id}
        columns={columns}
        count={seats ? `${t('users.count', { count: model.rows.length })} · ${seats}` : t('users.count', { count: model.rows.length })}
        {...(manage
          ? {
              selection: {
                selected: model.selected,
                onChange: (ids: string[]) => actions?.onSelected?.(ids),
                actions: (
                  <>
                    {/* F-CP-153: Pause · Give access back · Add to a project · Deactivate — who is left out is said in the next step. */}
                    <Button size="sm" variant="secondary" aria-label={t('team.bulk.pause', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : !facts.customer ? t('team.held.customersOnly') : null} onClick={() => actions?.onPause?.(picked)}>
                      <PauseCircle size={13} aria-hidden /> <SelectionLabel>{t('team.bulk.pause', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" variant="secondary" aria-label={t('team.bulk.giveBack', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : !facts.customer ? t('team.held.customersOnly') : null} onClick={() => actions?.onGiveBack?.(picked)}>
                      <PlayCircle size={13} aria-hidden /> <SelectionLabel>{t('team.bulk.giveBack', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" variant="secondary" aria-label={t('team.act.addToProject')} heldReason={picked.length === 0 ? t('held.noneChosen') : !facts.customer ? t('team.held.customersOnly') : facts.projects === 0 ? t('team.held.noProjects') : null} onClick={() => actions?.onAddToProject?.(picked)}>
                      <FolderPlus size={13} aria-hidden /> <SelectionLabel>{t('team.act.addToProject')}</SelectionLabel>
                    </Button>
                    <Button size="sm" variant="danger-outline" aria-label={t('users.deactivateN', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : null} onClick={() => actions?.onDeactivate?.(picked)}>
                      <UserMinus size={13} aria-hidden /> <SelectionLabel>{t('users.deactivateN', { count: picked.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              },
              isRowSelectable: (row: ColleagueLine) => {
                const held = colleagueHeld(row)
                return held ? t(held) : null
              },
            }
          : {})}
        onHelp={actions?.onHelp}
        state={state}
        cards={{ fields: { name: { role: 'title' }, role: { role: 'subtitle' } } }}
      />
    </AccountCard>
  )
}
