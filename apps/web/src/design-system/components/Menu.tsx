'use client'

import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useClickAway } from './useClickAway'
import { usePopoverPosition } from './usePopoverPosition'

export interface MenuItemDef {
  id: string
  label?: ReactNode
  icon?: ReactNode
  disabled?: boolean
  onSelect?: () => void
  /**
   * Render this item as a real `<a>` rather than a `<button>`.
   *
   * A menu of destinations needs actual links: ⌘-click, middle-click and "Open in new tab" are all
   * swallowed by a `<button onClick={router.push}>`, and an operator who expects a link to behave
   * like one gets nothing. `onSelect` still fires (instrumentation, closing the menu), so a caller
   * can do both.
   */
  href?: string
  /** `'_blank'` opens a new tab; `rel="noopener noreferrer"` is then applied automatically. */
  target?: '_blank' | '_self'
  /** Tooltip. Supplementary only — never the sole home of a reason; see `description`. */
  title?: string
  /**
   * A second line under the label, for the reason an item is unavailable — or any note that
   * belongs to the item rather than to the menu.
   *
   * 🔴 This is deliberately NOT a tooltip. A tooltip is hover-only: invisible to touch, invisible
   * to a keyboard user scanning the menu, and gone the moment the pointer moves. The whole point of
   * these rows is that a disabled item explains itself, and behind hover it explains itself only to
   * someone who already suspected there was something to find (hub rulings #133/#231 — an
   * instruction may never live only on a disabled control).
   *
   * The DS owns the wrap width, so every consumer wraps identically and no caller has to reach for
   * `white-space`. Before this existed, `Publish ▾` folded the reason into `label` as a second
   * nowrap span and the menu measured 617–629px wide for two items, with one line running 520.1px
   * beside a sibling that wrapped at 222.6px — two wrapping policies, 2.3× apart, in one menu.
   */
  description?: ReactNode
  /**
   * Render a rule instead of an item. Everything else on the entry is ignored.
   *
   * The SP wizard's Select menu needed a divider between "by campaign kind" and "by match type";
   * without one the two groups read as one undifferentiated list.
   */
  separator?: boolean
}

export interface MenuProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  selectedId?: string
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, item: MenuItemDef) => void
  /** trigger button content */
  label: ReactNode
  items: MenuItemDef[]
  align?: 'left' | 'right'
  triggerProps?: ButtonHTMLAttributes<HTMLButtonElement>
  className?: string
}

/**
 * An item's icon + text. Kept in one place so the `<a>` and `<button>` forms cannot drift — they
 * already had to be told twice that they look identical, and a description rendered in only one of
 * them is exactly the kind of divergence that ships.
 */
function MenuItemBody({ item }: { item: MenuItemDef }) {
  if (item.description == null) {
    return (
      <>
        {item.icon}
        {item.label}
      </>
    )
  }
  return (
    <>
      {item.icon}
      <span className="nds-menu-item-text">
        <span className="nds-menu-item-name">{item.label}</span>
        <span className="nds-menu-item-desc">{item.description}</span>
      </span>
    </>
  )
}

/**
 * Anchored dropdown menu (H10 `.h10-menu` look). The trigger renders as a DS
 * secondary button; the menu closes on outside-click or item select. Requires
 * `styles/primitives.css` (trigger) + `styles/components.css` (menu).
 */
export function Menu({ label, items, align = 'left', triggerProps, className, open: controlledOpen, onOpenChange, selectedId, onNavigate }: MenuProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next)
    onOpenChange?.(next)
  }
  const menuId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const typeahead = useRef({ text: '', at: 0 })
  const ref = useRef<HTMLDivElement>(null)
  // A menu sizes to its own content, not to a trigger that may be a 28px icon button.
  const { popRef, style: popStyle } = usePopoverPosition(open, ref, {
    width: 'anchor',
    align: align === 'right' ? 'end' : 'start',
  })
  // Was a hand-rolled copy of useClickAway. It had to go anyway: the panel now portals, so a
  // single-ref check treats clicking a menu item as an outside click.
  useClickAway([ref, popRef], () => {
    if (popRef.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true })
    setOpen(false)
  }, open)

  useEffect(() => {
    if (!open) return
    const panel = popRef.current
    const selected = panel?.querySelector<HTMLElement>('[data-selected="true"]:not([disabled])')
    const first = panel?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
    ;(selected ?? first ?? panel)?.focus({ preventScroll: true })
  }, [open, popRef])

  return (
    <div className={`nds-menu-wrap${className ? ` ${className}` : ''}`} ref={ref}>
      <button type="button" className="nds-btn" {...triggerProps} ref={trigger} aria-haspopup="menu" aria-controls={open ? menuId : undefined} aria-expanded={open}
        onClick={event => { triggerProps?.onClick?.(event); if (!event.defaultPrevented) setOpen(!open) }}
        onKeyDown={event => {
          triggerProps?.onKeyDown?.(event)
          if (!event.defaultPrevented && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true) }
        }}>
        {label}
      </button>
      {open && (
        createPortal(
          <div id={menuId} ref={popRef} style={popStyle} className="nds-menu" role="menu" tabIndex={-1} aria-label={triggerProps?.['aria-label']}
            onKeyDown={event => {
              const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')]
              const index = options.indexOf(document.activeElement as HTMLElement)
              if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus({ preventScroll: true }); return
              }
              if (event.key === 'Tab') { setOpen(false); trigger.current?.focus({ preventScroll: true }); return }
              let next: number | undefined
              if (event.key === 'ArrowDown') next = (index + 1) % options.length
              if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length
              if (event.key === 'Home') next = 0
              if (event.key === 'End') next = options.length - 1
              if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                const now = Date.now()
                typeahead.current.text = (now - typeahead.current.at < 500 ? typeahead.current.text : '') + event.key.toLowerCase()
                typeahead.current.at = now
                next = options.findIndex(option => option.textContent?.trim().toLowerCase().startsWith(typeahead.current.text))
              }
              if (next !== undefined && options[next]) { event.preventDefault(); options[next].focus() }
            }}>
            {items.map((it) =>
              it.separator ? (
                <div key={it.id} className="nds-menu-sep" role="separator" />
              ) : (
              it.href && !it.disabled ? (
                <a
                  key={it.id}
                  role="menuitem"
                  tabIndex={-1}
                  data-selected={it.id === selectedId || undefined}
                  aria-current={it.id === selectedId ? 'page' : undefined}
                  className={it.description != null ? 'has-desc' : undefined}
                  href={it.href}
                  title={it.title}
                  target={it.target}
                  rel={it.target === '_blank' ? 'noopener noreferrer' : undefined}
                  onClick={(event) => {
                    setOpen(false)
                    trigger.current?.focus({ preventScroll: true })
                    onNavigate?.(event, it)
                    it.onSelect?.()
                  }}
                  // A middle-click opens a new tab without firing `click`, so the menu would stay
                  // open behind it and any instrumentation would never run.
                  onAuxClick={() => {
                    it.onSelect?.()
                    setOpen(false)
                  }}
                >
                  <MenuItemBody item={it} />
                </a>
              ) : (
              <button
                key={it.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-selected={it.id === selectedId || undefined}
                className={it.description != null ? 'has-desc' : undefined}
                title={it.title}
                disabled={it.disabled}
                aria-disabled={it.disabled || undefined}
                onClick={() => {
                  setOpen(false)
                  trigger.current?.focus({ preventScroll: true })
                  it.onSelect?.()
                }}
              >
                <MenuItemBody item={it} />
              </button>
              )
              ),
            )}
          </div>,
          document.body,
        )
      )}
    </div>
  )
}
