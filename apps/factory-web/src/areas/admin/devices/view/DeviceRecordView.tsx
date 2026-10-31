'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { EditModeBar } from '@nexus/ui/patterns'
import { Button, Input, Pill, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Device } from '../../shared/api'
import { adminHref, STATUS_TONE } from '../../shared/model'
import { AdminMessages, dash, NoticeBanner, RecordProblem } from '../../shared/view/parts'
import { RecordFrame } from '../../shared/view/RecordFrame'
import { batteryOf, deviceTileMatch, isOutdated, networkKey, type DeviceRecordModel, type DeviceTab } from '../model'
import { inUseSinceWords } from './columns'
import { EnrolWizard, RevokeConfirm } from './DeviceDialogs'

export type { DeviceRecordModel } from '../model'

export interface DeviceRecordActions {
  onSave?: (draft: { name: string; stationId: string }) => Promise<boolean>
  onRenew?: (device: Device) => void
  onEnrolClose?: () => void
  onRevoke?: (open: boolean) => void
  onRevokeConfirm?: (device: Device) => Promise<boolean>
  onDock?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-013 — a Device record (design 02 admin.devices "Record: Device"): Station & mode (its name and station; moving to
 * another site needs a new enrolment; the mode comes with the floor step), Status (last seen, app version, "in use" —
 * never who — a new enrolment code for a replaced tablet, Revoke in the danger zone) and Activity. The Printer tab is W1.
 */
export function DeviceRecordView({ model, actions, panels }: { model: DeviceRecordModel; actions?: DeviceRecordActions; panels?: ReactNode }) {
  return (
    <AdminMessages>
      <DeviceRecord model={model} actions={actions} panels={panels} />
    </AdminMessages>
  )
}

function DeviceRecord({ model, actions, panels }: { model: DeviceRecordModel; actions?: DeviceRecordActions; panels?: ReactNode }) {
  const t = useT('admin')
  const locale = useLocale()
  const href = (path: string) => adminHref(model.prefix, path)
  const back = { href: href('/devices'), label: t('nav.devices') }
  const device = model.device
  if (!device) {
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
  const revoked = device.status === 'REVOKED'
  const tabs: Array<{ id: DeviceTab; label: string }> = [
    { id: 'binding', label: t('device.tab.binding') },
    { id: 'status', label: t('device.tab.status') },
    { id: 'activity', label: t('device.tab.activity') },
  ]
  return (
    <div className="fw-adm">
      <RecordFrame
        back={back}
        title={device.name}
        meta={[t(`devices.kind.${device.kind}`), model.site?.name].filter(Boolean).join(' · ')}
        status={
          <span className="fw-adm-tags">
            <Pill tone={STATUS_TONE[device.status] ?? 'neutral'}>{t(`devices.status.${device.status}`)}</Pill>
            {device.inUse && <Tag tone="info">{inUseSinceWords(device, { t, locale, now: new Date(model.now).getTime() }) ?? t('devices.inUse')}</Tag>}
          </span>
        }
        actions={
          <Button size="sm" onClick={() => actions?.onRenew?.(device)} heldReason={!model.can.manage ? t('held.needs', { right: t('right.devices_manage') }) : revoked ? t('device.held.revoked') : null}>
            {t('devices.newCode')}
          </Button>
        }
        tabs={tabs}
        active={model.tab}
        tabHref={(tab) => `${href(`/devices/${device.id}`)}?tab=${tab}`}
        dock={model.tab === 'activity' ? undefined : panels}
        dockOpen={model.dockOpen}
        onDock={actions?.onDock}
      >
        <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
        {revoked && <Banner tone="info" title={t('device.revokedBanner')} />}
        {device.status === 'PENDING' && <Banner tone="info" title={t('device.pendingBanner')} />}
        {model.tab === 'binding' && <BindingTab model={model} actions={actions} />}
        {model.tab === 'status' && <StatusTab model={model} actions={actions} />}
        {model.tab === 'activity' && panels}
      </RecordFrame>
      <EnrolWizard model={model.enrol} sites={model.site ? [model.site] : []} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onEnrolClose?.()} onRenew={actions?.onRenew} />
      <RevokeConfirm device={model.revoking ? device : null} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onRevoke?.(false)} onRevoke={actions?.onRevokeConfirm} />
    </div>
  )
}

