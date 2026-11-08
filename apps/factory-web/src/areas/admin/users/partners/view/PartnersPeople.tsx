'use client'

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { PauseCircle, PlayCircle, Users, UserX } from 'lucide-react'
import { EmptyState, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { ConfirmBox } from '../../../../sales/customers/portal/view/ConfirmBox'
import { heldWords, NoticeLine, PortalAccessMessages, usePortalT } from '../../../../sales/customers/portal/view/parts'
import type { User } from '../../../shared/api'
import { shownOf, type Loaded } from '../../../shared/model'
import { namesLine } from '../../../shared/reach'
import { PERSON_ACTIONS, type Organisations, type PersonAction } from '../api'
import { accessEnded, endsSoon, organisationHref, PARTNER_TILES, partnerTileCounts, partnerUserReach, partnerUserRows, STATUS_TONE, type PartnerCan, type PartnerTile, type PartnerUserRow } from '../model'
import type { PortalNotice } from '../../../../sales/customers/portal/model'

export interface PartnersAudienceModel {
  /** `/w/<company>` */
  prefix: string
  /** The partner people (GET /auth/users, audience PARTNER). */
  users: Loaded<User>
  /** GET /partners: the organisations and the counts ("Partners (n)", "Access ends soon"). */
  organisations: { value: Organisations | null; problem: string | null }
  tile: PartnerTile | null
  query: string
  pages: number
  /** Now (ISO): "ends soon". */
  now: string
  can: PartnerCan
  selected?: readonly string[]
  /** The bulk confirm open (its action). */
  bulk?: PersonAction | null
  busy?: boolean
  dialogProblem?: string | null
  notice?: PortalNotice | null
}

export interface PartnersAudienceActions {
  onTile?: (tile: PartnerTile | null) => void
  onMore?: () => void
  onRetry?: () => void
  onOpen?: (href: string) => void
  onSelected?: (ids: string[]) => void
  onBulk?: (action: PersonAction | null) => void
  /** One call per person through the partner routes; resolves true when the run finished (its notice says how). */
  onRun?: (action: PersonAction, users: readonly User[], reason: string) => Promise<boolean>
  onDismissNotice?: () => void
}

const ICONS = { suspend: <PauseCircle size={13} aria-hidden />, reactivate: <PlayCircle size={13} aria-hidden />, deactivate: <UserX size={13} aria-hidden /> } as const

/** "Partners (n)" in the audience line: the people of every partner organisation the person may see, once read. */
export const partnersCount = (model: PartnersAudienceModel): number | null => model.organisations.value?.counts.people ?? null

/**
 * Admin › Users, audience Partners (B-W2b-180; design admin.users sec:audience "Partners (W2b)", sec:tiles "Access ends soon
 * (W2b)"): the people of the partner organisations — name, organisation (→ its Portal access tab), e-mail, portal role,
 * sees prices (yes/no only: partners see price at most), end of access, last sign-in, state — with the tiles that need a
 * look (Invited, Access ends soon, Suspended, Deactivated; each a saved filter) and the bulk actions over the ticked rows
 * (Suspend, Reactivate, Deactivate through the partner routes: the organisation's seats count once). A partner is invited
 * from the organisation's Portal access tab, never here. Fetches nothing.
 */
export function PartnersPeople({ model, actions, tools, search }: { model: PartnersAudienceModel; actions?: PartnersAudienceActions; tools?: ReactNode; search?: ReactNode }) {
  return (
    <PortalAccessMessages>
      <People model={model} actions={actions} tools={tools} search={search} />
    </PortalAccessMessages>
  )
}

function People({ model, actions, tools, search }: { model: PartnersAudienceModel; actions?: PartnersAudienceActions; tools?: ReactNode; search?: ReactNode }) {
  const t = usePortalT()
  const locale = useLocale()
  const now = useMemo(() => new Date(model.now), [model.now])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const organisations = model.organisations.value?.organisations ?? []
  const all = model.users.items ? partnerUserRows(model.users.items, organisations, model.tile, model.query, now) : null
  const shown = shownOf(all ?? [], model.pages)
  const picked = shown.rows.filter((row) => selected.includes(row.user.id))
  const counts = partnerTileCounts(model.users.items, model.organisations.value?.counts ?? null, now)
  const reach = (action: PersonAction) => partnerUserReach(action, picked.map((row) => row.user), model.can)
  const select = (ids: string[]) => {
    setSelected(ids)
    actions?.onSelected?.(ids)
  }

  const orgsRead = model.organisations.value !== null
  const columns = useMemo<ColDef<PartnerUserRow>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<PartnerUserRow>) => (data ? <span className="fw-pa-strong">{data.user.displayName}</span> : null)
    const OrgCell = ({ data }: ICellRendererParams<PartnerUserRow>) =>
      data ? (
        data.organisation ? (
          <span className="fw-pa-cell">
            <Link href={organisationHref(model.prefix, data.organisation)} onClick={(event) => event.stopPropagation()}>
              {data.organisation.party.name}
            </Link>
            {data.user.partnerKind ? <Tag tone="neutral">{t(`kind.${data.user.partnerKind}`)}</Tag> : null}
          </span>
        ) : (
          // Still reading the organisations: a dash, never "not yours" before the answer.
          <span className="fw-pa-muted">{orgsRead ? t('partners.orgHidden') : '—'}</span>
        )
      ) : null
    const RoleCell = ({ data }: ICellRendererParams<PartnerUserRow>) => {
      if (!data) return null
      const role = data.user.roles.find((held) => !held.roleKey.startsWith('partner-'))
      return <span>{role ? t(`role.${role.roleKey}`) : data.user.status === 'INVITED' ? t('partners.roleOnAccept') : t('people.noRole')}</span>
    }
    const EndCell = ({ data }: ICellRendererParams<PartnerUserRow>) =>
      data ? (
        data.user.accessUntil ? (
          <span className="fw-pa-cell">
            <span>{formatDate(data.user.accessUntil, { locale })}</span>
            {accessEnded(data.user.accessUntil, now) ? <Tag tone="danger">{t('people.ended')}</Tag> : endsSoon(data.user.accessUntil, now) && data.user.status !== 'DEACTIVATED' ? <Tag tone="warning">{t('people.endsSoon')}</Tag> : null}
          </span>
        ) : (
          <span className="fw-pa-muted">{t('people.noEnd')}</span>
        )
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<PartnerUserRow>) => (data ? <Pill tone={STATUS_TONE[data.user.status]}>{t(`status.${data.user.status}`)}</Pill> : null)
    return [
      { colId: 'name', headerName: t('people.col.name'), minWidth: 180, flex: 1.2, valueGetter: (params) => params.data?.user.displayName ?? '', cellRenderer: NameCell },
      { colId: 'organisation', headerName: t('partners.col.organisation'), minWidth: 200, flex: 1.3, valueGetter: (params) => params.data?.organisation?.party.name ?? '', cellRenderer: OrgCell },
      { colId: 'email', headerName: t('people.col.email'), minWidth: 200, flex: 1.2, valueGetter: (params) => params.data?.user.email ?? '' },
      { colId: 'role', headerName: t('people.col.role'), minWidth: 130, flex: 0.8, valueGetter: (params) => params.data?.user.roles[0]?.roleKey ?? '', cellRenderer: RoleCell },
      { colId: 'until', headerName: t('people.col.until'), minWidth: 150, flex: 0.9, valueGetter: (params) => params.data?.user.accessUntil ?? '', cellRenderer: EndCell },
      { colId: 'lastSignIn', headerName: t('people.col.lastSignIn'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data?.user.lastSignInAt ? formatDateTime(params.data.user.lastSignInAt, { locale }) : t('people.never')) },
      { colId: 'language', headerName: t('partners.col.language'), minWidth: 100, flex: 0.5, valueGetter: (params) => (params.data ? t(`language.${params.data.user.locale === 'en' ? 'en' : 'it'}`) : '') },
      { colId: 'status', headerName: t('people.col.status'), minWidth: 130, flex: 0.7, valueGetter: (params) => (params.data ? t(`status.${params.data.user.status}`) : ''), cellRenderer: StatusCell },
    ]
  }, [t, locale, now, model.prefix, orgsRead])

  const problem = model.users.problem ?? model.organisations.problem
  const state = problem ? (
    <EmptyState
      title={t('partners.failed')}
      description={t(problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : all && all.length === 0 ? (
    model.tile || model.query ? (
      <EmptyState
        title={t('partners.noMatch')}
        action={
          <Button size="sm" onClick={() => actions?.onTile?.(null)}>
            {t('partners.clear')}
          </Button>
        }
      />
    ) : (
      <EmptyState icon={<Users size={24} aria-hidden />} title={t('partners.empty')} description={t('partners.emptyHint')} />
    )
  ) : undefined

  const bulk = model.bulk ?? null
  const bulkReach = bulk ? reach(bulk) : null
  const confirmNames = bulkReach ? namesLine(bulkReach.items.map((user) => user.displayName), (more) => t('confirm.andMore', { count: more })) : ''

  return (
    <>
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <MetricStrip
        metrics={PARTNER_TILES.map((tile: PartnerTile) => ({
          label: t(`partners.tile.${tile}`),
          value: counts[tile] === null ? '—' : String(counts[tile]),
          hint: t(`partners.tileHint.${tile}`),
          active: model.tile === tile,
          onClick: () => actions?.onTile?.(model.tile === tile ? null : tile),
        }))}
      />
      <ListFrame<PartnerUserRow>
        label={t('partners.tableLabel')}
        rows={all === null ? null : shown.rows}
        rowId={(row) => row.user.id}
        columns={columns}
        count={all ? t('partners.count', { shown: shown.rows.length, total: all.length }) : '—'}
        search={search}
        tools={
          <>
            {tools}
            {model.tile && <Tag tone="info">{t('partners.filtered', { tile: t(`partners.tile.${model.tile}`) })}</Tag>}
          </>
        }
        more={shown.more > 0 ? { label: t('partners.more', { count: shown.more }), onMore: () => actions?.onMore?.() } : null}
        onOpen={(row) => actions?.onOpen?.(`${model.prefix}/admin/users/${encodeURIComponent(row.user.id)}?tab=partner`)}
        selection={{
          selected: picked.map((row) => row.user.id),
          onChange: select,
          actions: (
            <>
              {PERSON_ACTIONS.map((action) => {
                const r = reach(action)
                const held = heldWords(t, r.held)
                return (
                  <Fragment key={action}>
                    <Button size="sm" variant={action === 'reactivate' ? 'secondary' : 'danger-outline'} heldReason={held} onClick={() => actions?.onBulk?.(action)} aria-label={t(`bulk.${action}`, { count: r.items.length })}>
                      {ICONS[action]} <SelectionLabel>{held ? t(`row.${action}`) : t(`bulk.${action}`, { count: r.items.length })}</SelectionLabel>
                    </Button>
                  </Fragment>
                )
              })}
            </>
          ),
        }}
        state={state}
      />
      <p className="fw-pa-hint">{t('partners.inviteWhere')}</p>
      <ConfirmBox
        open={bulk !== null && !!bulkReach && bulkReach.items.length > 0}
        title={bulk ? t(`confirm.${bulk}.title`, { count: bulkReach?.items.length ?? 0, name: bulkReach?.items[0]?.displayName ?? '' }) : ''}
        lines={bulk ? [t(`confirm.${bulk}.body`), confirmNames, ...(bulkReach && bulkReach.skipped > 0 ? [t('confirm.skipped', { count: bulkReach.skipped })] : [])] : []}
        confirmLabel={bulk ? t(`bulk.${bulk}`, { count: bulkReach?.items.length ?? 0 }) : ''}
        tone={bulk === 'reactivate' ? 'primary' : 'danger'}
        reason={bulk === 'suspend' || bulk === 'deactivate'}
        busy={model.busy}
        problem={model.dialogProblem ?? null}
        onClose={() => actions?.onBulk?.(null)}
        onConfirm={(reason) => {
          if (!bulk || !bulkReach) return
          void actions?.onRun?.(bulk, bulkReach.items, reason).then((done) => {
            if (done) select([])
          })
        }}
      />
    </>
  )
}
