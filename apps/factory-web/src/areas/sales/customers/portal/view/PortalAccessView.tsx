'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CircleX, ExternalLink, MessageSquarePlus, MoreHorizontal, Radio } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, CheckboxCard, Input, Skeleton, Tag, Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { previewHeld, progressApplies, settingsBody, settingsDraftOf, settingsProblems, type SettingsDraft } from '../../../../admin/users/partners/model'
import type { PortalAccessActions, PortalAccessModel, RequestRow } from '../model'
import { heldWords, NoticeLine, PortalAccessMessages, PortalStepUp, usePortalT } from './parts'
import { PeopleCard } from './PeopleCard'
import { PortalDialogs } from './PortalDialogs'

export type { PortalAccessActions, PortalAccessModel } from '../model'

/**
 * Customer › Portal access and Supplier › Portal access (B-W2b-180; design sales.customers rec:Customer/customer.portal,
 * purchasing.suppliers rec:Supplier/portal): the portal of one partner organisation as the office runs it —
 *  - Portal: the switch (the Owner's per-partner switch, OFF by default), the people it holds at most, the roles it offers,
 *    and for a customer or a brand the production-progress switch (Owner answer C1); explicit save (⌘S), a fresh code.
 *  - What they see: "Open preview" opens the portal exactly as they see it, read-only, in a new tab (an hour; recorded).
 *  - People with access: invite, the invitation again or revoked, change a role and the end of access, suspend,
 *    reactivate, deactivate — one by one or over the ticked rows; the live line "… signed in" while the tab is open.
 *  - Requests waiting for them (B-W2b-167): what we asked of them and still waits; ask for something; cancel.
 * Fetches nothing (areas/sales/customers/portal/PortalAccess.tsx reads and writes).
 */
export function PortalAccessView({ model, actions }: { model: PortalAccessModel; actions?: PortalAccessActions }) {
  return (
    <PortalAccessMessages>
      <PortalAccessTab model={model} actions={actions} />
    </PortalAccessMessages>
  )
}

