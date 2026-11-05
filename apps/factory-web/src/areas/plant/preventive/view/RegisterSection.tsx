'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { BookCheck, Printer, X } from 'lucide-react'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Select, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { CheckResult } from '../api'
import { CHECK_OUTCOMES, preventiveAddressText, printOfChosen, reportState, typeLabel, withAddress } from '../model'
import type { PreventivePageActions, PreventivePageModel } from '../view-model'
import { OutcomePill, PAGE_KEYS, SectionFailed, SectionHead, useDay, useWords } from './parts'

/** The law the register rests on (design sec register: D.Lgs. 81/2008 art. 71, results kept at least three years). */
export const REGISTER_LAW = 'D.Lgs. 81/2008 art. 71'

/**
 * Check register (design sec register; QHS-205): every result, newest first — day, machine, check, body or inspector,
 * outcome, the report (its file, else "missing" while the result is in force), the job a failed check made, next due,
 * kept until; a correction and the result it corrects say so. The tile "Reports missing" and an outcome filter; Export N
 * of the chosen rows (the register's export source), the frame's Export ▾ for the whole view. Enter opens the result.
 */
export function RegisterSection({ model, actions, onHelp }: { model: PreventivePageModel; actions?: PreventivePageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const locale = useLocale()
  const day = useDay()
  const ds = useDsWords()
  const { address, scope } = model
  const paged = model.register.status === 'ready' ? model.register.value : null
  const rows = paged?.rows ?? null
  const [selected, setSelected] = useState<string[]>(() => [...(model.registerSelected ?? [])])
  useEffect(() => {
    if (rows) setSelected((current) => current.filter((id) => rows.some((row) => row.id === id)))
  }, [rows])
  const chosen = (rows ?? []).filter((row) => selected.includes(row.id))
  const href = (result: CheckResult) => `${model.path}${preventiveAddressText(withAddress(address, { result: result.id, plan: null }))}`

  const columns = useMemo<ColDef<CheckResult>[]>(() => {
    const built: ColDef<CheckResult>[] = [
      {
        colId: 'performedOn',
        headerName: t('col.date'),
        minWidth: 130,
        flex: 0.9,
        valueGetter: (params) => params.data?.performedOn ?? '',
        valueFormatter: (params) => (params.data ? day(params.data.performedOn) : ''),
        cellRenderer: ({ data }: ICellRendererParams<CheckResult>) => (data ? <Link href={href(data)}>{day(data.performedOn)}</Link> : null),
      },
      { colId: 'machine', headerName: t('col.machine'), minWidth: 140, flex: 1, valueGetter: (params) => params.data?.machine.assetNumber ?? '' },
      ...(scope.allSites ? [{ colId: 'site', headerName: t('col.site'), minWidth: 140, flex: 1, valueGetter: (params: { data?: CheckResult }) => params.data?.site.name ?? '' } as ColDef<CheckResult>] : []),
      {
        colId: 'check',
        headerName: t('col.check'),
        minWidth: 210,
        flex: 1.6,
        valueGetter: (params) => (params.data ? typeLabel(params.data.checkType, locale) : ''),
        cellRenderer: ({ data }: ICellRendererParams<CheckResult>) =>
          data ? (
            <span className="fw-pv-cell">
              <span>{typeLabel(data.checkType, locale)}</span>
              <span className="fw-pv-muted">{data.checkType.legalBasis}</span>
            </span>
          ) : null,
      },
      { colId: 'by', headerName: t('col.by'), minWidth: 170, flex: 1.2, valueGetter: (params) => params.data?.performedBy ?? '' },
      {
        colId: 'outcome',
        headerName: t('col.outcome'),
        minWidth: 190,
        flex: 1.2,
        valueGetter: (params) => (params.data ? t(`outcome.${params.data.outcome}`) : ''),
        cellRenderer: ({ data }: ICellRendererParams<CheckResult>) =>
          data ? (
            <span className="fw-pv-cell">
              <OutcomePill outcome={data.outcome} say={t} />
              {data.correctedBy ? <span className="fw-pv-muted">{t('register.correctedBy', { date: day(data.correctedBy.performedOn) })}</span> : null}
              {data.corrects ? <span className="fw-pv-muted">{t('register.corrects', { date: day(data.corrects.performedOn) })}</span> : null}
            </span>
          ) : null,
      },
      {
        colId: 'report',
        headerName: t('col.report'),
        minWidth: 170,
        flex: 1.2,
        valueGetter: (params) => (params.data ? (params.data.reports.map((file) => file.originalName).join(', ') || t(`report.${reportState(params.data)}`)) : ''),
        cellRenderer: ({ data }: ICellRendererParams<CheckResult>) => {
          if (!data) return null
          const state = reportState(data)
          if (state === 'onFile') {
            return (
              <span className="fw-pv-cell">
                {data.reports.map((file) => (
                  <Button key={file.id} size="sm" variant="link" wrap onClick={() => actions?.onOpenReport?.(data.id, file.id)}>
                    {file.originalName}
                  </Button>
                ))}
              </span>
            )
          }
          return state === 'missing' ? <Tag tone="warning">{t('report.missing')}</Tag> : <span className="fw-pv-muted">{t(`report.${state}`)}</span>
        },
      },
      {
        colId: 'job',
        headerName: t('col.job'),
        minWidth: 130,
        flex: 0.8,
        valueGetter: (params) => params.data?.jobs.map((job) => job.number).join(', ') ?? '',
        cellRenderer: ({ data }: ICellRendererParams<CheckResult>) =>
          data ? (
            data.jobs.length > 0 ? (
              <span className="fw-pv-cell">
                {data.jobs.map((job) => (
                  <Link key={job.id} href={`${model.prefix}/plant/jobs/${encodeURIComponent(job.id)}`}>
                    {job.number}
                  </Link>
                ))}
              </span>
            ) : data.outcome !== 'PASSED' && data.inForce ? (
              <Link href={href(data)}>{t('register.noJobYet')}</Link>
            ) : (
              <span className="fw-pv-muted">—</span>
            )
          ) : null,
      },
      { colId: 'nextDue', headerName: t('col.nextDue'), minWidth: 120, flex: 0.8, valueGetter: (params) => params.data?.nextDueOn ?? '', valueFormatter: (params) => (params.data?.nextDueOn ? day(params.data.nextDueOn) : t('nextDue.byPlan')) },
      { colId: 'keptUntil', headerName: t('col.keptUntil'), minWidth: 120, flex: 0.8, valueGetter: (params) => params.data?.keptUntil ?? '', valueFormatter: (params) => (params.data ? day(params.data.keptUntil) : '') },
    ]
    return built
  }, [t, locale, day, scope.allSites, model.prefix, model.path, address, actions])

  const head = (
    <SectionHead id="fw-pv-register" title={t('register.title')} note={<LawRef law={REGISTER_LAW} plain={t('register.law')} labels={ds.lawRef} />}>
      <label className="fw-pv-filter">
        <span className="fw-pv-muted">{t('register.outcome')}</span>
        <Select value={address.outcome ?? ''} aria-label={t('register.outcome')} onChange={(event) => actions?.onAddress?.({ outcome: (event.target.value || null) as PreventivePageModel['address']['outcome'] })}>
          <option value="">{t('register.anyOutcome')}</option>
          {CHECK_OUTCOMES.map((outcome) => (
            <option key={outcome} value={outcome}>
              {t(`outcome.${outcome}`)}
            </option>
          ))}
        </Select>
      </label>
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )

  if (model.register.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('register.failed')} problem={model.register.problem} onRetry={actions?.onRetryRegister} />
      </>
    )
  }

  const tools = address.missing ? (
    <span className="fw-pv-tools">
      <Tag tone="warning">{t('tile.REPORTS_MISSING.label')}</Tag>
      <Button size="sm" variant="quiet" onClick={() => actions?.onAddress?.({ missing: false })}>
        <X size={13} aria-hidden /> {t('list.clearTile')}
      </Button>
    </span>
  ) : null

  return (
    <>
      {head}
      <ListFrame<CheckResult>
        label={t('register.label')}
        title={t('register.title')}
        listKey="plant.preventive.register"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t(paged?.next ? 'register.countMore' : 'register.count', { count: rows.length }) : '—'}
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('bulk.print', { count: chosen.length })} heldReason={chosen.length === 0 ? t('held.noneChosen') : null} onClick={() => window.open(printOfChosen(model.prefix, chosen), '_blank', 'noopener')}>
              <Printer size={13} aria-hidden /> <SelectionLabel>{t('bulk.print', { count: chosen.length })}</SelectionLabel>
            </Button>
          ),
          exportSelected: true,
        }}
        more={paged?.next ? { label: t('list.more'), onMore: () => actions?.onMoreRegister?.(), held: model.registerMore ? t('common.reading') : null } : null}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ result: row.id, plan: null })}
        state={
          rows && rows.length === 0 ? (
            <EmptyState icon={<BookCheck size={22} aria-hidden />} title={t(address.missing || address.outcome ? 'register.noneFilteredTitle' : 'register.noneTitle')} description={t(address.missing || address.outcome ? 'register.noneFiltered' : 'register.none')} />
          ) : undefined
        }
        cards={{ fields: { check: { role: 'title' } } }}
        today={model.today}
      />
      {model.register.status === 'loading' && <span className="fw-pv-slow">{t('common.stillLoading')}</span>}
    </>
  )
}
