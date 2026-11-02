'use client'

import { useMemo } from 'react'
import { CircleCheck, CircleSlash } from 'lucide-react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { SelectionLabel } from '@nexus/ui/grid'
import { EmptyState } from '@nexus/ui/components'
import { Button, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { siteColumn } from '../../../../shell/scope/scope-context'
import { TIME_ZONE } from '../../_shared/model'
import type { HeldRow } from '../api'
import { heldSelectable, HOLD_TONE } from '../model'
import type { PieceActions, PieceModel } from '../view-model'
import { said, Section, usePieceWords } from './parts'

/**
 * Held scans (design sec:held, MES-264): time · bundle · operation · pieces · why, no name and no person filter (the design's
 * Worker column stays out, Owner answer W1): who it was opens inside one record, with the right. Resolve on the row; Count N
 * asks the API for each (each refused until the attendance shows the person clocked in) and Do not pay N with one reason.
 */
export function HeldSection({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const read = model.held!
  const rows = read.status === 'ready' ? read.value : null
  const columns = useMemo<ColDef<HeldRow>[]>(() => {
    const site = siteColumn<HeldRow>(model.scope, (row) => row.siteId, t('sites.site'))
    return [
      {
        colId: 'at',
        headerName: t('held.time'),
        width: 190,
        valueGetter: (params) => params.data?.at ?? '',
        cellRenderer: (params: ICellRendererParams<HeldRow>) =>
          params.data ? (
            <a
              className="fw-pp-link"
              href={`?resolve=${encodeURIComponent(params.data.id)}`}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) return
                event.preventDefault()
                actions?.onOpenHeld(params.data!.id)
              }}
            >
              {formatDateTime(params.data.at, { locale, timeZone: TIME_ZONE })}
            </a>
          ) : null,
      },
      ...(site ? [site] : []),
      { colId: 'bundle', headerName: t('ledger.bundle'), width: 140, valueGetter: (params) => params.data?.bundle ?? '' },
      { colId: 'operation', headerName: t('rates.operation'), flex: 1, minWidth: 200, valueGetter: (params) => (params.data ? `${params.data.operation.code} · ${params.data.operation.name}` : '') },
      { colId: 'pieces', headerName: t('ledger.pieces'), width: 90, type: 'numericColumn', valueGetter: (params) => params.data?.pieces ?? 0 },
      { colId: 'why', headerName: t('held.why'), width: 240, valueGetter: (params) => (params.data ? t(`hold.${params.data.reason}`) : '') },
      {
        colId: 'status',
        headerName: t('periods.status'),
        width: 150,
        valueGetter: (params) => params.data?.status ?? '',
        cellRenderer: (params: ICellRendererParams<HeldRow>) =>
          params.data ? (
            <Pill tone={HOLD_TONE[params.data.status]} dot>
              {t(`holdStatus.${params.data.status}`)}
            </Pill>
          ) : null,
      },
    ]
  }, [t, locale, actions, model.scope])
  const can = model.can.managePay
  return (
    <Section id="held" title={t('held.title')} hint={t('held.hint')}>
      <ListFrame<HeldRow>
        listKey="people.piecerates.held"
        label={t('held.title')}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('held.count', { count: rows?.length ?? 0 })}
        tools={<SegmentedControl size="sm" aria-label={t('held.view')} value={model.address.heldAll ? 'all' : 'open'} onChange={(value) => actions?.onAddress({ heldAll: value === 'all' })} options={[{ value: 'open', label: t('held.open') }, { value: 'all', label: t('held.all') }]} />}
        onHelp={() => actions?.onHelp(true)}
        onOpen={(row) => actions?.onOpenHeld(row.id)}
        {...(can
          ? {
              isRowSelectable: (row: HeldRow) => (heldSelectable(row) ? said(t, heldSelectable(row)) : null),
              selection: {
                selected: model.selectedHeld,
                onChange: (ids: string[]) => actions?.onSelectHeld(ids),
                actions: (
                  <>
                    <Button size="sm" onClick={() => actions?.onCountHeld(model.selectedHeld)}>
                      <CircleCheck size={14} aria-hidden /> <SelectionLabel>{t('held.countN', { count: model.selectedHeld.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" onClick={() => actions?.onNotPaid(model.selectedHeld)}>
                      <CircleSlash size={14} aria-hidden /> <SelectionLabel>{t('held.notPayN', { count: model.selectedHeld.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              },
            }
          : {})}
        state={
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
            <EmptyState title={t('held.empty')} description={t('held.emptyBody')} />
          ) : undefined
        }
      />
    </Section>
  )
}
