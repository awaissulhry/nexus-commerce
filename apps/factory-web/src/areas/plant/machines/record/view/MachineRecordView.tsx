'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, FileWarning, FileX, Pencil, QrCode as QrIcon, ShieldOff, TriangleAlert, Wrench } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, SummaryTable, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { rightRef } from '../../../../../lib/i18n/rights'
import type { MachineRecord } from '../../../_shared/api'
import { ageWords, labelOf, personWords } from '../../../_shared/model'
import { Cost, JobPill, MachinePill, NoticeBanner, PlantMessages, SymptomText, useWords } from '../../../_shared/parts'
// ---- B-TH-265: the machine on RecordFrame (the band in the shell's row, the docked thread — notes only —, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'
// ---- end B-TH-265
import { changeHeld, nextCheckWords } from '../../depth/model'
import { DepthMessages, useDepthWords } from '../../depth/parts'
import { tagMachineOf } from '../../depth/use-tags'
import { DocumentsTab } from '../../depth/view/DocumentsTab'
import { ReleaseStepUp } from '../../depth/view/ReleaseStepUp'
import { StatusDialog } from '../../depth/view/StatusDialog'
import { StatusTab } from '../../depth/view/StatusTab'
import { TagTab } from '../../depth/view/TagTab'
import { TagsDialog } from '../../depth/view/TagsDialog'
import { MachineFields, machineDraftHeld } from '../../view/MachineFields'
import { RetireDialog } from '../../view/MachineDialogs'
import { MACHINE_TABS, type MachineRecordActions, type MachineRecordModel } from '../../view-model'

export type { MachineRecordActions, MachineRecordModel } from '../../view-model'

/**
 * SCR-150 — a machine (design plant.machines "Record: Machine", a record page), on RecordFrame (B-TH-265; the rule of picture 38): the
 * band in the shell's band row (‹ Machines & tools, the asset number and type, ONE live status pill, the site, the third-failure hint;
 * Report a problem as the primary with New job for it beside it; ⋯ Print its tag, every job of it, Change status, Copy the number,
 * Retire), the machine's thread docked beside every tab (new: the API had it, the page showed none; notes only — a machine's supplier
 * is no party of its maintenance; its tools in the thread's "⋯", R-ACT), ONE notice in the body column, and the tabs 5 → 4: Overview &
 * tag (the machine's facts — type, make, model, serial, year, site, line, station, work centre, the supplier and, with the cost grain
 * only, the purchase cost — with an explicit edit; the Now panel: status and why, the open job, the open requests; then the tag to
 * scale and its newest print), Documents & CE (kept: its own groups, on the tablets, CE on file, remove with a reason), Maintenance
 * history (every job of it, newest first) and Status & downtime. Every old ?tab= keeps working (R-8).
 */
// B-TH-265: `thread` is the docked thread (the office's OfficeRecordThread docked, or a design case's); `printThread` what the print view
// shows of it.
export function MachineRecordView({ model, actions, thread, printThread }: { model: MachineRecordModel; actions?: MachineRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <PlantMessages>
      <DepthMessages>
        <MachineRecordBody model={model} actions={actions} thread={thread} printThread={printThread} />
      </DepthMessages>
    </PlantMessages>
  )
}

