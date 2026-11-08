'use client'

import { useMemo } from 'react'
import { Archive, MapPin, MoreHorizontal, Plus, UserMinus, UserPlus, Users } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { useT } from '../../../../lib/i18n/provider'
import { colleagueHeld, defaultHeld, removeHeld, STATUS_TONE, type AddressRow, type ColleagueRow } from '../model'
import { AccountCard, type CardState } from './AccountCards'

/**
 * SCR-188's two lists on the shared list frame (Owner rule 2026-10-29: select-all, shift range, x / Space, bulk actions while
 * rows are selected, the keys in the footer's one icon; cards on a phone):
 *  - Colleagues (sec:users; SAL-059, SAL-060, SAL-069): name · e-mail · role · sees prices · last sign-in · status. The admin
 *    invites (the band's primary), changes a role (⋯), deactivates (⋯, or Deactivate N); everyone else reads names and roles
 *    and "Your admin is …". Roles the factory does not allow for this account are never offered.
 *  - Delivery addresses (sec:addresses; SAL-079): name, address, contact, the default mark, our check (approved, waiting for
 *    our check, not accepted with the reason). The admin adds one (it waits for our check), makes one the default (only a
 *    checked one), removes one or several. A waiting or refused address is never offered for an order.
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
}

export interface ColleaguesActions {
  onSelected?: (ids: string[]) => void
  onInvite?: () => void
  onChangeRole?: (row: ColleagueRow) => void
  onDeactivate?: (rows: readonly ColleagueRow[]) => void
  onRetry?: () => void
  onHelp?: () => void
}

type ColleagueLine = ColleaguesModel['rows'][number]

export function ColleaguesSection({ model, slow, actions, inviteHeld }: { model: ColleaguesModel; slow?: boolean; actions?: ColleaguesActions; inviteHeld: string | null }) {
  const t = useT('portal-account')
  const roles = useT('portal')
  const roleOf = (row: ColleagueRow) => (row.roleKey ? roles(`role.${row.roleKey}`) : (row.roleName ?? '—'))
  const manage = model.canManage && !model.readOnly
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
    const MoreCell = ({ data }: ICellRendererParams<ColleagueLine>) => {
      if (!data) return null
      const held = data.you ? t('held.yourself') : null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('users.rowMenu', { name: data.name }) }}
          items={[
            { id: 'role', label: t('users.changeRole'), disabled: held !== null || data.status === 'DEACTIVATED', ...(held ? { description: held } : {}), onSelect: () => actions?.onChangeRole?.(data) },
            { id: 'deactivate', label: t('users.deactivate'), tone: 'danger', disabled: held !== null, ...(held ? { description: held } : {}), onSelect: () => actions?.onDeactivate?.([data]) },
          ]}
        />
      )
    }
    const list: ColDef<ColleagueLine>[] = [
      { colId: 'name', headerName: t('users.col.name'), minWidth: 200, flex: 1.4, valueGetter: (params) => params.data?.name ?? '', cellRenderer: NameCell },
    ]
    if (manage) list.push({ colId: 'email', headerName: t('users.col.email'), minWidth: 200, flex: 1.4, valueGetter: (params) => params.data?.email ?? '—' })
    list.push(
      { colId: 'role', headerName: t('users.col.role'), minWidth: 130, flex: 0.9, valueGetter: (params) => (params.data ? roleOf(params.data) : '') },
      { colId: 'prices', headerName: t('users.col.prices'), minWidth: 120, flex: 0.6, valueGetter: (params) => (params.data ? t(params.data.seesPrices ? 'users.prices.yes' : 'users.prices.no') : ''), cellRenderer: PricesCell },
    )
    if (manage) list.push({ colId: 'lastSignIn', headerName: t('users.col.lastSignIn'), minWidth: 150, flex: 0.8, valueGetter: (params) => params.data?.lastSignIn ?? t('users.never') })
    list.push({ colId: 'status', headerName: t('users.col.status'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data ? t(`users.status.${params.data.status}`) : ''), cellRenderer: StatusCell })
    if (manage) list.push({ colId: 'more', headerName: t('users.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell })
    return list
    // roleOf reads `roles` only.
  }, [t, roles, manage, actions])
  const picked = model.rows.filter((row) => model.selected.includes(row.id))
  const onlyYou = model.state === 'ready' && model.rows.length === 1 && model.rows[0]?.you === true
  const state = onlyYou ? (
    <EmptyState
      icon={<Users size={22} aria-hidden />}
      title={t('users.onlyYou')}
      description={manage ? t('users.onlyYouHint') : undefined}
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
      title={t('users.title')}
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
        label={t('users.tableLabel')}
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
                  <Button size="sm" variant="danger-outline" aria-label={t('users.deactivateN', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : null} onClick={() => actions?.onDeactivate?.(picked)}>
                    <UserMinus size={13} aria-hidden /> <SelectionLabel>{t('users.deactivateN', { count: picked.length })}</SelectionLabel>
                  </Button>
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

// ── Delivery addresses ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface AddressesModel {
  state: CardState
  rows: readonly (AddressRow & { addedWords: string; checkedWords: string | null })[]
  canManage: boolean
  selected: readonly string[]
  readOnly: boolean
  /** An address opened from a notification (`?address=`): its row is marked. */
  focusId?: string | null
}

export interface AddressesActions {
  onSelected?: (ids: string[]) => void
  onAdd?: () => void
  onDefault?: (row: AddressRow) => void
  onRemove?: (rows: readonly AddressRow[]) => void
  onRetry?: () => void
  onHelp?: () => void
}