function BindingTab({ model, actions }: { model: DeviceRecordModel; actions?: DeviceRecordActions }) {
  const t = useT('admin')
  const device = model.device!
  const read = useMemo(() => ({ name: device.name, stationId: device.stationId ?? '' }), [device])
  const [draft, setDraft] = useState(model.draft ?? read)
  useEffect(() => setDraft(model.draft ?? read), [read, model.draft])
  const editable = model.can.manage && device.status !== 'REVOKED'
  const dirty = draft.name !== read.name || draft.stationId !== read.stationId
  const problem = draft.name.trim() === '' ? 'form.required' : null
  const station = model.site?.stations.find((item) => item.id === device.stationId)
  return (
    <div className="fw-adm-stack">
      <Card header={t('device.binding.title')} description={t('device.binding.hint')} headingLevel={2} padded>
        {editable ? (
          <div className="fw-adm-form">
            <Field label={t('devices.field.name')} required error={problem ? t(problem) : undefined}>
              <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label={t('devices.field.kind')}>
              <Input value={t(`devices.kind.${device.kind}`)} readOnly />
            </Field>
            <Field label={t('devices.field.site')} hint={t('device.binding.siteHint')}>
              <Input value={model.site?.name ?? '—'} readOnly />
            </Field>
            <Field label={t('devices.field.station')}>
              <Select value={draft.stationId} onChange={(event) => setDraft({ ...draft, stationId: event.target.value })}>
                <option value="">{t('devices.noStation')}</option>
                {(model.site?.stations ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : (
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('devices.field.name'), value: device.name },
              { label: t('devices.field.kind'), value: t(`devices.kind.${device.kind}`) },
              { label: t('devices.field.site'), value: dash(model.site?.name) },
              { label: t('devices.field.station'), value: dash(station?.name) },
            ]}
          />
        )}
      </Card>
      <Card header={t('device.mode.title')} headingLevel={2} padded>
        <Tag tone="info">{t('device.mode.coming')}</Tag>
        <p className="fw-adm-hint">{t('device.mode.later')}</p>
      </Card>
      {editable && dirty && (
        <EditModeBar
          count={1}
          message={t('form.unsaved', { count: 1 })}
          applyLabel={t('common.save')}
          busy={model.busy}
          saveShortcut
          applyHeldReason={problem ? t('form.fixFirst', { count: 1 }) : null}
          onDiscard={() => setDraft(read)}
          onApply={() => void actions?.onSave?.(draft)}
        />
      )}
    </div>
  )
}

function StatusTab({ model, actions }: { model: DeviceRecordModel; actions?: DeviceRecordActions }) {
  const t = useT('admin')
  const locale = useLocale()
  const device = model.device!
  const now = new Date(model.now).getTime()
  const silent = deviceTileMatch('notSeen', device, now)
  // B-W2a-42: what the tablet last said of itself (app version against the server's, battery, actions waiting).
  const battery = batteryOf(device)
  const outdated = isOutdated(device, model.currentVersion)
  const reported = device.statusReportedAt ? t('device.health.reportedAt', { at: formatDateTime(device.statusReportedAt, { locale }) }) : undefined
  const network = networkKey(device)
  return (
    <div className="fw-adm-stack">
      <Card header={t('device.health.title')} headingLevel={2} padded>
        {silent && device.lastSeenAt && <Banner tone="warning" title={t('device.health.silent', { at: formatDateTime(device.lastSeenAt, { locale }) })} />}
        {outdated && <Banner tone="info" title={t('device.health.outdated', { version: model.currentVersion ?? '' })} />}
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('devices.col.lastSeen'), value: device.lastSeenAt ? formatDateTime(device.lastSeenAt, { locale }) : '—' },
            { label: t('devices.col.version'), value: dash(device.appVersion), ...(outdated ? { hint: t('devices.outdatedTag') } : {}) },
            {
              label: t('devices.col.battery'),
              value: battery
                ? [t('devices.battery.percent', { percent: battery.percent }), battery.charging ? t('devices.battery.charging') : null, battery.low ? t('devices.battery.lowTag') : null].filter(Boolean).join(' · ')
                : t(device.statusReportedAt ? 'devices.battery.unknown' : 'device.health.notReported'),
              ...(reported ? { hint: reported } : {}),
            },
            {
              label: t('device.health.queued'),
              value: device.queuedActions === null || device.queuedActions === undefined ? t('device.health.notReported') : t('device.health.queuedValue', { count: device.queuedActions }),
              ...(reported ? { hint: reported } : {}),
            },
            { label: t('device.health.enrolled'), value: device.enrolledAt ? formatDateTime(device.enrolledAt, { locale }) : '—' },
            // B-W2b-24: the network as the tablet said it; since when someone is signed in (never who).
            { label: t('device.health.network'), value: network ? t(network) : t(device.statusReportedAt ? 'devices.network.unknown' : 'device.health.notReported'), ...(reported ? { hint: reported } : {}) },
            { label: t('device.health.inUse'), value: device.inUse ? (inUseSinceWords(device, { t, locale, now }) ?? t('device.health.inUseYes')) : t('device.health.inUseNo'), hint: t('device.health.neverWho') },
            ...(device.revokedAt ? [{ label: t('device.health.revoked'), value: formatDateTime(device.revokedAt, { locale }) }] : []),
          ]}
        />
        <p className="fw-adm-hint">{t('device.health.later')}</p>
      </Card>
      {device.status !== 'REVOKED' && (
        <Card header={t('record.dangerZone')} headingLevel={2} padded>
          <div className="fw-adm-danger-row">
            <div>
              <strong>{t('devices.revoke.action')}</strong>
              <span className="fw-adm-hint">{t('devices.revoke.cardBody')}</span>
            </div>
            <Button size="sm" variant="danger-outline" heldReason={model.can.revoke ? null : t('held.needs', { right: t('right.devices_revoke') })} onClick={() => actions?.onRevoke?.(true)}>
              {t('devices.revoke.action')}
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}
