'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { BellRing, MailOpen, RotateCcw } from 'lucide-react'
import { Banner, EmptyState, SourceIndicator } from '@nexus/ui/components'
import { Button, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import type { Cadence, EventKind, PreferenceChannel } from '@nexus/factory-domain/notifications/preferences/preferences'
import { CellSaveMark, Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { cellKey, cellOf, digestWaits, nextCell, NO_DEFAULT, pushWaits, SOURCE_KIND, type CellSave, type PreferencesModel, type RoleChoice } from '../model'
import '../preferences.css'

export interface PreferencesActions {
  onCell?: (event: EventKind, channel: PreferenceChannel, cadence: Cadence) => void
  onReset?: () => void
  /** Admins: show a role's defaults (null: the first). */
  onRole?: (roleId: string | null) => void
  onDefault?: (roleId: string, event: EventKind, channel: PreferenceChannel, cadence: Cadence | null) => void
  onRetry?: () => void
  /** The daily digest's time and days (the W2a digest dialog). */
  onDigest?: () => void
  /** Get urgent items on this phone. */
  onPush?: () => void
  onClose: () => void
}

/**
 * Notification preferences (design home.notifications popup preferences, W2b; PLT-141): the matrix of the seven kinds of news
 * by In app · E-mail · Push, each cell a cadence that saves at once (the DS CellSaveMark while it saves; a refusal on the cell),
 * where it comes from (SourceIndicator: my choice, "Default for <role>", the quiet default), Reset to my role's defaults; the
 * digest and push notes when a choice waits for them. An admin also sets the office roles' defaults (a role, the same matrix,
 * "No default"). Arrow keys move between cells, Esc closes. It draws ONE model.
 */
export function PreferencesDialog({ model, actions, initialTab = 'mine' }: { model: PreferencesModel; actions: PreferencesActions; initialTab?: 'mine' | 'roles' }) {
  return (
    <WithMessages namespaces={['home-mywork']}>
      <Preferences model={model} actions={actions} initialTab={initialTab} />
    </WithMessages>
  )
}

function Preferences({ model, actions, initialTab }: { model: PreferencesModel; actions: PreferencesActions; initialTab: 'mine' | 'roles' }) {
  const t = useT('home-mywork')
  const [tab, setTab] = useState<'mine' | 'roles'>(initialTab)
  const held = model.held ? t(model.held) : null
  const matrix = model.matrix.status === 'ready' ? model.matrix.data : null
  const showRoles = tab === 'roles' && matrix?.mayManageDefaults === true
  useEffect(() => {
    if (showRoles && model.defaults === null) actions.onRole?.(null)
  }, [showRoles, model.defaults, actions])
  const tableRef = useRef<HTMLTableElement>(null)
  const onMatrixKey = (event: KeyboardEvent<HTMLTableElement>) => {
    const target = event.target as HTMLElement
    const at = target.closest<HTMLElement>('[data-cell]')?.dataset.cell
    if (!at || !matrix) return
    const [eventKind, channel] = at.split(':') as [EventKind, PreferenceChannel]
    // A native select keeps ↑ / ↓ to change its value while it is open; ← / → and ↑ / ↓ with Alt move between cells.
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.altKey) return
    const next = nextCell(matrix.events, matrix.channels, { event: eventKind, channel }, event.key)
    if (!next) return
    event.preventDefault()
    tableRef.current?.querySelector<HTMLSelectElement>(`[data-cell="${cellKey(next.event, next.channel)}"] select`)?.focus()
  }

  return (
    <Modal
      open
      onClose={actions.onClose}
      size="lg"
      title={t('prefs.title')}
      footer={
        <span className="fw-prefs-footer">
          {matrix && tab === 'mine' && (
            <Button variant="secondary" heldReason={held ?? (matrix.cells.every((cell) => cell.source !== 'PERSON') ? t('prefs.held.nothingToReset') : null)} onClick={() => actions.onReset?.()}>
              <RotateCcw size={14} aria-hidden /> {t('prefs.reset')}
            </Button>
          )}
          <Button variant="primary" onClick={actions.onClose}>
            {t('prefs.close')}
          </Button>
        </span>
      }
    >
      <div className="fw-prefs">
        <p className="fw-prefs-muted">{t('prefs.body')}</p>
        {matrix?.mayManageDefaults && (
          <SegmentedControl
            ariaLabel={t('prefs.tabs')}
            size="sm"
            value={tab}
            onChange={(value) => setTab(value as 'mine' | 'roles')}
            options={[
              { value: 'mine', label: t('prefs.tab.mine') },
              { value: 'roles', label: t('prefs.tab.roles') },
            ]}
          />
        )}
        {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key)} />}
        {model.matrix.status === 'loading' ? (
          <div aria-busy="true" className="fw-prefs-loading">
            <p className="fw-prefs-muted" role="status">
              {t('loading')}
            </p>
            <Skeleton height={28} />
            <Skeleton height={28} />
            <Skeleton height={28} />
          </div>
        ) : model.matrix.status === 'error' ? (
          <Banner tone="danger" title={t('prefs.error')} action={<Button size="sm" onClick={() => actions.onRetry?.()}>{t('retry')}</Button>}>
            {t(model.matrix.problem)}
          </Banner>
        ) : matrix && !showRoles ? (
          <>
            {digestWaits(matrix) && (
              <Banner tone="warning" title={t('prefs.digestOff')} action={actions.onDigest ? <Button size="sm" onClick={actions.onDigest}><MailOpen size={13} aria-hidden /> {t('prefs.digestOpen')}</Button> : undefined} />
            )}
            {pushWaits(matrix) && (
              <Banner tone="info" title={t('prefs.pushNone')} action={actions.onPush ? <Button size="sm" onClick={actions.onPush}><BellRing size={13} aria-hidden /> {t('prefs.pushOpen')}</Button> : undefined} />
            )}
            <table ref={tableRef} className="fw-prefs-matrix" onKeyDown={onMatrixKey}>
              <caption className="fw-prefs-caption">{t('prefs.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('prefs.col.event')}</th>
                  {matrix.channels.map((channel) => (
                    <th key={channel} scope="col">
                      {t(`prefs.channel.${channel}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.events.map((event) => (
                  <tr key={event}>
                    <th scope="row">
                      <span className="fw-prefs-event">{t(`prefs.event.${event}.label`)}</span>
                      <span className="fw-prefs-muted">{t(`prefs.event.${event}.hint`)}</span>
                    </th>
                    {matrix.channels.map((channel) => {
                      const cell = cellOf(matrix.cells, event, channel)
                      if (!cell) return <td key={channel}>—</td>
                      const save = model.saving[cellKey(event, channel)]
                      const source = cell.source === 'ROLE' ? t('prefs.source.ROLE', { role: cell.role?.name ?? '' }) : t(`prefs.source.${cell.source}`)
                      return (
                        <td key={channel} data-cell={cellKey(event, channel)}>
                          <span className="fw-prefs-cell-label">{t(`prefs.channel.${channel}`)}</span>
                          <span className="fw-prefs-cell">
                            <Select
                              size="sm"
                              value={cell.cadence}
                              title={held ?? undefined}
                              aria-label={t('prefs.cellLabel', { event: t(`prefs.event.${event}.label`), channel: t(`prefs.channel.${channel}`) })}
                              onChange={(change) => actions.onCell?.(event, channel, change.target.value as Cadence)}
                            >
                              {cell.choices.map((choice) => (
                                <option key={choice} value={choice}>
                                  {t(`prefs.cadence.${choice}`)}
                                </option>
                              ))}
                            </Select>
                            <SourceIndicator kind={SOURCE_KIND[cell.source]} label={source} description={cell.source === 'QUIET' ? t('prefs.quietHint', { cadence: t(`prefs.cadence.${cell.quiet}`) }) : t(`prefs.sourceHint.${cell.source}`)} quiet={cell.source !== 'PERSON'} />
                            <SaveMark save={save} />
                          </span>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="fw-prefs-muted">{t('prefs.digestNote')}</p>
          </>
        ) : matrix && showRoles ? (
          <RoleDefaultsMatrix model={model} actions={actions} held={held} />
        ) : null}
      </div>
    </Modal>
  )
}

function SaveMark({ save }: { save: CellSave | undefined }) {
  const t = useT('home-mywork')
  if (!save) return null
  if (save.state === 'saving') return <CellSaveMark state="saving" />
  return (
    <span className="fw-prefs-failed" role="alert">
      {t(save.problem)}
    </span>
  )
}

/** The office roles' defaults (admins): a role, then the same matrix with "No default" (its holders get the quiet default). */
function RoleDefaultsMatrix({ model, actions, held }: { model: PreferencesModel; actions: PreferencesActions; held: string | null }) {
  const t = useT('home-mywork')
  const defaults = model.defaults
  if (!defaults || defaults.status === 'loading') return <Skeleton height={28} />
  if (defaults.status === 'error') {
    return (
      <Banner tone="danger" title={t('prefs.error')} action={<Button size="sm" onClick={() => actions.onRole?.(null)}>{t('retry')}</Button>}>
        {t(defaults.problem)}
      </Banner>
    )
  }
  const data = defaults.data
  if (data.roles.length === 0 || data.roleId === null) return <EmptyState title={t('prefs.roles.none')} description={t('prefs.roles.noneBody')} />
  const roleId = data.roleId
  const events = [...new Set(data.cells.map((cell) => cell.event))]
  const channels = [...new Set(data.cells.map((cell) => cell.channel))]
  return (
    <>
      <label className="fw-prefs-role">
        <span>{t('prefs.roles.pick')}</span>
        <Select size="sm" value={roleId} onChange={(change) => actions.onRole?.(change.target.value)}>
          {data.roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </Select>
      </label>
      <p className="fw-prefs-muted">{t('prefs.roles.body')}</p>
      <table className="fw-prefs-matrix">
        <caption className="fw-prefs-caption">{t('prefs.roles.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('prefs.col.event')}</th>
            {channels.map((channel) => (
              <th key={channel} scope="col">
                {t(`prefs.channel.${channel}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event}>
              <th scope="row">
                <span className="fw-prefs-event">{t(`prefs.event.${event}.label`)}</span>
              </th>
              {channels.map((channel) => {
                const cell = cellOf(data.cells, event, channel)
                if (!cell) return <td key={channel}>—</td>
                const value: RoleChoice = cell.cadence ?? NO_DEFAULT
                return (
                  <td key={channel} data-cell={cellKey(event, channel)}>
                    <span className="fw-prefs-cell-label">{t(`prefs.channel.${channel}`)}</span>
                    <span className="fw-prefs-cell">
                      <Select
                        size="sm"
                        value={value}
                        title={held ?? undefined}
                        aria-label={t('prefs.cellLabel', { event: t(`prefs.event.${event}.label`), channel: t(`prefs.channel.${channel}`) })}
                        onChange={(change) => actions.onDefault?.(roleId, event, channel, change.target.value === NO_DEFAULT ? null : (change.target.value as Cadence))}
                      >
                        <option value={NO_DEFAULT}>{t('prefs.roles.noDefault', { cadence: t(`prefs.cadence.${cell.quiet}`) })}</option>
                        {cell.choices.map((choice) => (
                          <option key={choice} value={choice}>
                            {t(`prefs.cadence.${choice}`)}
                          </option>
                        ))}
                      </Select>
                      <SaveMark save={model.defaultsSaving[cellKey(event, channel)]} />
                    </span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
