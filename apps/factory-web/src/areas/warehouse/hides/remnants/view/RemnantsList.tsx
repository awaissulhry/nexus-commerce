'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Banner, EmptyState, KeyValue } from '@nexus/ui/components'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { Uom } from '../../../../_shared/stock/api'
import { areaWords } from '../../dashboard/dashboard-model'
import { HidesMessages, useHideWords } from '../../words'
import type { RemnantRecord, RemnantRow, RemnantsPage } from '../api'
import '../../find/find.css'

/** The Remnants view's part of the Hides page (B-W2b-131): the pieces read, one piece opened, and the address prefix. */
export interface RemnantsListModel {
  prefix: string
  timeZone: string
  rows: { items: readonly RemnantRow[] | null; more: boolean; problem: string | null }
  totals: RemnantsPage['totals'] | null
  minimum: RemnantsPage['minimum'] | null
  /** One piece opened (`?remnant=<id>`): its record, still reading (value null, problem null), or why not. */
  open: { id: string; value: RemnantRecord | null; problem: string | null } | null
}

export interface RemnantsListActions {
  onMore?: () => void
  onRetry?: () => void
  onOpen?: (id: string | null) => void
}

/**
 * The remnant pieces (B-W2b-131 on B-W2b-100; SCM-254; design warehouse.hides Rows ▾ "Remnants", the tile "Remnants
 * (pieces · m², W2b)"): every tagged offcut in stock one by one on the shared list frame — its RM tag, the hide and lot it
 * came from, article and colour, shade, grade, its area (unit of entry and the other unit), where it lies, the work order it
 * came back from — with the pieces beside their area for the view, and the smallest piece kept (a constant until the
 * setting exists: said so). A row opens the piece with its history (tagged, state, moved; an office person by name, a floor
 * action by its audience only).
 */
export function RemnantsList({ model, actions }: { model: RemnantsListModel; actions?: RemnantsListActions }) {
  return (
    <HidesMessages>
      <List model={model} actions={actions} />
    </HidesMessages>
  )
}

