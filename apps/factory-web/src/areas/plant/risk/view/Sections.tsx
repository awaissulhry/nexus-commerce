'use client'

import { useEffect, useMemo } from 'react'
import Link from 'next/link'
import { ClipboardList, FileText, Printer, ShieldCheck, Users } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { DueCell } from '@nexus/ui/components/DueCell/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { siteColumn } from '../../../../shell/scope/scope-context'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { Assessment, MeasureView, SheetRow } from '../api'
import { addressText, assessmentsOf, LAW, localName, MEASURE_VIEWS, planPrintHref, recordHref, roleSheetsHref, sheetsOf, signingVersion, surveillanceWords, versionNo, withAddress } from '../model'
import type { RiskPageActions, RiskPageModel } from '../view-model'
import { useMeasureColumns, withheldCost } from './MeasureParts'
import { InForcePill, Law, PAGE_KEYS, SectionFailed, SectionHead, SectionLoading, SignersLine, useDay, useWhen, useWords } from './parts'

const openNewTab = (href: string) => window.open(href, '_blank', 'noopener')

/**
 * Assessments (design sec dvrs): one DVR per site or production unit, the top bar's site (with "All sites" a Site column and
 * the chip) — the assessment, the version in force with its certain date, who signed (employer, RSPP, RLS, doctor ✓), the
 * author, the next review (DueCell), open measures and roles. A row opens the record (its name is a link: ⌘-click a new
 * tab). Print plan N and Print role sheets N over the rows chosen. Empty: "Add the current DVR".
 */