function PortalAccessTab({ model, actions }: { model: PortalAccessModel; actions?: PortalAccessActions }) {
  const t = usePortalT()
  if (!model.can.view) return <EmptyState title={t('noAccess.title')} description={heldWords(t, 'right.view') ?? undefined} />
  if (model.problem && !model.access)
    return (
      <Card padded>
        <EmptyState
          title={t('failed.title')}
          description={t(model.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  if (!model.access)
    return (
      <div className="fw-pa" aria-busy="true">
        <Skeleton height={28} width="40%" />
        <div className="fw-pa-grid">
          <Skeleton height={220} />
          <Skeleton height={220} />
        </div>
        <Skeleton height={260} />
      </div>
    )
  return (
    <PortalDialogs model={model} actions={actions}>
      <div className="fw-pa">
        <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
        <LiveLine model={model} />
        {model.access.termsInForce === false && <Banner tone="warning" title={t('terms.missing')} />}
        <div className="fw-pa-grid">
          <SettingsCard model={model} actions={actions} />
          <PreviewCard model={model} actions={actions} />
        </div>
        <PeopleCard model={model} actions={actions} />
        <RequestsCard model={model} actions={actions} />
      </div>
      <PortalStepUp model={model.stepUp} onSubmit={actions?.onStepUp} onClose={actions?.onStepUpClose} />
    </PortalDialogs>
  )
}

/** The live line (design page.live "portal user signed in → Portal access"): who signed in while the tab is open. */
function LiveLine({ model }: { model: PortalAccessModel }) {
  const t = usePortalT()
  const locale = useLocale()
  return (
    <p className="fw-pa-live" role="status">
      <Radio size={13} aria-hidden />
      <span>{model.live === 'live' ? t('live.on') : model.live === 'offline' ? t('live.offline') : t('live.connecting')}</span>
      {model.asOf && <span className="fw-pa-muted">{t('live.asOf', { time: formatTime(model.asOf, { locale }) })}</span>}
      {model.signedIn && <Tag tone="success">{t(model.signedIn.first ? 'live.firstSignIn' : 'live.signedIn', { name: model.signedIn.name, time: formatTime(model.signedIn.at, { locale }) })}</Tag>}
    </p>
  )
}

function SettingsCard({ model, actions }: { model: PortalAccessModel; actions?: PortalAccessActions }) {
  const t = usePortalT()
  const access = model.access!
  const saved = access.settings
  const [draft, setDraft] = useState<SettingsDraft>(model.settingsDraft ?? settingsDraftOf(saved))
  // A save (or someone else's change) moves the version: the card starts again from what is stored.
  useEffect(() => setDraft(model.settingsDraft ?? settingsDraftOf(saved)), [saved.version, access.party.id])
  const body = settingsBody(saved, draft)
  const problems = settingsProblems(draft, access.seats)
  const count = body ? Object.keys(body).length - 1 : 0
  const held = model.can.manage ? (access.kinds.length === 0 ? t('held.noKind') : null) : heldWords(t, 'right.manage')
  const progress = progressApplies(access.kinds)
  const save = () => {
    if (!body || Object.keys(problems).length > 0 || model.busy) return
    void actions?.onSaveSettings?.(draft)
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && body) {
        event.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const offeredAll = draft.allowedRoleKeys.length === 0
  const mainRoles = access.roles
  const set = (patch: Partial<SettingsDraft>) => setDraft((current) => ({ ...current, ...patch }))
  return (
    <Card padded>
      <div className="fw-pa-head">
        <div className="fw-pa-head-text">
          <h2 className="fw-pa-h2">{t('settings.title')}</h2>
          <p className="fw-pa-hint">{t(`settings.intro.${model.side}`, { name: access.party.name })}</p>
        </div>
        <Tag tone={saved.portalOn ? 'success' : 'neutral'}>{t(saved.portalOn ? 'settings.on' : 'settings.off')}</Tag>
      </div>
      <div className="fw-pa-stack">
        <div className="fw-pa-switch">
          <Toggle checked={draft.portalOn} onChange={(next) => set({ portalOn: next })} disabled={held !== null} aria-label={t('settings.portalOn')} aria-describedby="fw-pa-on-hint" />
          <div className="fw-pa-switch-text">
            <span className="fw-pa-strong">{t('settings.portalOn')}</span>
            <span id="fw-pa-on-hint" className="fw-pa-hint">
              {held ?? t(draft.portalOn ? 'settings.portalOnHint' : 'settings.portalOffHint')}
            </span>
          </div>
        </div>
        {progress && (
          <div className="fw-pa-switch">
            <Toggle checked={draft.progressShared} onChange={(next) => set({ progressShared: next })} disabled={held !== null} aria-label={t('settings.progress')} aria-describedby="fw-pa-progress-hint" />
            <div className="fw-pa-switch-text">
              <span className="fw-pa-strong">{t('settings.progress')}</span>
              <span id="fw-pa-progress-hint" className="fw-pa-hint">
                {held ?? t('settings.progressHint')}
              </span>
            </div>
          </div>
        )}
        <Field label={t('settings.maxUsers')} hint={t('settings.maxUsersHint', { taken: access.seats.taken })} error={problems.maxUsers ? t(problems.maxUsers, { taken: access.seats.taken }) : undefined}>
          <Input inputMode="numeric" value={draft.maxUsers} onChange={(event) => set({ maxUsers: event.target.value.replace(/[^0-9]/g, '') })} placeholder={t('settings.noLimit')} disabled={held !== null} />
        </Field>
        {mainRoles.length > 0 && (
          <fieldset className="fw-pa-fieldset">
            <legend className="fw-pa-legend">{t('settings.roles')}</legend>
            <p className="fw-pa-hint">{t(offeredAll ? 'settings.rolesAll' : 'settings.rolesSome')}</p>
            <div className="fw-pa-cards fw-pa-cards-wide">
              {mainRoles.map((role) => {
                const on = offeredAll || draft.allowedRoleKeys.includes(role.key)
                return (
                  <CheckboxCard
                    key={role.key}
                    variant="row"
                    checked={on}
                    selected={on}
                    disabled={held !== null}
                    onChange={(event) => {
                      const current = offeredAll ? mainRoles.map((entry) => entry.key) : draft.allowedRoleKeys
                      const next = event.target.checked ? [...new Set([...current, role.key])] : current.filter((key) => key !== role.key)
                      set({ allowedRoleKeys: next.length === mainRoles.length ? [] : next })
                    }}
                    title={access.kinds.length > 1 ? `${t(`role.${role.key}`)} · ${t(`kind.${role.kind}`)}` : t(`role.${role.key}`)}
                    description={t(`roleLine.${role.key}`)}
                  />
                )
              })}
            </div>
          </fieldset>
        )}
      </div>
      {body && (
        <EditModeBar
          count={count}
          message={t('settings.unsaved', { count })}
          applyLabel={t('settings.save')}
          busy={model.busy}
          applyHeldReason={Object.keys(problems).length > 0 ? t('settings.fixFirst') : null}
          onDiscard={() => setDraft(settingsDraftOf(saved))}
          onApply={save}
          saveShortcut
        />
      )}
    </Card>
  )
}

/** What they see (design customer.portal.preview, new tab customers.portalPreview): the portal as they see it, read-only. */
function PreviewCard({ model, actions }: { model: PortalAccessModel; actions?: PortalAccessActions }) {
  const t = usePortalT()
  const access = model.access!
  const held = heldWords(t, previewHeld(access, model.can)) ?? (model.previewing ? t('preview.opening') : null)
  return (
    <Card padded>
      <div className="fw-pa-head">
        <div className="fw-pa-head-text">
          <h2 className="fw-pa-h2">{t('preview.title')}</h2>
          <p className="fw-pa-hint">{t(`preview.intro.${model.side}`, { name: access.party.name })}</p>
        </div>
      </div>
      <ul className="fw-pa-list">
        <li>{t('preview.readOnly')}</li>
        <li>{t('preview.hour')}</li>
        <li>{t('preview.recorded')}</li>
        {!access.settings.portalOn && <li>{t('preview.whileOff')}</li>}
      </ul>
      <div className="fw-pa-actions">
        <Button size="sm" heldReason={held} onClick={() => actions?.onPreview?.()}>
          <ExternalLink size={14} aria-hidden /> {t('preview.open')}
        </Button>
      </div>
    </Card>
  )
}

/** Requests waiting for them (B-W2b-167): what we asked of the party and still waits for their answer. */
function RequestsCard({ model, actions }: { model: PortalAccessModel; actions?: PortalAccessActions }) {
  const t = usePortalT()
  const locale = useLocale()
  const rows = model.requests.items
  const askHeld = !model.can.requests ? heldWords(t, 'right.requests') : model.access!.kinds.length === 0 ? t('held.noKind') : null
  const columns = useMemo<ColDef<RequestRow>[]>(() => {
    const WhatCell = ({ data }: ICellRendererParams<RequestRow>) => (data ? <span className="fw-pa-strong">{locale === 'en' ? data.words.en : data.words.it}</span> : null)
    const RecordCell = ({ data }: ICellRendererParams<RequestRow>) => (data ? <Link href={data.href}>{data.record.label}</Link> : null)
    const DueCell = ({ data }: ICellRendererParams<RequestRow>) =>
      data ? (
        <span className="fw-pa-cell">
          <span>{data.dueAt ? formatDate(data.dueAt, { locale }) : t('requests.noDue')}</span>
          {data.due === 'OVERDUE' ? <Tag tone="danger">{t('requests.overdue')}</Tag> : data.due === 'TODAY' ? <Tag tone="warning">{t('requests.today')}</Tag> : null}
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<RequestRow>) => {
      if (!data) return null
      const held = model.can.requests ? null : heldWords(t, 'right.requests')
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('requests.rowMenu', { what: locale === 'en' ? data.words.en : data.words.it }) }}
          items={[{ id: 'cancel', label: t('requests.cancel'), tone: 'danger', disabled: held !== null, ...(held ? { description: held } : {}), onSelect: () => actions?.onDialog?.({ kind: 'cancelRequest', requestIds: [data.id] }) }]}
        />
      )
    }
    return [
      { colId: 'what', headerName: t('requests.col.what'), minWidth: 240, flex: 1.8, valueGetter: (params) => (params.data ? (locale === 'en' ? params.data.words.en : params.data.words.it) : ''), cellRenderer: WhatCell },
      { colId: 'record', headerName: t('requests.col.record'), minWidth: 160, flex: 1, valueGetter: (params) => params.data?.record.label ?? '', cellRenderer: RecordCell },
      { colId: 'due', headerName: t('requests.col.due'), minWidth: 150, flex: 0.8, valueGetter: (params) => params.data?.dueAt ?? '', cellRenderer: DueCell },
      { colId: 'askedBy', headerName: t('requests.col.askedBy'), minWidth: 140, flex: 0.8, valueGetter: (params) => params.data?.askedBy ?? t('requests.system') },
      { colId: 'more', headerName: t('people.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.can.requests, actions])
  const picked = (rows ?? []).filter((row) => model.requests.selected.includes(row.id))
  const cancelHeld = !model.can.requests ? heldWords(t, 'right.requests') : picked.length === 0 ? t('held.nobody') : null
  const state = model.requests.problem ? (
    <EmptyState
      title={t('requests.failed')}
      description={t(model.requests.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetryRequests?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows && rows.length === 0 ? (
    <EmptyState title={t('requests.empty')} description={t('requests.emptyHint')} />
  ) : undefined
  return (
    <Card padded>
      <div className="fw-pa-head">
        <div className="fw-pa-head-text">
          <h2 className="fw-pa-h2">{t('requests.title')}</h2>
          <p className="fw-pa-hint">{t('requests.intro')}</p>
        </div>
        <div className="fw-pa-actions">
          <Button size="sm" heldReason={askHeld} onClick={() => actions?.onDialog?.({ kind: 'ask' })}>
            <MessageSquarePlus size={14} aria-hidden /> {t('requests.ask')}
          </Button>
        </div>
      </div>
      <ListFrame<RequestRow>
        label={t('requests.tableLabel')}
        listKey={null}
        rows={model.requests.problem ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('requests.count', { count: rows.length }) : '—'}
        selection={{
          selected: picked.map((row) => row.id),
          onChange: (ids: string[]) => actions?.onSelectedRequests?.(ids),
          actions: (
            <Button size="sm" variant="danger-outline" heldReason={cancelHeld} aria-label={t('requests.cancelN', { count: picked.length })} onClick={() => actions?.onDialog?.({ kind: 'cancelRequest', requestIds: picked.map((row) => row.id) })}>
              <CircleX size={13} aria-hidden /> <SelectionLabel>{cancelHeld ? t('requests.cancel') : t('requests.cancelN', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        onHelp={actions?.onHelp}
        state={state}
        cards={{ fields: { what: { role: 'title' }, due: { role: 'subtitle' } } }}
      />
    </Card>
  )
}
