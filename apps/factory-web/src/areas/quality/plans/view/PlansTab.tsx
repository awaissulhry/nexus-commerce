'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { MoreHorizontal, Printer } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { formatDate, formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { PlanRow } from '../api'
import { PLAN_STAGES, VERSION_STATUSES, type PlanStage, type VersionStatus } from '../constants'
import { chipsOf, filtered, planHref, printHref, versionWords } from '../model'
import { ChipsLine, PlanStatePill, useSay } from './parts'
import type { PlansModel } from './PlansView'

export interface PlansTabActions {
  onNewPlan?: () => void
  onStarter?: () => void
  onStage?: (stage: PlanStage | '') => void
  onStatus?: (status: VersionStatus | '') => void
  onSearch?: (q: string) => void
  onClearFilters?: () => void
  onSelect?: (ids: readonly string[]) => void
  onOpenPlan?: (planId: string) => void
  onCopyPlan?: (versionId: string) => void
  onRetryPlans?: () => void
}

/**
 * Plans (design pl-plans, QHS-008): the checklist templates in the ONE list frame — plan (code and name), stage, applies
 * to, version, status (Draft / Approved / Retired, waiting approval), owner, used by (records on any version), last
 * change. A row opens the plan record; the selection prints its checklists or exports. Empty: New plan, or the
 * leather-apparel starter set.
 */
