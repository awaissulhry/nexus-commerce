'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Factory, Plus, Trash2 } from 'lucide-react'
import { Banner, Card, Field, KeyValue, Menu, Modal, SummaryTable } from '@nexus/ui/components'
import { EditModeBar } from '@nexus/ui/patterns'
import { Button, Input, NumberStepper, Pill, Select, Skeleton, Tag, Toggle } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WORK_CENTRE_KINDS, type SiteStructure, type Station, type WorkCentreKind } from '../../shared/api'
import { adminHref, STATUS_TONE } from '../../shared/model'
import { AdminMessages, dash, ListState, NoticeBanner, RecordProblem } from '../../shared/view/parts'
import { RecordFrame } from '../../shared/view/RecordFrame'
import {
  archiveUses,
  centreName,
  floorDraft,
  floorProblems,
  IDLE_RANGE,
  partProblems,
  sameFloor,
  structureGroups,
  takenCodes,
  type FloorDraft,
  type PartDraft,
  type SiteDialog,
  type SiteRecordModel,
  type SiteTab,
} from '../model'

export type { SiteRecordModel } from '../model'

export interface SiteRecordActions {
  onDialog?: (dialog: SiteDialog | null) => void
  onShowArchived?: (show: boolean) => void
  /** Each resolves true when done (the dialog then closes). */
  onCreate?: (kind: 'line' | 'station' | 'centre', draft: PartDraft) => Promise<boolean>
  onRename?: (target: 'line' | 'station' | 'centre', id: string, name: string) => Promise<boolean>
  onMove?: (stationId: string, lineId: string | null) => Promise<boolean>
  onArchive?: (target: 'line' | 'station' | 'centre' | 'site', id: string) => Promise<boolean>
  onSaveFloor?: (draft: FloorDraft) => Promise<boolean>
  onDock?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-009 — a Site record (design 02 admin.org "Record: Site"): Structure (lines with their stations, stations standing
 * alone), Work centres, Calendars (shift ends and the floor's idle sign-out; the Owner's F1 floor setting shown as
 * coming with the floor step), Devices (the site's tablets and printers) and Activity. Fetches nothing (SiteRecord.tsx).
 */
export function SiteRecordView({ model, actions, panels }: { model: SiteRecordModel; actions?: SiteRecordActions; panels?: ReactNode }) {
  return (
    <AdminMessages>
      <SiteRecord model={model} actions={actions} panels={panels} />
    </AdminMessages>
  )
}

function SiteRecord({ model, actions, panels }: { model: SiteRecordModel; actions?: SiteRecordActions; panels?: ReactNode }) {
  const t = useT('admin')
  const href = (path: string) => adminHref(model.prefix, path)
  const structure = model.structure
  const [dialog, setDialog] = useState<SiteDialog | null>(model.dialog ?? null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog])
  const open = (next: SiteDialog | null) => {
    setDialog(next)
    actions?.onDialog?.(next)
  }

  if (!structure) {
    if (model.problem)
      return (
        <div className="fw-adm">
          <RecordProblem
            problem={model.problem}
            onRetry={actions?.onRetry}
            back={
              <Button size="sm" asChild>
                <Link href={href('/companies')}>{t('record.backTo', { name: t('nav.companies') })}</Link>
              </Button>
            }
          />
        </div>
      )
    return (
      <div className="fw-adm" aria-busy="true">
        <Skeleton height={36} width="40%" />
        <Skeleton height={28} width="60%" />
        <Skeleton height={220} />
      </div>
    )
  }

  const { site, company } = structure
  const archived = site.status === 'ARCHIVED'
  const manage = model.can.manage && !archived
  const heldManage = !model.can.manage ? t('held.needs', { right: t('right.sites_manage') }) : archived ? t('site.held.archived') : null
  const tabs: Array<{ id: SiteTab; label: string; count?: number | null }> = [
    { id: 'structure', label: t('site.tab.structure'), count: structure.stations.filter((station) => station.status === 'ACTIVE').length },
    { id: 'centres', label: t('site.tab.centres'), count: structure.workCentres.filter((centre) => centre.status === 'ACTIVE').length },
    { id: 'calendars', label: t('site.tab.calendars') },
    ...(model.can.viewDevices ? [{ id: 'devices' as const, label: t('site.tab.devices'), count: model.devices.items ? model.devices.items.filter((device) => device.status !== 'REVOKED').length : null }] : []),
    { id: 'activity', label: t('site.tab.activity') },
  ]
  const tab = tabs.some((item) => item.id === model.tab) ? model.tab : 'structure'

  return (
    <div className="fw-adm">
      <RecordFrame
        back={{ href: `${href(`/companies/${company.id}`)}?tab=sites`, label: company.legalName }}
        title={
          <>
            <span className="fw-adm-code">{site.code}</span> {site.name}
          </>
        }
        meta={t(`org.kind.${site.kind}`)}
        status={<Pill tone={STATUS_TONE[site.status] ?? 'neutral'}>{t(`status.${site.status}`)}</Pill>}
        actions={
          <>
            <Button size="sm" onClick={() => open({ kind: 'line' })} heldReason={heldManage}>
              {t('site.addLine')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => open({ kind: 'station' })} heldReason={heldManage ?? (structure.workCentres.some((centre) => centre.status === 'ACTIVE') ? null : t('site.held.noCentre'))}>
              {t('site.addStation')}
            </Button>
            {manage && (
              <Menu
                label={t('common.more')}
                align="right"
                triggerProps={{ 'aria-label': t('common.moreFor', { name: site.name }) }}
                items={[{ id: 'archive', label: t('site.archive.action'), tone: 'danger', onSelect: () => open({ kind: 'archive', target: 'site', id: site.id }) }]}
              />
            )}
          </>
        }
        tabs={tabs}
        active={tab}
        tabHref={(id) => `${href(`/companies/${company.id}/sites/${site.id}`)}?tab=${id}`}
        dock={tab === 'activity' ? undefined : panels}
        dockOpen={model.dockOpen}
        onDock={actions?.onDock}
      >
        <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
        {archived && <Banner tone="info" title={t('site.archivedBanner')} />}
        {!model.can.manage && !archived && <Banner tone="info" title={t('record.readOnly')} />}
        {tab === 'structure' && <StructureTab model={model} structure={structure} manage={manage} open={open} actions={actions} />}
        {tab === 'centres' && <CentresTab model={model} structure={structure} manage={manage} open={open} actions={actions} />}
        {tab === 'calendars' && <CalendarsTab model={model} structure={structure} actions={actions} />}
        {tab === 'devices' && <DevicesTab model={model} structure={structure} />}
        {tab === 'activity' && panels}
      </RecordFrame>
      <PartDialog structure={structure} dialog={dialog} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => open(null)} actions={actions} />
    </div>
  )
}

