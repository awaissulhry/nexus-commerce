'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner, Card, Field, KeyValue, Tabs, type TabItem } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { FLOOR_DEVICE_MODES, type Device, type FloorDeviceMode } from '../../shared/api'
import { adminHref, STATUS_TONE } from '../../shared/model'
import { AdminMessages, dash, NoticeBanner, RecordProblem } from '../../shared/view/parts'
import { batteryOf, bindingOf, bindingProblem, DEVICE_TABS, deviceTileMatch, isOutdated, networkKey, showsLine, type BindingDraft, type DeviceRecordModel } from '../model'
// ---- B-TH-269: the device on RecordFrame (the band in the shell's row, the docked thread — notes only —, one notice) ----
import { RecordFrame } from '../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../_shared/record-frame/RecordNotices'
import { inUseSinceWords } from './columns'
import { EnrolWizard, RevokeConfirm } from './DeviceDialogs'

export type { DeviceRecordModel } from '../model'

export interface DeviceRecordActions {
  onSave?: (draft: BindingDraft) => Promise<boolean>
  onRenew?: (device: Device) => void
  onEnrolClose?: () => void
  onRevoke?: (open: boolean) => void
  onRevokeConfirm?: (device: Device) => Promise<boolean>
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-013 — a Device record (design 02 admin.devices "Record: Device"), on RecordFrame (B-TH-269; the rule of picture 38, the tabs of
 * 08-tabs O-ADM-DEV): the band in the shell's band row (‹ Devices, its name, ONE state pill, its kind and site and "in use" — never
 * who —; New enrolment code, held with why; the Thread button ⌘J, the frame's; ⋯ its Keyboard line), the docked thread beside both
 * tabs (notes only: an admin record has no party, W03; with threads.read and devices.view, B-TH-005; Activity's tools in its "⋯",
 * R-ACT) and the tabs 3 → 2: Station & mode (its name and station; moving to another site needs a new enrolment; B-W2b-67: the mode,
 * its line or person, changed while nobody is signed in) and Status (last seen, app version, "in use" — never who — a new enrolment
 * code for a replaced tablet, Revoke in the danger zone). Every banner in the ONE notice of the body column. The Printer tab is W1.
 */
// B-TH-269: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows.
export function DeviceRecordView({ model, actions, thread, printThread }: { model: DeviceRecordModel; actions?: DeviceRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <AdminMessages>
      <DeviceRecord model={model} actions={actions} thread={thread} printThread={printThread} />
    </AdminMessages>
  )
}

function DeviceRecord({ model, actions, thread, printThread }: { model: DeviceRecordModel; actions?: DeviceRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const t = useT('admin')
  const locale = useLocale()
  const href = (path: string) => adminHref(model.prefix, path)
  const back = { href: href('/devices'), label: t('nav.devices') }
  const device = model.device
  const frame = { recordType: 'Device', personId: model.personId ?? null, threadLabel: t('record.dockLabel') }
  const backLink = <Link href={back.href}>{back.label}</Link>

  // Not found, no right, a failed read, loading: the band and its state inside the frame, no thread yet.
  if (!device) {
    return (
      <RecordFrame {...frame} thread={null} band={{ back: backLink, title: model.problem ? t('nav.devices') : <Skeleton width={260} height={22} />, moreLabel: t('common.more') }}>
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
          <div className="fw-adm" aria-busy="true">
            <Skeleton height={220} />
          </div>
        )}
      </RecordFrame>
    )
  }
  const revoked = device.status === 'REVOKED'
  const tabs: TabItem[] = DEVICE_TABS.map((tab) => ({ id: tab, label: t(`device.tab.${tab}`), href: `${href(`/devices/${device.id}`)}?tab=${tab}` }))
  return (
    <>
      <RecordFrame
        {...frame}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back: backLink,
          title: device.name,
          status: <Pill tone={STATUS_TONE[device.status] ?? 'neutral'}>{t(`devices.status.${device.status}`)}</Pill>,
          meta: (
            <span className="fw-adm-tags">
              <span>{[t(`devices.kind.${device.kind}`), model.site?.name].filter(Boolean).join(' · ')}</span>
              {device.inUse && <Tag tone="info">{inUseSinceWords(device, { t, locale, now: new Date(model.now).getTime() }) ?? t('devices.inUse')}</Tag>}
            </span>
          ),
          primary: (
            <Button size="sm" onClick={() => actions?.onRenew?.(device)} heldReason={!model.can.manage ? t('held.needs', { right: t('right.devices_manage') }) : revoked ? t('device.held.revoked') : null}>
              {t('devices.newCode')}
            </Button>
          ),
          moreLabel: t('common.moreFor', { name: device.name }),
        }}
      >
        <div className="fw-adm">
          <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
          {/* B-TH-269: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
          <RecordNotices>
            {model.notice && <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />}
            {revoked && <Banner tone="info" title={t('device.revokedBanner')} />}
            {device.status === 'PENDING' && <Banner tone="info" title={t('device.pendingBanner')} />}
          </RecordNotices>
          {model.tab === 'binding' && <BindingTab model={model} actions={actions} />}
          {model.tab === 'status' && <StatusTab model={model} actions={actions} />}
        </div>
      </RecordFrame>
      <EnrolWizard model={model.enrol} sites={model.site ? [model.site] : []} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onEnrolClose?.()} onRenew={actions?.onRenew} />
      <RevokeConfirm device={model.revoking ? device : null} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onRevoke?.(false)} onRevoke={actions?.onRevokeConfirm} />
    </>
  )
}

function BindingTab({ model, actions }: { model: DeviceRecordModel; actions?: DeviceRecordActions }) {
  const t = useT('admin')
  const device = model.device!
  const read = useMemo(() => bindingOf(device), [device])
  const [draft, setDraft] = useState(model.draft ?? read)
  useEffect(() => setDraft(model.draft ?? read), [read, model.draft])
  const editable = model.can.manage && device.status !== 'REVOKED'
  const dirty = (Object.keys(read) as (keyof BindingDraft)[]).some((key) => draft[key] !== read[key])
  const problem = bindingProblem(draft)
  const station = model.site?.stations.find((item) => item.id === device.stationId)
  const line = model.site?.lines.find((item) => item.id === device.lineId)
  const person = model.people?.find((item) => item.id === device.personalWorkerId)
  // API rule (B-W2b-52): a mode or a person changes only while nobody is signed in on the device.
  const modeEditable = editable && !device.inUse
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
            {draft.mode !== 'PHONE' && (
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
            )}
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
      <Card header={t('device.mode.title')} description={t(`devices.deviceModeShows.${device.mode ?? 'STATION'}`)} headingLevel={2} padded>
        {device.inUse && editable && <Banner tone="info" title={t('device.mode.inUse')} />}
        {modeEditable ? (
          <div className="fw-adm-form">
            <Field label={t('devices.field.mode')}>
              <Select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as FloorDeviceMode, lineId: '', personalWorkerId: '' })}>
                {FLOOR_DEVICE_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`devices.deviceMode.${mode}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {showsLine(draft.mode) && (
              <Field label={t('devices.field.line')} required>
                <Select value={draft.lineId} onChange={(event) => setDraft({ ...draft, lineId: event.target.value })}>
                  <option value="">{t('devices.pickLine')}</option>
                  {(model.site?.lines ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code} · {item.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {draft.mode === 'PHONE' && (
              <Field label={t('devices.field.person')} required hint={model.people ? t('devices.field.personHint') : t('devices.peopleHeld')}>
                <Select value={draft.personalWorkerId} onChange={(event) => setDraft({ ...draft, personalWorkerId: event.target.value })}>
                  <option value="">{t('devices.pickPerson')}</option>
                  {(model.people ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        ) : (
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('devices.field.mode'), value: t(`devices.deviceMode.${device.mode ?? 'STATION'}`) },
              ...(line ? [{ label: t('devices.field.line'), value: `${line.code} · ${line.name}` }] : []),
              ...(person ? [{ label: t('devices.field.person'), value: person.name }] : []),
            ]}
          />
        )}
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

const yesNo = (value: boolean | null): 'yes' | 'no' | 'unknown' => (value === null ? 'unknown' : value ? 'yes' : 'no')

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
            // B-W2b-67 (PLT-227): the kiosk lock as the tablet last reported it; never "locked": Android does not say.
            ...(device.mode === 'PHONE' ? [] : [{ label: t('device.kiosk.title'), value: device.kiosk ? [t(`device.kiosk.fullScreen.${yesNo(device.kiosk.fullScreen)}`), t(`device.kiosk.installed.${yesNo(device.kiosk.installed)}`), t(`device.kiosk.home.${device.kiosk.homeTest}`)].join(' · ') : t('device.health.notReported'), ...(device.kiosk ? { hint: t('device.kiosk.at', { at: formatDateTime(device.kiosk.checkedAt, { locale }) }) } : {}) }]),
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
