'use client'

import { useEffect, useMemo, useState } from 'react'
import { Columns3, ShieldCheck } from 'lucide-react'
import { Button, SegmentedControl } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { Role } from '../../shared/api'
import { adminHref, selectedAmong, shownOf } from '../../shared/model'
import { AdminMessages, BulkButton, FrameState, GrainChips, heldText, ListKeysHelp, ListSearch, ListState, PageHead, useRoleWords } from '../../shared/view/parts'
import { PermissionMatrix } from '../../shared/view/PermissionMatrix'
import { compareHeld, roleRows, type RolesViewModel } from '../model'
import { roleColumns } from './columns'

export type { RolesViewModel } from '../model'

export interface RolesActions {
  onQuery?: (query: string) => void
  onAudience?: (audience: RolesViewModel['audience']) => void
  /** "Show 50 more". */
  onMore?: () => void
  onRetry?: () => void
  /** Enter on a row: open the Role record. */
  onOpen?: (href: string) => void
}

/**
 * SCR-012 — Admin › Roles & permissions (design 02 admin.roles): one row per role in the Office list frame, said in plain
 * words first (what it does, what money it sees, whether it asks for two-factor), with what a custom copy lacks of its
 * ready-made template. Tick two or three roles and "Compare N" puts them side by side by area, differences marked (the
 * ticks are the pick). New role and Save role come in W2b. Fetches nothing (RolesPage.tsx reads the API).
 */
export function RolesView({ model, actions }: { model: RolesViewModel; actions?: RolesActions }) {
  return (
    <AdminMessages>
      <Roles model={model} actions={actions} />
    </AdminMessages>
  )
}

function Roles({ model, actions }: { model: RolesViewModel; actions?: RolesActions }) {
  const t = useT('admin')
  const words = useRoleWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const [compare, setCompare] = useState<readonly string[] | null>(model.compare ?? null)
  useEffect(() => setCompare(model.compare ?? null), [model.compare])
  const [help, setHelp] = useState(false)
  const items = model.roles.items
  const rows = items ? roleRows(items, model.query, model.audience) : []
  const shown = shownOf(rows, model.pages)
  const picked = selectedAmong(shown.rows, selected)
  const held = compareHeld(picked.length)
  const columns = useMemo(() => roleColumns({ t, prefix: model.prefix, words, roles: items ?? [] }), [t, model.prefix, words, items])
  const state = model.roles.problem ? (
    <FrameState problem={model.roles.problem} onRetry={actions?.onRetry} />
  ) : items && items.length === 0 ? (
    <FrameState empty={{ icon: <ShieldCheck size={24} aria-hidden />, title: t('roles.empty.title'), body: t('roles.empty.body') }} />
  ) : items && rows.length === 0 ? (
    <FrameState noMatch={{ onClear: () => actions?.onQuery?.(''), clearLabel: t('list.clearSearch') }} />
  ) : undefined
  return (
    <div className="fw-adm">
      <PageHead intro={t('roles.intro')} asOf={model.asOf} />
      <ListFrame<Role>
        label={t('roles.tableLabel')}
        rows={items === null ? null : shown.rows}
        rowId={(role) => role.id}
        columns={columns}
        count={items ? t('list.count', { shown: shown.rows.length, total: rows.length }) : '—'}
        search={<ListSearch label={t('roles.search')} value={model.query} onChange={actions?.onQuery} />}
        tools={
          <SegmentedControl
            ariaLabel={t('roles.audience.label')}
            size="sm"
            value={model.audience}
            onChange={(value) => {
              setSelected([])
              actions?.onAudience?.(value as RolesViewModel['audience'])
            }}
            options={['all', 'office', 'floor'].map((value) => ({ value, label: t(`roles.audience.${value}`) }))}
          />
        }
        selection={{
          selected: picked.map((role) => role.id),
          onChange: setSelected,
          actions: (
            <BulkButton
              icon={<Columns3 size={13} aria-hidden />}
              label={held ? t('roles.compareTitle') : t('roles.bulk.compare', { count: picked.length })}
              held={heldText(t, held)}
              tone="primary"
              onClick={() => setCompare(picked.map((role) => role.id))}
            />
          ),
        }}
        more={shown.more > 0 ? { label: t('list.more', { count: shown.more }), onMore: () => actions?.onMore?.() } : null}
        onHelp={() => setHelp(true)}
        onOpen={(role) => actions?.onOpen?.(adminHref(model.prefix, `/roles/${role.id}`))}
        state={state}
      />
      <p className="fw-adm-hint">{t('roles.later')}</p>
      <CompareModal model={model} picked={compare} onClose={() => setCompare(null)} />
      <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={[]} selection />
    </div>
  )
}

/** The ticked roles side by side: what money each sees, then every permission by area with the differences marked. */
function CompareModal({ model, picked, onClose }: { model: RolesViewModel; picked: readonly string[] | null; onClose: () => void }) {
  const t = useT('admin')
  const words = useRoleWords()
  if (picked === null) return null
  const chosen = picked.map((id) => (model.roles.items ?? []).find((role) => role.id === id)).filter((role): role is Role => !!role)
  return (
    <Modal open onClose={onClose} title={t('roles.compareTitle')} subtitle={t('roles.compareHint')} size="xxl" footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="fw-adm-modal-body">
        {!model.catalogue ? (
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
