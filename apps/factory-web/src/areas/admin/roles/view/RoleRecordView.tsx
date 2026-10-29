'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Banner, Card, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { adminHref, GRAINS, scopeWords } from '../../shared/model'
import { AdminMessages, GrainChips, ListState, RecordProblem, useRoleWords } from '../../shared/view/parts'
import { PermissionMatrix } from '../../shared/view/PermissionMatrix'
import { RecordFrame } from '../../shared/view/RecordFrame'
import { ALWAYS_RULES, heldAreas, holdersOf, templateGap, type RoleRecordModel, type RoleTab } from '../model'
import { RoleMarks } from './RolesView'

export type { RoleRecordModel } from '../model'

export interface RoleRecordActions {
  onDock?: () => void
  onRetry?: () => void
}

/**
 * SCR-012 — a Role record (design 02 admin.roles "Record: Role"): Permissions (what it can do in sentences first, its
 * money sight with what disappears without each grain, then every permission by area with its risk mark), Scope rules
 * (what always applies, read-only), Users (who holds it, where, until when) and Activity. Ready-made roles are read-only;
 * changing a custom copy comes in W2b. Fetches nothing (RoleRecord.tsx reads the API).
 */
export function RoleRecordView({ model, actions, panels }: { model: RoleRecordModel; actions?: RoleRecordActions; panels?: ReactNode }) {
  return (
    <AdminMessages>
      <RoleRecord model={model} actions={actions} panels={panels} />
    </AdminMessages>
  )
}

function RoleRecord({ model, actions, panels }: { model: RoleRecordModel; actions?: RoleRecordActions; panels?: ReactNode }) {
  const t = useT('admin')
  const href = (path: string) => adminHref(model.prefix, path)
  const back = { href: href('/roles'), label: t('nav.roles') }
  const role = model.role
  const words = useRoleWords()
  if (!role) {
    if (model.problem)
      return (
        <div className="fw-adm">
          <RecordProblem
            problem={model.problem}
            onRetry={actions?.onRetry}
            back={
              <Button size="sm" asChild>
                <Link href={back.href}>{t('record.backTo', { name: back.label })}</Link>
              </Button>
            }
          />
        </div>
      )
    return (
      <div className="fw-adm" aria-busy="true">
        <Skeleton height={36} width="40%" />
        <Skeleton height={220} />
      </div>
    )
  }
  const holders = model.holders.items ? holdersOf(role, model.holders.items) : null
  const tabs: Array<{ id: RoleTab; label: string; count?: number | null }> = [
    { id: 'permissions', label: t('role.tab.permissions'), count: role.permissions.length },
    { id: 'rules', label: t('role.tab.rules') },
    { id: 'users', label: t('role.tab.users'), count: holders ? holders.length : role.holders },
    { id: 'activity', label: t('role.tab.activity') },
  ]
  const gap = templateGap(role)
  return (
    <div className="fw-adm">
      <RecordFrame
        back={back}
        title={words.name(role)}
        meta={role.system ? t('roles.readyMade') : t('role.copyOf', { key: role.basedOn ? words.name({ key: role.basedOn, name: model.catalogue?.templates.find((template) => template.key === role.basedOn)?.name ?? role.basedOn }) : '—' })}
        status={<RoleMarks role={role} />}
        tabs={tabs}
        active={model.tab}
        tabHref={(tab) => `${href(`/roles/${role.id}`)}?tab=${tab}`}
        dock={model.tab === 'activity' ? undefined : panels}
        dockOpen={model.dockOpen}
        onDock={actions?.onDock}
      >
        <Banner tone="info" title={t(role.system ? 'role.readOnlySystem' : 'role.readOnlyCustom')} />
        {gap?.kind === 'adds' && (
          <Banner tone="warning" title={t('roles.gap.adds', { count: gap.count })}>
            {role.templateAdds.permissionsAdded.map((name) => t(`perm.${name.replace(/\./g, '_')}`)).join(' · ')}
          </Banner>
        )}
        {gap?.kind === 'outdated' && <Banner tone="warning" title={t('roles.gap.outdated')} />}
        {model.tab === 'permissions' && <PermissionsTab model={model} />}
        {model.tab === 'rules' && <RulesTab model={model} />}
        {model.tab === 'users' && <UsersTab model={model} />}
        {model.tab === 'activity' && panels}
      </RecordFrame>
    </div>
  )
}

