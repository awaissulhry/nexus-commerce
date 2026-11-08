'use client'

import { Fragment, useMemo, type ReactElement } from 'react'
import { MoreHorizontal, PauseCircle, PlayCircle, Send, UserPlus, UserX, Users } from 'lucide-react'
import { Card, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { PartnerPerson } from '../../../../admin/users/partners/api'
import { accessEnded, endsSoon, inviteHeld, peopleRows, personReach, rowHeld, seatsLeft, STATUS_TONE, type RowAction } from '../../../../admin/users/partners/model'
import { showsPrices, type PortalAccessActions, type PortalAccessModel } from '../model'
import { heldWords, usePortalT } from './parts'

const BULK: ReadonlyArray<{ action: RowAction; icon: ReactElement; tone?: 'danger-outline' }> = [
  { action: 'resend', icon: <Send size={13} aria-hidden /> },
  { action: 'suspend', icon: <PauseCircle size={13} aria-hidden />, tone: 'danger-outline' },
  { action: 'reactivate', icon: <PlayCircle size={13} aria-hidden /> },
  { action: 'deactivate', icon: <UserX size={13} aria-hidden />, tone: 'danger-outline' },
]

/**
 * People with access (design customer.portal.users / Supplier portal.access): who may sign in, their role and what they may
 * also do, whether they see prices (customers; never a supplier or a workshop: one line says so), the end of access, the
 * last sign-in and the state — on the shared list frame (select-all, shift range, x / Space, bulk actions while rows are
 * selected; the keys in the footer's one icon; cards on a phone). ⋯ per row: change the access, the invitation again or
 * revoked, suspend, reactivate, deactivate. Each action says why it is held.
 */
export function PeopleCard({ model, actions }: { model: PortalAccessModel; actions?: PortalAccessActions }) {
  const t = usePortalT()
  const locale = useLocale()
  const access = model.access!
  const now = useMemo(() => new Date(model.now), [model.now])
  const prices = showsPrices(access)
  const rows = peopleRows(access.people, model.showLeft)
  const selected = rows.filter((row) => model.selected.includes(row.id))
  const invite = heldWords(t, inviteHeld(access, model.can))
  const roleOf = (person: PartnerPerson) => (person.roleKey ? t(`role.${person.roleKey}`) : t('people.noRole'))
  const open = (action: RowAction, people: readonly PartnerPerson[]) => actions?.onDialog?.({ kind: 'confirm', action, userIds: people.map((person) => person.id) })

  const columns = useMemo<ColDef<PartnerPerson>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<PartnerPerson>) =>
      data ? (
        <span className="fw-pa-cell">
          <span className="fw-pa-strong">{data.displayName}</span>
          {data.admin ? <Pill tone="neutral">{t('people.admin')}</Pill> : null}
        </span>
      ) : null
    const RoleCell = ({ data }: ICellRendererParams<PartnerPerson>) =>
      data ? (
        <span className="fw-pa-cell">
          <span>{roleOf(data)}</span>
          {data.capabilities.map((capability) => (
            <Tag key={capability} tone="neutral">
              {t(`capability.${capability}`)}
            </Tag>
          ))}
        </span>
      ) : null
    const EndCell = ({ data }: ICellRendererParams<PartnerPerson>) =>
      data ? (
        data.accessUntil ? (
          <span className="fw-pa-cell">
            <span>{formatDate(data.accessUntil, { locale })}</span>
            {accessEnded(data.accessUntil, now) ? <Tag tone="danger">{t('people.ended')}</Tag> : endsSoon(data.accessUntil, now) && data.status !== 'DEACTIVATED' ? <Tag tone="warning">{t('people.endsSoon')}</Tag> : null}
          </span>
        ) : (
          <span className="fw-pa-muted">{t('people.noEnd')}</span>
        )
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<PartnerPerson>) =>
      data ? (
        <span className="fw-pa-cell">
          <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill>
          {data.status === 'INVITED' ? <span className="fw-pa-muted">{data.invitation ? t('people.invitationEnds', { date: formatDate(data.invitation.expiresAt, { locale }) }) : t('people.invitationExpired')}</span> : null}
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<PartnerPerson>) => {
      if (!data) return null
      const reach = (action: RowAction) => personReach(action, [data], model.can)
      const item = (id: RowAction, tone?: 'danger') => {
        const held = heldWords(t, reach(id).held)
        return { id, label: t(`row.${id}`), ...(tone ? { tone } : {}), disabled: held !== null, ...(held ? { description: held } : {}), onSelect: () => open(id, [data]) }
      }
      const changeHeld = !model.can.manage ? heldWords(t, 'right.manage') : data.status === 'DEACTIVATED' ? t('held.left') : null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('people.rowMenu', { name: data.displayName }) }}
          items={[
            { id: 'change', label: t('row.change'), disabled: changeHeld !== null, ...(changeHeld ? { description: changeHeld } : {}), onSelect: () => actions?.onDialog?.({ kind: 'person', userId: data.id }) },
            ...(data.status === 'INVITED' ? [item('resend'), item('revoke', 'danger')] : []),
            ...(data.status === 'ACTIVE' ? [item('suspend')] : []),
            ...(data.status === 'SUSPENDED' ? [item('reactivate')] : []),
            ...(data.status === 'ACTIVE' || data.status === 'SUSPENDED' ? [item('deactivate', 'danger')] : []),
          ]}
        />
      )
    }
    const list: ColDef<PartnerPerson>[] = [
      { colId: 'name', headerName: t('people.col.name'), minWidth: 190, flex: 1.3, valueGetter: (params) => params.data?.displayName ?? '', cellRenderer: NameCell },
      { colId: 'email', headerName: t('people.col.email'), minWidth: 200, flex: 1.3, valueGetter: (params) => params.data?.email ?? '' },
      { colId: 'role', headerName: t('people.col.role'), minWidth: 170, flex: 1.2, valueGetter: (params) => (params.data ? roleOf(params.data) : ''), cellRenderer: RoleCell },
    ]
    if (prices) list.push({ colId: 'prices', headerName: t('people.col.prices'), minWidth: 110, flex: 0.6, valueGetter: (params) => (params.data ? t(params.data.seesPrices ? 'people.prices.yes' : 'people.prices.no') : '') })
    list.push(
      { colId: 'until', headerName: t('people.col.until'), minWidth: 150, flex: 0.9, valueGetter: (params) => params.data?.accessUntil ?? '', cellRenderer: EndCell },
      { colId: 'lastSignIn', headerName: t('people.col.lastSignIn'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data?.lastSignInAt ? formatDateTime(params.data.lastSignInAt, { locale }) : t('people.never')) },
      { colId: 'status', headerName: t('people.col.status'), minWidth: 170, flex: 1, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: StatusCell },
      { colId: 'more', headerName: t('people.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    )
    return list
    // roleOf and open read only `t` and `actions`.
  }, [t, locale, now, prices, model.can, actions])

  const left = seatsLeft(access.seats)
  const seats = access.seats.max === null ? t('people.seatsOpen', { count: access.seats.taken }) : t('people.seats', { taken: access.seats.taken, max: access.seats.max })
  const empty =
    rows.length === 0 && !model.showLeft ? (
      <EmptyState
        icon={<Users size={22} aria-hidden />}
        title={t(`people.empty.${model.side}`)}
        description={t(`people.emptyHint.${model.side}`)}
        action={
          <Button size="sm" variant="primary" heldReason={invite} onClick={() => actions?.onDialog?.({ kind: 'invite' })}>
            <UserPlus size={14} aria-hidden /> {t('people.invite')}
          </Button>
        }
      />
    ) : undefined

  return (
    <Card padded>
      <div className="fw-pa-head">
        <div className="fw-pa-head-text">
          <h2 className="fw-pa-h2">{t('people.title')}</h2>
          <p className="fw-pa-hint">{t(`people.intro.${model.side}`)}</p>
          {!prices && <p className="fw-pa-hint">{t('people.noPricesLine')}</p>}
        </div>
        <div className="fw-pa-actions">
          <Button size="sm" variant="primary" heldReason={invite} onClick={() => actions?.onDialog?.({ kind: 'invite' })}>
            <UserPlus size={14} aria-hidden /> {t('people.invite')}
          </Button>
        </div>
      </div>
      <ListFrame<PartnerPerson>
        label={t('people.tableLabel')}
        listKey={null}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={`${t('people.count', { count: rows.length })} · ${seats}${left === 0 ? ` · ${t('people.full')}` : ''}`}
        tools={<Checkbox checked={model.showLeft} onChange={(event) => actions?.onShowLeft?.(event.target.checked)} label={t('people.showLeft')} />}
        selection={{
          selected: selected.map((row) => row.id),
          onChange: (ids: string[]) => actions?.onSelected?.(ids),
          actions: (
            <>
              {BULK.map(({ action, icon, tone }) => {
                const reach = personReach(action, selected, model.can)
                const held = heldWords(t, reach.held)
                return (
                  <Fragment key={action}>
                    <Button size="sm" variant={tone ?? 'secondary'} heldReason={held} onClick={() => open(action, reach.items)} aria-label={t(`bulk.${action}`, { count: reach.items.length })}>
                      {icon} <SelectionLabel>{held ? t(`row.${action}`) : t(`bulk.${action}`, { count: reach.items.length })}</SelectionLabel>
                    </Button>
                  </Fragment>
                )
              })}
            </>
          ),
        }}
        isRowSelectable={(row: PartnerPerson) => {
          const held = rowHeld(row)
          return held ? t(held) : null
        }}
        onOpen={(row) => (model.can.manage && row.status !== 'DEACTIVATED' ? actions?.onDialog?.({ kind: 'person', userId: row.id }) : undefined)}
        state={empty}
        cards={{ fields: { name: { role: 'title' }, role: { role: 'subtitle' } } }}
      />
    </Card>
  )
}
