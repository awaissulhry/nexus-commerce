'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { NexusGrid, SHEET_GRID_OPTIONS, type ColDef, type ICellRendererParams, type ValueSetterParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { offerPicksOf, offerPicksProblemKey, type GroupOffer, type GroupRecord } from '../../model'
import type { GroupRecordActions, GroupRecordModel } from '../../view-model'
import { useSay } from '../../view/parts'
import { cellRules, cellTip } from './cells'

/**
 * Option group › Styles (design rec tab option.styles, PRD-206; autosave): the styles that offer the group, each with its
 * own minimum and maximum (empty: the group's) and what it asks in the end; Add styles (offer the group on them) and
 * Withdraw (removed when nothing of the style names its options, else kept archived). An offer is a change of the style's
 * spec: a released style may need a new revision first — the API's refusal is said in our words with its own as data.
 */
export function StylesTab({ group, model, actions }: { group: GroupRecord; model: GroupRecordModel; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const say = useSay()
  const offerHeld = group.status === 'ARCHIVED' ? t('held.archived') : !model.can.offer ? t('held.noOffer') : model.offline ? t('held.offline') : null
  const offers = useMemo(() => [...group.styles].sort((a, b) => (a.status === b.status ? a.style.code.localeCompare(b.style.code) : a.status === 'ACTIVE' ? -1 : 1)), [group.styles])

  const columns = useMemo<ColDef<GroupOffer>[]>(() => {
    const rowHeld = (row: GroupOffer | undefined) => (!row ? offerHeld : offerHeld ?? (row.status === 'ARCHIVED' ? t('styles.held.withdrawn') : row.style.status === 'ARCHIVED' ? t('styles.held.styleArchived') : null))
    const StyleCell = ({ data }: ICellRendererParams<GroupOffer>) =>
      data ? (
        <span className="fw-lib-cell">
          <Link className="fw-lib-rowlink" href={`${model.prefix}/products/styles/${data.style.id}`}>
            {data.style.code}
          </Link>
          <span className="fw-lib-sub">{data.style.name}</span>
        </span>
      ) : null
    const picks = (field: 'minPicks' | 'maxPicks', header: string): ColDef<GroupOffer> => ({
      colId: field,
      headerName: header,
      minWidth: 120,
      flex: 0.6,
      sortable: false,
      type: 'rightAligned',
      editable: (params) => !rowHeld(params.data),
      valueGetter: (params) => (params.data ? (params.data[field] ?? '') : ''),
      valueFormatter: (params) => (params.value === '' || params.value === null ? t('styles.groups', { value: field === 'minPicks' ? group.minPicks : (group.maxPicks ?? t('styles.any')) }) : String(params.value)),
      valueSetter: (params: ValueSetterParams<GroupOffer>) => {
        if (!params.data) return false
        const value = offerPicksOf(String(params.newValue ?? ''))
        if (value === undefined) {
          actions?.onOfferCell?.(params.data.id, field, 'invalid')
          return false
        }
        if (value === params.data[field]) return false
        actions?.onOfferCell?.(params.data.id, field, value)
        return false
      },
      cellClassRules: cellRules(model.cells, field),
      tooltipValueGetter: (params) => {
        const row = params.data as GroupOffer | undefined
        const mark = cellTip(model.cells, row?.id, field, tl, t)
        if (mark) return mark
        if (!row) return undefined
        const problem = offerPicksProblemKey(group.kind, group, row.minPicks, row.maxPicks)
        return problem ? t(problem) : (rowHeld(row) ?? t('styles.picksHint'))
      },
    })
    const StyleStatusCell = ({ data }: ICellRendererParams<GroupOffer>) => (data ? <span>{t(`styleStatus.${data.style.status}`)}</span> : null)
    const AsksCell = ({ data }: ICellRendererParams<GroupOffer>) => (data ? <span className="fw-opt-num">{say(data.picks)}</span> : null)
    const OfferCell = ({ data }: ICellRendererParams<GroupOffer>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(data.status === 'ACTIVE' ? 'styles.offered' : 'styles.withdrawn')}</Pill> : null)
    const WithdrawCell = ({ data }: ICellRendererParams<GroupOffer>) =>
      data && data.status === 'ACTIVE' ? (
        <Button size="sm" variant="quiet" heldReason={offerHeld ?? (model.cells[`${data.id}/withdraw`]?.state === 'saving' ? tl('held.busy') : null)} aria-label={t('styles.withdrawOf', { code: data.style.code })} onClick={() => actions?.onDialog?.({ kind: 'withdraw', offerId: data.id })}>
          {t('styles.withdraw')}
        </Button>
      ) : null
    return [
      { colId: 'style', headerName: t('styles.col.style'), minWidth: 220, flex: 1.6, sortable: false, cellRenderer: StyleCell },
      { colId: 'styleStatus', headerName: t('styles.col.styleStatus'), minWidth: 120, flex: 0.6, sortable: false, cellRenderer: StyleStatusCell },
      picks('minPicks', t('styles.col.min')),
      picks('maxPicks', t('styles.col.max')),
      { colId: 'asks', headerName: t('styles.col.asks'), minWidth: 130, flex: 0.6, sortable: false, cellRenderer: AsksCell },
      { colId: 'offer', headerName: t('styles.col.offer'), minWidth: 130, flex: 0.6, sortable: false, cellRenderer: OfferCell },
      { colId: 'withdraw', headerName: t('styles.col.withdraw'), minWidth: 130, maxWidth: 150, sortable: false, cellRenderer: WithdrawCell },
    ]
  }, [group, model.cells, model.prefix, offerHeld, actions, t, tl, say])

  return (
    <Card padded>
      <div className="fw-opt-cardhead">
        <h2 className="fw-lib-h3">{t('styles.title')}</h2>
        <span className="fw-lib-hint">{t('styles.intro')}</span>
      </div>
      {offerHeld && offers.length > 0 && <Banner tone="info" title={t('readOnly', { reason: offerHeld })} />}
      {offers.length === 0 ? (
        <EmptyState
          title={t('styles.empty.title')}
          description={t(offerHeld ? 'styles.empty.bodyView' : 'styles.empty.body')}
          action={
            !offerHeld ? (
              <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ kind: 'styles', q: '', results: null, picked: [], busy: false, outcome: null })}>
                <Plus size={14} aria-hidden /> {t('styles.add')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="fw-opt-grid" role="region" aria-label={t('styles.title')}>
          <NexusGrid<GroupOffer> {...SHEET_GRID_OPTIONS} rowData={offers} columnDefs={columns} getRowId={(params) => params.data.id} domLayout="autoHeight" />
        </div>
      )}
      <p className="fw-lib-hint">{t('styles.hint')}</p>
    </Card>
  )
}
