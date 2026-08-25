'use client'

/**
 * FB.1 — the Filters panel, lifted out of `AdsDataGrid` so a page can render it somewhere else.
 *
 * The markup and every class name are `AdsDataGrid`'s, moved verbatim — `ads.css:420-464` styles it
 * unchanged, and the grid now renders THIS component rather than a second copy. There is one
 * implementation of a filter bar in this product and this is it.
 *
 * ── Why it had to leave the grid ────────────────────────────────────────────────────────────────
 *
 * The panel renders immediately above the grid's own card. On the eleven Rules & Automation pages
 * that puts it *below* the census strip, while the scope selects sat *above* the summary band — two
 * control strips for one job, at opposite ends of the page's numbers. The operator asked for one
 * bar, at the top. A page can only put it there if it can render it itself.
 *
 * ── The collapsed summary, which is not decoration ──────────────────────────────────────────────
 *
 * 🔴 Every Rules & Automation page passes `filtersDefaultOpen={false}`, and the header used to say
 * only "Show Filters". That was survivable while the panel held metric ranges. It is NOT survivable
 * now that it holds SCOPE: a collapsed panel would hide the fact that you are looking at one
 * portfolio, and a narrowed view that looks like a full one is the defect this whole section keeps
 * paying for. So the collapsed header names what is set, and `summaryOf` renders values rather than
 * counts — "Filters · GALE-JACKET · Enabled" tells you where you are; "3 filters" does not.
 */
import { useState, type ReactNode } from 'react'
import { Button } from '@/design-system/primitives'
import { ChevronDown } from 'lucide-react'
import { Listbox, MultiSelect } from '@/design-system/components'
import { InfoTip } from '@/design-system/primitives'
import type { GridFilter, FilterState, RangeVal } from './WorkspaceGrid'

/**
 * `__`-prefixed keys are the SERVER's — the page owns them in the URL and the grid never filters
 * rows on them. A saved preset must not carry them: applying a metric preset from last week would
 * otherwise rewrite your scope and move you to a different account view.
 */
export const isServerKey = (k: string) => k.startsWith('__')
export const stripServerKeys = (s: FilterState): FilterState =>
  Object.fromEntries(Object.entries(s).filter(([k]) => !isServerKey(k)))

/** What a value looks like in the collapsed header. Values, never counts. */
function summaryOf(filters: GridFilter[], state: FilterState): string[] {
  const out: string[] = []
  for (const f of filters) {
    const v = state[f.key]
    if (f.kind === 'range') {
      const r = v as RangeVal | undefined
      if (r?.min || r?.max) out.push(`${f.label} ${r.min || '…'}–${r.max || '…'}`)
      continue
    }
    const opts = f.options
    if (f.kind === 'multiselect') {
      const vals = (v as string[] | undefined) ?? []
      if (vals.length === 0) continue
      // One value reads as itself; several would run the header off the page.
      out.push(vals.length === 1 ? (opts.find((o) => o.value === vals[0])?.label ?? vals[0]) : `${f.label}: ${vals.length}`)
      continue
    }
    const val = v as string | undefined
    if (!val) continue
    out.push(opts.find((o) => o.value === val)?.label ?? val)
  }
  return out
}

