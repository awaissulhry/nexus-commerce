'use client'

import { useMemo, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { EmptyState, Sparkline } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { formatDate } from '../../../../lib/i18n/format'
import { money, quantity } from '../../../_shared/buying/model'
import type { YieldRow } from '../api'
import { acceptHeld, area, dismissHeld, pct, proposalWords, visibleYield, type Words } from '../model'
import type { LeatherActions, LeatherModel } from '../view-model'

/**
 * Planned vs actual yield (design planning.leather sec:yield; PLN-109): per style, from the cut log of the site's work orders
 * — hides and cuts, the planned area (the BOM's need of what was cut) against the area used, the planned and the actual loss,
 * the trend per work order, and the proposal "Set loss 12 % → 14 %" on N cuts. Accept (the planner) opens the confirm; Dismiss
 * asks a reason. Held buttons say why. Never by cutter. The extra loss's value only with the cost grain.
 */
export function YieldSection({ model, actions, words }: { model: LeatherModel; actions?: LeatherActions; words: Words }) {
  const { t, locale } = words
  const answer = model.yields.status === 'ready' ? model.yields.value : null
  const rows = useMemo(() => (answer ? visibleYield(answer.rows, model.controls) : null), [answer, model.controls])
  const minCuts = answer?.minCuts ?? 5

  const StyleCell = ({ data }: ICellRendererParams<YieldRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span className="fw-lp-ellipsis">{data.style.code}</span>
        <span className="fw-lp-sub fw-lp-ellipsis">{data.revision ? t('yield.revision', { revision: data.revision.revision, name: data.style.name }) : data.style.name}</span>
      </span>
    ) : null
  const CutsCell = ({ data }: ICellRendererParams<YieldRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span>{t('yield.cuts', { count: data.cuts })}</span>
        <span className="fw-lp-sub">{t('yield.hides', { count: data.hides })}</span>
      </span>
    ) : null
  const AreaCell = ({ data }: ICellRendererParams<YieldRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span>{area(data.actualArea, data.uom ?? '', words)}</span>
        <span className="fw-lp-sub">{t('yield.planned', { area: area(data.plannedArea, data.uom ?? '', words) })}</span>
      </span>
    ) : null
  const LossCell = ({ data }: ICellRendererParams<YieldRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span>{t('yield.actualLoss', { loss: pct(data.actualLossPct, words) })}</span>
        <span className="fw-lp-sub">{data.plannedLossPct === null ? t('yield.noPlan') : t(`yield.plannedLoss.${data.plannedSource ?? 'BOM'}`, { loss: pct(data.plannedLossPct, words) })}</span>
      </span>
    ) : null
  const TrendCell = ({ data }: ICellRendererParams<YieldRow>) =>
    data ? (
      <Sparkline
        values={data.trend.map((point) => (point.lossPct === null ? null : Number(point.lossPct)))}
        shape="line"
        domain={[0, null]}
        label={t('yield.trend', { style: data.style.code })}
        format={(n) => `${quantity(String(n), locale)} %`}
        emptyLabel={t('yield.noTrend')}
      />
    ) : null
  const ProposalCell = ({ data }: ICellRendererParams<YieldRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span className={data.proposal.state === 'PROPOSED' ? 'fw-lp-strong fw-lp-ellipsis' : 'fw-lp-ellipsis'}>{proposalWords(data, words, minCuts)}</span>
        <span className="fw-lp-sub fw-lp-ellipsis">
          {data.proposal.state === 'PROPOSED'
            ? t('yield.restsOn', { count: data.proposal.cuts })
            : data.lastDecision
              ? t(`yield.last.${data.lastDecision.decision}`, { date: formatDate(data.lastDecision.at, { locale, timeZone: model.timeZone }), reason: data.lastDecision.reason ?? '' })
              : ''}
        </span>
      </span>
    ) : null
  const ValueCell = ({ data }: ICellRendererParams<YieldRow>) => (data ? <span>{data.currency ? money(data.extraLossValue ?? null, data.currency, locale) : '—'}</span> : null)
  const ActionsCell = ({ data }: ICellRendererParams<YieldRow>) => {
    if (!data) return null
    const accept = acceptHeld(data, model.can)
    const dismiss = dismissHeld(data, model.can)
    if (data.proposal.state === 'TOO_FEW' || data.proposal.state === 'IN_LINE') return <Pill tone="neutral">{t(`yield.state.${data.proposal.state}`)}</Pill>
    return (
      <span className="fw-lp-inline">
        <Button size="sm" variant="primary" heldReason={accept ? t(accept) : null} onClick={() => actions?.onAccept?.(data.style.id)} aria-label={t('yield.acceptOf', { style: data.style.code })}>
          <Check size={13} aria-hidden /> {t('yield.accept')}
        </Button>
        <Button size="sm" variant="quiet" heldReason={dismiss ? t(dismiss) : null} onClick={() => actions?.onDismiss?.(data.style.id)} aria-label={t('yield.dismissOf', { style: data.style.code })}>
          <X size={13} aria-hidden /> {t('yield.dismiss')}
        </Button>
      </span>
    )
  }

  const columns: ColDef<YieldRow>[] = [
    { colId: 'style', headerName: t('col.style'), minWidth: 170, flex: 1, cellRenderer: StyleCell },
    { colId: 'cuts', headerName: t('col.cuts'), minWidth: 120, flex: 0.6, cellRenderer: CutsCell },
    { colId: 'area', headerName: t('col.yieldArea'), minWidth: 170, flex: 0.9, cellRenderer: AreaCell },
    { colId: 'loss', headerName: t('col.loss'), minWidth: 190, flex: 1, cellRenderer: LossCell },
    { colId: 'trend', headerName: t('col.trend'), minWidth: 120, flex: 0.6, cellRenderer: TrendCell },
    { colId: 'proposal', headerName: t('col.proposal'), minWidth: 240, flex: 1.4, cellRenderer: ProposalCell },
    ...(model.seesCost ? [{ colId: 'value', headerName: t('col.extraValue'), minWidth: 130, flex: 0.7, cellRenderer: ValueCell } satisfies ColDef<YieldRow>] : []),
    { colId: 'actions', headerName: t('col.actions'), minWidth: 210, flex: 1, sortable: false, cellRenderer: ActionsCell },
  ]

  let state: ReactNode = undefined
  if (model.yields.status === 'error') {
    state = <EmptyState title={t('yield.error')} description={t(model.yields.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('yield')}>{t('common.retry')}</Button>} />
  } else if (rows && rows.length === 0) {
    state = model.controls.q.trim() !== '' || model.controls.tile === 'drift' ? <EmptyState title={t('empty.noMatch.title')} description={t('empty.noMatch.body')} /> : <EmptyState title={t('yield.empty', { min: minCuts })} />
  }

  return (
    <>
      <div className="fw-lp-section-head">
        <h2 className="fw-lp-h2" id="fw-lp-yield">
          {t('yield.title')}
        </h2>
        <p className="fw-lp-hint">{answer ? t('yield.purposeSince', { date: formatDate(answer.from, { locale, timeZone: model.timeZone }), min: minCuts }) : t('yield.purpose')}</p>
      </div>
      <ListFrame<YieldRow>
        label={t('yield.title')}
        listKey="planning.leather.3"
        rows={state ? [] : rows}
        rowId={(row) => row.style.id}
        columns={columns}
        count={rows ? t('yield.count', { count: rows.length }) : '—'}
        keys={[]}
        onHelp={() => actions?.onKeys?.()}
        state={state}
      />
    </>
  )
}
