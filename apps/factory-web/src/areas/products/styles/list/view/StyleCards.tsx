'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Hand, MoreHorizontal, Shirt, SlidersHorizontal } from 'lucide-react'
import { Menu } from '@nexus/ui/components'
import { Button, Checkbox, Pill, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { StyleRow } from '../../api'
import { moneyText, rangeWords, revisionChips, STATUS_TONE } from '../../model'
import type { ListPrices } from '../list-model'

/** The product type's sign on the card (no picture in the list yet: the gallery comes in W2b). */
function TypeIcon({ type }: { type: StyleRow['productType'] }) {
  return type === 'GLOVES' ? <Hand size={18} aria-hidden /> : <Shirt size={18} aria-hidden />
}

export interface StyleCardsProps {
  rows: readonly StyleRow[] | null
  /** Drawn in place of the cards (a failed read, nothing yet, nothing matching). */
  state?: ReactNode
  count: ReactNode
  search: ReactNode
  /** The filters beyond the search (the Filters (n) button's number). */
  filterCount: number
  onFilters: () => void
  selected: readonly string[]
  onSelected: (ids: string[]) => void
  /** The bulk actions while select mode holds rows. */
  bulk: ReactNode
  prices: ListPrices
  showPrice: boolean
  recordHref: (row: StyleRow) => string
  onDuplicate?: (row: StyleRow) => void
  duplicateHeld: string | null
  more: { label: string; onMore: () => void } | null
  /** Design cases: select mode already on. */
  selectMode?: boolean
}

/**
 * The styles list below 720 px (design products.styles sec:styles.phone; DS gap D3 "Grid card list", composed here):
 * one card per style — the type's sign (the picture comes with the gallery, W2b), code and name (a real link), status,
 * revision, range and SKUs, and the list price with the price grain — with a toolbar of search, Filters (n) (the filter
 * sheet) and Select: select mode puts a box on each card, Select all, and the same bulk actions as the grid.
 */
export function StyleCards({ rows, state, count, search, filterCount, onFilters, selected, onSelected, bulk, prices, showPrice, recordHref, onDuplicate, duplicateHeld, more, selectMode }: StyleCardsProps) {
  const t = useT('products')
  const locale = useLocale()
  const [selecting, setSelecting] = useState(selectMode ?? selected.length > 0)
  const items = rows ?? []
  const all = items.length > 0 && items.every((row) => selected.includes(row.id))
  const some = !all && items.some((row) => selected.includes(row.id))
  const toggle = (id: string) => onSelected(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id])
  return (
    <section className="fw-stc" aria-label={t('list.tableLabel')}>
      <div className="fw-stc-bar">
        {selecting ? (
          <>
            <Checkbox
              ref={(box) => {
                // The DS box has no mixed state of its own: the native one, set on the element.
                if (box) box.indeterminate = some
              }}
              checked={all}
              onChange={() => onSelected(all ? [] : items.map((row) => row.id))}
              aria-label={t('phone.selectAll')}
              label={t('phone.selected', { count: selected.length })}
            />
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                setSelecting(false)
                onSelected([])
              }}
            >
              {t('phone.done')}
            </Button>
          </>
        ) : (
          <>
            <div className="fw-stc-search">{search}</div>
            <Button size="sm" onClick={onFilters} aria-haspopup="dialog">
              <SlidersHorizontal size={13} aria-hidden /> {filterCount > 0 ? t('phone.filtersN', { count: filterCount }) : t('phone.filters')}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setSelecting(true)} heldReason={items.length === 0 ? t('phone.nothingToSelect') : null}>
              {t('phone.select')}
            </Button>
          </>
        )}
      </div>
      {selecting && selected.length > 0 && <div className="fw-stc-bulk">{bulk}</div>}
      <p className="fw-st-hint" role="status">
        {count}
      </p>
      {state ?? (
        <ul className="fw-stc-list">
          {items.map((row) => {
            const price = prices.state === 'ready' ? prices.byStyle[row.id] : undefined
            const on = selected.includes(row.id)
            return (
              <li key={row.id} className={on ? 'fw-stc-card is-on' : 'fw-stc-card'}>
                {selecting && <Checkbox checked={on} onChange={() => toggle(row.id)} aria-label={t('phone.selectOne', { code: row.code })} />}
                <span className="fw-stc-thumb" aria-hidden>
                  <TypeIcon type={row.productType} />
                </span>
                <span className="fw-stc-body">
                  <span className="fw-stc-top">
                    <Link className="fw-st-rowlink" href={recordHref(row)}>
                      {row.code}
                    </Link>
                    <Pill tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Pill>
                  </span>
                  <span className="fw-stc-name">{row.name}</span>
                  <span className="fw-st-inline">
                    {revisionChips(row).map((chip) => (
                      <Tag key={chip.kind} tone={chip.kind === 'released' ? 'success' : 'info'}>
                        {t(`list.rev.${chip.kind}`, { revision: chip.revision })}
                      </Tag>
                    ))}
                    {revisionChips(row).length === 0 && <span className="fw-st-hint">{t('list.noRevision')}</span>}
                  </span>
                  <span className="fw-st-hint">
                    {[t(`productType.${row.productType}`), row.sizes.length ? rangeWords(row.sizes) : null, t('phone.skus', { count: row.skuCount })].filter(Boolean).join(' · ')}
                  </span>
                  {showPrice && prices.state === 'ready' && (
                    <span className="fw-stc-price">{price?.price ? t(price.from ? 'list.price.from' : 'list.price.is', { price: moneyText(price.price, prices.list.currency, locale) }) : t('list.price.none')}</span>
                  )}
                </span>
                <Menu
                  label={<MoreHorizontal size={16} aria-hidden />}
                  align="right"
                  triggerProps={{ 'aria-label': t('list.rowMenu', { code: row.code }) }}
                  items={[
                    { id: 'open', label: t('list.open'), href: recordHref(row) },
                    { id: 'duplicate', label: t('list.duplicate'), disabled: !!duplicateHeld, description: duplicateHeld ?? undefined, onSelect: () => onDuplicate?.(row) },
                  ]}
                />
              </li>
            )
          })}
        </ul>
      )}
      {more && !state && (
        <Button size="sm" onClick={more.onMore}>
          {more.label}
        </Button>
      )}
    </section>
  )
}