export function AdsFilterBar({
  filters, value, onChange, defaultOpen = false, onAfterChange, presetsSlot, notesSlot,
}: {
  filters: GridFilter[]
  value: FilterState
  onChange: (next: FilterState) => void
  defaultOpen?: boolean
  /** the grid's `setPage(1)` — a narrowed view must not stay on page 7 of the old one */
  onAfterChange?: () => void
  /** AdsDataGrid's Filter Library controls, rendered in the footer. It owns the localStorage
   *  and the naming; this component only gives it a place to stand. */
  presetsSlot?: ReactNode
  /**
   * What the server said about this scope: a contradiction, the intersection note, the portfolio
   * blind spot. Rendered at the BOTTOM of the panel and OUTSIDE the collapsible body — under the
   * controls when open, under the head when collapsed. 🔴 A contradiction ("nothing can match this
   * scope") that a collapsed panel could hide would leave an empty grid with no explanation.
   */
  notesSlot?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  // Notes are the server's verdict on the scope and outlive an empty control list.
  if (!filters.length && !notesSlot) return null

  const set = (next: FilterState) => { onChange(next); onAfterChange?.() }
  const setKey = (key: string, v: string | string[]) => set({ ...value, [key]: v })
  const setRange = (key: string, side: 'min' | 'max', v: string) =>
    set({ ...value, [key]: { min: '', max: '', ...(value[key] as RangeVal | undefined), [side]: v } })

  const hasActive = Object.values(value).some((v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? !!v : !!(v?.min || v?.max)))
  const summary = summaryOf(filters, value)

  return (
    <div className={`h10-am-fpanel${open ? '' : ' is-collapsed'}`}>
      <div className="fphead">
        <h3>Filters</h3>
        {/* The collapsed state has to carry the scope, or a one-portfolio view looks account-wide. */}
        {!open && summary.length > 0 && (
          <span className="fpsum" title={summary.join(' · ')}>
            {summary.slice(0, 3).join(' · ')}{summary.length > 3 ? ` · ${summary.length - 3} more` : ''}
          </span>
        )}
        <Button variant="link" className="tog" onClick={() => setOpen((v) => !v)}>
          <ChevronDown size={14} className={open ? 'up' : ''} />{open ? 'Hide Filters' : 'Show Filters'}
        </Button>
      </div>
      {open && (
        <>
          <div className="frow">
            {filters.map((f) => f.kind === 'select' ? (
              <div className={`ffield ${f.wide ? 'wide' : ''}`} key={f.key}>
                <span>{f.label}{f.tip && <InfoTip tip={f.tip} />}</span>
                <Listbox
                  options={f.options}
                  value={(value[f.key] as string) ?? ''}
                  onChange={(v) => setKey(f.key, v)}
                  emptyLabel={f.placeholder ?? 'All'}
                  emptyIsPlaceholder
                  searchable={f.searchable}
                  ariaLabel={f.label}
                  disabled={f.disabled}
                />
                {/* A grain that cannot narrow this page says so rather than sitting there inert. */}
                {f.note && <em className="ffnote">{f.note}</em>}
              </div>
            ) : f.kind === 'multiselect' ? (
              <div className={`ffield ${f.wide ? 'wide' : ''}`} key={f.key}>
                <span>{f.label}{f.tip && <InfoTip tip={f.tip} />}</span>
                <MultiSelect
                  options={f.options}
                  value={(value[f.key] as string[]) ?? []}
                  onChange={(v) => setKey(f.key, v)}
                  placeholder={f.placeholder ?? 'All'}
                  ariaLabel={f.label}
                  searchable={f.searchable}
                />
                {f.note && <em className="ffnote">{f.note}</em>}
              </div>
            ) : (
              <div className="ffield" key={f.key}>
                <span>{f.label}{f.tip && <InfoTip tip={f.tip} />}</span>
                <div className="mm">
                  {(['min', 'max'] as const).map((side) => (
                    <div className={`mmin ${f.unit === '€' ? 'cur' : f.unit === '%' ? 'pct' : ''}`} key={side}>
                      {f.unit === '€' && <span className="ad">€</span>}
                      <input
                        inputMode="decimal"
                        placeholder={side === 'min' ? 'Min' : 'Max'}
                        value={(value[f.key] as RangeVal | undefined)?.[side] ?? ''}
                        onChange={(e) => setRange(f.key, side, e.target.value)}
                        aria-label={`${f.label} ${side}`}
                      />
                      {f.unit === '%' && <span className="ad">%</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="fft">
            {presetsSlot}
            <span className="grow" />
            <Button
 size="sm" onClick={() => set({})} disabled={!hasActive}
 title="Clears everything in this bar, scope included — one bar, one Clear."
 >Clear</Button>
          </div>
        </>
      )}
      {notesSlot}
    </div>
  )
}
