'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CalendarClock, ListChecks, X } from 'lucide-react'
import { DueCell } from '@nexus/ui/components/DueCell/index'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { CheckPlan } from '../api'
import { machineText, modelText, planSelectHeld, preventiveAddressText, typeLabel, withAddress } from '../model'
import type { PreventivePageActions, PreventivePageModel } from '../view-model'
import { CheckLaw, intervalText, OutcomePill, PAGE_KEYS, SectionFailed, SectionHead, useDay, useWords } from './parts'

/**
 * Plans (design sec plans): each recurring check — the check and its law, the machine, the kind (statutory; preventive
 * maintenance by time or use comes later), the interval, last done, next due (a tone and words), the outside body, the
 * owner. Active | Ended; a tile's due filter (Checks overdue, Due in 30 days) as a chip. Enter opens the Plan window;
 * Move N moves the chosen checks to one day with one reason. "Show more" reads the next page.
 */
export function PlansSection({ model, actions, onHelp }: { model: PreventivePageModel; actions?: PreventivePageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const locale = useLocale()
  const day = useDay()
  const ds = useDsWords()
  const { address, scope, can } = model
  const paged = model.plans.status === 'ready' ? model.plans.value : null
  const rows = paged?.rows ?? null
  const [selected, setSelected] = useState<string[]>(() => [...(model.selected ?? [])])
  useEffect(() => {
    if (rows) setSelected((current) => current.filter((id) => rows.some((row) => row.id === id)))
  }, [rows])
  const picked = (rows ?? []).filter((row) => selected.includes(row.id) && planSelectHeld(row, can) === null)
  const href = (plan: CheckPlan) => `${model.path}${preventiveAddressText(withAddress(address, { plan: plan.id, result: null }))}`

  const columns = useMemo<ColDef<CheckPlan>[]>(() => {
    const built: ColDef<CheckPlan>[] = [
      {
        colId: 'check',
        headerName: t('col.plan'),
        minWidth: 230,
        flex: 2,
        valueGetter: (params) => (params.data ? typeLabel(params.data.checkType, locale) : ''),
        cellRenderer: ({ data }: ICellRendererParams<CheckPlan>) =>
          data ? (
            <span className="fw-pv-cell">
              <Link href={href(data)}>{typeLabel(data.checkType, locale)}</Link>
              <CheckLaw type={data.checkType} say={t} />
            </span>
          ) : null,
      },
      {
        colId: 'machine',
        headerName: t('col.machine'),
        minWidth: 170,
        flex: 1.4,
        valueGetter: (params) => (params.data ? machineText(params.data.machine) : ''),
        cellRenderer: ({ data }: ICellRendererParams<CheckPlan>) =>
          data ? (
            <span className="fw-pv-cell">
              <Link href={`${model.prefix}/plant/machines/${encodeURIComponent(data.machine.id)}`}>{data.machine.assetNumber}</Link>
              {data.machine.locked ? <span className="fw-pv-warn">{t('chip.locked')}</span> : modelText(data.machine) ? <span className="fw-pv-muted">{modelText(data.machine)}</span> : null}
            </span>
          ) : null,
      },
      ...(scope.allSites ? [{ colId: 'site', headerName: t('col.site'), minWidth: 140, flex: 1, valueGetter: (params: { data?: CheckPlan }) => params.data?.site.name ?? '' } as ColDef<CheckPlan>] : []),
      { colId: 'kind', headerName: t('col.kind'), minWidth: 120, flex: 0.8, valueGetter: () => t('kind.STATUTORY') },
      { colId: 'interval', headerName: t('col.interval'), minWidth: 140, flex: 1, valueGetter: (params) => (params.data ? intervalText(t, params.data.interval, params.data.intervalUnit) : '') },
      {
        colId: 'lastDone',
        headerName: t('col.lastDone'),
        minWidth: 170,
        flex: 1,
        valueGetter: (params) => params.data?.lastDone?.performedOn ?? '',
        valueFormatter: (params) => (params.data?.lastDone ? `${day(params.data.lastDone.performedOn)} · ${t(`outcome.${params.data.lastDone.outcome}`)}` : t('lastDone.none')),
        cellRenderer: ({ data }: ICellRendererParams<CheckPlan>) =>
          data ? (
            data.lastDone ? (
              <span className="fw-pv-row">
                <span>{day(data.lastDone.performedOn)}</span>
                <OutcomePill outcome={data.lastDone.outcome} say={t} />
              </span>
            ) : (
              <span className="fw-pv-muted">{t('lastDone.none')}</span>
            )
          ) : null,
      },
      {
        colId: 'nextDue',
        headerName: t('col.nextDue'),
        minWidth: 180,
        flex: 1.2,
        valueGetter: (params) => params.data?.nextDueOn ?? '',
        valueFormatter: (params) => (params.data ? `${day(params.data.nextDueOn)} · ${t(`due.${params.data.due.state}`)}` : ''),
        cellRenderer: ({ data }: ICellRendererParams<CheckPlan>) =>
          data ? (
            data.status === 'ENDED' ? (
              <Pill tone="neutral">{t('due.ENDED')}</Pill>
            ) : (
              <DueCell value={{ due: data.nextDueOn }} today={model.today} formatDate={(iso) => day(iso)} labels={{ ...ds.dueCell, validUntil: (text) => t('dueOn', { date: text }) }} />
            )
          ) : null,
      },
      { colId: 'body', headerName: t('col.body'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? (params.data.outsideBody?.name ?? t('body.inHouse')) : '') },
      { colId: 'owner', headerName: t('col.owner'), minWidth: 140, flex: 1, valueGetter: (params) => (params.data ? (params.data.owner?.name ?? t('owner.none')) : '') },
    ]
    return built
  }, [t, locale, day, ds, scope.allSites, model.prefix, model.today, model.path, address])

  const head = (
    <SectionHead id="fw-pv-plans" title={t('plans.title')} note={t('plans.note')}>
      <SegmentedControl
        size="sm"
        ariaLabel={t('plans.status')}
        value={address.ended ? 'ENDED' : 'ACTIVE'}
        onChange={(value) => actions?.onAddress?.({ ended: value === 'ENDED', due: null })}
        options={[
          { value: 'ACTIVE', label: t('plans.active') },
          { value: 'ENDED', label: t('plans.ended') },
        ]}
      />
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )

  if (model.plans.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('plans.failed')} problem={model.plans.problem} onRetry={actions?.onRetryPlans} />
      </>
    )
  }

  const tools = address.due ? (
    <span className="fw-pv-tools">
      <Tag tone={address.due === 'OVERDUE' ? 'danger' : 'warning'}>{t(`tile.${address.due}.label`)}</Tag>
      <Button size="sm" variant="quiet" onClick={() => actions?.onAddress?.({ due: null })}>
        <X size={13} aria-hidden /> {t('list.clearTile')}
      </Button>
    </span>
  ) : null

  return (
    <>
      {head}
      <ListFrame<CheckPlan>
        label={t('plans.label')}
        title={t('plans.title')}
        listKey="plant.preventive"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t(paged?.next ? 'plans.countMore' : 'plans.count', { count: rows.length }) : '—'}
        tools={tools}
        selection={
          can.manage
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <Button size="sm" variant="primary" aria-label={t('bulk.move', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneActive') : null} onClick={() => actions?.onMoveMany?.(picked.map((row) => row.id))}>
                    <CalendarClock size={13} aria-hidden /> <SelectionLabel>{t('bulk.move', { count: picked.length })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        isRowSelectable={can.manage ? (row) => (planSelectHeld(row, can) ? t(planSelectHeld(row, can)!) : null) : undefined}
        more={paged?.next ? { label: t('list.more'), onMore: () => actions?.onMorePlans?.(), held: model.plansMore ? t('common.reading') : null } : null}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ plan: row.id, result: null })}
        state={
          rows && rows.length === 0 ? (
            <EmptyState
              icon={<ListChecks size={22} aria-hidden />}
              title={t(address.due ? 'plans.noneFilteredTitle' : address.ended ? 'plans.noneEndedTitle' : 'plans.noneTitle')}
              description={t(address.due ? 'plans.noneFiltered' : address.ended ? 'plans.noneEnded' : 'plans.none')}
            />
          ) : undefined
        }
        cards={{ fields: { check: { role: 'title' } } }}
        today={model.today}
      />
      {model.plans.status === 'loading' && <span className="fw-pv-slow">{t('common.stillLoading')}</span>}
    </>
  )
}
