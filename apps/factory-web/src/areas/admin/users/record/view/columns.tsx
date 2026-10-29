'use client'

import { IdentityCell, type ColDef } from '@nexus/ui/grid'
import { Pill } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import type { Translate } from '../../../../../lib/i18n/messages'
import type { Assignment } from '../../../shared/api'
import { adminHref, scopeWords, type ScopeOption } from '../../../shared/model'
import { cellOf as cell } from '../../../shared/view/cells'

/**
 * SCR-011 a person's roles: the role (the Role record's link), where it applies, from, until (or when it ended), live or
 * ended. An ended assignment stays listed (never deleted).
 */
export function assignmentColumns(ctx: { t: Translate; locale: Locale; prefix: string; companies: readonly ScopeOption[]; roleName: (role: { key: string; name: string }) => string }): ColDef<Assignment>[] {
  const { t, locale } = ctx
  const name = (assignment: Assignment) => ctx.roleName({ key: assignment.roleKey, name: assignment.roleName })
  const until = (assignment: Assignment) => (assignment.endedAt ? formatDate(assignment.endedAt, { locale }) : assignment.validTo ? formatDate(assignment.validTo, { locale }) : t('user.noEnd'))
  return [
    {
      colId: 'role',
      headerName: t('roles.col.name'),
      valueGetter: ({ data }) => (data ? name(data) : ''),
      flex: 1.4,
      minWidth: 190,
      cellRenderer: cell<Assignment>((assignment) => <IdentityCell noImage title={name(assignment)} titleAttr={name(assignment)} href={adminHref(ctx.prefix, `/roles/${assignment.roleId}`)} />),
    },
    { colId: 'where', headerName: t('users.col.where'), valueGetter: ({ data }) => (data ? scopeWords(data, ctx.companies, t('scope.all')) || '—' : ''), flex: 1.8, minWidth: 200 },
    { colId: 'from', headerName: t('user.col.from'), valueGetter: ({ data }) => (data ? formatDate(data.validFrom, { locale }) : ''), flex: 0.8, minWidth: 120 },
    { colId: 'to', headerName: t('user.col.to'), valueGetter: ({ data }) => (data ? until(data) : ''), flex: 0.8, minWidth: 120 },
    {
      colId: 'state',
      headerName: t('users.col.status'),
      valueGetter: ({ data }) => (!data ? '' : t(data.live ? 'user.live' : 'user.ended')),
      flex: 0.6,
      minWidth: 110,
      cellRenderer: cell<Assignment>((assignment) => <Pill tone={assignment.live ? 'success' : 'neutral'}>{t(assignment.live ? 'user.live' : 'user.ended')}</Pill>),
    },
  ]
}