type AddressLine = AddressesModel['rows'][number]

export function AddressesSection({ model, slow, actions }: { model: AddressesModel; slow?: boolean; actions?: AddressesActions }) {
  const t = useT('portal-account')
  const manage = model.canManage && !model.readOnly
  const columns = useMemo<ColDef<AddressLine>[]>(() => {
    const AddressCell = ({ data }: ICellRendererParams<AddressLine>) =>
      data ? (
        <span className="fw-pacc-cell fw-pacc-cell-stack">
          <span className="fw-pacc-strong">
            {data.name ?? data.line}
            {data.isDefault ? (
              <>
                {' '}
                <Pill tone="info">{t('addresses.default')}</Pill>
              </>
            ) : null}
          </span>
          {data.name ? <span className="fw-pacc-muted">{data.line}</span> : null}
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<AddressLine>) =>
      data ? (
        <span className="fw-pacc-cell fw-pacc-cell-stack">
          <Pill tone={data.tone}>{t(`addresses.state.${data.state}`)}</Pill>
          {data.reason ? <span className="fw-pacc-muted">{t('addresses.reason', { reason: data.reason })}</span> : data.checkedWords ? <span className="fw-pacc-muted">{data.checkedWords}</span> : null}
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<AddressLine>) => {
      if (!data) return null
      const asDefault = defaultHeld(data)
      const remove = removeHeld(data)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('addresses.rowMenu', { name: data.name ?? data.line }) }}
          items={[
            { id: 'default', label: t('addresses.makeDefault'), disabled: asDefault !== null, ...(asDefault ? { description: t(asDefault) } : {}), onSelect: () => actions?.onDefault?.(data) },
            { id: 'remove', label: t('addresses.remove'), tone: 'danger', disabled: remove !== null, ...(remove ? { description: t(remove) } : {}), onSelect: () => actions?.onRemove?.([data]) },
          ]}
        />
      )
    }
    const list: ColDef<AddressLine>[] = [
      { colId: 'address', headerName: t('addresses.col.address'), minWidth: 260, flex: 2, valueGetter: (params) => (params.data ? [params.data.name, params.data.line].filter(Boolean).join(' — ') : ''), cellRenderer: AddressCell, autoHeight: true },
      { colId: 'contact', headerName: t('addresses.col.contact'), minWidth: 160, flex: 1, valueGetter: (params) => params.data?.contact ?? '—' },
      { colId: 'status', headerName: t('addresses.col.status'), minWidth: 200, flex: 1.2, valueGetter: (params) => (params.data ? t(`addresses.state.${params.data.state}`) : ''), cellRenderer: StatusCell, autoHeight: true },
      { colId: 'added', headerName: t('addresses.col.added'), minWidth: 150, flex: 0.9, valueGetter: (params) => params.data?.addedWords ?? '' },
    ]
    if (manage) list.push({ colId: 'more', headerName: t('addresses.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell })
    return list
  }, [t, manage, actions])
  const picked = model.rows.filter((row) => model.selected.includes(row.id))
  const empty =
    model.state === 'ready' && model.rows.length === 0 ? (
      <EmptyState
        icon={<MapPin size={22} aria-hidden />}
        title={t('addresses.empty')}
        description={manage ? t('addresses.emptyHint') : undefined}
        action={
          manage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onAdd?.()}>
              <Plus size={14} aria-hidden /> {t('addresses.add')}
            </Button>
          ) : undefined
        }
      />
    ) : undefined
  const waiting = model.rows.filter((row) => row.state === 'WAITING').length
  return (
    <AccountCard
      id="addresses"
      title={t('addresses.title')}
      description={manage ? t('addresses.subtitleAdmin') : t('addresses.subtitle')}
      state={model.state}
      slow={slow}
      failed={t('addresses.failed')}
      onRetry={actions?.onRetry}
      action={
        manage ? (
          <Button size="sm" onClick={() => actions?.onAdd?.()}>
            <Plus size={14} aria-hidden /> {t('addresses.add')}
          </Button>
        ) : undefined
      }
    >
      <ListFrame<AddressLine>
        label={t('addresses.tableLabel')}
        listKey={null}
        rows={model.rows}
        rowId={(row) => row.id}
        columns={columns}
        count={waiting > 0 ? `${t('addresses.count', { count: model.rows.length })} · ${t('addresses.waitingCount', { count: waiting })}` : t('addresses.count', { count: model.rows.length })}
        {...(manage
          ? {
              selection: {
                selected: model.selected,
                onChange: (ids: string[]) => actions?.onSelected?.(ids),
                actions: (
                  <Button size="sm" variant="danger-outline" aria-label={t('addresses.removeN', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : null} onClick={() => actions?.onRemove?.(picked)}>
                    <Archive size={13} aria-hidden /> <SelectionLabel>{t('addresses.removeN', { count: picked.length })}</SelectionLabel>
                  </Button>
                ),
              },
              isRowSelectable: (row: AddressLine) => {
                const held = removeHeld(row)
                return held ? t(held) : null
              },
            }
          : {})}
        onHelp={actions?.onHelp}
        {...(model.focusId ? { focusRow: Math.max(0, model.rows.findIndex((row) => row.id === model.focusId)) } : {})}
        state={empty}
        cards={{ fields: { address: { role: 'title' }, status: { role: 'subtitle' } } }}
      />
    </AccountCard>
  )
}