export function AssessmentsSection({ model, actions, onHelp }: { model: RiskPageModel; actions?: RiskPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const { scope, address } = model
  const answer = model.assessments.status === 'ready' ? model.assessments.value : null
  const rows = useMemo(() => (answer ? assessmentsOf(answer.assessments, address.tile) : null), [answer, address.tile])
  const selected = model.selected?.assessments ?? []
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.onSelected?.({ assessments: selected.filter((id) => rows.some((row) => row.id === id)) })
  }, [rows, selected, actions])

  const columns = useMemo<ColDef<Assessment>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<Assessment>) =>
      data ? (
        <span className="fw-rk-cell">
          <Link href={recordHref(model.prefix, data.id)} className="fw-rk-strong">
            {data.name}
          </Link>
          {!scope.allSites && data.name !== data.site.name ? <span className="fw-rk-muted">{data.site.name}</span> : null}
        </span>
      ) : null
    const VersionCell = ({ data }: ICellRendererParams<Assessment>) =>
      data ? (
        <span className="fw-rk-cell">
          <InForcePill version={data.inForce} />
          {data.waiting ? <span className="fw-rk-warn">{t('version.waitingShort', { version: versionNo(data.waiting) })}</span> : null}
        </span>
      ) : null
    const SignedCell = ({ data }: ICellRendererParams<Assessment>) => {
      const version = data ? signingVersion(data) : null
      return version ? <SignersLine signers={version.signers} /> : data ? <span className="fw-rk-muted">—</span> : null
    }
    const ReviewCell = ({ data }: ICellRendererParams<Assessment>) => (data ? <DueCell value={data.nextReviewOn} today={model.today} formatDate={(iso) => day(iso)} labels={{ ...ds.dueCell, validUntil: (text) => t('due.on', { date: text }), none: t('review.none') }} /> : null)
    const MeasuresCell = ({ data }: ICellRendererParams<Assessment>) =>
      data ? (
        <span className="fw-rk-cell">
          <span>{t('assessments.open', { count: data.openMeasures })}</span>
          {data.overdueMeasures > 0 ? <span className="fw-rk-danger">{t('assessments.overdue', { count: data.overdueMeasures })}</span> : null}
        </span>
      ) : null
    const site = siteColumn<Assessment>(scope, (row) => row.siteId, t('assessments.col.site'))
    return [
      { colId: 'name', headerName: t('assessments.col.name'), minWidth: 200, flex: 1.3, valueGetter: (params) => params.data?.name ?? '', cellRenderer: NameCell },
      ...(site ? [site] : []),
      { colId: 'version', headerName: t('assessments.col.version'), minWidth: 210, flex: 1.2, valueGetter: (params) => params.data?.inForce?.certainDateOn ?? '', cellRenderer: VersionCell },
      { colId: 'signed', headerName: t('assessments.col.signed'), minWidth: 220, flex: 1.2, sortable: false, valueGetter: (params) => (params.data ? (signingVersion(params.data)?.signers.filter((signer) => signer.signedOn).length ?? 0) : 0), cellRenderer: SignedCell },
      { colId: 'author', headerName: t('assessments.col.author'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? (signingVersion(params.data)?.authorName ?? '—') : '') },
      { colId: 'review', headerName: t('assessments.col.review'), minWidth: 170, flex: 0.9, valueGetter: (params) => params.data?.nextReviewOn ?? '', cellRenderer: ReviewCell },
      { colId: 'measures', headerName: t('assessments.col.measures'), minWidth: 130, flex: 0.7, valueGetter: (params) => params.data?.openMeasures ?? 0, cellRenderer: MeasuresCell },
      { colId: 'roles', headerName: t('assessments.col.roles'), minWidth: 90, flex: 0.5, cellClass: 'fw-rk-num', valueGetter: (params) => params.data?.roles ?? 0 },
    ]
  }, [t, ds, day, scope, model.prefix, model.today])

  const head = (
    <SectionHead id="fw-rk-dvrs" title={t('assessments.title')} note={<Law law={answer?.law ?? LAW.dvr} plain={t('law.dvr')} />}>
      {address.tile === 'reviews' || address.tile === 'signatures' ? (
        <Button size="sm" variant="quiet" aria-label={t('filter.clear')} onClick={() => actions?.onAddress?.({ tile: null })}>
          {t(`filter.${address.tile}`)} ×
        </Button>
      ) : null}
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )
  if (model.assessments.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('assessments.failed')} problem={model.assessments.problem} onRetry={actions?.onRetryAssessments} />
      </>
    )
  }
  if (!answer || !rows) {
    return (
      <>
        {head}
        <SectionLoading rows={3} />
      </>
    )
  }
  const picked = rows.filter((row) => selected.includes(row.id))
  const addHeld = !model.can.manage ? t('held.manage') : !model.companyId ? t('held.company') : null
  return (
    <>
      {head}
      <ListFrame<Assessment>
        label={t('assessments.label')}
        title={t('assessments.title')}
        listKey="plant.risk"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('assessments.count', { count: rows.length })}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.({ assessments: ids }),
          actions: (
            <>
              <Button size="sm" aria-label={t('bulk.plans', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : null} onClick={() => openNewTab(planPrintHref(model.prefix, { assessments: picked.map((row) => row.id) }))}>
                <Printer size={13} aria-hidden /> <SelectionLabel>{t('bulk.plans', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onGo?.(recordHref(model.prefix, row.id))}
        state={
          rows.length === 0 ? (
            address.tile ? (
              <EmptyState icon={<ShieldCheck size={22} aria-hidden />} title={t('assessments.noneFiltered')} description={t(`filter.${address.tile}None`)} />
            ) : (
              <EmptyState
                icon={<FileText size={22} aria-hidden />}
                title={t('assessments.emptyTitle')}
                description={t('assessments.empty')}
                action={
                  <Button size="sm" variant="primary" heldReason={addHeld} onClick={() => actions?.onAddress?.({ add: 'version' })}>
                    {t('assessments.addCurrent')}
                  </Button>
                }
              />
            )
          ) : undefined
        }
        cards={{ fields: { name: { role: 'title' }, version: { role: 'subtitle' } }, hrefOf: (row) => recordHref(model.prefix, row.id) }}
      />
    </>
  )
}

/**
 * Improvement plan (design sec measures, QHS-234): every measure of the top bar's site — "all sites" with All sites — as the
 * API's own views (open by default, late, due in 30 days, mine, done, cancelled, all), with inline owner, due and status.
 * A row opens its assessment's plan tab. Print N over the rows chosen. Empty: "No open measures."
 */
export function MeasuresSection({ model, actions, onHelp }: { model: RiskPageModel; actions?: RiskPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const { scope, address } = model
  const answer = model.measures.status === 'ready' ? model.measures.value : null
  const rows = answer?.measures ?? null
  const selected = model.selected?.measures ?? []
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.onSelected?.({ measures: selected.filter((id) => rows.some((row) => row.id === id)) })
  }, [rows, selected, actions])
  const columns = useMeasureColumns({ frame: model, cells: model.cells, owners: model.owners, site: scope.allSites, evidence: false, hrefOf: (row) => recordHref(model.prefix, row.assessmentId, { tab: 'plan', measure: row.id }), actions })
  const title = scope.allSites ? t('measures.titleAll') : t('measures.title')
  const head = (
    <SectionHead id="fw-rk-measures" title={title} note={<Law law={answer?.law ?? LAW.plan} plain={t('law.plan')} />}>
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )
  if (model.measures.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('measures.failed')} problem={model.measures.problem} onRetry={actions?.onRetryMeasures} />
      </>
    )
  }
  if (!answer || !rows) {
    return (
      <>
        {head}
        <SectionLoading rows={5} />
      </>
    )
  }
  const picked = rows.filter((row) => selected.includes(row.id))
  return (
    <>
      {head}
      <ListFrame
        label={t('measures.label')}
        title={title}
        listKey="plant.risk.2"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('measures.count', { count: rows.length })}
        search={
          <Select size="sm" value={address.view} aria-label={t('measures.viewLabel')} onChange={(event) => actions?.onAddress?.({ view: event.target.value as MeasureView })}>
            {MEASURE_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`view.${view}`)}
              </option>
            ))}
          </Select>
        }
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.({ measures: ids }),
          actions: (
            <Button size="sm" aria-label={t('bulk.print', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : null} onClick={() => openNewTab(planPrintHref(model.prefix, { ids: picked.map((row) => row.id), view: 'all' }))}>
              <Printer size={13} aria-hidden /> <SelectionLabel>{t('bulk.print', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onGo?.(recordHref(model.prefix, row.assessmentId, { tab: 'plan', measure: row.id }))}
        more={answer.complete ? null : { label: t('measures.more'), onMore: () => undefined, held: t('measures.moreHeld') }}
        withheld={withheldCost(t, model.can.cost)}
        state={rows.length === 0 ? <EmptyState icon={<ClipboardList size={22} aria-hidden />} title={t(address.view === 'open' ? 'measures.empty' : 'measures.noneInView')} description={t('measures.emptyHint')} /> : undefined}
        cards={{ fields: { title: { role: 'title' }, status: { role: 'subtitle' } }, hrefOf: (row) => recordHref(model.prefix, row.assessmentId, { tab: 'plan', measure: row.id }) }}
      />
    </>
  )
}

/**
 * Role sheets (design sec roles; QHS-236): the index of roles and what they require — role, site, people, risks, PPE items,
 * courses, surveillance, last changed. A row opens the sheet (J / K walk the index); Print N role sheets over the rows chosen
 * (given to the worker at induction); Add role for the safety officer.
 */
export function RolesSection({ model, actions, onHelp }: { model: RiskPageModel; actions?: RiskPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const locale = useLocale()
  const when = useWhen()
  const { scope, address } = model
  const answer = model.sheets.status === 'ready' ? model.sheets.value : null
  const rows = useMemo(() => (answer ? sheetsOf(answer.roleSheets, address.tile) : null), [answer, address.tile])
  const selected = model.selected?.sheets ?? []
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.onSelected?.({ sheets: selected.filter((id) => rows.some((row) => row.id === id)) })
  }, [rows, selected, actions])
  const columns = useMemo<ColDef<SheetRow>[]>(() => {
    const RoleCell = ({ data }: ICellRendererParams<SheetRow>) =>
      data ? (
        <span className="fw-rk-cell">
          <Link href={`${model.prefix}/plant/risk${addressText(withAddress(address, { sheet: data.id }))}`} className="fw-rk-strong" scroll={false}>
            {localName(data, locale)}
          </Link>
          <span className="fw-rk-muted fw-rk-code">{data.code}</span>
        </span>
      ) : null
    const CountCell = (field: 'ppeItems' | 'courses') => ({ data }: ICellRendererParams<SheetRow>) =>
      data ? data[field] === 0 ? <Pill tone="warning">{t(field === 'ppeItems' ? 'roles.noKit' : 'roles.noCourses')}</Pill> : <span>{data[field]}</span> : null
    const SurveillanceCell = ({ data }: ICellRendererParams<SheetRow>) => {
      if (!data) return null
      const words = surveillanceWords(data.surveillance)
      return <span>{t(words.key, words.params)}</span>
    }
    const site = siteColumn<SheetRow>(scope, (row) => row.siteId, t('roles.col.site'))
    return [
      { colId: 'role', headerName: t('roles.col.role'), minWidth: 190, flex: 1.3, valueGetter: (params) => (params.data ? localName(params.data, locale) : ''), cellRenderer: RoleCell },
      ...(site ? [site] : []),
      { colId: 'people', headerName: t('roles.col.people'), minWidth: 90, flex: 0.5, cellClass: 'fw-rk-num', valueGetter: (params) => params.data?.people ?? 0 },
      { colId: 'risks', headerName: t('roles.col.risks'), minWidth: 90, flex: 0.5, cellClass: 'fw-rk-num', valueGetter: (params) => params.data?.risks ?? 0 },
      { colId: 'ppe', headerName: t('roles.col.ppe'), minWidth: 110, flex: 0.6, valueGetter: (params) => params.data?.ppeItems ?? 0, cellRenderer: CountCell('ppeItems') },
      { colId: 'courses', headerName: t('roles.col.courses'), minWidth: 110, flex: 0.6, valueGetter: (params) => params.data?.courses ?? 0, cellRenderer: CountCell('courses') },
      { colId: 'surveillance', headerName: t('roles.col.surveillance'), minWidth: 170, flex: 1, valueGetter: (params) => (params.data ? t(surveillanceWords(params.data.surveillance).key, surveillanceWords(params.data.surveillance).params) : ''), cellRenderer: SurveillanceCell },
      { colId: 'updated', headerName: t('roles.col.updated'), minWidth: 150, flex: 0.8, valueGetter: (params) => (params.data ? when(params.data.updatedAt) : '') },
    ]
  }, [t, locale, when, scope, model.prefix, address])

  const canAdd = model.can.sheets && (answer?.canAdd ?? true)
  const head = (
    <SectionHead id="fw-rk-roles" title={t('roles.title')} note={<Law law={answer?.law.roleSheet ?? LAW.roleSheet} plain={t('law.roleSheet')} />}>
      <Input size="sm" type="search" value={address.q} placeholder={t('roles.search')} aria-label={t('roles.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />
      {address.tile === 'roles' && (
        <Button size="sm" variant="quiet" aria-label={t('filter.clear')} onClick={() => actions?.onAddress?.({ tile: null })}>
          {t('filter.roles')} ×
        </Button>
      )}
      <Button size="sm" heldReason={canAdd ? (model.companyId ? null : t('held.company')) : t('held.sheets')} onClick={() => actions?.onAddress?.({ add: 'role' })}>
        <Users size={13} aria-hidden /> {t('roles.add')}
      </Button>
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )
  if (model.sheets.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('roles.failed')} problem={model.sheets.problem} onRetry={actions?.onRetrySheets} />
      </>
    )
  }
  if (!answer || !rows) {
    return (
      <>
        {head}
        <SectionLoading rows={4} />
      </>
    )
  }
  const picked = rows.filter((row) => selected.includes(row.id))
  return (
    <>
      {head}
      <ListFrame<SheetRow>
        label={t('roles.label')}
        title={t('roles.title')}
        listKey="plant.risk.3"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('roles.count', { count: rows.length })}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.({ sheets: ids }),
          actions: (
            <Button size="sm" aria-label={t('bulk.sheets', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : null} onClick={() => openNewTab(roleSheetsHref(model.prefix, picked.map((row) => row.id)))}>
              <Printer size={13} aria-hidden /> <SelectionLabel>{t('bulk.sheets', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ sheet: row.id })}
        more={answer.complete ? null : { label: t('roles.more'), onMore: () => undefined, held: t('roles.moreHeld') }}
        state={
          rows.length === 0 ? (
            address.q || address.tile ? (
              <EmptyState icon={<Users size={22} aria-hidden />} title={t('roles.noneFiltered')} description={t('roles.noneFilteredHint')} />
            ) : (
              <EmptyState
                icon={<Users size={22} aria-hidden />}
                title={t('roles.emptyTitle')}
                description={t('roles.empty')}
                action={
                  canAdd && model.companyId ? (
                    <Button size="sm" variant="primary" onClick={() => actions?.onAddress?.({ add: 'role' })}>
                      {t('roles.addFirst')}
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : undefined
        }
        cards={{ fields: { role: { role: 'title' }, surveillance: { role: 'subtitle' } } }}
      />
    </>
  )
}
