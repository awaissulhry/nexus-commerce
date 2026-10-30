'use client'

import { useMemo, useRef, useState, useEffect } from 'react'
import Link from 'next/link'
import { Percent, Plus, Search, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { useLocale } from '../../../../../lib/i18n/provider'
import { percent, unitPrice } from '../../../quotes/model'
import type { PriceEntry, PriceListDetail } from '../../api'
import { entriesMatching, nextVersionHeld, priceColumnIds, pricesHeld, sortedEntries, versionToShow } from '../../model'
import { PartState, useDay, useValidity, useWords, VersionPill } from '../../parts'
import type { CellState, PriceListRecordActions, PriceListRecordModel } from '../record-model'

/**
 * Prices (design pricelist.prices: one row per style, and colourway when it differs): the version shown (the draft being
 * edited, else the one in force; any other from the picker), then the ONE list frame — the net unit price typed in place
 * and saved when the cell is left (autosave per cell, on a DRAFT only), the standard cost (cost grain) and the margin %
 * at this price (margin grain; under the floor is toned) — and, over the rows picked, Raise N by % (reviewed before it
 * is written) and Remove N. A version in force keeps its prices: the tab says so and offers the next version.
 */
export function PricesTab({ list, model, actions }: { list: PriceListDetail; model: PriceListRecordModel; actions?: PriceListRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const day = useDay()
  const validity = useValidity()
  const version = versionToShow(list, model.versionId)
  const held = pricesHeld(list, version, model.can)
  const editable = held === null
  const answer = model.prices.answer && model.prices.answer.version.id === version?.id ? model.prices.answer : null
  const entries = useMemo(() => sortedEntries(answer?.entries ?? []), [answer])
  const shown = useMemo(() => entriesMatching(entries, model.q), [entries, model.q])
  const picked = shown.filter((entry) => model.selectedPrices.includes(entry.id))
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const live = useRef({ actions, cells: model.cells, editable, currency: list.currency, locale })
  live.current = { actions, cells: model.cells, editable, currency: list.currency, locale }
  const ownKeys: ListKey[] = []
  const versionHref = (id: string) => `${model.prefix}/sales/price-lists/${encodeURIComponent(list.id)}?tab=prices&version=${encodeURIComponent(id)}`

  const columns = useMemo<ColDef<PriceEntry>[]>(() => {
    const StyleCell = ({ data }: ICellRendererParams<PriceEntry>) =>
      data ? (
        <span className="fw-pl-cell">
          <Link className="fw-pl-link" href={`${model.prefix}/products/styles/${encodeURIComponent(data.styleId)}`} tabIndex={-1}>
            {data.style.code}
          </Link>
          <span className="fw-pl-sub">{data.style.name}</span>
        </span>
      ) : null
    const ColourCell = ({ data }: ICellRendererParams<PriceEntry>) => (data ? <span>{data.colourway ? `${data.colourway.code} · ${data.colourway.name}` : t('prices.everyColour')}</span> : null)
    const PriceCell = ({ data }: ICellRendererParams<PriceEntry>) => {
      if (!data) return null
      const { editable: canEdit, cells, currency, locale: here } = live.current
      const mark: CellState | undefined = cells[data.id]
      if (!canEdit) return <span className="fw-pl-num">{unitPrice(data.unitPrice, currency, here)}</span>
      return (
        <span className="fw-pl-price">
          <Input
            key={`p-${data.id}-${data.unitPrice ?? ''}`}
            size="sm"
            fieldClassName="fw-pl-price-input"
            inputMode="decimal"
            aria-label={t('prices.priceOf', { style: data.style.code, colour: data.colourway?.code ?? t('prices.everyColour') })}
            defaultValue={data.unitPrice ?? ''}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
              if (event.key === 'Escape') {
                ;(event.target as HTMLInputElement).value = data.unitPrice ?? ''
                ;(event.target as HTMLInputElement).blur()
              }
            }}
            onBlur={(event) => {
              const next = event.target.value.trim()
              if (next !== (data.unitPrice ?? '')) live.current.actions?.onPrice?.(data, next)
            }}
          />
          {mark && (
            <span className={`fw-pl-mark ${mark}`} role="status">
              {t(`prices.cell.${mark}`)}
            </span>
          )}
        </span>
      )
    }
    const MarginCell = ({ data }: ICellRendererParams<PriceEntry>) =>
      data ? (
        <span className="fw-pl-inline">
          {percent(data.marginPct, live.current.locale)}
          {data.belowFloor ? <Tag tone="warning">{t('prices.belowFloor')}</Tag> : null}
        </span>
      ) : null
    const all: Record<string, ColDef<PriceEntry>> = {
      style: { colId: 'style', headerName: t('prices.col.style'), minWidth: 160, flex: 1.4, cellRenderer: StyleCell, valueGetter: (params) => params.data?.style.code ?? '' },
      colour: { colId: 'colour', headerName: t('prices.col.colour'), minWidth: 160, flex: 1.4, cellRenderer: ColourCell, valueGetter: (params) => params.data?.colourway?.code ?? '' },
      price: { colId: 'price', headerName: t('prices.col.price'), minWidth: 170, flex: 1, type: 'rightAligned', cellRenderer: PriceCell, valueGetter: (params) => params.data?.unitPrice ?? '' },
      cost: { colId: 'cost', headerName: t('prices.col.cost'), minWidth: 140, flex: 1, type: 'rightAligned', valueGetter: (params) => unitPrice(params.data?.standardCost, list.currency, locale) },
      margin: { colId: 'margin', headerName: t('prices.col.margin'), minWidth: 170, flex: 1, cellRenderer: MarginCell, valueGetter: (params) => params.data?.marginPct ?? '' },
    }
    // Money by grain: a column the person's grains do not reach is absent (the API sends no such field either).
    return priceColumnIds(model.can).map((id) => all[id]!)
    // Words, the person's grains and the language: a change rebuilds the cells; the edit state is read through `live`.
  }, [t, locale, model.prefix, model.can.price, model.can.cost, model.can.margin, list.currency, editable, model.cells])

  const nextHeld = nextVersionHeld(list, model.can)
  const bulkHeld = held ? t(held) : model.busy ? t('held.busy') : null

  return (
    <div className="fw-pl-stack">
      <Card padded>
        <div className="fw-pl-tabhead">
          <div className="fw-pl-tabhead-fields">
            <Field label={t('prices.version')}>
              <Select className="fw-pl-version-field" value={version?.id ?? ''} onChange={(event) => actions?.onVersion?.(event.target.value)} aria-label={t('prices.version')}>
                {list.versions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t(item.status === 'DRAFT' ? 'prices.versionDraft' : 'prices.versionActive', { revision: item.revision })}
                  </option>
                ))}
              </Select>
            </Field>
            {version && (
              <KeyValue
                dense
                labelCase="sentence"
                items={[
                  { label: t('prices.days'), value: validity(version.validFrom, version.validTo) },
                  { label: t('prices.status'), value: <VersionPill version={version} today={model.today} /> },
                  ...(version.activatedAt ? [{ label: t('prices.activatedAt'), value: day(version.activatedAt.slice(0, 10)) }] : []),
                ]}
              />
            )}
          </div>
        </div>
        {version?.note && <p className="fw-pl-hint">{version.note}</p>}
      </Card>

      {held && held !== 'held.noPrice' && (
        <Banner
          tone="info"
          title={t(held, { revision: version?.revision ?? 0 })}
          action={
            held === 'held.activeVersion' ? (
              <Button size="sm" heldReason={nextHeld ? t(nextHeld) : model.busy ? t('held.busy') : null} onClick={() => actions?.onNextVersion?.()}>
                {t('record.nextVersion')}
              </Button>
            ) : held === 'held.activeHasDraft' && list.draftVersionId ? (
              <Button size="sm" asChild>
                <Link href={versionHref(list.draftVersionId)}>{t('prices.toDraft')}</Link>
              </Button>
            ) : undefined
          }
        />
      )}
      {!model.can.price && <Banner tone="info" title={t('held.noPrice')} />}
      {model.can.price && (!model.can.cost || !model.can.margin) && <p className="fw-pl-hint">{t(model.can.margin ? 'prices.grainNoteCost' : 'prices.grainNote')}</p>}

      {model.prices.problem || (model.prices.loading && !answer) ? (
        <PartState problem={model.prices.problem} loading={model.prices.loading} label={t('tab.prices')} onRetry={actions?.onRetryPrices} />
      ) : (
        <ListFrame<PriceEntry>
          label={t('prices.table', { revision: version?.revision ?? 0 })}
          listKey={null}
          rows={shown}
          rowId={(entry) => entry.id}
          columns={columns}
          rowKind="two-line"
          count={t('prices.count', { count: shown.length })}
          search={
            <Input
              size="sm"
              type="search"
              leadingIcon={<Search size={13} aria-hidden />}
              aria-label={t('prices.search')}
              placeholder={t('prices.search')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                actions?.onSearch?.(event.target.value)
              }}
            />
          }
          right={
            <Button size="sm" heldReason={held ? t(held) : !model.can.styles ? t('held.noStyles') : null} onClick={() => actions?.onDialog?.({ kind: 'addPrice' })}>
              <Plus size={13} aria-hidden /> {t('prices.add')}
            </Button>
          }
          selection={{
            selected: model.selectedPrices,
            onChange: (ids) => actions?.onSelectPrices?.(ids),
            actions: (
              <>
                <Button size="sm" aria-label={t('prices.bulk.raise', { count: picked.length })} heldReason={bulkHeld} onClick={() => actions?.onDialog?.({ kind: 'raise', pct: '' })}>
                  <Percent size={13} aria-hidden /> <SelectionLabel>{t('prices.bulk.raise', { count: picked.length })}</SelectionLabel>
                </Button>
                <Button size="sm" variant="danger-outline" aria-label={t('prices.bulk.remove', { count: picked.length })} heldReason={bulkHeld} onClick={() => actions?.onDialog?.({ kind: 'removePrices' })}>
                  <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('prices.bulk.remove', { count: picked.length })}</SelectionLabel>
                </Button>
              </>
            ),
          }}
          keys={ownKeys}
          onHelp={() => actions?.onDialog?.({ kind: 'help' })}
          state={
            entries.length === 0 ? (
              <EmptyState
                title={t('prices.empty.title')}
                description={t(editable ? 'prices.empty.body' : 'prices.empty.bodyView')}
                action={
                  <Button size="sm" variant="primary" heldReason={held ? t(held) : !model.can.styles ? t('held.noStyles') : null} onClick={() => actions?.onDialog?.({ kind: 'addPrice' })}>
                    {t('prices.add')}
                  </Button>
                }
              />
            ) : shown.length === 0 ? (
              <EmptyState
                title={t('prices.noMatch')}
                action={
                  <Button size="sm" onClick={() => actions?.onSearch?.('')}>
                    {t('list.clearAll')}
                  </Button>
                }
              />
            ) : undefined
          }
          focusRow={model.focusRow}
        />
      )}
      {editable && entries.length > 0 && <p className="fw-pl-hint">{t('prices.autosave')}</p>}
    </div>
  )
}