function ShowArchived({ model, actions }: { model: SiteRecordModel; actions?: SiteRecordActions }) {
  const t = useT('admin')
  return (
    <label className="fw-adm-toggle-row">
      <Toggle size="sm" checked={model.showArchived} onChange={(next) => actions?.onShowArchived?.(next)} aria-label={t('org.showArchived')} />
      <span className="fw-adm-hint">{t('org.showArchived')}</span>
    </label>
  )
}

function StructureTab({ model, structure, manage, open, actions }: { model: SiteRecordModel; structure: SiteStructure; manage: boolean; open: (dialog: SiteDialog) => void; actions?: SiteRecordActions }) {
  const t = useT('admin')
  const groups = structureGroups(structure, model.showArchived)
  const empty = structure.lines.length === 0 && structure.stations.length === 0
  if (empty)
    return (
      <ListState
        loading={false}
        empty={{
          icon: <Factory size={24} aria-hidden />,
          title: t('site.structure.empty'),
          body: structure.workCentres.length === 0 ? t('site.structure.emptyCentres') : undefined,
          action: manage ? (
            <Button variant="primary" onClick={() => open({ kind: 'line' })}>
              {t('site.addLine')}
            </Button>
          ) : undefined,
        }}
      />
    )
  const stationMenu = (station: Station) => {
    const uses = archiveUses(structure, 'station', station.id)
    return (
      <Menu
        label={t('common.more')}
        align="right"
        triggerProps={{ 'aria-label': t('common.moreFor', { name: station.name }) }}
        items={[
          { id: 'rename', label: t('site.rename'), onSelect: () => open({ kind: 'rename', target: 'station', id: station.id }) },
          { id: 'move', label: t('site.move'), onSelect: () => open({ kind: 'move', stationId: station.id }) },
          { id: 'archive', label: t('site.archiveStation'), tone: 'danger', ...(uses.devices ? { disabled: true, description: t('site.held.stationDevices', { count: uses.devices }) } : {}), onSelect: () => open({ kind: 'archive', target: 'station', id: station.id }) },
        ]}
      />
    )
  }
  return (
    <div className="fw-adm-stack">
      <div className="fw-adm-toolbar">
        <ShowArchived model={model} actions={actions} />
        <span className="fw-adm-hint">{t('site.structure.hint')}</span>
      </div>
      {groups.map((group) => {
        const line = group.line
        const lineUses = line ? archiveUses(structure, 'line', line.id) : {}
        return (
          <Card
            key={line?.id ?? 'alone'}
            header={line ? `${line.code} · ${line.name}` : t('site.alone')}
            description={line ? t('site.line.stations', { count: group.stations.length }) : t('site.aloneHint')}
            headingLevel={2}
            headerAction={
              manage ? (
                <span className="fw-adm-actions">
                  <Button size="sm" variant="quiet" onClick={() => open({ kind: 'station', lineId: line?.id ?? null })}>
                    <Plus size={14} aria-hidden /> {t('site.addStationHere')}
                  </Button>
                  {line && (
                    <Menu
                      label={t('common.more')}
                      align="right"
                      triggerProps={{ 'aria-label': t('common.moreFor', { name: line.name }) }}
                      items={[
                        { id: 'rename', label: t('site.rename'), onSelect: () => open({ kind: 'rename', target: 'line', id: line.id }) },
                        { id: 'archive', label: t('site.archiveLine'), tone: 'danger', ...(lineUses.stations ? { disabled: true, description: t('site.held.lineStations', { count: lineUses.stations }) } : {}), onSelect: () => open({ kind: 'archive', target: 'line', id: line.id }) },
                      ]}
                    />
                  )}
                </span>
              ) : undefined
            }
          >
            {group.stations.length === 0 ? (
              <p className="fw-adm-hint">{t('site.line.empty')}</p>
            ) : (
              <SummaryTable
                label={t('site.structure.tableLabel', { name: line?.name ?? t('site.alone') })}
                density="roomy"
                stackOnPhone
                columns={[t('org.col.code'), t('org.col.name'), t('site.col.centre'), t('site.col.devices'), t('org.col.status'), t('common.actions')]}
                widths={['14%', '30%', '22%', '12%', '12%', '10%']}
                align={['left', 'left', 'left', 'left', 'left', 'right']}
                rows={group.stations.map((station) => ({
                  id: station.id,
                  cells: [
                    <span key="code" className="fw-adm-code">{station.code}</span>,
                    station.name,
                    dash(centreName(structure.workCentres, station.workCentreId)),
                    station.devices > 0 ? t('site.devicesBound', { count: station.devices }) : '—',
                    <Pill key="status" tone={STATUS_TONE[station.status] ?? 'neutral'}>{t(`status.${station.status}`)}</Pill>,
                    manage && station.status === 'ACTIVE' ? stationMenu(station) : '',
                  ],
                }))}
              />
            )}
          </Card>
        )
      })}
    </div>
  )
}