function PermissionsTab({ model }: { model: RoleRecordModel }) {
  const t = useT('admin')
  const role = model.role!
  const areas = heldAreas(role, model.catalogue)
  const words = useRoleWords()
  const missing = GRAINS.filter((grain) => !role.grains.includes(grain))
  return (
    <div className="fw-adm-stack">
      <Card header={t('role.plain')} headingLevel={2} padded>
        <p className="fw-adm-intro">{words.description(role) ?? t('roles.noDescription')}</p>
        {areas.length > 0 && (
          <ul className="fw-adm-guards">
            {areas.map((row) => (
              <li key={row.area}>{t('role.areaLine', { area: t(`area.${row.area}`) === `area.${row.area}` ? row.area : t(`area.${row.area}`), count: row.count, total: row.total })}</li>
            ))}
          </ul>
        )}
        <p className="fw-adm-cell-row">
          <span className="fw-adm-hint">{t('user.seesMoney')}</span> <GrainChips grains={role.grains} />
        </p>
        {missing.length > 0 && (
          <ul className="fw-adm-guards">
            {missing.map((grain) => (
              <li key={grain} className="fw-adm-hint">
                {t(`grains.without.${grain}`)}
              </li>
            ))}
          </ul>
        )}
        {role.requireMfa && <Tag tone="info">{t('role.mfaRequired')}</Tag>}
      </Card>
      <Card header={t('role.every')} description={t('role.everyHint')} headingLevel={2} padded>
        {!model.catalogue ? <ListState loading /> : <PermissionMatrix permissions={model.catalogue.permissions.filter((permission) => (role.audience === 'floor' ? true : permission.area !== 'floor'))} columns={[{ id: role.id, name: words.name(role), permissions: role.permissions }]} />}
      </Card>
    </div>
  )
}

function RulesTab({ model }: { model: RoleRecordModel }) {
  const t = useT('admin')
  const role = model.role!
  return (
    <div className="fw-adm-stack">
      <Card header={t('role.rules.title')} description={t('role.rules.hint')} headingLevel={2}>
        <SummaryTable label={t('role.rules.title')} density="roomy" stackOnPhone columns={[t('role.rules.rule'), t('role.rules.why')]} rows={ALWAYS_RULES.map((rule) => ({ id: rule, cells: [t(`role.rule.${rule}.title`), t(`role.rule.${rule}.why`)] }))} />
      </Card>
      <Card header={t('role.mfa.title')} headingLevel={2} padded>
        <p className="fw-adm-intro">{t(role.requireMfa ? 'role.mfa.on' : 'role.mfa.off')}</p>
        <p className="fw-adm-hint">{t('role.mfa.later')}</p>
      </Card>
    </div>
  )
}

function UsersTab({ model }: { model: RoleRecordModel }) {
  const t = useT('admin')
  const locale = useLocale()
  const role = model.role!
  const href = (path: string) => adminHref(model.prefix, path)
  if (role.audience === 'floor') return <Banner tone="info" title={t('role.floorHolders', { count: role.holders })} />
  if (model.holders.items === null || model.holders.problem) return <ListState loading={model.holders.items === null} problem={model.holders.problem} />
  const holders = holdersOf(role, model.holders.items)
  if (holders.length === 0) return <ListState loading={false} empty={{ title: t('role.nobody') }} />
  return (
    <Card>
      <SummaryTable
        label={t('role.tab.users')}
        density="roomy"
        stackOnPhone
        columns={[t('users.col.name'), t('users.col.where'), t('user.col.to')]}
        rows={holders.map(({ user, scope, validTo }) => ({
          id: `${user.id}-${scopeWords(scope, model.companies, '')}`,
          cells: [
            <Link key="name" className="fw-adm-name" href={href(`/users/${user.id}?tab=roles`)}>
              {user.displayName}
            </Link>,
            scopeWords(scope, model.companies, t('scope.all')) || '—',
            validTo ? formatDate(validTo, { locale }) : t('user.noEnd'),
          ],
        }))}
      />
    </Card>
  )
}
