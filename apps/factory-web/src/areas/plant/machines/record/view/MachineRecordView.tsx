'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, MoreHorizontal, Pencil, QrCode as QrIcon, TriangleAlert, Wrench } from 'lucide-react'
import { Card, EmptyState, KeyValue, Menu, SummaryTable, type TabItem } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { MachineRecord } from '../../../_shared/api'
import { ageWords, labelOf, personWords } from '../../../_shared/model'
import { Cost, JobPill, LiveLine, MachinePill, NoticeBanner, PlantMessages, RecordFrame, SymptomText, useWords } from '../../../_shared/parts'
import { MachineFields, machineDraftHeld } from '../../view/MachineFields'
import { RetireDialog } from '../../view/MachineDialogs'
import { MACHINE_TABS, type MachineRecordActions, type MachineRecordModel } from '../../view-model'

export type { MachineRecordActions, MachineRecordModel } from '../../view-model'

/**
 * SCR-150 — a machine (design plant.machines "Record: Machine", a record page): the band (‹ Machines & tools, the asset
 * number and type, its live status; Report a problem, New job for it, Print its tag; ⋯ Retire) and the W2a tabs:
 * Overview (the machine's facts — type, make, model, serial, year, site, line, station, work centre, the supplier and,
 * with the cost grain only, the purchase cost — with an explicit edit; the Now panel: status and why, the open job, the
 * open requests; checks, criticality and authorised operators come with W2b) and Maintenance history (every job of it,
 * newest first: date, type, problem, state, time from start to hand-back; failure codes and cost come later).
 */
export function MachineRecordView({ model, actions }: { model: MachineRecordModel; actions?: MachineRecordActions }) {
  return (
    <PlantMessages>
      <MachineRecordBody model={model} actions={actions} />
    </PlantMessages>
  )
}

function MachineRecordBody({ model, actions }: { model: MachineRecordModel; actions?: MachineRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const listHref = `${model.prefix}/plant/machines`
  const value = model.loaded.status === 'ready' ? model.loaded.value : null
  const machine = value?.card.machine ?? null
  const base = machine ? `${listHref}/${encodeURIComponent(machine.id)}` : listHref
  const tabs: TabItem[] = MACHINE_TABS.map((tab) => ({ id: tab, href: tab === 'overview' ? base : `${base}?tab=${tab}`, label: t(`machineTab.${tab}`), count: tab === 'history' && value ? value.history.length : null }))
  const retired = machine?.status === 'RETIRED'
  const manage = model.can.manageMachines && (value?.canManage ?? false)

  let title: ReactNode = null
  let meta: ReactNode = null
  let bandActions: ReactNode = null
  if (machine && value) {
    title = `${machine.assetNumber} · ${labelOf(machine.class, locale)}`
    meta = (
      <>
        <MachinePill status={machine.status} locked={machine.locked} />
        <Tag tone="neutral">{machine.siteCode}</Tag>
        {value.card.repeatFailure && (
          <Tag tone="warning">
            <AlertTriangle size={11} aria-hidden /> {t('detail.repeatFailure', { count: value.card.requestsIn30Days })}
          </Tag>
        )}
      </>
    )
    bandActions = (
      <span className="fw-pl-actions">
        <Button size="sm" asChild>
          <Link href={`${listHref}/tags?ids=${encodeURIComponent(machine.id)}`} target="_blank">
            <QrIcon size={14} aria-hidden /> {t('machines.printTag')}
          </Link>
        </Button>
        {!retired && (
          <Button size="sm" heldReason={model.can.manageJobs ? null : t('held.noManageJobs')} asChild={model.can.manageJobs}>
            {model.can.manageJobs ? (
              <Link href={`${model.prefix}/plant/jobs?new=1&machine=${encodeURIComponent(machine.id)}`}>
                <Wrench size={14} aria-hidden /> {t('machineRecord.newJob')}
              </Link>
            ) : (
              <>
                <Wrench size={14} aria-hidden /> {t('machineRecord.newJob')}
              </>
            )}
          </Button>
        )}
        {!retired && (
          <Button size="sm" variant="primary" heldReason={value.canReport ? null : t('held.noReport')} asChild={value.canReport}>
            {value.canReport ? (
              <Link href={`${model.prefix}/plant/requests?report=1&machine=${encodeURIComponent(machine.id)}`}>
                <TriangleAlert size={14} aria-hidden /> {t('requests.report')}
              </Link>
            ) : (
              <>
                <TriangleAlert size={14} aria-hidden /> {t('requests.report')}
              </>
            )}
          </Button>
        )}
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('record.more') }}
          items={[
            { id: 'jobs', label: t('record.machineJobs'), href: `${model.prefix}/plant/jobs?machine=${encodeURIComponent(machine.id)}&view=all` },
            ...(!retired && manage ? [{ id: 'retire', label: t('machineRecord.retire'), onSelect: () => actions?.onRetire?.() }] : []),
          ]}
        />
      </span>
    )
  }

  return (
    <RecordFrame
      backHref={listHref}
      backLabel={t('record.backMachines')}
      loaded={model.loaded}
      noun={t('record.machine')}
      title={title}
      meta={meta}
      actions={bandActions}
      status={<LiveLine asOf={model.asOf} live={model.live} />}
      tabs={tabs}
      tab={model.tab}
      onRetry={actions?.onRetry}
    >
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {value && model.tab === 'overview' && <Overview model={model} value={value} actions={actions} manage={manage} place={place} />}
      {value && model.tab === 'history' && <History model={model} value={value} place={place} />}
      {value && model.retire && (
        <RetireDialog machines={[value.card.machine]} reason={model.retire.reason} busy={model.retire.busy} problem={model.retire.problem} refused={[]} t={t} onReason={actions?.onRetireReason} onClose={actions?.onRetireClose} onSubmit={actions?.onRetireSubmit} />
      )}
    </RecordFrame>
  )
}

