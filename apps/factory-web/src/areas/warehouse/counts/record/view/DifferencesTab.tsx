'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, MessageSquareText, RotateCcw } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/stock/model'
import { Qty } from '../../../../_shared/stock/parts'
import type { CountLine, CountReason, CountRecord } from '../../api'
import { differenceSelectable } from '../../model'
import { KeysModal, Money, PartState, useWords } from '../../parts'
import type { CountRecordActions, CountRecordModel } from '../../view-model'

/**
 * Count › Differences (design warehouse.counts/rec:Count/differences, cn-diff): what differs, by how much and why — each
 * line with what was expected and counted (the recount's result when one was asked), the difference and its share of the
 * expected quantity, its value at the unit cost (the cost grain only), the reason (an adjustment reason; one that asks
 * for detail opens the reason dialog), whether a recount is suggested (a hide, something found where nothing was
 * expected, or over 5 %) and the recount's result. Select lines to ask their recount or give them one reason at once.
 * "No differences ✓" when everything agrees.
 */
export function DifferencesTab({ value, model, actions }: { value: CountRecord; model: CountRecordModel; actions?: CountRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const latest = useRef(actions)
  latest.current = actions
  const items = model.diffs.items
  const rowsKey = items?.map((line) => line.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const editable = value.status === 'COUNTING' && model.can.manage
  const reasons = model.reasons
  const reasonWord = (code: string | null, all: readonly CountReason[] | null) => {
    if (!code) return null
    const found = all?.find((reason) => reason.code === code)
    return found ? (locale === 'en' ? found.labelEn : found.labelIt) : code
  }

  const columns = useMemo<ColDef<CountLine>[]>(() => {
    const LineCell = ({ data }: ICellRendererParams<CountLine>) =>
      data ? (
        <span className="fw-st-cell" title={`${data.location.code} · ${data.item.code} ${data.item.name}`}>
          <span className="fw-st-ellipsis">
            <span className="fw-st-num">{data.seq}</span> · {data.item.code} · {data.item.name}
          </span>
          <span className="fw-st-sub">{[data.location.code, data.colour?.name, data.hide ? t('line.hide', { code: data.hide.code }) : data.lot ? t('line.lot', { code: data.lot.code }) : null].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const ExpectedCell = ({ data }: ICellRendererParams<CountLine>) => (data ? <Qty value={data.expected} uom={data.item.uom} decimals={4} /> : null)
    const CountedCell = ({ data }: ICellRendererParams<CountLine>) =>
      data ? (
        <span className="fw-st-cell">
          <Qty value={data.final} uom={data.item.uom} decimals={4} />
          {data.recount?.quantity && <span className="fw-st-sub">{t('diff.recounted', { count: quantity(data.counted, locale, 4) })}</span>}
        </span>
      ) : null
    const DiffCell = ({ data }: ICellRendererParams<CountLine>) => {
      if (!data || data.difference === null) return null
      const number = Number(data.difference)
      return (
        <span className={number < 0 ? 'fw-st-num strong fw-cn-danger' : 'fw-st-num strong'}>
          {`${number > 0 ? '+' : number < 0 ? '−' : ''}${quantity(Math.abs(number), locale, 4)} ${t(`stock:uom.${data.item.uom}`)}`}
        </span>
      )
    }
    const PercentCell = ({ data }: ICellRendererParams<CountLine>) =>
      data ? <span className="fw-st-num">{data.percent === null ? t('diff.noExpected') : `${Number(data.percent) > 0 ? '+' : Number(data.percent) < 0 ? '−' : ''}${quantity(Math.abs(Number(data.percent)), locale, 1)} %`}</span> : null
    const ValueCell = ({ data }: ICellRendererParams<CountLine>) =>
      data ? (
        data.differenceAmount === null || data.differenceAmount === undefined ? (
          <span className="fw-st-sub" title={t('diff.noCostTitle')}>
            {t('diff.noCost')}
          </span>
        ) : (
          <Money minor={data.differenceAmount} currency={value.currency} signed />
        )
      ) : null
    const ReasonCell = ({ data }: ICellRendererParams<CountLine>) => {
      if (!data) return null
      const word = reasonWord(data.reasonCode, reasons)
      if (!editable || data.status === 'UNCOUNTED') {
        return (
          <span className="fw-st-cell">
            <span className={word ? undefined : 'fw-st-warning'}>{word ?? t('diff.noReason')}</span>
            {data.reasonNote && <span className="fw-st-sub" title={data.reasonNote}>{data.reasonNote}</span>}
          </span>
        )
      }
      return (
        <Select size="sm" aria-label={t('diff.reasonOf', { seq: data.seq })} value={data.reasonCode ?? ''} onChange={(event) => latest.current?.onReason?.(data, event.target.value || null)}>
          <option value="">{t('diff.pickReason')}</option>
          {(reasons ?? []).map((reason) => (
            <option key={reason.code} value={reason.code}>
              {locale === 'en' ? reason.labelEn : reason.labelIt}
            </option>
          ))}
        </Select>
      )
    }
    const RecountCell = ({ data }: ICellRendererParams<CountLine>) => {
      if (!data) return null
      if (data.recount) {
        return (
          <span className="fw-st-cell">
            <span>
              <Pill tone={data.recount.quantity === null ? 'warning' : 'info'}>{t(data.recount.quantity === null ? 'diff.recountAsked' : 'diff.recountDone')}</Pill>
            </span>
            <span className="fw-st-sub">{data.recount.at ? formatDateTime(data.recount.at, place) : formatDateTime(data.recount.requestedAt, place)}</span>
          </span>
        )
      }
      return data.recountSuggested ? <Pill tone="warning">{t('diff.recountSuggested')}</Pill> : <span className="fw-st-sub">—</span>
    }
    const cols: ColDef<CountLine>[] = [
      { colId: 'line', headerName: t('diff.col.line'), minWidth: 220, flex: 1.8, cellRenderer: LineCell },
      { colId: 'expected', headerName: t('line.col.expected'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: ExpectedCell },
      { colId: 'counted', headerName: t('line.col.counted'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: CountedCell },
      { colId: 'difference', headerName: t('diff.col.difference'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: DiffCell },
      { colId: 'percent', headerName: t('diff.col.percent'), minWidth: 80, flex: 0.5, type: 'rightAligned', cellRenderer: PercentCell },
    ]
    if (model.can.cost) cols.push({ colId: 'value', headerName: t('diff.col.value'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: ValueCell })
    cols.push(
      { colId: 'reason', headerName: t('diff.col.reason'), minWidth: 180, flex: 1.2, cellRenderer: ReasonCell },
      { colId: 'recount', headerName: t('diff.col.recount'), minWidth: 150, flex: 0.9, cellRenderer: RecountCell },
    )
    return cols
  }, [t, locale, model.timeZone, model.can.cost, value.currency, editable, reasons])

  if (value.status === 'DRAFT') return <EmptyState title={t('lines.draft')} description={t('lines.draftBody')} />
  if (model.diffs.problem || items === null) return <PartState problem={model.diffs.problem} loading={items === null} label={t('tab.differences')} onRetry={actions?.onRetryDiffs} />

  const picked = items.filter((line) => selected.includes(line.id))
  const recountable = picked.filter((line) => line.status !== 'UNCOUNTED')
  const ownKeys: ListKey[] = []
  const state =
    items.length === 0 ? (
      <EmptyState
        icon={<CheckCircle2 size={24} aria-hidden />}
        title={t('diff.none')}
        description={value.summary.uncounted > 0 ? t('diff.noneYet', { count: value.summary.uncounted }) : t('diff.noneBody')}
      />
    ) : undefined
  const unreasoned = items.filter((line) => line.status === 'COUNTED' && !line.reasonCode).length

  return (
    <div className="fw-cn-stack">
      {editable && unreasoned > 0 && <Banner tone="warning" title={t('diff.needReasons', { count: unreasoned })} />}
      {!model.can.cost && <p className="fw-cn-hint">{t('diff.costHidden')}</p>}
      <ListFrame<CountLine>
        label={t('diff.tableLabel', { number: value.number })}
        rows={state ? [] : items}
        rowId={(line) => line.id}
        columns={columns}
        count={t('diff.count', { count: items.length })}
        selection={
          editable
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <>
                    <Button size="sm" heldReason={recountable.length === 0 ? t('diff.select.uncounted') : null} onClick={() => actions?.onRecounts?.(recountable.map((line) => line.id))} aria-label={t('diff.askRecount', { count: recountable.length })}>
                      <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('diff.askRecount', { count: recountable.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'reason', lineIds: picked.map((line) => line.id), reasonCode: null, reasonNote: '' })} aria-label={t('diff.giveReason', { count: picked.length })}>
                      <MessageSquareText size={13} aria-hidden /> <SelectionLabel>{t('diff.giveReason', { count: picked.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              }
            : undefined
        }
        isRowSelectable={(line) => {
          const why = differenceSelectable(line, value, model.can)
          return why ? t(why) : null
        }}
        more={model.diffs.more ? { label: t('list.showMore'), onMore: () => actions?.onMoreDiffs?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        state={state}
      />
      {help && <KeysModal own={ownKeys} withSelection={editable} onClose={() => setHelp(false)} />}
    </div>
  )
}