function List({ model, actions }: { model: RemnantsListModel; actions?: RemnantsListActions }) {
  const t = useHideWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const unit = (uom: Uom) => t(`stock:uom.${uom}`)
  const columns = useMemo<ColDef<RemnantRow>[]>(() => {
    const TagCell = ({ data }: ICellRendererParams<RemnantRow>) =>
      data ? (
        <span className="fw-st-cell">
          <button type="button" className="fw-st-link fw-wl-code fw-hd-linkish" onClick={() => actions?.onOpen?.(data.id)}>
            {data.code}
          </button>
          <span className="fw-st-sub">{t(`rem.state.${data.state}`)}</span>
        </span>
      ) : null
    const HideCell = ({ data }: ICellRendererParams<RemnantRow>) =>
      data ? (
        <span className="fw-st-cell">
          <Link className="fw-st-link fw-wl-code" href={`${model.prefix}/warehouse/hides/${encodeURIComponent(data.hide.id)}`}>
            {data.hide.code}
          </Link>
          <Link className="fw-st-sub fw-st-link" href={`${model.prefix}/warehouse/lots/${encodeURIComponent(data.lot.id)}`}>
            {data.lot.code}
          </Link>
        </span>
      ) : null
    const ArticleCell = ({ data }: ICellRendererParams<RemnantRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis">{`${data.item.code} · ${data.item.name}`}</span>
          <span className="fw-st-sub">{data.colour ? `${data.colour.code} ${data.colour.name}` : '—'}</span>
        </span>
      ) : null
    const ShadeCell = ({ data }: ICellRendererParams<RemnantRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span>{data.shade ?? '—'}</span>
          {data.outOfShade && <Tag tone="warning">{t('rem.outOfShade')}</Tag>}
        </span>
      ) : null
    const AreaCell = ({ data }: ICellRendererParams<RemnantRow>) => (data ? <span className="fw-st-num">{areaWords(data.area.quantity, data.area.uom, unit, locale)}</span> : null)
    const FromCell = ({ data }: ICellRendererParams<RemnantRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span>{data.move.workOrderNumber ?? t(`rem.reason.${data.move.reason === 'REMNANT' ? 'REMNANT' : 'OTHER'}`)}</span>
          <span className="fw-st-sub">{formatDate(data.move.occurredAt, place)}</span>
        </span>
      ) : null
    return [
      { colId: 'tag', headerName: t('rem.col.tag'), minWidth: 160, flex: 1, cellRenderer: TagCell },
      { colId: 'hide', headerName: t('rem.col.hide'), minWidth: 150, flex: 1, cellRenderer: HideCell },
      { colId: 'article', headerName: t('rem.col.article'), minWidth: 180, flex: 1.3, cellRenderer: ArticleCell },
      { colId: 'shade', headerName: t('rem.col.shade'), minWidth: 110, flex: 0.7, cellRenderer: ShadeCell },
      { colId: 'grade', headerName: t('rem.col.grade'), field: 'grade', minWidth: 80, flex: 0.5, valueFormatter: (params) => (params.value as string | null) ?? '—' },
      { colId: 'area', headerName: t('rem.col.area'), minWidth: 160, flex: 1, type: 'rightAligned', cellRenderer: AreaCell },
      { colId: 'place', headerName: t('rem.col.place'), minWidth: 130, flex: 0.8, valueGetter: (params: { data?: RemnantRow }) => (params.data?.location ? `${params.data.location.code} · ${params.data.location.name}` : '—') },
      { colId: 'from', headerName: t('rem.col.from'), minWidth: 140, flex: 0.9, cellRenderer: FromCell },
    ]
  }, [t, locale, model.prefix, model.timeZone, actions])

  const totals = (model.totals ?? []).filter((total) => total.pieces > 0)
  const state = model.rows.problem ? (
    <EmptyState title={t('rem.failed')} description={t(`stock:${model.rows.problem}`)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('lots:rec.retry')}</Button>} />
  ) : model.rows.items && model.rows.items.length === 0 ? (
    <EmptyState title={t('rem.empty')} description={t('rem.emptyBody')} />
  ) : undefined
  const opened = model.open
  const piece = opened?.value?.remnant ?? null

  return (
    <div className="fw-st">
      <p className="fw-wl-text" role="status">
        <b>{totals.length > 0 ? totals.map((total) => t('dash.two', { hides: t('dash.pieces', { count: total.pieces }), area: areaWords(total.area, total.uom, unit, locale) })).join(' · ') : '—'}</b>
        {model.minimum && <span className="fw-st-sub">{` · ${t(model.minimum.setting ? 'rem.minimum' : 'rem.minimumFixed', { area: areaWords(model.minimum.area, model.minimum.uom, unit, locale) })}`}</span>}
      </p>
      <ListFrame<RemnantRow>
        listKey={null}
        label={t('rem.tableLabel')}
        rows={state ? [] : model.rows.items}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.items ? t(model.rows.more ? 'rem.countMore' : 'rem.count', { count: model.rows.items.length }) : '—'}
        more={model.rows.more && model.rows.items && model.rows.items.length > 0 ? { label: t('lots:rec.showMore'), onMore: () => actions?.onMore?.() } : null}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
      />
      {opened && (
        <Modal open onClose={() => actions?.onOpen?.(null)} size="md" title={piece ? t('rem.record.title', { code: piece.code }) : t('rem.record.loading')}>
          {opened.problem ? (
            <Banner tone="danger" title={t('rem.record.failed')}>
              {t(`stock:${opened.problem}`)}
            </Banner>
          ) : !opened.value || !piece ? (
            <p role="status">
              <Spinner size={12} /> {t('rem.record.loading')}
            </p>
          ) : (
            <div className="fw-wl-stack tight">
              <KeyValue
                dense
                columns={2}
                labelCase="sentence"
                items={[
                  { label: t('rem.col.tag'), value: <span className="fw-wl-code">{piece.code}</span>, hint: t(`rem.state.${piece.state}`) },
                  { label: t('rem.col.area'), value: areaWords(piece.area.quantity, piece.area.uom, unit, locale) },
                  { label: t('rem.col.hide'), value: piece.hide.code, hint: piece.lot.code },
                  { label: t('rem.col.article'), value: `${piece.item.code} · ${piece.item.name}`, hint: piece.colour ? `${piece.colour.code} ${piece.colour.name}` : undefined },
                  { label: t('rem.col.shade'), value: piece.shade ?? '—', hint: piece.outOfShade ? t('rem.outOfShade') : undefined },
                  { label: t('rem.col.grade'), value: piece.grade ?? '—' },
                  { label: t('rem.col.place'), value: piece.location ? `${piece.location.code} · ${piece.location.name}` : '—' },
                  { label: t('rem.col.from'), value: piece.move.workOrderNumber ?? '—', hint: formatDateTime(piece.move.occurredAt, place) },
                ]}
              />
              {piece.note && <p className="fw-wl-text">{piece.note}</p>}
              <h3 className="fw-wl-h3">{t('rem.record.history')}</h3>
              {opened.value.history.length === 0 && <p className="fw-st-sub">{t('rem.record.noHistory')}</p>}
              <ul className="fw-hd-move-list">
                {opened.value.history.map((entry, index) => (
                  <li key={`${entry.at}-${index}`}>
                    <span className="fw-st-num">{formatDateTime(entry.at, place)}</span>
                    <span>{t(`rem.action.${entry.action}`)}</span>
                    <span className="fw-st-sub">
                      {entry.action === 'STATE' ? `${entry.from ? t(`rem.state.${entry.from}`) : '—'} → ${entry.to ? t(`rem.state.${entry.to}`) : '—'}` : entry.action === 'MOVED' ? `${entry.from ?? '—'} → ${entry.to ?? '—'}` : ''}
                    </span>
                    <span className="fw-st-sub">{entry.by ?? t(entry.audience === 'FLOOR' ? 'rem.byFloor' : 'rem.bySystem')}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