function CentresTab({ model, structure, manage, open, actions }: { model: SiteRecordModel; structure: SiteStructure; manage: boolean; open: (dialog: SiteDialog) => void; actions?: SiteRecordActions }) {
  const t = useT('admin')
  const centres = structure.workCentres.filter((centre) => model.showArchived || centre.status === 'ACTIVE')
  return (
    <div className="fw-adm-stack">
      <div className="fw-adm-toolbar">
        {manage && (
          <Button size="sm" onClick={() => open({ kind: 'centre' })}>
            <Plus size={14} aria-hidden /> {t('site.addCentre')}
          </Button>
        )}
        <ShowArchived model={model} actions={actions} />
        <span className="fw-adm-hint">{t('site.centres.hint')}</span>
      </div>
      {centres.length === 0 ? (
        <ListState loading={false} empty={{ title: t('site.centres.empty') }} />
      ) : (
        <Card>
          <SummaryTable
            label={t('site.tab.centres')}
            density="roomy"
            stackOnPhone
            columns={[t('org.col.code'), t('org.col.name'), t('org.col.kind'), t('site.col.stations'), t('org.col.status'), t('common.actions')]}
            align={['left', 'left', 'left', 'left', 'left', 'right']}
            rows={centres.map((centre) => {
              const uses = archiveUses(structure, 'centre', centre.id)
              return {
                id: centre.id,
                cells: [
                  <span key="code" className="fw-adm-code">{centre.code}</span>,
                  centre.name,
                  t(`site.centreKind.${centre.kind}`),
                  String(structure.stations.filter((station) => station.workCentreId === centre.id && station.status === 'ACTIVE').length),
                  <Pill key="status" tone={STATUS_TONE[centre.status] ?? 'neutral'}>{t(`status.${centre.status}`)}</Pill>,
                  manage && centre.status === 'ACTIVE' ? (
                    <Menu
                      key="menu"
                      label={t('common.more')}
                      align="right"
                      triggerProps={{ 'aria-label': t('common.moreFor', { name: centre.name }) }}
                      items={[
                        { id: 'rename', label: t('site.rename'), onSelect: () => open({ kind: 'rename', target: 'centre', id: centre.id }) },
                        { id: 'archive', label: t('site.archiveCentre'), tone: 'danger', ...(uses.stations ? { disabled: true, description: t('site.held.centreStations', { count: uses.stations }) } : {}), onSelect: () => open({ kind: 'archive', target: 'centre', id: centre.id }) },
                      ]}
                    />
                  ) : (
                    ''
                  ),
                ],
              }
            })}
          />
        </Card>
      )}
      <p className="fw-adm-hint">{t('site.centres.capacityLater')}</p>
    </div>
  )
}