export function PlansTab({ model, actions }: { model: PlansModel; actions?: PlansTabActions }) {
  const t = useT('quality-plans')
  const say = useSay()
  const locale = useLocale()
  const [search, setSearch] = useState(model.address.q)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  const act = useRef(actions)
  act.current = actions
  const answer = model.plans.value

  const columns = useMemo<ColDef<PlanRow>[]>(() => {
    const PlanCell = ({ data }: ICellRendererParams<PlanRow>) =>
      data ? (
        <Link className="fw-q-link fw-q-code" href={planHref(model.prefix, data.id)}>
          {data.code}
        </Link>
      ) : null
    const NameCell = ({ data }: ICellRendererParams<PlanRow>) => (data ? <span>{data.name}</span> : null)
    const StageCell = ({ data }: ICellRendererParams<PlanRow>) => (data ? <span>{t(`stage.${data.stage}`)}</span> : null)
    const AppliesCell = ({ data }: ICellRendererParams<PlanRow>) => (data ? <ChipsLine chips={chipsOf(data.appliesTo)} prefix={model.prefix} /> : null)
    const VersionCell = ({ data }: ICellRendererParams<PlanRow>) => (data ? <span className="fw-q-code">{say(versionWords(data))}</span> : null)
    const StatusCell = ({ data }: ICellRendererParams<PlanRow>) => (data ? <PlanStatePill row={data} /> : null)
    const OwnerCell = ({ data }: ICellRendererParams<PlanRow>) => (data ? data.owner ? <span>{data.owner.name}</span> : <span className="fw-q-hint">{t('plans.noOwner')}</span> : null)
    const UsedCell = ({ data }: ICellRendererParams<PlanRow>) => (data ? <span className="fw-q-num">{t('plans.usedBy', { count: data.usedBy, n: formatNumber(data.usedBy, locale) })}</span> : null)
    const ChangeCell = ({ data }: ICellRendererParams<PlanRow>) => (data ? <time className="fw-q-num" dateTime={data.lastChangeAt}>{formatDate(data.lastChangeAt, { locale })}</time> : null)
    const MoreCell = ({ data }: ICellRendererParams<PlanRow>) => {
      if (!data) return null
      const copyFrom = data.approved?.id ?? data.draft?.id ?? null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('plans.rowMenu', { code: data.code }) }}
          items={[
            { id: 'open', label: t('plans.open'), href: planHref(model.prefix, data.id) },
            { id: 'versions', label: t('plans.versions'), href: planHref(model.prefix, data.id, 'versions') },
            { id: 'print', label: t('plans.print'), href: printHref(model.prefix, { plans: [data.id] }), target: '_blank' },
            {
              id: 'copy',
              label: t('plans.copy'),
              disabled: !model.can.manage || !copyFrom,
              description: !model.can.manage ? t('held.noManage') : !copyFrom ? t('plans.copyNone') : undefined,
              onSelect: () => copyFrom && act.current?.onCopyPlan?.(copyFrom),
            },
          ]}
        />
      )
    }
    return [
      { colId: 'code', headerName: t('col.plan'), minWidth: 130, flex: 0.6, cellRenderer: PlanCell },
      { colId: 'name', headerName: t('col.name'), minWidth: 180, flex: 1, cellRenderer: NameCell },
      { colId: 'stage', headerName: t('col.stage'), minWidth: 110, flex: 0.5, cellRenderer: StageCell },
      { colId: 'appliesTo', headerName: t('col.appliesTo'), minWidth: 200, flex: 1.3, cellRenderer: AppliesCell },
      { colId: 'version', headerName: t('col.version'), minWidth: 140, flex: 0.55, cellRenderer: VersionCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 150, flex: 0.6, cellRenderer: StatusCell },
      { colId: 'owner', headerName: t('col.owner'), minWidth: 130, flex: 0.6, cellRenderer: OwnerCell },
      { colId: 'usedBy', headerName: t('col.usedBy'), minWidth: 120, flex: 0.45, type: 'rightAligned', cellRenderer: UsedCell },
      { colId: 'lastChange', headerName: t('col.lastChange'), minWidth: 120, flex: 0.45, cellRenderer: ChangeCell },
      { colId: 'more', headerName: t('col.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, say, locale, model.prefix, model.can.manage])

  const rows = answer?.plans ?? null
  const picked = (rows ?? []).filter((row) => model.selected.includes(row.id))
  const isFiltered = filtered(model.address)
  const missingStarter = model.starter?.value?.filter((plan) => plan.missing).length ?? null
  const retry = (
    <Button size="sm" onClick={() => actions?.onRetryPlans?.()}>
      {t('common.retry')}
    </Button>
  )
  const state = model.plans.problem ? (
    <EmptyState title={t('plans.failed')} description={t(model.plans.problem)} action={retry} />
  ) : rows && rows.length === 0 ? (
    isFiltered ? (
      <EmptyState
        title={t('plans.noMatch')}
        description={t('plans.noMatchBody')}
        action={
          <Button size="sm" onClick={() => actions?.onClearFilters?.()}>
            {t('plans.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={t('plans.empty')}
        description={t('plans.emptyBody')}
        action={
          model.can.manage ? (
            <span className="fw-qp-actions">
              <Button size="sm" variant="primary" onClick={() => actions?.onNewPlan?.()}>
                {t('plans.new')}
              </Button>
              <Button size="sm" disabled={model.busy === 'starter'} heldReason={missingStarter === 0 ? t('plans.starterNone') : model.live === 'offline' ? t('held.offline') : null} onClick={() => actions?.onStarter?.()}>
                {missingStarter === null ? t('plans.starterAdd') : t('plans.starterAddCount', { count: missingStarter })}
              </Button>
            </span>
          ) : undefined
        }
      />
    )
  ) : undefined
  const counts = answer?.counts
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]
  return (
    <section className="fw-qp-tab" aria-label={t('tab.plans')}>
      {counts && counts.waitingApproval > 0 && (
        <p className="fw-qp-muted" role="status">
          {t('plans.waitingLine', { count: counts.waitingApproval })}
        </p>
      )}
      {answer?.truncated && <p className="fw-qp-muted">{t('plans.truncated')}</p>}
      <ListFrame<PlanRow>
        label={t('plans.tableLabel')}
        title={t('plans.fileTitle')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('plans.count', { count: rows.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            aria-label={t('plans.search')}
            placeholder={t('plans.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onSearch?.(search)
            }}
            onBlur={() => search !== model.address.q && actions?.onSearch?.(search)}
          />
        }
        tools={
          <>
            <Select size="sm" aria-label={t('plans.stageFilter')} value={model.address.stage} onChange={(event) => actions?.onStage?.(event.target.value as PlanStage | '')}>
              <option value="">{t('plans.allStages')}</option>
              {PLAN_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {counts ? t('plans.stageCount', { stage: t(`stage.${stage}`), count: counts.byStage[stage] ?? 0 }) : t(`stage.${stage}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('plans.statusFilter')} value={model.address.status} onChange={(event) => actions?.onStatus?.(event.target.value as VersionStatus | '')}>
              <option value="">{t('plans.allStatuses')}</option>
              {VERSION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`status.${status}`)}
                </option>
              ))}
            </Select>
          </>
        }
        selection={{
          selected: model.selected,
          onChange: (ids) => actions?.onSelect?.(ids),
          exportSelected: true,
          actions: (
            <Button size="sm" asChild aria-label={t('plans.printMany', { count: picked.length })}>
              <a href={printHref(model.prefix, { plans: picked.map((row) => row.id) })} target="_blank" rel="noopener noreferrer">
                <Printer size={13} aria-hidden /> <SelectionLabel>{t('plans.printMany', { count: picked.length })}</SelectionLabel>
              </a>
            </Button>
          ),
        }}
        keys={ownKeys}
        onOpen={(row) => actions?.onOpenPlan?.(row.id)}
        state={state}
      />
    </section>
  )
}
