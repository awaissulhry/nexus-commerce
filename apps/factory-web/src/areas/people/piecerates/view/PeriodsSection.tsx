'use client'

import { useMemo } from 'react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { EmptyState } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { PeriodRow } from '../api'
import { monthText, moneyText, PERIOD_TONE } from '../model'
import type { PieceActions, PieceModel } from '../view-model'
import { Figure, said, Section, usePieceWords } from './parts'

/**
 * Pay periods (design sec:periods, MES-260) on the shared list frame: counts and states; a total only for a group of the
 * minimum size and with the pay grain, else its cell says so. Periods are the company's, so no site column. Nothing here acts
 * on many rows: a period is run, reviewed and locked one at a time, on its record.
 */
export function PeriodsSection({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const read = model.periods!
  const rows = read.status === 'ready' ? [...read.value].sort((a, b) => b.month.localeCompare(a.month)) : null
  const hidden = t('periods.hidden')
  const columns = useMemo<ColDef<PeriodRow>[]>(
    () => [
      {
        colId: 'month',
        headerName: t('periods.month'),
        flex: 1,
        minWidth: 170,
        valueGetter: (params) => params.data?.month ?? '',
        cellRenderer: (params: ICellRendererParams<PeriodRow>) =>
          params.data ? (
            <a
              className="fw-pp-link"
              href={`?period=${encodeURIComponent(params.data.id)}`}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) return
                event.preventDefault()
                actions?.onOpenPeriod(params.data!.id)
              }}
            >
              {monthText(params.data.month, locale)}
            </a>
          ) : null,
      },
      {
        colId: 'status',
        headerName: t('periods.status'),
        width: 150,
        valueGetter: (params) => params.data?.status ?? '',
        cellRenderer: (params: ICellRendererParams<PeriodRow>) =>
          params.data ? (
            <Pill tone={PERIOD_TONE[params.data.status]} dot>
              {t(`period.${params.data.status}`)}
            </Pill>
          ) : null,
      },
      { colId: 'people', headerName: t('periods.people'), width: 110, type: 'numericColumn', valueGetter: (params) => params.data?.people ?? 0 },
      { colId: 'earnings', headerName: t('periods.earnings'), width: 150, type: 'numericColumn', cellRenderer: (params: ICellRendererParams<PeriodRow>) => (params.data ? <Figure value={moneyText(params.data.earnings, params.data.currency, locale)} hidden={params.data.tooFew ? t('periods.tooFew') : hidden} /> : null) },
      { colId: 'makeUp', headerName: t('periods.makeUp'), width: 150, type: 'numericColumn', cellRenderer: (params: ICellRendererParams<PeriodRow>) => (params.data ? <Figure value={moneyText(params.data.makeUp, params.data.currency, locale)} hidden={params.data.tooFew ? t('periods.tooFew') : hidden} /> : null) },
      { colId: 'held', headerName: t('periods.held'), width: 120, type: 'numericColumn', valueGetter: (params) => params.data?.heldOpen ?? 0 },
      { colId: 'disputes', headerName: t('periods.disputes'), width: 120, type: 'numericColumn', valueGetter: (params) => params.data?.disputesOpen ?? 0 },
      { colId: 'statements', headerName: t('periods.statements'), width: 170, valueGetter: (params) => (params.data ? t('periods.approved', { approved: params.data.statements.approved, of: params.data.statements.approved + params.data.statements.draft }) : '') },
    ],
    [t, locale, hidden, actions],
  )
  const state =
    read.status === 'failed' ? (
      <EmptyState
        title={t('common.failed')}
        description={said(t, read.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry()}>
            {t('common.retry')}
          </Button>
        }
      />
    ) : rows?.length === 0 ? (
      <EmptyState title={t('periods.empty')} description={t('periods.emptyBody')} />
    ) : undefined
  return (
    <Section id="periods" title={t('periods.title')} hint={t('periods.hint')}>
      <ListFrame<PeriodRow> listKey="people.piecerates.periods" label={t('periods.title')} rows={rows} rowId={(row) => row.id} columns={columns} count={t('periods.count', { count: rows?.length ?? 0 })} onHelp={() => actions?.onHelp(true)} onOpen={(row) => actions?.onOpenPeriod(row.id)} state={state} />
    </Section>
  )
}
