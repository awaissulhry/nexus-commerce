'use client'

import { IdentityCell, type ColDef } from '@nexus/ui/grid'
import { Pill, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import type { Role, User, Worker } from '../../shared/api'
import { adminHref, STATUS_TONE, type ScopeOption } from '../../shared/model'
import { cellOf as cell } from '../../shared/view/cells'
import { GrainChips } from '../../shared/view/parts'
import { userGrains, whereWords, type SiteOption } from '../model'

/** What the Users columns draw with: the page's words, its language, the role names in its words, the reads it holds. */
export interface UsersColumnsContext {
  t: Translate
  locale: Locale
  prefix: string
  roleName: (role: { key: string; name: string }) => string
  roles: readonly Role[] | null
  companies: readonly ScopeOption[]
  sites: readonly SiteOption[]
}

/** SCR-010 office people: name and e-mail (the record's link), roles, where, money sight, status, two-factor, last sign-in. */
export function officeColumns(ctx: UsersColumnsContext): ColDef<User>[] {
  const { t, locale } = ctx
  const where = (user: User) => whereWords(user.roles, ctx.companies, t('scope.all'))
  const lastSignIn = (user: User) => (user.lastSignInAt ? formatDateTime(user.lastSignInAt, { locale }) : '—')
  const inviteUntil = (user: User) => (user.status === 'INVITED' && user.invitationExpiresAt ? t('users.validUntil', { date: formatDate(user.invitationExpiresAt, { locale }) }) : null)
  return [
    {
      colId: 'name',
      headerName: t('users.col.name'),
      valueGetter: ({ data }) => data?.displayName ?? '',
      flex: 2,
      minWidth: 210,
      cellRenderer: cell<User>((user) => <IdentityCell noImage title={user.displayName} titleAttr={user.displayName} href={adminHref(ctx.prefix, `/users/${user.id}`)} sub={user.email} />),
    },
    {
      colId: 'roles',
      headerName: t('users.col.roles'),
      valueGetter: ({ data }) => (data ? data.roles.map((role) => ctx.roleName({ key: role.roleKey, name: role.roleName })).join(', ') : ''),
      flex: 1.4,
      minWidth: 160,
      cellRenderer: cell<User>((user) =>
        user.roles.length === 0 ? (
          <span className="fw-adm-hint">{t('users.noRole')}</span>
        ) : (
          <span className="fw-adm-celltags">
            {user.roles.map((role) => (
              <Tag key={role.assignmentId}>{ctx.roleName({ key: role.roleKey, name: role.roleName })}</Tag>
            ))}
          </span>
        ),
      ),
    },
    { colId: 'where', headerName: t('users.col.where'), valueGetter: ({ data }) => (data ? (where(data) ?? '—') : ''), flex: 1.2, minWidth: 140 },
    {
      colId: 'money',
      headerName: t('users.col.money'),
      valueGetter: ({ data }) => (data ? (userGrains(data, ctx.roles) ?? []).join(' ') : ''),
      width: 280,
      minWidth: 270,
      cellRenderer: cell<User>((user) => {
        const grains = userGrains(user, ctx.roles)
        return grains ? (
          <span className="fw-adm-celltags">
            <GrainChips grains={grains} label={t('grains.labelOf', { name: user.displayName })} />
          </span>
        ) : (
          '—'
        )
      }),
    },
    {
      colId: 'status',
      headerName: t('users.col.status'),
      valueGetter: ({ data }) => (data ? t(`users.status.${data.status}`) : ''),
      minWidth: 140,
      flex: 0.7,
      cellRenderer: cell<User>((user) => (
        <div className="fw-adm-cell2">
          <span>
            <Pill tone={STATUS_TONE[user.status] ?? 'neutral'}>{t(`users.status.${user.status}`)}</Pill>
          </span>
          {inviteUntil(user) && <span className="nds-cell-sub">{inviteUntil(user)}</span>}
        </div>
      )),
    },
    {
      colId: 'twoFactor',
      headerName: t('users.col.twoFactor'),
      valueGetter: ({ data }) => (!data ? '' : data.status === 'INVITED' || data.status === 'DEACTIVATED' ? '—' : t(data.mfaEnabled ? 'users.mfa.on' : 'users.mfa.off')),
      minWidth: 125,
      flex: 0.5,
    },
    { colId: 'lastSignIn', headerName: t('users.col.lastSignIn'), valueGetter: ({ data }) => (data ? lastSignIn(data) : ''), minWidth: 150, flex: 1 },
  ]
}

/** SCR-010 floor workers: name and employee number (the record's link), site, floor roles, badge, PIN, status, language. */
export function floorColumns(ctx: UsersColumnsContext): ColDef<Worker>[] {
  const { t } = ctx
  const siteName = (worker: Worker) => ctx.sites.find((site) => site.id === worker.siteId)?.name ?? '—'
  const language = (code: string) => (t(`common.language.${code}`) === `common.language.${code}` ? code : t(`common.language.${code}`))
  const pin = (worker: Worker) => t(worker.pinMustChange ? 'users.pin.mustChange' : worker.hasPin ? 'users.pin.set' : 'users.pin.none')
  return [
    {
      colId: 'name',
      headerName: t('users.col.name'),
      valueGetter: ({ data }) => data?.displayName ?? '',
      flex: 2,
      minWidth: 220,
      cellRenderer: cell<Worker>((worker) => (
        <IdentityCell
          noImage
          title={worker.displayName}
          titleAttr={worker.displayName}
          href={adminHref(ctx.prefix, `/users/floor/${worker.id}`)}
          sub={worker.employeeCode ? t('users.employeeNo', { code: worker.employeeCode }) : undefined}
        />
      )),
    },
    { colId: 'site', headerName: t('users.col.site'), valueGetter: ({ data }) => (data ? siteName(data) : ''), flex: 1.2, minWidth: 170 },
    {
      colId: 'roles',
      headerName: t('users.col.floorRoles'),
      valueGetter: ({ data }) => (data ? data.roles.map((role) => ctx.roleName(role)).join(', ') : ''),
      flex: 1.3,
      minWidth: 170,
      cellRenderer: cell<Worker>((worker) =>
        worker.roles.length === 0 ? (
          <span className="fw-adm-hint">{t('users.noFloorRole')}</span>
        ) : (
          <span className="fw-adm-celltags">
            {worker.roles.map((role) => (
              <Tag key={role.workerRoleId}>{ctx.roleName(role)}</Tag>
            ))}
          </span>
        ),
      ),
    },
    {
      colId: 'badge',
      headerName: t('users.col.badge'),
      valueGetter: ({ data }) => (!data ? '' : data.badge ? t('users.badgeHint', { hint: data.badge.hint }) : t('users.noBadge')),
      minWidth: 120,
      flex: 0.7,
      cellRenderer: cell<Worker>((worker) => (worker.badge ? t('users.badgeHint', { hint: worker.badge.hint }) : <span className="fw-adm-hint">{t('users.noBadge')}</span>)),
    },
    { colId: 'pin', headerName: t('users.col.pin'), valueGetter: ({ data }) => (data ? pin(data) : ''), minWidth: 130, flex: 0.8 },
    {
      colId: 'status',
      headerName: t('users.col.status'),
      valueGetter: ({ data }) => (data ? t(`users.workerStatus.${data.status}`) : ''),
      minWidth: 170,
      flex: 0.9,
      cellRenderer: cell<Worker>((worker) => (
        <span className="fw-adm-celltags">
          <Pill tone={STATUS_TONE[worker.status] ?? 'neutral'}>{t(`users.workerStatus.${worker.status}`)}</Pill>
          {worker.locked && <Tag tone="warning">{t('users.locked')}</Tag>}
        </span>
      )),
    },
    { colId: 'language', headerName: t('users.col.language'), valueGetter: ({ data }) => (data ? language(data.locale) : ''), minWidth: 110, flex: 0.6 },
  ]
}