function MachineRecordBody({ model, actions, thread, printThread }: { model: MachineRecordModel; actions?: MachineRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const listHref = `${model.prefix}/plant/machines`
  const value = model.loaded.status === 'ready' ? model.loaded.value : null
  const machine = value?.card.machine ?? null
  const base = machine ? `${listHref}/${encodeURIComponent(machine.id)}` : listHref
  const d = useDepthWords()
  const depth = model.depth
  const documents = depth?.documents.loaded.status === 'ready' ? depth.documents.loaded.value.documents.length : null
  const tabs: TabItem[] = MACHINE_TABS.filter((tab) => depth || tab === 'overview' || tab === 'history').map((tab) => ({
    id: tab,
    href: tab === 'overview' ? base : `${base}?tab=${tab}`,
    label: tab === 'overview' || tab === 'history' ? t(`machineTab.${tab}`) : d(`tab.${tab}`),
    count: tab === 'history' && value ? value.history.length : tab === 'docs' ? documents : null,
  }))
  const retired = machine?.status === 'RETIRED'
  const manage = model.can.manageMachines && (value?.canManage ?? false)
  const statusHeldKey = machine ? changeHeld(machine, { manage }) : null
  // `r` reports a problem for this machine (design kb "Record: r report a problem").
  const latest = useRef(actions)
  latest.current = actions
  const canReport = !!value?.canReport && !retired
  const quiet = !!(model.retire || depth?.status || depth?.tags || depth?.stepUp.open || depth?.documents.viewer || depth?.documents.remove || model.edit)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || quiet || !canReport) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'r') {
        event.preventDefault()
        latest.current?.depth?.onReport?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quiet, canReport])

  const back = <Link href={listHref}>{t('record.backMachines')}</Link>
  const frame = { recordType: 'Machine', personId: model.personId ?? null, threadLabel: t('record.dockLabelMachine') }

  // Loading, not found, no right, a failed read: the band and its state inside the frame, no thread yet.
  if (!machine || !value) {
    const loaded = model.loaded
    return (
      <RecordFrame {...frame} thread={null} band={{ back, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.machine'), moreLabel: t('record.more') }}>
        <div className="fw-pl-stack">
          {loaded.status === 'loading' ? (
            <Card padded aria-busy="true">
              <p className="fw-pl-hint" role="status">
                <Spinner size={14} /> {t('record.loading')}
              </p>
              <div className="fw-pl-stack tight">
                {Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} height={22} />
                ))}
              </div>
            </Card>
          ) : (
            <Card padded>
              <EmptyState
                icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
                title={t(loaded.status === 'error' ? 'record.failed' : loaded.status === 'forbidden' ? 'problem.forbidden' : 'record.notFound')}
                description={loaded.status === 'error' ? t(loaded.problem) : loaded.status === 'forbidden' ? t('problem.noPermission', { right: rightRef('plant.view') }) : t('record.notFoundBody')}
                action={
                  loaded.status === 'error' ? (
                    <Button size="sm" onClick={actions?.onRetry}>
                      {t('common.retry')}
                    </Button>
                  ) : (
                    <Button size="sm" asChild>
                      <Link href={listHref}>{t('record.backMachines')}</Link>
                    </Button>
                  )
                }
              />
            </Card>
          )}
        </div>
      </RecordFrame>
    )
  }

  const meta = (
    <>
      <Tag tone="neutral">{machine.siteCode}</Tag>
      {value.card.repeatFailure && (
        <Tag tone="warning">
          <AlertTriangle size={11} aria-hidden /> {t('detail.repeatFailure', { count: value.card.requestsIn30Days })}
        </Tag>
      )}
    </>
  )
  // The band's primary: Report a problem, and New job for it beside it (at most two actions; the rest in the ⋯).
  const primary = retired ? undefined : (
    <span className="fw-pl-actions">
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
      <Button size="sm" variant="primary" heldReason={value.canReport ? null : t('held.noReport')} asChild={value.canReport}>
        {value.canReport ? (
          <Link href={`${model.prefix}/plant/requests?report=1&machine=${encodeURIComponent(machine.id)}`} aria-keyshortcuts="r">
            <TriangleAlert size={14} aria-hidden /> {t('requests.report')}
          </Link>
        ) : (
          <>
            <TriangleAlert size={14} aria-hidden /> {t('requests.report')}
          </>
        )}
      </Button>
    </span>
  )
  const more: MenuItemDef[] = [
    { id: 'tag', label: t('machines.printTag'), icon: <QrIcon size={15} aria-hidden />, href: `${listHref}/tags?ids=${encodeURIComponent(machine.id)}`, target: '_blank' as const },
    { id: 'jobs', label: t('record.machineJobs'), href: `${model.prefix}/plant/jobs?machine=${encodeURIComponent(machine.id)}&view=all` },
    ...(depth ? [{ id: 'status', label: d('status.open'), onSelect: () => actions?.depth?.onOpenStatus?.(), disabled: statusHeldKey !== null, ...(statusHeldKey ? { description: d(statusHeldKey) } : {}) }] : []),
    { id: 'copy', label: t('record.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(machine.assetNumber).catch(() => undefined) },
    ...(!retired && manage ? [{ id: 'retire', label: t('machineRecord.retire'), tone: 'danger' as const, onSelect: () => actions?.onRetire?.() }] : []),
  ]

  return (
    <RecordFrame {...frame} thread={thread ?? null} printThread={printThread} band={{ back, title: `${machine.assetNumber} · ${labelOf(machine.class, locale)}`, status: <MachinePill status={machine.status} locked={machine.locked} />, meta, primary, more, moreLabel: t('record.more') }}>
      <div className="fw-pl-stack">
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

        {/* B-TH-265: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
          <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
          {/* The shell's band says the tab's live state; offline, the page says since when its figures are. */}
          {model.live === 'offline' && <Banner tone="warning" title={t('record.offline', { time: model.asOf ? formatTime(model.asOf, place) : '—' })} />}
        </RecordNotices>

        {/* B-TH-265: Overview & tag — the Overview body, then the Tag body, both as they are. */}
        {model.tab === 'overview' && (
          <>
            <Overview model={model} value={value} actions={actions} manage={manage} place={place} />
            {depth && (
              <TagTab
                machine={{ ...tagMachineOf(value.card.machine, locale) }}
                job={depth.tagJob}
                canPrint={depth.canPrint}
                sheetHref={`${listHref}/tags?ids=${encodeURIComponent(value.card.machine.id)}`}
                onPrint={actions?.depth?.onOpenTags}
                onRetry={actions?.depth?.onTagRetry}
              />
            )}
          </>
        )}
        {model.tab === 'history' && <History model={model} value={value} place={place} />}
        {depth && model.tab === 'docs' && <DocumentsTab state={depth.documents} canManage={manage} actions={actions?.depth} />}
        {depth && model.tab === 'status' && (
          <StatusTab loaded={depth.history.loaded} week={depth.history.week} today={depth.today} changeHeld={statusHeldKey} onWeek={actions?.depth?.onWeek} onChange={actions?.depth?.onOpenStatus} onRetry={actions?.depth?.onRetryHistory} />
        )}
      </div>
      {depth?.status && (
        <StatusDialog
          machine={value.card.machine}
          state={depth.status}
          can={{ manage, signSafe: model.can.signSafe }}
          onDraft={actions?.depth?.onStatusDraft}
          onClose={actions?.depth?.onStatusClose}
          onSubmit={actions?.depth?.onStatusSubmit}
        />
      )}
      {depth?.tags && (
        <TagsDialog
          state={depth.tags}
          canPrint={depth.canPrint}
          sheetHref={`${listHref}/tags?ids=${encodeURIComponent(value.card.machine.id)}`}
          onPrinter={actions?.depth?.onTagPrinter}
          onCopies={actions?.depth?.onTagCopies}
          onPrint={actions?.depth?.onTagPrint}
          onRetry={actions?.depth?.onTagRetry}
          onClose={actions?.depth?.onTagsClose}
        />
      )}
      {depth && <ReleaseStepUp state={depth.stepUp} onSubmit={actions?.depth?.onStepUpSubmit} onCancel={actions?.depth?.onStepUpCancel} />}
      {model.retire && (
        <RetireDialog machines={[value.card.machine]} reason={model.retire.reason} busy={model.retire.busy} problem={model.retire.problem} refused={[]} t={t} onReason={actions?.onRetireReason} onClose={actions?.onRetireClose} onSubmit={actions?.onRetireSubmit} />
      )}
    </RecordFrame>
  )
}

function Overview({ model, value, actions, manage, place }: { model: MachineRecordModel; value: MachineRecord; actions?: MachineRecordActions; manage: boolean; place: { locale: ReturnType<typeof useLocale>; timeZone: string } }) {
  const t = useWords()
  const d = useDepthWords()
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
              { label: t('machineRecord.nextCheck'), value: model.depth ? <NextCheck model={model} /> : t('machineRecord.nextCheckLater') },
              ...(model.depth ? [{ label: d('depth.ce'), value: <CeLine model={model} base={`${model.prefix}/plant/machines/${encodeURIComponent(machine.id)}`} /> }] : []),
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

/** The Now panel's next statutory check (B-W2b-124's plan), linking its plan in Preventive & statutory checks. */
function NextCheck({ model }: { model: MachineRecordModel }) {
  const d = useDepthWords()
  const locale = useLocale()
  const facts = model.depth?.facts ?? null
  const words = nextCheckWords(d, facts, (day) => formatDate(day, { locale, timeZone: 'UTC' }), (worded) => labelOf(worded, locale))
  if (!facts?.nextCheck) return <span>{words.text}</span>
  return (
    <Link className={words.state === 'OVERDUE' ? 'fw-pl-link fw-pl-danger' : 'fw-pl-link'} href={`${model.prefix}/plant/preventive?plan=${encodeURIComponent(facts.nextCheck.planId)}`}>
      {words.text}
    </Link>
  )
}

/** The Now panel's CE line: on file, or missing (art. 71) with the way to the Documents & CE tab. */
function CeLine({ model, base }: { model: MachineRecordModel; base: string }) {
  const d = useDepthWords()
  const facts = model.depth?.facts ?? null
  if (!facts) return <span>—</span>
  return facts.ceOnFile ? (
    <Link className="fw-pl-link" href={`${base}?tab=docs`}>
      {d('depth.ceOnFile')}
    </Link>
  ) : (
    <Link className="fw-pl-link fw-pl-danger" href={`${base}?tab=docs`}>
      <FileWarning size={12} aria-hidden /> {d('depth.ceMissing')}
    </Link>
  )
}
