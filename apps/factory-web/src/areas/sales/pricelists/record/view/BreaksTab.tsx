'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { Archive, ArchiveRestore, Plus, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { sizeColumns } from '@nexus/ui/grid/size-columns/index'
import { Button, Input, Pill, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { percent, unitPrice } from '../../../quotes/model'
import type { PriceListDetail } from '../../api'
import type { Minimum, PriceBreak } from '../../depth/api'
import { movableMinimums, sortedBreaks, surchargeGrid, surchargeSizes, type SurchargeGridRow } from '../../depth/model'
import { PartState, say, useDay, useDepthWords, useWords } from '../../parts'
import type { BreaksDepthActions, BreaksDepthModel } from '../record-model'
import '../../depth/depth.css'

/**
 * Breaks & surcharges (design sales.pricelists record tab pricelist.breaks, W2b; SAL-166, SAL-170, SAL-178, SAL-180): the
 * version shown's quantity breaks (a price's own or every price's discount: from N pieces, a unit price or a discount,
 * autosaved per cell on the draft), its size surcharges as rows of sizes (the DS SizeColumns: the version's for every
 * style and per style, an amount or a percent per size; each style's own beside them, kept on the style), the list's
 * minimum order quantities (warn, block or a small-run surcharge) and whether its documents show the discount. A version
 * in force keeps its rules (read only, said why). It fetches nothing.
 */
export function BreaksTab({ list, model, actions }: { list: PriceListDetail; model: BreaksDepthModel; actions?: BreaksDepthActions }) {
  const t = useDepthWords()
  const w = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const day = useDay()
  const latest = useRef({ actions, cells: model.cells, editable: model.held === null })
  latest.current = { actions, cells: model.cells, editable: model.held === null }
  const rules = model.rules.status === 'ready' ? model.rules.value : null
  const breaks = useMemo(() => (rules ? sortedBreaks(rules.breaks) : null), [rules])
  const grid = useMemo(() => (rules ? surchargeGrid(rules) : []), [rules])
  const sizes = useMemo(() => (rules ? surchargeSizes(rules, model.extraSizes) : []), [rules, model.extraSizes])
  const currency = list.currency
  const editable = model.held === null
  const minimums = model.minimums.status === 'ready' ? model.minimums.value : null

  const breakColumns = useMemo<ColDef<PriceBreak>[]>(() => {
    const PriceOf = ({ data }: ICellRendererParams<PriceBreak>) =>
      data ? (
        data.entry ? (
          <span className="fw-pd-cell">
            <strong>
              {data.entry.style.code} · {data.entry.colourway ? data.entry.colourway.code : t('breaks.everyColour')}
            </strong>
            <span className="fw-pd-sub">{data.entry.validFrom || data.entry.validTo ? t('breaks.days', { from: day(data.entry.validFrom), to: day(data.entry.validTo) }) : data.entry.style.name}</span>
          </span>
        ) : (
          <strong>{t('breaks.everyPrice')}</strong>
        )
      ) : null
    const MoneyCell = (field: 'unitPrice' | 'discountPct') =>
      function Cell({ data }: ICellRendererParams<PriceBreak>) {
        if (!data) return null
        const { editable: canEdit, cells } = latest.current
        const value = data[field] ?? null
        const mark = cells[`${data.id}:${field}`]
        const shown = field === 'unitPrice' ? unitPrice(value, currency, locale) : percent(value, locale)
        if (!canEdit || (field === 'unitPrice' && data.entryId === null)) return <span className="fw-pd-num">{value === null ? '—' : shown}</span>
        return (
          <span className="fw-pd-edit">
            <Input
              key={`${data.id}-${field}-${value ?? ''}`}
              size="sm"
              fieldClassName="fw-pd-edit-input"
              inputMode="decimal"
              aria-label={t(field === 'unitPrice' ? 'breaks.priceOf' : 'breaks.pctOf', { count: data.minQuantity, of: data.entry ? data.entry.style.code : t('breaks.everyPrice') })}
              defaultValue={value ?? ''}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
                if (event.key === 'Escape') {
                  ;(event.target as HTMLInputElement).value = value ?? ''
                  ;(event.target as HTMLInputElement).blur()
                }
              }}
              onBlur={(event) => {
                const next = event.target.value.trim()
                if (next !== (value ?? '')) latest.current.actions?.onBreakCell?.(data, field, next)
              }}
            />
            {mark && <span className={`fw-pd-mark ${mark}`}>{t(`cell.${mark}`)}</span>}
          </span>
        )
      }
    return [
      { colId: 'price', headerName: t('breaks.col.price'), minWidth: 220, flex: 1.6, cellRenderer: PriceOf, valueGetter: (params) => params.data?.entry?.style.code ?? '' },
      { colId: 'from', headerName: t('breaks.col.from'), minWidth: 120, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? t('breaks.pieces', { count: params.data.minQuantity }) : '') },
      ...(model.can.price
        ? [
            { colId: 'listPrice', headerName: t('breaks.col.listPrice'), minWidth: 130, flex: 0.8, type: 'rightAligned', valueGetter: (params) => (params.data?.entry ? unitPrice(params.data.entry.unitPrice, currency, locale) : '—') } as ColDef<PriceBreak>,
            { colId: 'unitPrice', headerName: t('breaks.col.unitPrice'), minWidth: 160, flex: 1, type: 'rightAligned', cellRenderer: MoneyCell('unitPrice'), valueGetter: (params) => params.data?.unitPrice ?? '' } as ColDef<PriceBreak>,
            { colId: 'discountPct', headerName: t('breaks.col.discount'), minWidth: 150, flex: 1, type: 'rightAligned', cellRenderer: MoneyCell('discountPct'), valueGetter: (params) => params.data?.discountPct ?? '' } as ColDef<PriceBreak>,
          ]
        : []),
    ]
    // Words, grains and the language rebuild the cells; the edit state is read through `latest`.
  }, [t, locale, currency, model.can.price, editable, model.cells, day])

  const surchargeColumns = useMemo<ColDef<SurchargeGridRow>[]>(() => {
    const WhoCell = ({ data }: ICellRendererParams<SurchargeGridRow>) =>
      data ? (
        <span className="fw-pd-cell">
          <strong>{data.style ? `${data.style.code} · ${data.style.name}` : t('surcharges.everyStyle')}</strong>
          <span className="fw-pd-sub">
            {t(data.kind === 'amount' ? 'surcharges.kindAmount' : 'surcharges.kindPct', { currency })}
            {data.scope === 'STYLE' ? ` · ${t('surcharges.own')}` : ''}
          </span>
        </span>
      ) : null
    return [
      { colId: 'who', headerName: t('surcharges.col.who'), minWidth: 220, flex: 1.6, pinned: 'left', cellRenderer: WhoCell, valueGetter: (params) => params.data?.id ?? '' },
      ...(sizes.length > 0
        ? sizeColumns<SurchargeGridRow>({
            sizes,
            value: (row, size) => row.values[size] ?? null,
            required: false,
            editable: (row) => latest.current.editable && row.scope === 'VERSION',
            onChange: (row, size, value) => latest.current.actions?.onSurchargeCell?.(row, size, value),
            onRefused: (_row, size, text) => latest.current.actions?.onSurchargeRefused?.(size, text),
            unit: null,
            scale: 4,
            locale: INTL_LOCALE[locale],
            cellLabel: (row, size) => t('surcharges.cellOf', { who: row.style?.code ?? t('surcharges.everyStyle'), size, kind: t(row.kind === 'amount' ? 'surcharges.kindAmount' : 'surcharges.kindPct', { currency }) }),
            labels: ds.sizeColumns,
          })
        : []),
    ]
  }, [t, sizes, locale, ds.sizeColumns, currency])

  const minimumColumns = useMemo<ColDef<Minimum>[]>(() => {
    const SubjectCell = ({ data }: ICellRendererParams<Minimum>) =>
      data ? (
        <span className="fw-pd-cell">
          <strong>{data.subject === 'STYLE' ? (data.style ? `${data.style.code} · ${data.style.name}` : '—') : data.subject === 'PRODUCT_TYPE' ? t(`minimums.type.${data.productType ?? 'OTHER'}`) : data.item ? `${data.item.code} · ${data.item.name}` : '—'}</strong>
          <span className="fw-pd-sub">{t(`minimums.subject.${data.subject}`)}</span>
        </span>
      ) : null
    const ActionCell = ({ data }: ICellRendererParams<Minimum>) =>
      data ? (
        <span className="fw-pd-inline">
          <Tag tone={data.action === 'BLOCK' ? 'danger' : data.action === 'WARN' ? 'warning' : 'info'}>{t(`minimums.action.${data.action}`)}</Tag>
          {data.action === 'SURCHARGE' && model.can.price ? <span>{data.surchargeAmount ? t('minimums.surchargeAmount', { amount: unitPrice(data.surchargeAmount, data.currency ?? currency, locale) }) : data.surchargePct ? t('minimums.surchargePct', { pct: percent(data.surchargePct, locale) }) : ''}</span> : null}
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<Minimum>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`minimums.status.${data.status}`)}</Pill> : null)
    return [
      { colId: 'subject', headerName: t('minimums.col.subject'), minWidth: 220, flex: 1.6, cellRenderer: SubjectCell, valueGetter: (params) => params.data?.style?.code ?? params.data?.productType ?? params.data?.item?.code ?? '' },
      { colId: 'minimum', headerName: t('minimums.col.minimum'), minWidth: 180, flex: 1, valueGetter: (params) => (params.data ? t(`minimums.per.${params.data.per}`, { count: params.data.minQuantity }) : '') },
      { colId: 'action', headerName: t('minimums.col.action'), minWidth: 220, flex: 1.3, cellRenderer: ActionCell, valueGetter: (params) => params.data?.action ?? '' },
      { colId: 'note', headerName: t('minimums.col.note'), minWidth: 160, flex: 1, valueGetter: (params) => params.data?.note ?? '' },
      { colId: 'status', headerName: t('minimums.col.status'), minWidth: 120, flex: 0.6, cellRenderer: StatusCell, valueGetter: (params) => params.data?.status ?? '' },
    ]
  }, [t, locale, currency, model.can.price])

  const heldWords = model.held ? t(model.held.key, model.held.params) : null
  const breaksPicked = (breaks ?? []).filter((row) => model.selectedBreaks.includes(row.id))
  const minimumsHeld = !model.can.manage ? w('held.noManage') : list.status === 'ARCHIVED' ? w('held.archived') : model.busy ? w('held.busy') : null
  const moveHeld = (move: 'archive' | 'reactivate') => minimumsHeld ?? (movableMinimums(minimums ?? [], model.selectedMinimums, move).length === 0 ? t(move === 'archive' ? 'minimums.held.noneActive' : 'minimums.held.noneArchived') : null)

  const section = (id: string, title: string, sub: string, action: ReactNode, body: ReactNode) => (
    <Card padded>
      <section className="fw-pd-section" aria-labelledby={id}>
        <div className="fw-pd-section-head">
          <div>
            <h2 id={id} className="fw-pd-h2">
              {title}
            </h2>
            <p className="fw-pl-hint">{sub}</p>
          </div>
          {action}
        </div>
        {body}
      </section>
    </Card>
  )

  return (
    <div className="fw-pl-stack">
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words) ?? ''}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {w('common.dismiss')}
            </Button>
          }
        />
      )}
      {model.version && <p className="fw-pl-hint">{t('breaks.ofVersion', { revision: model.version.revision })}</p>}
      {heldWords && model.held?.key !== 'held.noPrice' && <Banner tone="info" title={heldWords} />}
      {!model.can.price && <Banner tone="info" title={t('held.noPrice')} />}

      {section(
        'fw-pd-discount',
        t('discount.title'),
        t('discount.sub'),
        null,
        <SegmentedControl
          ariaLabel={t('discount.title')}
          wrap
          value={model.showDiscount ? 'show' : 'net'}
          disabled={!model.can.manage || list.status === 'ARCHIVED' || model.busy}
          onChange={(value) => actions?.onShowDiscount?.(value === 'show')}
          options={[
            { value: 'net', label: t('discount.net') },
            { value: 'show', label: t('discount.show') },
          ]}
        />,
      )}

      {model.rules.status !== 'ready' ? (
        <PartState problem={model.rules.status === 'error' ? model.rules.problem : null} loading={model.rules.status === 'loading'} label={t('tab.breaks')} onRetry={actions?.onRetry} />
      ) : (
        <>
          {section(
            'fw-pd-breaks',
            t('breaks.title'),
            t('breaks.sub'),
            <Button size="sm" heldReason={heldWords} onClick={() => actions?.onDialog?.({ kind: 'addBreak' })}>
              <Plus size={13} aria-hidden /> {t('breaks.add')}
            </Button>,
            <ListFrame<PriceBreak>
              label={t('breaks.title')}
              listKey={null}
              rows={breaks}
              rowId={(row) => row.id}
              columns={breakColumns}
              rowKind="two-line"
              count={t('breaks.count', { count: breaks?.length ?? 0 })}
              selection={{
                selected: model.selectedBreaks,
                onChange: (ids) => actions?.onSelectBreaks?.(ids),
                actions: (
                  <Button size="sm" variant="danger-outline" heldReason={heldWords ?? (model.busy ? w('held.busy') : null)} onClick={() => actions?.onDialog?.({ kind: 'removeBreaks' })} aria-label={t('breaks.remove', { count: breaksPicked.length })}>
                    <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('breaks.remove', { count: breaksPicked.length })}</SelectionLabel>
                  </Button>
                ),
              }}
              state={breaks && breaks.length === 0 ? <EmptyState title={t('breaks.empty')} description={t(editable ? 'breaks.emptyBody' : 'breaks.emptyView')} /> : undefined}
            />,
          )}
          {section(
            'fw-pd-surcharges',
            t('surcharges.title'),
            t('surcharges.sub'),
            <Button size="sm" heldReason={heldWords} onClick={() => actions?.onDialog?.({ kind: 'addSurcharge' })}>
              <Plus size={13} aria-hidden /> {t('surcharges.add')}
            </Button>,
            model.can.price ? (
              <>
                <ListFrame<SurchargeGridRow>
                  label={t('surcharges.title')}
                  listKey={null}
                  rows={grid}
                  rowId={(row) => row.id}
                  columns={surchargeColumns}
                  rowKind="two-line"
                  count={t('surcharges.count', { count: sizes.length })}
                  cards={null}
                  state={sizes.length === 0 ? <EmptyState title={t('surcharges.empty')} description={t(editable ? 'surcharges.emptyBody' : 'surcharges.emptyView')} /> : undefined}
                />
                <p className="fw-pl-hint">{t(editable ? 'surcharges.how' : 'surcharges.howView')}</p>
              </>
            ) : (
              <p className="fw-pl-hint">{t('held.noPrice')}</p>
            ),
          )}
        </>
      )}

      {section(
        'fw-pd-minimums',
        t('minimums.title'),
        t('minimums.sub'),
        <Button size="sm" heldReason={minimumsHeld} onClick={() => actions?.onDialog?.({ kind: 'addMinimum' })}>
          <Plus size={13} aria-hidden /> {t('minimums.add')}
        </Button>,
        model.minimums.status !== 'ready' ? (
          <PartState problem={model.minimums.status === 'error' ? model.minimums.problem : null} loading={model.minimums.status === 'loading'} label={t('minimums.title')} onRetry={actions?.onRetry} />
        ) : (
          <ListFrame<Minimum>
            label={t('minimums.title')}
            listKey={null}
            rows={minimums}
            rowId={(row) => row.id}
            columns={minimumColumns}
            rowKind="two-line"
            count={t('minimums.count', { count: minimums?.length ?? 0 })}
            selection={{
              selected: model.selectedMinimums,
              onChange: (ids) => actions?.onSelectMinimums?.(ids),
              actions: (
                <>
                  <Button size="sm" heldReason={moveHeld('archive')} onClick={() => actions?.onMoveMinimums?.('archive')} aria-label={t('minimums.archive', { count: movableMinimums(minimums ?? [], model.selectedMinimums, 'archive').length })}>
                    <Archive size={13} aria-hidden /> <SelectionLabel>{t('minimums.archive', { count: movableMinimums(minimums ?? [], model.selectedMinimums, 'archive').length })}</SelectionLabel>
                  </Button>
                  <Button size="sm" heldReason={moveHeld('reactivate')} onClick={() => actions?.onMoveMinimums?.('reactivate')} aria-label={t('minimums.reactivate', { count: movableMinimums(minimums ?? [], model.selectedMinimums, 'reactivate').length })}>
                    <ArchiveRestore size={13} aria-hidden /> <SelectionLabel>{t('minimums.reactivate', { count: movableMinimums(minimums ?? [], model.selectedMinimums, 'reactivate').length })}</SelectionLabel>
                  </Button>
                </>
              ),
            }}
            state={minimums && minimums.length === 0 ? <EmptyState title={t('minimums.empty')} description={t('minimums.emptyBody')} /> : undefined}
          />
        ),
      )}
    </div>
  )
}
