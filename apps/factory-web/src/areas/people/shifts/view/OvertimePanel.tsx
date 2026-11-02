'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Clock, FileQuestion, Send, ThumbsUp } from 'lucide-react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { EmptyState } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { SelectionLabel } from '@nexus/ui/grid'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { siteColumn } from '../../../../shell/scope/scope-context'
import type { OvertimeListed } from '../api'
import { bulkOfRequests, checksWords, clockFull, dayLong, hoursWords, requestSelectable, STAGE_TONE } from '../model'
import type { ShiftsActions, ShiftsModel } from '../view-model'
import { said, useShiftWords } from './parts'

/**
 * Overtime requests (design people.shifts sec:ot-requests, MES-222) on the shared list frame: date · line · hours · reason ·
 * people asked · agreed n of m · limit check · status. The limit column counts people a limit warns or holds, never whose:
 * names are inside the one request. Bulk: Ask N (drafts), Approve N (what somebody agreed to); a row with neither verb
 * says why on its box.
 */
export function OvertimePanel({ model, actions, onHelp }: { model: ShiftsModel; actions?: ShiftsActions | undefined; onHelp: () => void }) {
  const t = useShiftWords()
  const locale = useLocale()
  const items = model.requests.items
  const columns = useMemo<ColDef<OvertimeListed>[]>(() => {
    const site = siteColumn<OvertimeListed>(model.scope, (row) => row.site.id, t('sheet.site'))
    return [
      {
        colId: 'date',
        headerName: t('ot.date'),
        width: 150,
        valueGetter: (params) => params.data?.date ?? '',
        cellRenderer: (params: ICellRendererParams<OvertimeListed>) =>
          params.data ? (
            <Link href={`?open=${encodeURIComponent(params.data.id)}`} scroll={false} onClick={(event) => { if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); actions?.onOpenRequest(params.data!.id) } }}>
              {dayLong(params.data.date, locale)}
            </Link>
          ) : null,
      },
      ...(site ? [site] : []),
      { colId: 'line', headerName: t('ot.line'), width: 130, valueGetter: (params) => (params.data?.line ? params.data.line.code : t('ot.anyLine')) },
      { colId: 'hours', headerName: t('ot.hours'), width: 130, valueGetter: (params) => (params.data ? `${hoursWords(params.data.minutes)}${params.data.startMinute !== null ? ` · ${clockFull(params.data.startMinute)}` : ''}` : '') },
      { colId: 'reason', headerName: t('ot.reason'), flex: 1, minWidth: 200, valueGetter: (params) => params.data?.reason ?? '' },
      { colId: 'asked', headerName: t('ot.asked'), width: 140, type: 'numericColumn', valueGetter: (params) => params.data?.counts.asked ?? 0 },
      { colId: 'agreed', headerName: t('ot.agreed'), width: 120, valueGetter: (params) => (params.data ? t('ot.agreedOf', { agreed: params.data.counts.agreed, asked: params.data.counts.asked }) : '') },
      {
        colId: 'checks',
        headerName: t('ot.limits'),
        width: 170,
        valueGetter: (params) => (params.data ? (said(t, checksWords(params.data.checks)) || t('ot.checks.ok')) : ''),
      },
      {
        colId: 'stage',
        headerName: t('ot.status'),
        width: 130,
        valueGetter: (params) => (params.data ? t(`stage.${params.data.stage}`) : ''),
        cellRenderer: (params: ICellRendererParams<OvertimeListed>) => (params.data ? <Pill tone={STAGE_TONE[params.data.stage]} dot>{t(`stage.${params.data.stage}`)}</Pill> : null),
      },
    ]
  }, [model.scope, t, locale, actions])

  const picked = useMemo(() => (items ?? []).filter((row) => model.selectedRequests.includes(row.id)), [items, model.selectedRequests])
  const bulk = bulkOfRequests(picked, model.can)
  const manages = model.can.overtime || model.can.approve

  return (
    <section className="fw-rs-section" aria-label={t('ot.title')}>
      <h2 className="fw-rs-section-title">{t('ot.title')}</h2>
      <ListFrame<OvertimeListed>
        label={t('ot.title')}
        rows={items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t('ot.count', { count: items.length }) : ''}
        rowKind="text"
        onOpen={(row) => actions?.onOpenRequest(row.id)}
        onHelp={onHelp}
        cards={{ hrefOf: (row) => `?open=${encodeURIComponent(row.id)}` }}
        {...(manages
          ? {
              selection: {
                selected: model.selectedRequests,
                onChange: (ids: string[]) => actions?.onSelectRequests(ids),
                actions: (
                  <>
                    <Button size="sm" variant="primary" onClick={() => actions?.onBulkApprove()} heldReason={bulk.approve.length > 0 ? null : t('held.noneToApprove')}>
                      <ThumbsUp size={14} aria-hidden /> <SelectionLabel>{t('ot.bulkApprove', { count: bulk.approve.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => actions?.onBulkAsk()} heldReason={bulk.ask.length > 0 ? null : t('held.noneToAsk')}>
                      <Send size={14} aria-hidden /> <SelectionLabel>{t('ot.bulkAsk', { count: bulk.ask.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              },
              isRowSelectable: (row: OvertimeListed) => (requestSelectable(row) ? null : t('held.rowClosed')),
            }
          : {})}
        state={
          model.requests.problem ? (
            <EmptyState
              icon={<FileQuestion size={22} aria-hidden />}
              title={t('ot.failed')}
              description={t(model.requests.problem)}
              action={
                <Button size="sm" onClick={() => actions?.onShowRequests()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : items && items.length === 0 ? (
            <EmptyState
              icon={<Clock size={22} aria-hidden />}
              title={t('ot.none')}
              description={t('ot.noneBody')}
              {...(model.can.overtime && actions
                ? {
                    action: (
                      <Button size="sm" onClick={() => actions.onOvertime()}>
                        {t('band.overtime')}
                      </Button>
                    ),
                  }
                : {})}
            />
          ) : undefined
        }
      />
    </section>
  )
}
