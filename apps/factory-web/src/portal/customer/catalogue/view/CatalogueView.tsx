'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { LayoutGrid, List, PackageSearch, ShoppingCart, SlidersHorizontal, WifiOff } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { CatalogueRead, StyleCard } from '../api'
import { filterCount, filtered, isPpe, ppeKey, ppeWords, styleName, typeKey, type CatalogueFilters, type CatalogueViewMode } from '../model'
import { useOrderingWords } from '../../neworder/words'
import { Loading, PricesNote, ReadFailed } from '../../neworder/view/parts'
import { StyleCardView } from './StyleCards'
import { StyleDetailDialog, type StyleDetailModel, type StyleDetailActions } from './StyleDetailDialog'
import '../catalogue.css'

/**
 * SCR-226 › Catalogue (design portal.customer.catalogue: sec:filters "Find a style fast", sec:styles "Styles you can buy",
 * pop:style-detail): the styles this customer may buy with its prices (price grain only), filters as chips with counts and
 * Clear all (a phone: "Filters (n)"), cards or the same fields in the shared list frame (select-all, shift range, x / Space,
 * "Add N to the order" while rows are selected, keys only in the footer's info icon), the style in a DetailModal with
 * J / K through the results. Nothing here writes: "Add to order" opens the draft.
 */

export interface CatalogueViewModel {
  state: 'loading' | 'error' | 'ready'
  read: CatalogueRead | null
  filters: CatalogueFilters
  view: CatalogueViewMode
  prefix: string
  /** A phone: the filters' panel is open. */
  filtersOpen: boolean
  /** The list view's selected rows. */
  selected: readonly string[]
  /** Why "Add to order" cannot act (a key), or null. */
  addHeld: string | null
  /** No connection: what was loaded and when. */
  offlineSince: string | null
  /** The catalogue changed since it was read ("Catalogue updated · Show"). */
  updated: boolean
  detail: StyleDetailModel | null
  /** Design cases: the keys panel open. */
  keysOpen?: boolean
}

export interface CatalogueActions {
  onSearch?: (q: string) => void
  onFilter?: (patch: Partial<CatalogueFilters>) => void
  onClear?: () => void
  onView?: (view: CatalogueViewMode) => void
  onToggleFilters?: () => void
  onOpen?: (id: string) => void
  onAdd?: (ids: readonly string[]) => void
  onSelect?: (ids: string[]) => void
  onRetry?: () => void
  onShowUpdate?: () => void
  onHelp?: () => void
  /** "No styles are open to you yet. Ask us." */
  onAsk?: () => void
  detail?: StyleDetailActions
}

