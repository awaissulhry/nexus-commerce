'use client'

/**
 * BarList — labelled horizontal bars for categories (B-W2b-09; design "BarList": customers, suppliers, lots, ageing):
 * the value written at the end, optional stacked parts (ageing buckets) with their legend, a click drills down.
 *
 *   <BarList label="Margin by customer" format={(n) => pct(n, locale)} active={customer} onPick={setCustomer}
 *     items={[{ id: 'c1', label: 'Rossi Moto', sub: '4 orders', value: 18.2, tone: 'warning' }, …]} />
 *   <BarList label="Overdue by customer" format={money} keys={[{ id: 'd30', label: '0–30 days' }, { id: 'd60', label: '31–60 days', tone: 'warning' }]}
 *     items={[{ id: 'c1', label: 'Rossi Moto', value: 12400, parts: { d30: 8000, d60: 4400 } }]} />
 *
 * - **A table for a screen reader**: the list IS a table (caption, a name and a value column), so each row is read as
 *   "Rossi Moto, 18.2 %" and a stacked bar's parts are said after its value; the bars are drawn for the eye only.
 * - **Drill-down**: `onPick(id)` makes each name a button (`aria-pressed` with `active`), `href` a real link.
 * - **Never colour alone**: the value is always written; a stacked bar's parts alternate a pattern and the legend
 *   names them; an unknown value says "—".
 * Its own entry point (`charts/bar-list`). Words: `labels`; numbers: `format`.
 */
import type { ComponentType, ReactNode } from 'react'
import NextLink from 'next/link'

import { mergeLabels } from '../../lib/labels'
import { BAR_LIST_LABELS, type BarListLabels } from './BarListLabels'
import { barListView, type BarTone } from './barListModel'
import './bar-list.css'

export interface BarListItem {
  id: string
  /** The category's name ("Rossi Moto"). */
  label: string
  /** A short line under the name ("4 orders"). */
  sub?: ReactNode
  /** The value; null when not known. */
  value: number | null | undefined
  /** The value written (default `format(value)`). */
  valueText?: string
  /** Stacked parts by the legend's id. */
  parts?: Readonly<Record<string, number | null | undefined>>
  /** A real link: the record behind the bar. */
  href?: string
  tone?: BarTone
}

export interface BarListKey {
  id: string
  label: string
  tone?: BarTone
}

export type BarListLinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode; 'aria-label'?: string }>

export interface BarListProps {
  items: readonly BarListItem[]
  /** The list's name (its table caption): "Margin by customer". */
  label: string
  /** Writes a value: "18.2 %", "€12,400". */
  format: (value: number) => string
  /** The stacked parts' legend, in drawing order. */
  keys?: readonly BarListKey[]
  /** The scale's end (bars of several lists that must compare). Default: the largest value. */
  max?: number | null
  /** A row's name is a button: drill down to that category. */
  onPick?: (id: string) => void
  /** The picked row (`aria-pressed`). */
  active?: string | null
  linkAs?: BarListLinkComponent
  labels?: Partial<BarListLabels>
  className?: string
}

export function BarList({ items, label, format, keys = [], max, onPick, active, linkAs, labels, className }: BarListProps) {
  const words = mergeLabels(BAR_LIST_LABELS, labels)
  const cls = ['nds-barlist', className ?? ''].filter(Boolean).join(' ')
  if (items.length === 0) return <p className={`${cls} is-empty`}>{words.empty}</p>
  const view = barListView(items, { max, keys: keys.map((key) => key.id) })
  const Link = linkAs ?? NextLink
  return (
    <div className={cls}>
      {keys.length > 0 && (
        <ul className="nds-barlist-key" aria-hidden>
          {keys.map((key, index) => (
            <li key={key.id}>
              <span className={`nds-barlist-swatch tone-${key.tone ?? 'neutral'} pattern-${index % 4}`} />
              {key.label}
            </li>
          ))}
        </ul>
      )}
      <table className="nds-barlist-table">
        <caption className="nds-vh">{label}</caption>
        <colgroup>
          <col className="nds-barlist-colname" />
          <col />
        </colgroup>
        <thead className="nds-vh">
          <tr>
            <th scope="col">{words.name}</th>
            <th scope="col">{words.value}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, row) => {
            const bar = view.bars[row]!
            const valueText = bar.known ? (item.valueText ?? format(bar.value)) : words.unknown
            const partsText = bar.parts.length > 0
              ? words.parts(bar.parts.map((part) => ({ label: keys[part.index]!.label, value: format(part.value) })))
              : null
            const picked = active != null && active === item.id
            const name = onPick ? (
              <button
                type="button"
                className="nds-barlist-pick"
                aria-pressed={active !== undefined ? picked : undefined}
                aria-label={words.pick(item.label, valueText)}
                onClick={() => onPick(item.id)}
              >
                {item.label}
              </button>
            ) : item.href ? (
              <Link className="nds-barlist-link" href={item.href}>
                {item.label}
              </Link>
            ) : (
              item.label
            )
            return (
              <tr key={item.id} className={`nds-barlist-row tone-${item.tone ?? 'neutral'}${picked ? ' is-active' : ''}${bar.known ? '' : ' is-unknown'}`}>
                <th scope="row" className="nds-barlist-name">
                  <span className="nds-barlist-label">{name}</span>
                  {item.sub != null && item.sub !== '' && <span className="nds-barlist-sub">{item.sub}</span>}
                </th>
                <td className="nds-barlist-valuecell">
                  <span className="nds-barlist-cell">
                  <span className="nds-barlist-track" aria-hidden>
                    {view.zero > 0 && <span className="nds-barlist-zero" style={{ left: `${view.zero}%` }} />}
                    {bar.known && bar.parts.length > 0 ? (
                      <span className="nds-barlist-stack" style={{ left: `${bar.left}%`, width: `${bar.width}%` }}>
                        {bar.parts.map((part) => (
                          <span key={part.id} className={`nds-barlist-part tone-${keys[part.index]!.tone ?? 'neutral'} pattern-${part.index % 4}`} style={{ width: `${(part.width / (bar.width || 1)) * 100}%` }} />
                        ))}
                      </span>
                    ) : bar.known ? (
                      <span className="nds-barlist-fill" style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />
                    ) : null}
                  </span>
                  <span className="nds-barlist-value">{valueText}</span>
                  </span>
                  {partsText && <span className="nds-vh">{` (${partsText})`}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
