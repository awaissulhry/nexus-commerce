'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Package } from 'lucide-react'
import { Button, Checkbox, Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { Dual, QualityPill, Qty } from '../../../_shared/stock/parts'
import type { StockLine } from '../model'

export interface StockCardsProps {
  lines: readonly StockLine[] | null
  /** Drawn in place of the cards (a failed read, nothing yet, nothing matching). */
  state?: ReactNode
  count: ReactNode
  search: ReactNode
  /** The Rows ▾ view and the tile's chip (the same filters as the grid). */
  tools: ReactNode
  selected: readonly string[]
  onSelected: (ids: string[]) => void
  /** The bulk actions while select mode holds rows (the grid's). */
  bulk: ReactNode
  /** Where a card opens: its hide, else its lot; null for stock without a lot. */
  hrefOf: (line: StockLine) => string | null
  /** Design cases: select mode already on. */
  selectMode?: boolean
}

/**
 * Stock below 720 px (design warehouse.stock sec:st-phone; DS gap D3 "Grid card list", composed here as the styles list
 * does): the same rows as cards — material and colour, the lot with its quality Pill (held words when held), on hand
 * (leather in two numbers), the place — with the same search and Rows ▾ view; a tap on the code opens the lot (or the
 * hide); Select mode puts a box on each card, Select all, and the grid's bulk actions.
 */
export function StockCards({ lines, state, count, search, tools, selected, onSelected, bulk, hrefOf, selectMode }: StockCardsProps) {
  const t = useT('warehouse-stock')
  const [selecting, setSelecting] = useState(selectMode ?? selected.length > 0)
  const items = lines ?? []
  const all = items.length > 0 && items.every((line) => selected.includes(line.id))
  const some = !all && items.some((line) => selected.includes(line.id))
  const toggle = (id: string) => onSelected(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id])
  return (
    <section className="fw-stkc" aria-label={t('st.tableLabel')}>
      <div className="fw-stkc-bar">
        {selecting ? (
          <>
            <Checkbox
              ref={(box) => {
                // The DS box has no mixed state of its own: the native one, set on the element.
                if (box) box.indeterminate = some
              }}
              checked={all}
              onChange={() => onSelected(all ? [] : items.map((line) => line.id))}
              aria-label={t('st.phone.selectAll')}
              label={t('st.phone.selected', { count: selected.length })}
            />
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                setSelecting(false)
                onSelected([])
              }}
            >
              {t('st.phone.done')}
            </Button>
          </>
        ) : (
          <>
            <div className="fw-stkc-search">{search}</div>
            {tools}
            <Button size="sm" variant="quiet" onClick={() => setSelecting(true)} heldReason={items.length === 0 ? t('st.phone.nothingToSelect') : null}>
              {t('st.phone.select')}
            </Button>
          </>
        )}
      </div>
      {selecting && selected.length > 0 && <div className="fw-stkc-bar">{bulk}</div>}
      <p className="fw-stk-hint" role="status">
        {count}
      </p>
      {state ?? (
        <ul className="fw-stkc-list">
          {items.map((line) => {
            const on = selected.includes(line.id)
            const href = hrefOf(line)
            const code = line.hide?.code ?? line.lot?.code ?? null
            return (
              <li key={line.id} className={on ? 'fw-stkc-card is-on' : 'fw-stkc-card'}>
                {selecting && <Checkbox checked={on} onChange={() => toggle(line.id)} aria-label={t('st.phone.selectOne', { material: line.item.code, place: line.location.code })} />}
                <span className="fw-stkc-thumb" aria-hidden>
                  <Package size={18} />
                </span>
                <span className="fw-stkc-body">
                  <span className="fw-stkc-top">
                    <span className="fw-st-ellipsis">
                      {line.item.code} · {line.item.name}
                    </span>
                    {line.lot && (line.hold ? <Pill tone="warning">{t('st.onHold')}</Pill> : <QualityPill status={line.lot.qualityStatus} />)}
                  </span>
                  <span className="fw-st-sub">{[line.colour ? `${line.colour.code} ${line.colour.name}` : t(`st.tracking.${line.item.tracking}`), line.location.code].join(' · ')}</span>
                  <span className="fw-stkc-top">
                    {code && href ? (
                      <Link className="fw-st-link" href={href}>
                        {code}
                      </Link>
                    ) : (
                      <span className="fw-st-sub">{t('st.noLot')}</span>
                    )}
                    {line.item.tracking === 'HIDE' && !line.hide ? <Dual hides={line.hides} area={line.onHand} uom={line.item.baseUom} /> : <Qty value={line.onHand} uom={line.item.baseUom} strong />}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