function Overview({ model, value, actions, manage, place }: { model: MachineRecordModel; value: MachineRecord; actions?: MachineRecordActions; manage: boolean; place: { locale: ReturnType<typeof useLocale>; timeZone: string } }) {
  const t = useWords()
  const locale = place.locale
  const machine = value.card.machine
  const retired = machine.status === 'RETIRED'
  const editHeld = !manage ? t('held.noManageMachines') : retired ? t('held.machineRetired') : null
  const heldKey = model.edit ? machineDraftHeld(model.edit, false, model.can) : null
  const applyHeld = heldKey ? t(heldKey) : model.busy ? t('held.busy') : null
  return (
    <div className="fw-pl-split">
      <Card padded>
        <div className="fw-pl-stack tight">
          <h3 className="fw-pl-h3">{t('machineRecord.facts')}</h3>
          {model.edit ? (
            <form
              className="fw-pl-dialog"
              onSubmit={(event) => {
                event.preventDefault()
                if (!applyHeld) actions?.onEditApply?.()
              }}
            >
              <MachineFields draft={model.edit} creating={false} sites={model.sites} classes={model.classes} suppliers={model.suppliers} field={model.field} can={model.can} onDraft={actions?.onDraft} onFindSupplier={actions?.onFindSupplier} />
              <span className="fw-pl-row">
                <Button size="sm" onClick={() => actions?.onEditCancel?.()}>
                  {t('common.discard')}
                </Button>
                <Button size="sm" variant="primary" type="submit" heldReason={applyHeld}>
                  {model.busy ? <Spinner size={12} /> : null} {t('common.apply')}
                </Button>
              </span>
            </form>
          ) : (
            <>
              <KeyValue
                dense
                labelCase="sentence"
                columns={2}
                items={[
                  { label: t('machine.assetNumber'), value: <span className="fw-pl-code">{machine.assetNumber}</span>, hint: t('machine.assetNumberFixed') },
                  { label: t('machine.type'), value: labelOf(machine.class, locale) },
                  { label: t('machine.make'), value: machine.make ?? '—' },
                  { label: t('machine.model'), value: machine.modelName ?? '—' },
                  { label: t('machine.serial'), value: machine.serialNumber ?? '—' },
                  { label: t('machine.year'), value: machine.year !== null ? String(machine.year) : '—' },
                  { label: t('machine.site'), value: machine.siteCode },
                  { label: t('col.line'), value: machine.line ? `${machine.line.code} · ${machine.line.name}` : '—' },
                  { label: t('machine.station'), value: machine.station ? `${machine.station.code} · ${machine.station.name}` : t('machine.noStation') },
                  { label: t('machine.workCentre'), value: machine.workCentre ? `${machine.workCentre.code} · ${machine.workCentre.name}` : '—' },
                  ...(model.can.parties ? [{ label: t('machine.supplier'), value: machine.supplier ? `${machine.supplier.code} · ${machine.supplier.name}` : '—' }] : []),
                  ...(model.can.cost ? [{ label: t('machine.cost'), value: <Cost minor={machine.purchaseCost} /> }] : []),
                  { label: t('record.criticality'), value: t('record.criticalityLater') },
                  { label: t('machine.note'), value: machine.note ?? '—' },
                ]}
              />
              <span>
                <Button size="sm" heldReason={editHeld} onClick={() => actions?.onEdit?.()}>
                  <Pencil size={13} aria-hidden /> {t('common.edit')}
                </Button>
              </span>
            </>
          )}
        </div>
      </Card>

      <Card padded>
        <aside className="fw-pl-stack tight" aria-label={t('machineRecord.now')}>
          <h3 className="fw-pl-h3">{t('machineRecord.now')}</h3>
          <span className="fw-pl-row">
            <MachinePill status={machine.status} locked={machine.locked} />
            <span className="fw-pl-hint">{t('machine.since', { time: formatDateTime(machine.statusSince, place) })}</span>
          </span>
          {machine.status !== 'RUNNING' && <p className={`fw-pl-text${machine.locked ? ' fw-pl-danger' : ''}`}>{t(`machineReason.${machine.locked ? 'LOCKED' : machine.status}`)}</p>}
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('detail.openJob'), value: value.card.openJob ? <Link className="fw-pl-link" href={`${model.prefix}/plant/jobs/${encodeURIComponent(value.card.openJob.id)}`}>{value.card.openJob.number}</Link> : t('detail.noOpenJob') },
              { label: t('detail.requests30'), value: String(value.card.requestsIn30Days) },
              { label: t('machineRecord.nextCheck'), value: t('machineRecord.nextCheckLater') },
              { label: t('machineRecord.operators'), value: t('machineRecord.operatorsLater') },
            ]}
          />
          <p className="fw-pl-h3">{t('machineRecord.openRequests', { count: value.openRequests.length })}</p>
          {value.openRequests.length === 0 ? (
            <p className="fw-pl-hint">{t('machineRecord.noOpenRequests')}</p>
          ) : (
            <ul className="fw-pl-plain">
              {value.openRequests.map((request) => (
                <li key={request.id} className="fw-pl-cell">
                  <Link className="fw-pl-link" href={`${model.prefix}/plant/requests?open=${encodeURIComponent(request.id)}`}>
                    <SymptomText symptom={request.symptom} description={request.description} />
                  </Link>
                  <span className="fw-pl-sub">
                    {formatDateTime(request.reportedAt, place)} · {personWords(t, request.reportedBy)} · {t(`requestStatus.${request.status}`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </Card>
    </div>
  )
}

function History({ model, value, place }: { model: MachineRecordModel; value: MachineRecord; place: { locale: ReturnType<typeof useLocale>; timeZone: string } }) {
  const t = useWords()
  if (value.history.length === 0) {
    return (
      <Card padded>
        <EmptyState title={t('machineRecord.noHistory')} description={t('machineRecord.noHistoryBody')} />
      </Card>
    )
  }
  return (
    <div className="fw-pl-stack tight">
      <SummaryTable
        label={t('machineTab.history')}
        density="roomy"
        columns={[t('col.number'), t('machineRecord.date'), t('field.type'), t('col.problem'), t('col.state'), t('machineRecord.time'), t('machineRecord.failureCode')]}
        align={[undefined, undefined, undefined, undefined, undefined, 'right', 'left']}
        rows={value.history.map((job) => ({
          id: job.id,
          cells: [
            <Link key="number" className="fw-pl-link fw-pl-code" href={`${model.prefix}/plant/jobs/${encodeURIComponent(job.id)}`}>
              {job.number}
            </Link>,
            formatDate(job.createdAt, place),
            t(`jobType.${job.type}`),
            job.problem,
            <JobPill key="state" status={job.status} />,
            job.startedAt && job.handedBack ? ageWords(t, Math.max(0, Math.round((new Date(job.handedBack.at).getTime() - new Date(job.startedAt).getTime()) / 60_000))) : '—',
            '—',
          ],
        }))}
      />
      <p className="fw-pl-hint">{t('machineRecord.historyFoot')}</p>
    </div>
  )
}
