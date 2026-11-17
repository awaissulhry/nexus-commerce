'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner, Card, SummaryTable, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { adminHref, GRAINS } from '../../shared/model'
import { AdminMessages, FrameState, GrainChips, ListKeysHelp, ListState, RecordProblem, useRoleWords } from '../../shared/view/parts'
import { PermissionMatrix } from '../../shared/view/PermissionMatrix'
import { ALWAYS_RULES, heldAreas, holdersOf, templateGap, type Holder, type RoleRecordModel, type RoleTab } from '../model'
import { holderColumns } from './columns'
import { RoleTwoFactor, type RoleTwoFactorActions } from '../../security/view/RoleTwoFactor'
import { FreshCode } from '../../security/step-up/view/FreshCode'
import { WithMessages } from '../../../../record-panels/i18n'
import { ArchiveDialog } from '../save-role/view/ArchiveDialog'
import { ArchiveButtons, DepthNotice, EditHeld, RoleEditor, type RoleEditorActions } from '../save-role/view/RoleEditor'
// ---- B-TH-269: the role on RecordFrame (the band in the shell's row, the docked thread — notes only —, one notice) ----
import { RecordFrame } from '../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../_shared/record-frame/RecordNotices'

export type { RoleRecordModel } from '../model'

export interface RoleRecordActions {
  /** Enter on a holder's row: open the person's roles. */
  onOpen?: (href: string) => void
  onRetry?: () => void
  /** B-W2a-36: the Two-factor card's save, dialog and step-up. */
  twoFactor?: RoleTwoFactorActions
  /** B-W2b-413: Change role, Archive and Restore, their fresh code. */
  editor?: RoleEditorActions
  archive?: { onArchive?: () => void; onRestore?: () => void; onConfirm?: (reason: string) => void; onClose?: () => void }
  onDismissNotice?: () => void
  onFreshSubmit?: (code: string) => void
  onFreshClose?: () => void
}

/**
 * SCR-012 — a Role record (design 02 admin.roles "Record: Role"), on RecordFrame (B-TH-269; the rule of picture 38, the tabs of
 * 08-tabs O-ADM-ROLE): the band in the shell's band row (‹ Roles, the role's name, ONE kind pill — ready-made, custom or archived —,
 * its audience and what it is a copy of; Restore for an archived copy; ⋯ Archive role held with why, its Keyboard line), the docked
 * thread beside every tab (notes only: W03, no outside party on an admin thread; Activity's tools in its "⋯", R-ACT) and the tabs
 * 4 → 3: Permissions (what it can do in sentences first, its money sight with what disappears without each grain, then every
 * permission by area with its risk mark), Scope rules (what always applies, read-only — "A customer limit covers customer records",
 * decision 17 —, two-factor) and Users (who holds it, where, until when). Every banner in the ONE notice of the body column.
 * Ready-made roles are read-only; B-W2b-413: a custom role's permissions and money sight are ticked and saved through the review
 * (save-role/), and it is archived or restored from the band. Fetches nothing (RoleRecord.tsx reads the API).
 */
// B-TH-269: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
export function RoleRecordView({ model, actions, thread, printThread }: { model: RoleRecordModel; actions?: RoleRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <AdminMessages>
      <WithMessages namespaces={['admin-security-depth']}>
        <RoleRecord model={model} actions={actions} thread={thread} printThread={printThread} />
      </WithMessages>
    </AdminMessages>
  )
}

