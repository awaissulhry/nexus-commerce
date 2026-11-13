'use client'

import { useMemo, useRef, type MouseEvent } from 'react'
import { Calculator, ListRestart } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../../list-frame/model'
import type { QuoteDetail, QuoteLine } from '../../../api'
import { money, percent, unitPrice, type Grains } from '../../../model'
import type { PriceReason, PricingLine, QuoteListPrices, QuotePricing } from '../api'
import { breakOf, lineFlag, lineHeld, manualOf, optionsOf, pricingRows, reasonLabel, startOf, type Tone, type Words } from '../model'
import { PriceDepthMessages, usePriceWords } from '../words'
import { ManualChange, type ManualModel } from './ManualChange'
import { signedPrice } from './signed'
import '../price-depth.css'

export interface PricingByLineModel {
  quote: QuoteDetail
  pricing: { status: 'loading' } | { status: 'error'; problem: Words } | { status: 'ready'; value: QuotePricing }
  listPrices: QuoteListPrices | null
  reasons: readonly PriceReason[]
  grains: Grains
  /** Why the prices cannot change here (the version is not a draft, no right), or null. */
  readOnly: Words | null
  selected: readonly string[]
  /** A net being saved or refused, per line. */
  cells: Readonly<Record<string, 'saving' | 'failed'>>
  busy: boolean
  notice: { words: Words; tone: Tone } | null
  manual: ManualModel | null
  /** Bumped when a typed net is dropped (the cell shows the line's net again). */
  resetKey?: number
  /** Design cases: the row that has the focus. */
  focusRow?: number
}

export interface PricingByLineActions {
  onSelect?: (ids: string[]) => void
  /** Row → the docked line drawer with the waterfall (`?line=`). */
  onOpen?: (lineId: string) => void
  /** A net typed in its cell: the manual change asks its reason. */
  onNet?: (lineId: string, text: string) => void
  onBulk?: (how: 'LIST' | 'SUGGESTED', lineIds: string[]) => void
  onRetry?: () => void
  onDismissNotice?: () => void
  manual?: Parameters<typeof ManualChange>[0]['actions']
}

type Row = { pricing: PricingLine; line: QuoteLine | null }

/**
 * Price & margin › Pricing by line (design quote.price.lines, W2b parts of B-W2b-343): how each price was reached and what
 * each line earns, in the ONE list frame — the list price, the options, the quantity break, the manual change with its
 * reason, the net unit (typed in its cell: a manual change asks its reason code), the unit cost and its source (the cost
 * grain), the margin € (cost and margin) and % against the floor (the margin grain), the flag. A row opens the line drawer
 * with its waterfall; selected rows re-price from the list or from the cost, one after the other. It fetches nothing.
 */
export function PricingByLine({ model, actions }: { model: PricingByLineModel; actions?: PricingByLineActions }) {
  return (
    <PriceDepthMessages>
      <Pricing model={model} actions={actions} />
    </PriceDepthMessages>
  )
}

