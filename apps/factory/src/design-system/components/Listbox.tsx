'use client'

import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { useClickAway } from './useClickAway'
import { usePopoverPosition } from './usePopoverPosition'
import type { Size } from '../primitives/size'
import { ListboxPanel } from './ListboxPanel'

export interface ListboxOption {
  /** Additional searchable terms without repeating them in the visible option label. */
  searchText?: string
  /** Supporting value at the end of the option row; the trigger continues to show the label. */
  trailing?: ReactNode
  value: string
  label: string
  disabled?: boolean
  /** native tooltip for this option; defaults to the label, which is how a truncated
   *  option stays readable (options are nowrap + ellipsis) */
  title?: string
  /**
   * Optional heading this option sits under. Options sharing a group render together, groups in
   * first-seen order.
   *
   * Exists because the rule builder's action picker is 26 actions across six `<optgroup>`s
   * ("Bids", "Budget", "Pause/resume"…) and flattening them loses the only structure that makes
   * the list navigable — so that one select stayed native rather than adopt the DS.
   */
  group?: string
  /**
   * Node shown before the label — a flag, a channel mark, a colour swatch. Rendered in the option
   * row AND on the trigger when this option is selected.
   *
   * `label` stays a `string` because it is what search ranks against; the leading node is
   * decorative and carries no text. A native `<select>` cannot do this at all — an `<option>` may
   * not contain markup — which is why a market picker showing a flag could not move to the DS
   * until now, and why `Select` is not getting the same prop.
   */
  leading?: ReactNode
}

export interface ListboxProps {
  /**
   * `xs` is the dense grid-cell tier, matching Button/Input/Select. Without it a Listbox's 13px
   * trigger sat beside 11.5px fields, which is why the last two native selects in the console
   * could not adopt it.
   */
  size?: Extract<Size, 'xs' | 'sm' | 'md'>
  options: ListboxOption[]
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  /**
   * id for the TRIGGER, so a `<label htmlFor>` reaches it.
   *
   * `Field` clones its single element child with a generated id and points its label at it. This
   * component had a closed prop set and silently dropped it, leaving `<label for>` aimed at
   * nothing — which is worse than an unlabelled control, because it looks correct in the markup
   * and reads as unlabelled to a screen reader.
   */
  id?: string
  'aria-describedby'?: string
  className?: string
  disabled?: boolean
  /** trigger width. Every one of the ads console's 97 select call sites sets one. */
  width?: number | string
  /** force the in-popover search box; it otherwise appears past `LISTBOX_SEARCH_THRESHOLD` (D18: 9+ options) */
  searchable?: boolean
  searchPlaceholder?: string
  /**
   * Label for "nothing selected", which also renders a clear row at the top of the list — the
   * difference between a form select and a FILTER select. Skipped when the caller's own options
   * already contain a `value: ''` row, otherwise the list shows two clear rows and the caller's
   * label silently wins the closed-state lookup.
   */
  emptyLabel?: string
  /** render `emptyLabel` greyed — a placeholder ("Select a Portfolio") rather than a real
   *  default ("All"). Same distinction the ads filter bar has always drawn. */
  emptyIsPlaceholder?: boolean
  /**
   * Where the option panel is portalled. Default `document.body`, which is right for a page.
   *
   * 🔴 R-VT-8 (orchestrator, on VT.2c's measurement) — inside an **AG Grid popup editor** it is wrong:
   * the panel lands outside the popup's DOM, so clicking an option is a click OUTSIDE the editor and the
   * edit ends before `onChange` can report. VT.2c measured it on the variation-theme cell's target
   * control. The fix belongs in the DS and not in the page, so the host names its own container here and
   * the panel stays a child of the popup. Positioning is unaffected: `usePopoverPosition` returns
   * `position: fixed` viewport coordinates, which do not depend on the portal parent (no transformed
   * ancestor is introduced — AG positions its popup with `left`/`top`).
   *
   * `null` / `undefined` = `document.body`, so every existing call site is unchanged.
   */
  portalTo?: Element | null
}

/** Past this many options a picker gets a search box without being asked. */

/**
 * Plain single-select styled dropdown — the zero-native-control replacement
 * for the `Select` primitive (which styles a native `<select>` and still
 * opens the OS option list). Button trigger in the Select box skin + the
 * Combobox popover, no typeahead. Wave 1 gap-fill (2026-07-04): pages are
 * banned from native selects; this is what they migrate to.
 */
export function Listbox({ size = 'md', options, value, onChange, placeholder = 'Select…', ariaLabel, id, 'aria-describedby': describedBy, className, disabled,
  width, searchable, searchPlaceholder = 'Search…', emptyLabel, emptyIsPlaceholder = false, portalTo }: ListboxProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { popRef, style: popStyle } = usePopoverPosition(open, ref, { width: 'anchor' })
  useClickAway([ref, popRef], () => setOpen(false), open)
  const selected = options.find((o) => o.value === value)
  // Choosing or cancelling a portalled option returns to the owning control.
  // Click-away still leaves focus at the user's newly chosen destination.
  const close = () => { setOpen(false); triggerRef.current?.focus() }

  return (
    <div className={['nds-listbox', size === 'md' ? '' : size, className].filter(Boolean).join(' ')} style={width != null ? { width } : undefined} ref={ref}>
      <button ref={triggerRef} type="button" id={id} aria-describedby={describedBy} className="nds-listbox-btn" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}>
        {selected?.leading != null && <span className="nds-listbox-lead">{selected.leading}</span>}
        <span className={selected == null && (emptyIsPlaceholder || emptyLabel == null) ? 'ph' : undefined}>{selected?.label ?? emptyLabel ?? placeholder}</span>
        <ChevronDown size={15} className="chev" aria-hidden />
      </button>
      {open && (
        createPortal(
          <ListboxPanel
            panelRef={popRef}
            style={popStyle}
            options={options}
            value={value}
            onCommit={(v) => { onChange(v); close() }}
            onCancel={close}
            searchable={searchable}
            searchPlaceholder={searchPlaceholder}
            emptyLabel={emptyLabel}
          />,
          /* R-VT-8: the host's container when it named one — an AG popup editor must keep the panel
             inside itself. `document.body` otherwise, which is every page call site. */
          portalTo ?? document.body,
        )
      )}
    </div>
  )
}