function RoleRecord({ model, actions, thread, printThread }: { model: RoleRecordModel; actions?: RoleRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const t = useT('admin')
  const td = useT('admin-security-depth')
  const href = (path: string) => adminHref(model.prefix, path)
  const back = { href: href('/roles'), label: t('nav.roles') }
  const role = model.role
  const words = useRoleWords()
  const frame = { recordType: 'Role', personId: model.personId ?? null, threadLabel: t('record.dockLabel') }
  if (!role) {
    // Loading, not found, no right, a failed read: the band and its state, no thread yet.
    return (
      <RecordFrame {...frame} thread={null} band={{ back: <Link href={back.href}>{back.label}</Link>, title: model.problem ? t('nav.roles') : <Skeleton width={220} height={22} /> }}>
        {model.problem ? (
          <RecordProblem
            problem={model.problem}
            onRetry={actions?.onRetry}
            back={
              <Button size="sm" asChild>
                <Link href={back.href}>{t('record.backTo', { name: back.label })}</Link>
              </Button>
            }
          />
        ) : (
          <div className="fw-adm-stack" aria-busy="true">
            <Skeleton height={36} width="40%" />
            <Skeleton height={220} />
          </div>
        )}
      </RecordFrame>
    )
  }
  const holders = model.holders.items ? holdersOf(role, model.holders.items) : null
  const base = href(`/roles/${role.id}`)
  const tabs: TabItem[] = (
    [
      { id: 'permissions', label: t('role.tab.permissions'), count: role.permissions.length },
      { id: 'rules', label: t('role.tab.rules') },
      { id: 'users', label: t('role.tab.users'), count: holders ? holders.length : role.holders },
    ] satisfies Array<{ id: RoleTab; label: string; count?: number | null }>
  ).map((tab) => ({ ...tab, href: `${base}?tab=${tab.id}` }))
  const gap = templateGap(role)
  // ONE pill: the role's kind (an archived copy says so first); its audience and what it copies travel with the title.
  const kind = role.archivedAt ? { tone: 'warning' as const, key: 'roles.kind.archived' } : role.system ? { tone: 'neutral' as const, key: 'roles.kind.system' } : { tone: 'info' as const, key: 'roles.kind.custom' }
  const copyOf = role.system ? t('roles.readyMade') : t('role.copyOf', { key: role.basedOn ? words.name({ key: role.basedOn, name: model.catalogue?.templates.find((template) => template.key === role.basedOn)?.name ?? role.basedOn }) : '—' })
  // Restore is an archived copy's one step (the band's primary); Archive sits in ⋯, held with why in words.
  const archive = model.archive
  const more: MenuItemDef[] =
    archive && !role.system && !role.archivedAt
      ? [{ id: 'archive', label: td('archive.button'), tone: 'danger', disabled: archive.held !== null, ...(archive.held ? { description: td(archive.held) } : {}), onSelect: () => actions?.archive?.onArchive?.() }]
      : []
  return (
    <>
      <RecordFrame
        {...frame}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back: <Link href={back.href}>{back.label}</Link>,
          title: words.name(role),
          status: <Pill tone={kind.tone}>{t(kind.key)}</Pill>,
          meta: (
            <span className="fw-adm-tags">
              <Tag>{t(`roles.audience.${role.audience}`)}</Tag>
              <span className="fw-adm-hint">{copyOf}</span>
            </span>
          ),
          ...(archive && role.archivedAt ? { primary: <ArchiveButtons role={role} held={archive.held} onArchive={actions?.archive?.onArchive} onRestore={actions?.archive?.onRestore} /> } : {}),
          more,
        }}
      >
        <div className="fw-adm-stack">
          <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
          {/* B-TH-269: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
          <RecordNotices>
            {model.notice && <DepthNotice notice={model.notice} onDismiss={actions?.onDismissNotice} />}
            {gap?.kind === 'adds' && (
              <Banner tone="warning" title={t('roles.gap.adds', { count: gap.count })}>
                {role.templateAdds.permissionsAdded.map((name) => t(`perm.${name.replace(/\./g, '_')}`)).join(' · ')}
              </Banner>
            )}
            {gap?.kind === 'outdated' && <Banner tone="warning" title={t('roles.gap.outdated')} />}
            {/* B-W2b-413: a custom role is changed on its Permissions tab; when it cannot be, why. */}
            {!role.system && model.editHeld && <EditHeld reason={model.editHeld} />}
            {role.system && <Banner tone="info" title={t('role.readOnlySystem')} />}
          </RecordNotices>
          {model.tab === 'permissions' && <PermissionsTab model={model} actions={actions} />}
          {model.tab === 'rules' && <RulesTab model={model} actions={actions} />}
          {model.tab === 'users' && <UsersTab model={model} actions={actions} />}
        </div>
      </RecordFrame>
      {model.archive?.dialog && <ArchiveDialog model={model.archive.dialog} onConfirm={actions?.archive?.onConfirm} onClose={actions?.archive?.onClose} />}
      <FreshCode model={model.freshCode} onSubmit={actions?.onFreshSubmit} onClose={actions?.onFreshClose} />
    </>
  )
}