function CalendarsTab({ model, structure, actions }: { model: SiteRecordModel; structure: SiteStructure; actions?: SiteRecordActions }) {
  const t = useT('admin')
  const settings = model.floor.settings
  const read = useMemo(() => (settings ? floorDraft(settings) : null), [settings])
  const [draft, setDraft] = useState<FloorDraft | null>(model.floorDraft ?? read)
  useEffect(() => setDraft(model.floorDraft ?? read), [read, model.floorDraft])
  const editable = model.can.manageDevices && structure.site.status === 'ACTIVE'
  const problems = draft ? floorProblems(draft) : {}
  const dirty = !!draft && !!read && !sameFloor(draft, read)
  return (
    <div className="fw-adm-stack">
      {!model.can.viewDevices ? (
        <Banner tone="info" title={t('held.needs', { right: t('right.devices_view') })} />
      ) : model.floor.problem ? (
        <ListState loading={false} problem={model.floor.problem} onRetry={actions?.onRetry} />
      ) : !draft ? (
        <ListState loading />
      ) : (
        <Card header={t('site.floor.title')} description={t('site.floor.hint', { zone: structure.site.timezone })} headingLevel={2} padded>
          <div className="fw-adm-form-col">
            <Field label={t('site.floor.idle')} hint={t('site.floor.idleHint', { min: IDLE_RANGE.min, max: IDLE_RANGE.max })} error={problems.idleMinutes ? t(problems.idleMinutes, IDLE_RANGE) : undefined}>
              <NumberStepper
                value={draft.idleMinutes}
                min={IDLE_RANGE.min}
                max={IDLE_RANGE.max}
                disabled={!editable}
                suffix={t('site.floor.minutes')}
                decrementLabel={t('site.floor.less')}
                incrementLabel={t('site.floor.more')}
                onChange={(next) => setDraft({ ...draft, idleMinutes: next })}
              />
            </Field>
            <Field label={t('site.floor.shiftEnds')} hint={t('site.floor.shiftEndsHint')} error={problems.shiftEnds ? t(problems.shiftEnds) : undefined} htmlFor="shift-end-0">
              <ul className="fw-adm-list">
                {draft.shiftEnds.length === 0 && <li className="fw-adm-hint">{t('site.floor.noShifts')}</li>}
                {draft.shiftEnds.map((end, index) => (
                  <li key={index} className="fw-adm-shift-row">
                    <Input
                      id={`shift-end-${index}`}
                      type="time"
                      size="sm"
                      value={end}
                      readOnly={!editable}
                      aria-label={t('site.floor.shiftEnd', { n: index + 1 })}
                      aria-invalid={problems[`shiftEnds/${index}`] ? true : undefined}
                      onChange={(event) => setDraft({ ...draft, shiftEnds: draft.shiftEnds.map((item, at) => (at === index ? event.target.value : item)) })}
                    />
                    {editable && (
                      <Button size="sm" variant="quiet" aria-label={t('site.floor.removeShift', { time: end || '—' })} onClick={() => setDraft({ ...draft, shiftEnds: draft.shiftEnds.filter((_, at) => at !== index) })}>
                        <Trash2 size={14} aria-hidden />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Field>
            {editable && (
              <span>
                <Button size="sm" onClick={() => setDraft({ ...draft, shiftEnds: [...draft.shiftEnds, ''] })}>
                  <Plus size={14} aria-hidden /> {t('site.floor.addShift')}
                </Button>
              </span>
            )}
            <KeyValue labelCase="sentence" items={[{ label: t('org.field.timezone'), value: structure.site.timezone, hint: t('site.floor.zoneHint') }]} />
          </div>
        </Card>
      )}
      {model.can.viewDevices && draft && (
        <Card header={t('site.badge.title')} description={t('site.badge.hint')} headingLevel={2} padded>
          {editable ? (
            <div className="fw-adm-toggles">
              <label className="fw-adm-toggle-row">
                <span>{t('site.badge.switch')}</span>
                <Toggle checked={draft.badgeOnlySignIn} onChange={(next) => setDraft({ ...draft, badgeOnlySignIn: next })} aria-label={t('site.badge.switch')} />
              </label>
              <p className="fw-adm-hint">{t(draft.badgeOnlySignIn ? 'site.badge.on' : 'site.badge.off')}</p>
            </div>
          ) : (
            <div className="fw-adm-toggles">
              <KeyValue labelCase="sentence" items={[{ label: t('site.badge.switch'), value: t(draft.badgeOnlySignIn ? 'site.badge.stateOn' : 'site.badge.stateOff'), hint: t(draft.badgeOnlySignIn ? 'site.badge.on' : 'site.badge.off') }]} />
              <p className="fw-adm-hint">{structure.site.status === 'ACTIVE' ? t('held.needs', { right: t('right.devices_manage') }) : t('site.held.archived')}</p>
            </div>
          )}
        </Card>
      )}
      <p className="fw-adm-hint">{t('site.floor.holidaysLater')}</p>
      {editable && dirty && draft && (
        <EditModeBar
          count={1}
          message={t('form.unsaved', { count: 1 })}
          applyLabel={t('common.save')}
          busy={model.busy}
          saveShortcut
          applyHeldReason={Object.keys(problems).length > 0 ? t('form.fixFirst', { count: Object.keys(problems).length }) : null}
          onDiscard={() => setDraft(read)}
          onApply={() => void actions?.onSaveFloor?.(draft)}
        />
      )}
    </div>
  )
}

function DevicesTab({ model, structure }: { model: SiteRecordModel; structure: SiteStructure }) {
  const t = useT('admin')
  const locale = useLocale()
  const href = (path: string) => adminHref(model.prefix, path)
  const { site } = structure
  const devices = model.devices.items
  const printers = model.printers.items
  const station = (id: string | null) => structure.stations.find((item) => item.id === id)?.name ?? null
  return (
    <div className="fw-adm-stack">
      <Card
        header={t('site.devices.tablets')}
        headingLevel={2}
        headerAction={
          model.can.manageDevices && site.status === 'ACTIVE' ? (
            <Button size="sm" variant="primary" asChild>
              <Link href={`${href('/devices')}?enrol=${site.id}`}>{t('devices.enrol')}</Link>
            </Button>
          ) : undefined
        }
      >
        {devices === null || model.devices.problem ? (
          <ListState loading={devices === null} problem={model.devices.problem} />
        ) : devices.length === 0 ? (
          <p className="fw-adm-hint">{t('site.devices.empty')}</p>
        ) : (
          <SummaryTable
            label={t('site.devices.tablets')}
            density="roomy"
            stackOnPhone
            columns={[t('org.col.name'), t('devices.col.station'), t('org.col.status'), t('devices.col.lastSeen')]}
            rows={devices.map((device) => ({
              id: device.id,
              cells: [
                <Link key="name" className="fw-adm-name" href={href(`/devices/${device.id}`)}>
                  {device.name}
                </Link>,
                dash(station(device.stationId)),
                <span key="status" className="fw-adm-tags">
                  <Pill tone={STATUS_TONE[device.status] ?? 'neutral'}>{t(`devices.status.${device.status}`)}</Pill>
                  {device.inUse && <Tag tone="info">{t('devices.inUse')}</Tag>}
                </span>,
                device.lastSeenAt ? formatDateTime(device.lastSeenAt, { locale, timeZone: site.timezone }) : '—',
              ],
            }))}
          />
        )}
      </Card>
      {model.can.viewPrinters && (
        <Card
          header={t('site.devices.printers')}
          headingLevel={2}
          headerAction={
            model.can.manageDevices && site.status === 'ACTIVE' ? (
              <Button size="sm" asChild>
                <Link href={`${href('/devices')}?mode=printers&new=printer&site=${site.id}`}>{t('printers.add')}</Link>
              </Button>
            ) : undefined
          }
        >
          {printers === null || model.printers.problem ? (
            <ListState loading={printers === null} problem={model.printers.problem} />
          ) : printers.length === 0 ? (
            <p className="fw-adm-hint">{t('printers.empty.body')}</p>
          ) : (
            <SummaryTable
              label={t('site.devices.printers')}
              density="roomy"
              stackOnPhone
              columns={[t('org.col.code'), t('org.col.name'), t('org.col.kind'), t('org.col.status')]}
              rows={printers.map((printer) => ({
                id: printer.id,
                cells: [<span key="code" className="fw-adm-code">{printer.code}</span>, printer.name, t(`printers.kind.${printer.kind}`), <Pill key="status" tone={STATUS_TONE[printer.status] ?? 'neutral'}>{t(`printers.status.${printer.status}`)}</Pill>],
              }))}
            />
          )}
        </Card>
      )}
    </div>
  )
}

const BLANK: PartDraft = { code: '', name: '', kind: 'SEWING', workCentreId: '', lineId: '' }

function PartDialog({ structure, dialog, busy, problem, onClose, actions }: { structure: SiteStructure; dialog: SiteDialog | null; busy: boolean; problem: string | null; onClose: () => void; actions?: SiteRecordActions }) {
  const t = useT('admin')
  const [draft, setDraft] = useState<PartDraft>(BLANK)
  const [tried, setTried] = useState(false)
  const activeCentres = structure.workCentres.filter((centre) => centre.status === 'ACTIVE')
  const activeLines = structure.lines.filter((line) => line.status === 'ACTIVE')
  useEffect(() => {
    setTried(false)
    if (!dialog) return
    if (dialog.kind === 'station') setDraft({ ...BLANK, lineId: dialog.lineId ?? '', workCentreId: activeCentres[0]?.id ?? '' })
    else if (dialog.kind === 'rename') {
      const rows: ReadonlyArray<{ id: string; name: string }> = dialog.target === 'line' ? structure.lines : dialog.target === 'centre' ? structure.workCentres : structure.stations
      setDraft({ ...BLANK, name: rows.find((row) => row.id === dialog.id)?.name ?? '' })
    } else if (dialog.kind === 'move') setDraft({ ...BLANK, lineId: structure.stations.find((station) => station.id === dialog.stationId)?.lineId ?? '' })
    else setDraft(BLANK)
  }, [dialog])
  if (!dialog) return null

  const footer = (label: string, run: () => Promise<boolean> | undefined, held: string | null = null, tone: 'primary' | 'danger' = 'primary') => (
    <>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button
        variant={tone}
        heldReason={held ?? (busy ? t('common.saving') : null)}
        onClick={() => {
          setTried(true)
          void run()
        }}
      >
        {label}
      </Button>
    </>
  )

  if (dialog.kind === 'line' || dialog.kind === 'station' || dialog.kind === 'centre') {
    const kind = dialog.kind
    const problems = partProblems(kind, draft, takenCodes(structure, kind))
    const ready = Object.keys(problems).length === 0
    const shown = (field: string) => (tried && problems[field] ? t(problems[field]!) : undefined)
    const run = () => (ready ? actions?.onCreate?.(kind, { ...draft, code: draft.code.trim().toUpperCase() }) : undefined)
    return (
      <Modal open onClose={onClose} title={t(`site.dialog.${kind}.title`)} subtitle={t(`site.dialog.${kind}.hint`, { site: structure.site.name })} size="sm" busy={busy} footer={footer(t(`site.dialog.${kind}.create`), run, tried && !ready ? t('form.fixFirst', { count: Object.keys(problems).length }) : null)}>
        <form
          className="fw-adm-modal-body"
          onSubmit={(event) => {
            event.preventDefault()
            setTried(true)
            void run()
          }}
        >
          {problem && <Banner tone="danger" title={t(problem)} />}
          <Field label={t('org.field.code')} hint={t('site.field.codeHint')} required error={shown('code')}>
            <Input autoFocus className="fw-adm-code" value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('org.col.name')} required error={shown('name')}>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          {kind === 'centre' && (
            <Field label={t('org.col.kind')}>
              <Select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as WorkCentreKind })}>
                {WORK_CENTRE_KINDS.map((item) => (
                  <option key={item} value={item}>
                    {t(`site.centreKind.${item}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {kind === 'station' && (
            <>
              <Field label={t('site.col.centre')} required error={shown('workCentreId')} hint={t('site.field.centreHint')}>
                <Select value={draft.workCentreId} onChange={(event) => setDraft({ ...draft, workCentreId: event.target.value })}>
                  {activeCentres.map((centre) => (
                    <option key={centre.id} value={centre.id}>
                      {centre.code} · {centre.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('site.field.line')}>
                <Select value={draft.lineId} onChange={(event) => setDraft({ ...draft, lineId: event.target.value })}>
                  <option value="">{t('site.alone')}</option>
                  {activeLines.map((line) => (
                    <option key={line.id} value={line.id}>
                      {line.code} · {line.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </form>
      </Modal>
    )
  }

  if (dialog.kind === 'rename') {
    const ready = draft.name.trim() !== ''
    const run = () => (ready ? actions?.onRename?.(dialog.target, dialog.id, draft.name.trim()) : undefined)
    return (
      <Modal open onClose={onClose} title={t('site.dialog.rename.title')} size="sm" busy={busy} footer={footer(t('common.save'), run, tried && !ready ? t('form.required') : null)}>
        <form
          className="fw-adm-modal-body"
          onSubmit={(event) => {
            event.preventDefault()
            setTried(true)
            void run()
          }}
        >
          {problem && <Banner tone="danger" title={t(problem)} />}
          <Field label={t('org.col.name')} required error={tried && !ready ? t('form.required') : undefined}>
            <Input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
        </form>
      </Modal>
    )
  }

  if (dialog.kind === 'move') {
    const station = structure.stations.find((item) => item.id === dialog.stationId)
    return (
      <Modal open onClose={onClose} title={t('site.dialog.move.title', { name: station?.name ?? '' })} size="sm" busy={busy} footer={footer(t('site.dialog.move.go'), () => actions?.onMove?.(dialog.stationId, draft.lineId || null))}>
        <div className="fw-adm-modal-body">
          {problem && <Banner tone="danger" title={t(problem)} />}
          <Field label={t('site.field.line')}>
            <Select autoFocus value={draft.lineId} onChange={(event) => setDraft({ ...draft, lineId: event.target.value })}>
              <option value="">{t('site.alone')}</option>
              {activeLines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.code} · {line.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    )
  }

  // archive
  const uses = archiveUses(structure, dialog.target, dialog.id)
  const usedBy = Object.entries(uses)
  const name =
    dialog.target === 'site'
      ? structure.site.name
      : ((dialog.target === 'line' ? structure.lines : dialog.target === 'centre' ? structure.workCentres : structure.stations) as ReadonlyArray<{ id: string; name: string }>).find((row) => row.id === dialog.id)?.name ?? ''
  return (
    <Modal
      open
      onClose={onClose}
      title={t('site.dialog.archive.title', { name })}
      size="sm"
      busy={busy}
      footer={footer(t('site.dialog.archive.go'), () => (usedBy.length === 0 ? actions?.onArchive?.(dialog.target, dialog.id) : undefined), usedBy.length > 0 ? t('site.dialog.archive.held') : null, 'danger')}
    >
      <div className="fw-adm-modal-body">
        {problem && <Banner tone="danger" title={t(problem)} />}
        <p className="fw-adm-intro">{t('site.dialog.archive.body')}</p>
        {usedBy.length > 0 && (
          <Banner tone="warning" title={t('site.dialog.archive.uses')}>
            <ul className="fw-adm-guards">
              {usedBy.map(([kind, count]) => (
                <li key={kind}>{t(`problem.inUseBy.${kind}`, { count })}</li>
              ))}
            </ul>
          </Banner>
        )}
      </div>
    </Modal>
  )
}
