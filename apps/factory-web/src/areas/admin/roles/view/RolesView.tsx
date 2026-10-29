'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Search, ShieldCheck } from 'lucide-react'
import { Banner, Modal } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, Pill, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import type { Role } from '../../shared/api'
import { adminHref, pageOf } from '../../shared/model'
import { AdminMessages, GrainChips, ListState, ListTable, PageHead, useRoleWords } from '../../shared/view/parts'
import { PermissionMatrix } from '../../shared/view/PermissionMatrix'
import { roleRows, templateGap, type RolesViewModel } from '../model'

export type { RolesViewModel } from '../model'

export interface RolesActions {
  onQuery?: (query: string) => void
  onAudience?: (audience: RolesViewModel['audience']) => void
  onRetry?: () => void
}

/**
 * SCR-012 — Admin › Roles & permissions (design 02 admin.roles): one row per role, said in plain words first (what it
 * does, what money it sees, whether it asks for two-factor), with what a custom copy lacks of its ready-made template.
 * Compare roles puts two or three side by side by area, differences marked. New role and Save role come in W2b.
 * Fetches nothing (RolesPage.tsx reads the API).
 */
export function RolesView({ model, actions }: { model: RolesViewModel; actions?: RolesActions }) {
  return (
    <AdminMessages>
      <Roles model={model} actions={actions} />
    </AdminMessages>
  )
}

/** A role's kind and audience, in words. */
export function RoleMarks({ role }: { role: Role }) {
  const t = useT('admin')
  return (
    <span className="fw-adm-tags">
      <Tag tone={role.system ? 'neutral' : 'info'}>{t(role.system ? 'roles.kind.system' : 'roles.kind.custom')}</Tag>
      <Tag>{t(`roles.audience.${role.audience}`)}</Tag>
    </span>
  )
}

function Roles({ model, actions }: { model: RolesViewModel; actions?: RolesActions }) {
  const t = useT('admin')
  const href = (path: string) => adminHref(model.prefix, path)
  const [compare, setCompare] = useState<readonly string[] | null>(model.compare ?? null)
  useEffect(() => setCompare(model.compare ?? null), [model.compare])
  const items = model.roles.items
  const words = useRoleWords()
  const rows = items ? roleRows(items, model.query, model.audience) : []
  const paged = pageOf(rows, 1)
  const templateName = (key: string | null) => (key ? words.name({ key, name: (items ?? []).find((role) => role.key === key)?.name ?? key }) : null)
  return (
    <div className="fw-adm">
      <PageHead
        intro={t('roles.intro')}
        asOf={model.asOf}
        actions={
          <Button size="sm" onClick={() => setCompare([])} heldReason={items && items.length >= 2 ? null : t('roles.held.compare')}>
            {t('roles.compare')}
          </Button>
        }
      />
      <div className="fw-adm-toolbar">
        <SegmentedControl
          ariaLabel={t('roles.audience.label')}
          size="sm"
          value={model.audience}
          onChange={(value) => actions?.onAudience?.(value as RolesViewModel['audience'])}
          options={['all', 'office', 'floor'].map((value) => ({ value, label: t(`roles.audience.${value}`) }))}
        />
        <span className="fw-adm-toolbar-search">
          <Input size="sm" fieldClassName="fw-adm-fill" type="search" leadingIcon={<Search size={14} aria-hidden />} aria-label={t('roles.search')} placeholder={t('roles.search')} value={model.query} onChange={(event) => actions?.onQuery?.(event.target.value)} />
        </span>
      </div>
      {model.roles.problem || items === null ? (
        <ListState problem={model.roles.problem} loading={items === null} onRetry={actions?.onRetry} />
      ) : items.length === 0 ? (
        <ListState loading={false} empty={{ icon: <ShieldCheck size={24} aria-hidden />, title: t('roles.empty.title'), body: t('roles.empty.body') }} />
      ) : rows.length === 0 ? (
        <ListState loading={false} empty={{ title: t('list.noMatch'), action: <Button size="sm" onClick={() => actions?.onQuery?.('')}>{t('list.clearSearch')}</Button> }} />
      ) : (
        <ListTable
          label={t('roles.tableLabel')}
          columns={[t('roles.col.name'), t('roles.col.does'), t('roles.col.people'), t('roles.col.money'), t('roles.col.twoFactor'), t('roles.col.basedOn')]}
          widths={['20%', '32%', '8%', '18%', '9%', '13%']}
          page={paged.page}
          pageCount={paged.pageCount}
          count={t('list.count', { shown: paged.rows.length, total: rows.length })}
          rows={paged.rows.map((role) => {
            const gap = templateGap(role)
            return {
              id: role.id,
              cells: [
                <span key="name" className="fw-adm-cell">
                  <Link className="fw-adm-name" href={href(`/roles/${role.id}`)}>
                    {words.name(role)}
                  </Link>
                  <RoleMarks role={role} />
                </span>,
                <span key="does" className="fw-adm-cell">
                  <span>{words.description(role) ?? t('roles.noDescription')}</span>
                  {gap?.kind === 'adds' && <Tag tone="warning">{t('roles.gap.adds', { count: gap.count })}</Tag>}
                  {gap?.kind === 'outdated' && <Tag tone="warning">{t('roles.gap.outdated')}</Tag>}
                </span>,
                String(role.holders),
                <GrainChips key="money" grains={role.grains} label={t('grains.labelOf', { name: words.name(role) })} />,
                role.requireMfa ? <Pill key="mfa" tone="info">{t('common.yes')}</Pill> : t('common.no'),
                role.system ? t('roles.readyMade') : (templateName(role.basedOn) ?? '—'),
              ],
            }
          })}
        />
      )}
      <p className="fw-adm-hint">{t('roles.later')}</p>
      <CompareModal model={model} picked={compare} onPick={setCompare} />
    </div>
  )
}