function PermissionsTab({ model, actions }: { model: RoleRecordModel; actions?: RoleRecordActions }) {
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
      {model.editor ? (
        <RoleEditor model={model.editor} actions={actions?.editor} />
      ) : (
        <Card header={t('role.every')} description={t('role.everyHint')} headingLevel={2} padded>
          {!model.catalogue ? <ListState loading /> : <PermissionMatrix permissions={model.catalogue.permissions.filter((permission) => (role.audience === 'floor' ? true : permission.area !== 'floor'))} columns={[{ id: role.id, name: words.name(role), permissions: role.permissions }]} />}
        </Card>
      )}
    </div>
  )
}

function RulesTab({ model, actions }: { model: RoleRecordModel; actions?: RoleRecordActions }) {
  const t = useT('admin')
  const locale = useLocale()
  const role = model.role!
  return (
    <div className="fw-adm-stack">
      <Card header={t('role.rules.title')} description={t('role.rules.hint')} headingLevel={2}>
        <SummaryTable label={t('role.rules.title')} density="roomy" stackOnPhone columns={[t('role.rules.rule'), t('role.rules.why')]} rows={ALWAYS_RULES.map((rule) => ({ id: rule, cells: [t(`role.rule.${rule}.title`), t(`role.rule.${rule}.why`)] }))} />
      </Card>
      {/* B-W2a-36 (PLT-045): the switch; a floor role keeps the W0 words (it never asks for two-factor). */}
      {model.twoFactor && role.audience === 'office' ? (
        <RoleTwoFactor model={model.twoFactor} actions={actions?.twoFactor} />
      ) : (
        <Card header={t('role.mfa.title')} headingLevel={2} padded>
          <p className="fw-adm-intro">{t(role.requireMfa ? 'role.mfa.on' : 'role.mfa.off')}</p>
          {/* B-W2b-24: since when it asks (Role.requireMfaSince). */}
          {role.requireMfa && <p className="fw-adm-hint">{role.requireMfaSince ? t('role.mfa.since', { day: formatDate(role.requireMfaSince, { locale }) }) : t('role.mfa.sinceUnknown')}</p>}
        </Card>
      )}
    </div>
  )
}

function UsersTab({ model, actions }: { model: RoleRecordModel; actions?: RoleRecordActions }) {
  const t = useT('admin')
  const locale = useLocale()
  const [help, setHelp] = useState(false)
  const role = model.role!
  const columns = useMemo(() => holderColumns({ t, locale, prefix: model.prefix, companies: model.companies }), [t, locale, model.prefix, model.companies])
  if (role.audience === 'floor') return <Banner tone="info" title={t('role.floorHolders', { count: role.holders })} />
  const holders = model.holders.items ? holdersOf(role, model.holders.items) : null
  return (
    <>
      <ListFrame<Holder>
        label={t('role.tab.users')}
        rows={holders}
        rowId={(holder) => holder.id}
        columns={columns}
        count={holders ? t('role.holders', { count: holders.length }) : '—'}
        onOpen={(holder) => actions?.onOpen?.(`${adminHref(model.prefix, `/users/${holder.user.id}`)}?tab=roles`)}
        onHelp={() => setHelp(true)}
        state={model.holders.problem ? <FrameState problem={model.holders.problem} onRetry={actions?.onRetry} /> : holders && holders.length === 0 ? <FrameState empty={{ title: t('role.nobody') }} /> : undefined}
      />
      <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={[]} selection={false} />
    </>
  )
}
