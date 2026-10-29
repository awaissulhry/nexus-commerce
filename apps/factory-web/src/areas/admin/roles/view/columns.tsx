'use client'

import { IdentityCell, type ColDef } from '@nexus/ui/grid'
import { Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import type { Role } from '../../shared/api'
import { adminHref, scopeWords, type ScopeOption } from '../../shared/model'
import { cellOf as cell } from '../../shared/view/cells'
import { GrainChips } from '../../shared/view/parts'
import { templateGap, type Holder } from '../model'

/** What the roles lists draw with: the page's words, the role names and plain lines in its language. */
export interface RolesColumnsContext {
  t: Translate
  prefix: string
  words: { name: (role: { key: string; name: string }) => string; description: (role: { key: string; description: string | null }) => string | null }
  /** Every role (a copy's template name). */
  roles: readonly Role[]
}

/** A role's kind and audience, in words (the Roles list's sub-line, the Role record's status). */
export function RoleMarks({ role, t }: { role: Role; t: Translate }) {
  return (
    <>
      <Tag tone={role.system ? 'neutral' : 'info'}>{t(role.system ? 'roles.kind.system' : 'roles.kind.custom')}</Tag>
      <Tag>{t(`roles.audience.${role.audience}`)}</Tag>
    </>
  )
}

/**
 * SCR-012 every role in plain words: its name (the Role record's link) with its kind and audience, what it does (and
 * what a copy lacks of its template), its people, what money it sees, two-factor, what it is based on.
 */
export function roleColumns(ctx: RolesColumnsContext): ColDef<Role>[] {
  const { t, words } = ctx
  const basedOn = (role: Role) => (role.system ? t('roles.readyMade') : role.basedOn ? words.name({ key: role.basedOn, name: ctx.roles.find((item) => item.key === role.basedOn)?.name ?? role.basedOn }) : '—')
  return [
    {
      colId: 'name',
      headerName: t('roles.col.name'),
      valueGetter: ({ data }) => (data ? words.name(data) : ''),
      flex: 1.6,
      minWidth: 220,
      cellRenderer: cell<Role>((role) => (
        <IdentityCell noImage title={words.name(role)} titleAttr={words.name(role)} href={adminHref(ctx.prefix, `/roles/${role.id}`)} sub={<RoleMarks role={role} t={t} />} />
      )),
    },
    {
      colId: 'does',
      headerName: t('roles.col.does'),
      valueGetter: ({ data }) => (data ? (words.description(data) ?? t('roles.noDescription')) : ''),
      flex: 2.6,
      minWidth: 280,
      cellRenderer: cell<Role>((role) => {
        const gap = templateGap(role)
        return (
          <div className="fw-adm-cell2">
            <span className="fw-adm-ellipsis" title={words.description(role) ?? undefined}>
              {words.description(role) ?? t('roles.noDescription')}
            </span>
            {gap && <span className="nds-cell-sub">{gap.kind === 'adds' ? <Tag tone="warning">{t('roles.gap.adds', { count: gap.count })}</Tag> : <Tag tone="warning">{t('roles.gap.outdated')}</Tag>}</span>}
          </div>
        )
      }),
    },
    { colId: 'people', headerName: t('roles.col.people'), valueGetter: ({ data }) => data?.holders ?? null, minWidth: 90, flex: 0.35 },
    {
      colId: 'money',
      headerName: t('roles.col.money'),
      valueGetter: ({ data }) => data?.grains.join(' ') ?? '',
      width: 280,
      minWidth: 270,
      cellRenderer: cell<Role>((role) => (
        <span className="fw-adm-celltags">
          <GrainChips grains={role.grains} label={t('grains.labelOf', { name: words.name(role) })} />
        </span>
      )),
    },
    {
      colId: 'twoFactor',
      headerName: t('roles.col.twoFactor'),
      valueGetter: ({ data }) => (!data ? '' : t(data.requireMfa ? 'common.yes' : 'common.no')),
      minWidth: 120,
      flex: 0.6,
      cellRenderer: cell<Role>((role) => (role.requireMfa ? <Pill tone="info">{t('common.yes')}</Pill> : t('common.no'))),
    },
    { colId: 'basedOn', headerName: t('roles.col.basedOn'), valueGetter: ({ data }) => (data ? basedOn(data) : ''), minWidth: 150, flex: 0.9 },
  ]
}

/** SCR-012 Role record › Users: who holds the role (the person's roles), where it applies, until when. */
export function holderColumns(ctx: { t: Translate; locale: Locale; prefix: string; companies: readonly ScopeOption[] }): ColDef<Holder>[] {
  const { t, locale } = ctx
  return [
    {
      colId: 'name',
      headerName: t('users.col.name'),
      valueGetter: ({ data }) => data?.user.displayName ?? '',
      flex: 1.6,
      minWidth: 220,
      cellRenderer: cell<Holder>(({ user }) => <IdentityCell noImage title={user.displayName} titleAttr={user.displayName} href={`${adminHref(ctx.prefix, `/users/${user.id}`)}?tab=roles`} sub={user.email} />),
    },
    { colId: 'where', headerName: t('users.col.where'), valueGetter: ({ data }) => (data ? scopeWords(data.scope, ctx.companies, t('scope.all')) || '—' : ''), flex: 1.6, minWidth: 200 },
    { colId: 'to', headerName: t('user.col.to'), valueGetter: ({ data }) => (!data ? '' : data.validTo ? formatDate(data.validTo, { locale }) : t('user.noEnd')), flex: 0.8, minWidth: 130 },
  ]
}