function CompareModal({ model, picked, onPick }: { model: RolesViewModel; picked: readonly string[] | null; onPick: (next: readonly string[] | null) => void }) {
  const t = useT('admin')
  const roles = model.roles.items ?? []
  const words = useRoleWords()
  if (picked === null) return null
  const chosen = picked.map((id) => roles.find((role) => role.id === id)).filter((role): role is Role => !!role)
  const toggle = (id: string, on: boolean) => onPick(on ? [...picked, id].slice(-3) : picked.filter((item) => item !== id))
  return (
    <Modal open onClose={() => onPick(null)} title={t('roles.compareTitle')} subtitle={t('roles.compareHint')} size="xxl" footer={<Button onClick={() => onPick(null)}>{t('common.close')}</Button>}>
      <div className="fw-adm-modal-body">
        <fieldset className="fw-adm-form">
          <legend className="fw-adm-sr">{t('roles.comparePick')}</legend>
          {roles.map((role) => (
            <CheckboxCard key={role.id} variant="row" checked={picked.includes(role.id)} selected={picked.includes(role.id)} onChange={(event) => toggle(role.id, event.target.checked)} title={words.name(role)} description={t(`roles.audience.${role.audience}`)} />
          ))}
        </fieldset>
        {chosen.length < 2 ? (
          <Banner tone="info" title={t('roles.compareNeedTwo')} />
        ) : !model.catalogue ? (
          <ListState loading />
        ) : (
          <>
            <div className="fw-adm-form">
              {chosen.map((role) => (
                <span key={role.id} className="fw-adm-cell">
                  <span className="fw-adm-name">{words.name(role)}</span>
                  <GrainChips grains={role.grains} label={t('grains.labelOf', { name: words.name(role) })} />
                </span>
              ))}
            </div>
            <PermissionMatrix permissions={model.catalogue.permissions} columns={chosen.map((role) => ({ id: role.id, name: words.name(role), permissions: role.permissions }))} onlyHeld />
          </>
        )}
      </div>
    </Modal>
  )
}