export function CatalogueView({ model, actions }: { model: CatalogueViewModel; actions?: CatalogueActions }) {
  const words = useOrderingWords()
  const { t, locale } = words
  const read = model.read
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const addHeld = model.addHeld ? t(model.addHeld) : null
  const count = filterCount(model.filters)

  const columns = useMemo((): ColDef<StyleCard>[] => {
    const seesPrices = read?.seesPrices ?? false
    const currency = read?.currency ?? 'EUR'
    const StyleCell = ({ data }: ICellRendererParams<StyleCard>) =>
      data ? (
        <span className="fw-pcat-cell">
          <button type="button" className="fw-pcat-name" onClick={() => latest.current.actions?.onOpen?.(data.id)}>
            {styleName(data, locale)}
          </button>
          <span className="fw-pcat-cell-sub">{data.code}</span>
        </span>
      ) : null
    const RangeCell = ({ data }: ICellRendererParams<StyleCard>) => (data ? <Pill tone={data.ownLabel ? 'info' : 'neutral'}>{data.ownLabel ? t('card.ownLabel') : t('card.openRange')}</Pill> : null)
    const PpeCell = ({ data }: ICellRendererParams<StyleCard>) => (data ? <Pill tone={isPpe(data.ppe.category) ? 'warning' : 'neutral'}>{ppeWords(data.ppe, t)}</Pill> : null)
    const column = (colId: string, header: string, cellRenderer: ColDef<StyleCard>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }, value: (row: StyleCard) => string): ColDef<StyleCard> => ({
      colId,
      headerName: header,
      cellRenderer,
      sortable: false,
      valueGetter: ({ data }) => (data ? value(data) : ''),
      ...size,
    })
    return [
      column('style', t('col.style'), StyleCell, { flex: 1.6, minWidth: 220 }, (row) => `${styleName(row, locale)} ${row.code}`),
      column('type', t('col.type'), null, { flex: 0.8, minWidth: 120 }, (row) => `${t(typeKey(row.productType))}${row.season ? ` · ${row.season}` : ''}`),
      column('colours', t('col.colours'), null, { flex: 1.2, minWidth: 160 }, (row) => row.colours.map((colour) => colour.name).join(' · ')),
      column('sizes', t('col.sizes'), null, { flex: 0.6, minWidth: 100 }, (row) => row.range),
      column('ppe', t('col.ppe'), PpeCell, { flex: 1.2, minWidth: 180 }, (row) => ppeWords(row.ppe, t)),
      column('range', t('col.range'), RangeCell, { flex: 0.8, minWidth: 130 }, (row) => (row.ownLabel ? t('card.ownLabel') : t('card.openRange'))),
      ...(seesPrices ? [column('price', t('col.priceFrom'), null, { flex: 0.7, minWidth: 120 }, (row) => words.price(row.priceFrom, currency) ?? '')] : []),
    ]
  }, [read?.seesPrices, read?.currency, t, locale, words])

  const chips = (label: string, values: readonly { value: string; count: number; label: string }[], current: string | null, onPick: (value: string | null) => void) =>
    values.length === 0 ? null : (
      <div className="fw-pcat-chiprow" role="group" aria-label={label}>
        <span className="fw-pcat-chiprow-label">{label}</span>
        {values.map((entry) => (
          <FilterChip key={entry.value} pressed={entry.value === current} count={entry.count} onClick={() => onPick(entry.value === current ? null : entry.value)}>
            {entry.label}
          </FilterChip>
        ))}
      </div>
    )

  const filters = read ? (
    <div className={model.filtersOpen ? 'fw-pcat-filters' : 'fw-pcat-filters is-closed'} id="catalogue-filters">
      {chips(t('filters.category'), read.facets.categories.map((entry) => ({ ...entry, label: t(typeKey(entry.value)) })), model.filters.category, (category) => actions?.onFilter?.({ category }))}
      {chips(t('filters.season'), read.facets.seasons.map((entry) => ({ ...entry, label: entry.value })), model.filters.season, (season) => actions?.onFilter?.({ season }))}
      {chips(t('filters.ppe'), read.facets.ppe.map((entry) => ({ ...entry, label: t(ppeKey(entry.value)) })), model.filters.ppe, (ppe) => actions?.onFilter?.({ ppe }))}
      {chips(
        t('filters.range'),
        [
          ...(read.facets.ownLabel > 0 ? [{ value: 'OWN_LABEL', count: read.facets.ownLabel, label: t('card.ownLabel') }] : []),
          ...(read.facets.openRange > 0 ? [{ value: 'OPEN_RANGE', count: read.facets.openRange, label: t('card.openRange') }] : []),
        ],
        model.filters.range === 'ALL' ? null : model.filters.range,
        (range) => actions?.onFilter?.({ range: (range as CatalogueFilters['range'] | null) ?? 'ALL' }),
      )}
    </div>
  ) : null

  const toolbar = (
    <div className="fw-pcat-toolbar">
      <Input
        className="fw-pcat-search"
        type="search"
        aria-label={t('filters.search')}
        placeholder={t('filters.searchHint')}
        defaultValue={model.filters.q}
        data-list-search=""
        onKeyDown={(event) => {
          if (event.key === 'Enter') actions?.onSearch?.((event.target as HTMLInputElement).value)
          if (event.key === 'Escape' && (event.target as HTMLInputElement).value === '') (event.target as HTMLInputElement).blur()
        }}
        onBlur={(event) => {
          if (event.target.value.trim() !== model.filters.q.trim()) actions?.onSearch?.(event.target.value)
        }}
      />
      <Button size="sm" variant="secondary" className="fw-pcat-filters-toggle" aria-expanded={model.filtersOpen} aria-controls="catalogue-filters" onClick={() => actions?.onToggleFilters?.()}>
        <SlidersHorizontal size={14} aria-hidden /> {count > 0 ? t('filters.toggleN', { count }) : t('filters.toggle')}
      </Button>
      {filtered(model.filters) ? (
        <Button size="sm" variant="quiet" onClick={() => actions?.onClear?.()}>
          {t('filters.clear')}
        </Button>
      ) : null}
      <span className="fw-pcat-spacer" />
      {read ? <span className="fw-pcat-count">{read.count === read.total ? t('catalogue.count', { count: read.count }) : t('catalogue.countOf', { count: read.count, total: read.total })}</span> : null}
      <SegmentedControl
        ariaLabel={t('catalogue.viewLabel')}
        size="sm"
        value={model.view}
        onChange={(value) => actions?.onView?.(value === 'list' ? 'list' : 'cards')}
        options={[
          { value: 'cards', label: t('catalogue.cards'), icon: <LayoutGrid size={14} aria-hidden /> },
          { value: 'list', label: t('catalogue.list'), icon: <List size={14} aria-hidden /> },
        ]}
      />
    </div>
  )

  let body: ReactNode
  if (model.state === 'loading') body = <Loading rows={6} height={220} cards={model.view === 'cards'} />
  else if (model.state === 'error' || !read) body = <ReadFailed title={t('catalogue.failed')} onRetry={actions?.onRetry} />
  else if (read.total === 0)
    body = (
      <EmptyState
        icon={<PackageSearch size={24} aria-hidden />}
        title={t('catalogue.empty')}
        description={t('catalogue.emptyBody')}
        action={
          <Button size="sm" onClick={() => actions?.onAsk?.()}>
            {t('catalogue.ask')}
          </Button>
        }
      />
    )
  else if (read.styles.length === 0 && model.view === 'cards')
    body = (
      <EmptyState
        title={t('catalogue.noMatch')}
        description={model.filters.q.trim() ? t('catalogue.noMatchSearch', { q: model.filters.q.trim() }) : t('catalogue.noMatchFilters')}
        action={
          <Button size="sm" onClick={() => actions?.onClear?.()}>
            {t('filters.clear')}
          </Button>
        }
      />
    )
  else if (model.view === 'cards')
    body = (
      <ul className="fw-pcat-grid" aria-label={t('catalogue.stylesLabel')}>
        {read.styles.map((style) => (
          <li key={style.id}>
            <StyleCardView style={style} currency={read.currency} seesPrices={read.seesPrices} onOpen={() => actions?.onOpen?.(style.id)} add={{ heldReason: addHeld, onAdd: () => actions?.onAdd?.([style.id]) }} />
          </li>
        ))}
      </ul>
    )
  else
    body = (
      <ListFrame<StyleCard>
        label={t('catalogue.stylesLabel')}
        title={t('catalogue.title')}
        listKey={null}
        rows={read.styles}
        rowId={(row) => row.id}
        columns={columns}
        count={t('catalogue.count', { count: read.count })}
        selection={{
          selected: model.selected,
          onChange: (ids) => actions?.onSelect?.(ids),
          actions: (
            <Button size="sm" variant="primary" heldReason={addHeld} onClick={() => actions?.onAdd?.(model.selected)} aria-label={t('catalogue.addN', { count: model.selected.length })}>
              <ShoppingCart size={13} aria-hidden /> <SelectionLabel>{t('catalogue.addN', { count: model.selected.length })}</SelectionLabel>
            </Button>
          ),
        }}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        onHelp={actions?.onHelp}
        state={
          read.styles.length === 0 ? (
            <EmptyState
              title={t('catalogue.noMatch')}
              description={t('catalogue.noMatchFilters')}
              action={
                <Button size="sm" onClick={() => actions?.onClear?.()}>
                  {t('filters.clear')}
                </Button>
              }
            />
          ) : undefined
        }
        cards={{ hrefOf: () => null }}
        keysOpen={model.keysOpen}
      />
    )

  return (
    <div className="fw-pcat">
      {model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline.title', { time: words.time(model.offlineSince) })} /> : null}
      {model.updated ? (
        <Banner
          tone="info"
          title={t('catalogue.changed')}
          action={
            <Button size="sm" onClick={() => actions?.onShowUpdate?.()}>
              {t('catalogue.show')}
            </Button>
          }
        />
      ) : null}
      <section className="fw-pcat-section" aria-labelledby="catalogue-find">
        <h2 id="catalogue-find" className="fw-pno-h2">
          {t('filters.title')}
        </h2>
        {toolbar}
        {filters}
      </section>
      <section className="fw-pcat-section" aria-labelledby="catalogue-styles">
        <h2 id="catalogue-styles" className="fw-pno-h2">
          {t('catalogue.stylesTitle')}
        </h2>
        {read && !read.seesPrices ? <PricesNote /> : null}
        {body}
      </section>
      {model.detail ? <StyleDetailDialog model={model.detail} actions={actions?.detail} /> : null}
    </div>
  )
}