function Pricing({ model, actions }: { model: PricingByLineModel; actions?: PricingByLineActions }) {
  const { t, sales, say } = usePriceWords()
  const locale = useLocale()
  const { quote, grains } = model
  const currency = quote.current.currency
  const ready = model.pricing.status === 'ready' ? model.pricing.value : null
  const rows = useMemo<Row[] | null>(() => (ready ? pricingRows(ready, quote) : null), [ready, quote])
  const editable = model.readOnly === null
  const live = useRef({ actions, cells: model.cells, editable, reasons: model.reasons, list: model.listPrices, resetKey: model.resetKey ?? 0 })
  live.current = { actions, cells: model.cells, editable, reasons: model.reasons, list: model.listPrices, resetKey: model.resetKey ?? 0 }
  const lang = locale === 'it' ? 'it' : 'en'

  const columns = useMemo<ColDef<Row>[]>(() => {
    const open = (event: MouseEvent, id: string) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      live.current.actions?.onOpen?.(id)
    }
    const LineCell = ({ data }: ICellRendererParams<Row>) =>
      data ? (
        <span className="fw-qpd-cell">
          <button type="button" className="fw-qpd-rowlink" onClick={(event) => open(event, data.pricing.lineId)}>
            <strong>{data.pricing.seq}</strong> {data.line ? `${data.line.style.code} · ${data.line.colourway.code}` : ''}
          </button>
          <span className="fw-qpd-sub">{data.pricing.kind === 'SIZE_GRID' ? (data.line?.colourway.name ?? '') : t(`fee.${data.pricing.feeKind ?? 'OTHER'}`)}</span>
        </span>
      ) : null
    const BreakCell = ({ data }: ICellRendererParams<Row>) => {
      if (!data) return null
      const step = breakOf(data.pricing.steps)
      if (!step) return <span className="fw-qpd-muted">—</span>
      const list = live.current.list?.lines.find((entry) => entry.lineId === data.pricing.lineId)
      const same = list?.break && step.source?.id === list.break.breakId
      return (
        <span className="fw-qpd-cell end">
          <span>{signedPrice(step.delta, currency, locale)}</span>
          {same && list?.break ? <span className="fw-qpd-sub">{t('col.breakFrom', { count: list.break.minQuantity })}</span> : null}
        </span>
      )
    }
    const ManualCell = ({ data }: ICellRendererParams<Row>) => {
      if (!data) return null
      const start = startOf(data.pricing.steps)
      const step = manualOf(data.pricing.steps)
      const reasons = live.current.reasons
      if (step) {
        return (
          <span className="fw-qpd-cell end">
            <span>{signedPrice(step.delta, currency, locale)}</span>
            {step.reasonCode ? <span className="fw-qpd-sub">{reasonLabel(reasons, step.reasonCode, lang)}</span> : null}
          </span>
        )
      }
      if (start?.kind === 'MANUAL') {
        return (
          <span className="fw-qpd-cell end">
            <span>{t('col.typedStart')}</span>
            {start.reasonCode ? <span className="fw-qpd-sub">{reasonLabel(reasons, start.reasonCode, lang)}</span> : null}
          </span>
        )
      }
      return <span className="fw-qpd-muted">—</span>
    }
    const NetCell = ({ data }: ICellRendererParams<Row>) => {
      if (!data) return null
      const { editable: canEdit, cells } = live.current
      const mark = cells[data.pricing.lineId]
      const held = lineHeld(data.pricing, 'NET')
      const now = data.pricing.unitPrice ?? ''
      if (!canEdit || held) return <span className="fw-qpd-num">{unitPrice(data.pricing.unitPrice, currency, locale)}</span>
      return (
        <span className="fw-qpd-net">
          <Input
            key={`n-${data.pricing.lineId}-${now}-${live.current.resetKey}`}
            size="sm"
            fieldClassName="fw-qpd-net-input"
            inputMode="decimal"
            aria-label={t('col.netOf', { line: data.pricing.seq })}
            defaultValue={now}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
              if (event.key === 'Escape') {
                ;(event.target as HTMLInputElement).value = now
                ;(event.target as HTMLInputElement).blur()
              }
            }}
            onBlur={(event) => {
              const next = event.target.value.trim()
              if (next !== now && next !== '') live.current.actions?.onNet?.(data.pricing.lineId, next)
            }}
          />
          {mark && (
            <span className={`fw-qpd-mark ${mark}`} role="status">
              {t(`cell.${mark}`)}
            </span>
          )}
        </span>
      )
    }
    const SourceCell = ({ data }: ICellRendererParams<Row>) => {
      if (!data) return null
      const based = data.pricing.suggested?.basedOn ?? null
      const revision = based?.revision ?? data.line?.styleRevision?.revision ?? null
      const status = based?.revisionStatus ?? data.line?.styleRevision?.status ?? null
      if (revision === null) return <span className="fw-qpd-muted">{data.pricing.kind === 'SIZE_GRID' ? sales('lines.noCostSheet') : '—'}</span>
      const on = based?.computedAt ?? based?.on ?? null
      return (
        <span className="fw-qpd-cell">
          <span>{t(status === 'RELEASED' ? 'col.revReleased' : 'col.revDraft', { revision })}</span>
          {on ? <span className="fw-qpd-sub">{t('col.pricedOn', { date: formatDate(on.length === 10 ? `${on}T12:00:00Z` : on, { locale }) })}</span> : null}
        </span>
      )
    }
    const MarginCell = ({ data }: ICellRendererParams<Row>) => {
      if (!data) return null
      const flag = lineFlag(data.pricing)
      return (
        <span className="fw-qpd-inline end">
          {percent(data.pricing.marginPct, locale)}
          {flag ? <Tag tone={flag === 'negative' ? 'danger' : 'warning'}>{t(`flag.${flag}`)}</Tag> : null}
        </span>
      )
    }
    const cols: ColDef<Row>[] = [
      { colId: 'line', headerName: t('col.line'), minWidth: 190, flex: 1.6, pinned: 'left', cellRenderer: LineCell, valueGetter: (params) => params.data?.pricing.seq ?? 0 },
      { colId: 'qty', headerName: t('col.qty'), minWidth: 80, flex: 0.5, type: 'rightAligned', valueGetter: (params) => params.data?.pricing.quantity ?? 0 },
      { colId: 'list', headerName: t('col.list'), minWidth: 120, flex: 0.9, type: 'rightAligned', valueGetter: (params) => unitPrice(params.data?.pricing.listUnitPrice, currency, locale) },
      { colId: 'options', headerName: t('col.options'), minWidth: 110, flex: 0.8, type: 'rightAligned', valueGetter: (params) => (params.data ? (optionsOf(params.data.pricing.steps) ? signedPrice(optionsOf(params.data.pricing.steps), currency, locale) : '—') : '') },
      { colId: 'break', headerName: t('col.break'), minWidth: 130, flex: 0.9, type: 'rightAligned', cellRenderer: BreakCell, valueGetter: (params) => breakOf(params.data?.pricing.steps)?.delta ?? '' },
      { colId: 'manual', headerName: t('col.manual'), minWidth: 150, flex: 1.1, type: 'rightAligned', cellRenderer: ManualCell, valueGetter: (params) => manualOf(params.data?.pricing.steps)?.delta ?? '' },
      { colId: 'net', headerName: t(quote.current.priceBasis === 'GROSS' ? 'col.netGross' : 'col.net'), minWidth: 170, flex: 1.1, type: 'rightAligned', cellRenderer: NetCell, valueGetter: (params) => params.data?.pricing.unitPrice ?? '' },
      ...(grains.cost
        ? [
            { colId: 'cost', headerName: t('col.cost'), minWidth: 120, flex: 0.9, type: 'rightAligned', valueGetter: (params) => (params.data?.line ? (params.data.line.costComplete ? unitPrice(params.data.line.unitCost, currency, locale) : sales('lines.costMissing')) : '—') } as ColDef<Row>,
            { colId: 'source', headerName: t('col.source'), minWidth: 170, flex: 1.1, cellRenderer: SourceCell, valueGetter: (params) => params.data?.pricing.suggested?.basedOn?.revision ?? '' } as ColDef<Row>,
          ]
        : []),
      ...(grains.cost && grains.margin ? [{ colId: 'marginAmount', headerName: t('col.marginAmount'), minWidth: 120, flex: 0.9, type: 'rightAligned', valueGetter: (params) => (params.data?.line ? money(params.data.line.marginAmount, currency, locale) : '—') } as ColDef<Row>] : []),
      ...(grains.margin ? [{ colId: 'margin', headerName: t('col.margin'), minWidth: 170, flex: 1, type: 'rightAligned', cellRenderer: MarginCell, valueGetter: (params) => params.data?.pricing.marginPct ?? '' } as ColDef<Row>] : []),
    ]
    return cols
    // Words, grains, the basis and the language rebuild the cells; the edit state is read through `live`.
  }, [t, sales, locale, lang, currency, quote.current.priceBasis, grains.cost, grains.margin, editable, model.cells, model.resetKey])

  const picked = (rows ?? []).filter((row) => model.selected.includes(row.pricing.lineId))
  const reach = (how: 'LIST' | 'SUGGESTED') => picked.filter((row) => lineHeld(row.pricing, how) === null)
  const bulkHeld = (how: 'LIST' | 'SUGGESTED') => (model.readOnly ? say(model.readOnly) : model.busy ? t('held.busy') : reach(how).length === 0 ? t(how === 'LIST' ? 'held.noneList' : 'held.noneCost') : null)
  const keys: ListKey[] = [{ keys: ['Enter'], does: t('keys.open') }]
  const floor = ready?.floor

  return (
    <div className="fw-qpd-stack">
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {model.readOnly && <Banner tone="info" title={say(model.readOnly)} />}
      <Card
        header={t('pricing.title')}
        headingLevel={3}
        description={`${t('pricing.sub')}${grains.margin && floor?.marginFloorPct !== undefined ? ` ${t(floor.source === 'ROLE' ? 'pricing.floorRole' : 'pricing.floorCompany', { floor: percent(floor.marginFloorPct, locale) })}` : ''}`}
      >
        <ListFrame<Row>
          label={t('pricing.title')}
          listKey={null}
          rows={model.pricing.status === 'error' ? [] : rows}
          rowId={(row) => row.pricing.lineId}
          columns={columns}
          rowKind="two-line"
          count={rows ? t('pricing.count', { count: rows.length }) : t('common.loading')}
          isRowSelectable={(row) => (row.pricing.kind === 'SIZE_GRID' ? null : t('held.fee'))}
          selection={{
            selected: model.selected,
            onChange: (ids) => actions?.onSelect?.(ids),
            actions: (
              <>
                <Button size="sm" heldReason={bulkHeld('LIST')} onClick={() => actions?.onBulk?.('LIST', reach('LIST').map((row) => row.pricing.lineId))} aria-label={t('bulk.list', { count: reach('LIST').length })}>
                  {model.busy ? <Spinner size={12} /> : <ListRestart size={13} aria-hidden />} <SelectionLabel>{t('bulk.list', { count: reach('LIST').length })}</SelectionLabel>
                </Button>
                <Button size="sm" heldReason={bulkHeld('SUGGESTED')} onClick={() => actions?.onBulk?.('SUGGESTED', reach('SUGGESTED').map((row) => row.pricing.lineId))} aria-label={t('bulk.cost', { count: reach('SUGGESTED').length })}>
                  <Calculator size={13} aria-hidden /> <SelectionLabel>{t('bulk.cost', { count: reach('SUGGESTED').length })}</SelectionLabel>
                </Button>
              </>
            ),
          }}
          keys={keys}
          onOpen={(row) => actions?.onOpen?.(row.pricing.lineId)}
          focusRow={model.focusRow}
          state={
            model.pricing.status === 'error' ? (
              <EmptyState
                title={t('pricing.failed')}
                description={say(model.pricing.problem)}
                action={
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                }
              />
            ) : rows && rows.length === 0 ? (
              <EmptyState title={sales('price.empty.title')} description={sales('price.empty.body')} />
            ) : undefined
          }
        />
        <p className="fw-q-hint">{t(editable ? 'pricing.howEdit' : 'pricing.howOpen')}</p>
      </Card>
      {model.manual && <ManualChange model={model.manual} actions={actions?.manual} />}
    </div>
  )
}
