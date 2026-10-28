'use client'

import { useCallback, useEffect, useId, useRef, type ComponentType, type FocusEvent, type KeyboardEvent, type MouseEvent, type MouseEventHandler, type ReactNode, type RefObject } from 'react'
import NextLink from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useHorizontalOverflow } from './useHorizontalOverflow'
import { revealDelta, stripStep } from './tabsScroll'
import { useStripEdges } from './useStripEdges'

export interface TabItem {
  id: string
  label: ReactNode
  /** SG.1 — optional count pill after the label (H10's tab-count treatment). `null` renders
   *  nothing (unknown ≠ zero); `0` renders a pill reading 0, which is a real answer. */
  count?: number | null
  /** SG.1 — optional small promo/context badge between label and count (H10's "New" pill). */
  badge?: string
  /** SG.1 — optional leading icon (H10 marks its A.I. tab). Sized by the caller (≤16px). */
  icon?: ReactNode
  /** 9.3 — a tab that cannot be entered yet. Carries `disabled` + `aria-disabled` so the
   *  reason is reachable; never the only signal (the label should say why). */
  disabled?: boolean
  /**
   * Link tabs (bid page DS lane, 2026-10-10): the tab is a real link to this route — open in a new tab, middle-click and
   * a copied address all work. When any tab has an `href` the bar is a `<nav>` of links with `aria-current="page"` on
   * the active one (`activeTabFromPath` finds it from the route), not a tablist: a link goes to another page, it does
   * not show a panel. A tab with no `href` (or disabled) in a link bar stays focusable, `aria-disabled`, and goes nowhere.
   */
  href?: string
}

/** The host's link for link tabs. The web app passes its workspace `Link` (it keeps `/w/<id>`); default Next's `Link`. */
export type TabLinkComponent = ComponentType<{
  href: string
  className?: string
  children?: ReactNode
  onClick?: MouseEventHandler<HTMLAnchorElement>
  'aria-current'?: 'page'
}>

/**
 * Ids for the `tab` ↔ `tabpanel` pairing, so a caller can label its panel with the same base.
 *
 * ARIA wants the relationship stated from BOTH ends: the tab points at its panel with
 * `aria-controls`, and the panel points back with `aria-labelledby`. A tablist with neither — which
 * is what this component emitted until now — announces the tabs but never tells a screen-reader
 * user which region they govern.
 */
export function tabIds(base: string, tabId: string) {
  return { tab: `${base}-tab-${tabId}`, panel: `${base}-panel-${tabId}` }
}

/**
 * Spread onto the element rendering the active tab's content:
 * `<div {...tabPanelProps(base, active)}>`.
 */
export function tabPanelProps(base: string, activeTabId: string) {
  const { tab, panel } = tabIds(base, activeTabId)
  return { id: panel, role: 'tabpanel' as const, 'aria-labelledby': tab, tabIndex: 0 }
}

export interface TabsProps {
  /**
   * Accessible name for the `tablist`. Same shape as `SegmentedControl`: a tablist with no name
   * is announced unlabelled, so the reader hears the tabs but not what they belong to.
   */
  ariaLabel?: string
  tabs: TabItem[]
  active: string
  /** Button tabs: the tab the person chose. Link tabs: optional, told on a click before the link is followed. */
  onChange?: (id: string) => void
  /** Link tabs only: the link component (default Next's `Link`). */
  linkAs?: TabLinkComponent
  className?: string
  /**
   * SG.1 — 'lg' is the PAGE-level tab bar (H10's Suggestions/Analytics tabs: larger bolder
   * labels, 3px indicator, count pills at full weight). Default 'md' is byte-identical to the
   * original underline bar, so the existing consumers are untouched.
   *
   * CT.1 — 'sm' is a tab strip INSIDE a bar beside 28px controls (the studio's 40px scope row, the
   * record drawer's pane strip): the bar's type (sm-plus, 600), tabs stretched to the strip so the
   * indicator meets its edge, and no hairline of its own because the host draws one.
   *
   * While a strip scrolls sideways under an overlay scrollbar it grows by a band below the tabs for the
   * bar (`useHorizontalOverflow`, components.css). A host that FIXES its height around an `sm` strip must
   * grow with it (`:has(> .nds-tabs[data-overflows])`), or the band would shrink the tabs.
   */
  size?: 'sm' | 'md' | 'lg'
  /**
   * `lg` only (polish round 2, 2026-10-10): a section bar with many tabs — 13.5px labels, 16px apart — so the eleven
   * Rules & Automation tabs fit at 1440. The look is the `lg` bar's; only the size and the gap shrink.
   */
  dense?: boolean
  /**
   * Keep long labels within a narrow container; the active tab scrolls into view — when it changes, when tabs are
   * added or removed around it, and when a label grows (each moves it out of view on a phone). Only the strip scrolls.
   * While it scrolls, the scrollbar sits in a band BELOW the tabs, never over a label, the active underline or a focus
   * ring (Owner 2026-10-05); a strip that fits keeps its exact layout.
   *
   * Polish round 2 (audit M6): each edge with more tabs beyond it fades out and shows an arrow that scrolls that way
   * (a pointer affordance: it takes no focus and is hidden from screen readers, which hear every tab). A tab that takes
   * the focus is brought wholly into view clear of the fade, and when the focus leaves the strip the tab you are on is
   * brought back, so the strip is never left scrolled with a cut label. Rules: `tabsScroll.ts`. The strip is wrapped
   * in `.nds-tabs-scroller` (it holds the arrows); `className` stays on the strip.
   *
   * A press never scrolls the strip (2026-10-13): a mouse or touch press focuses its tab between press and release, and
   * a reveal then moved the tab from under the pointer, so the release landed beside it and the click was lost. The
   * strip follows a KEYBOARD focus (`:focus-visible`) only, and a pressed tab is brought into view after its click.
   */
  overflow?: 'scroll'
  /**
   * Shared id base for the `tab`/`tabpanel` pairing. Pass the same value to `tabPanelProps()` on
   * the element that renders the active tab's content.
   *
   * Optional so the ~dozen existing consumers are untouched: without it the bar emits no
   * `aria-controls`, exactly as before.
   */
  idBase?: string
}

/**
 * Scroll the strip — only the strip, never the page around it — so the tab is wholly in view, clear of the edge fade
 * (a tab wider than the strip shows its start). A tab already in view does not move it.
 */
function revealInStrip(list: HTMLElement, tab: HTMLElement) {
  const delta = revealDelta(list.getBoundingClientRect(), tab.getBoundingClientRect(), list)
  if (delta) list.scrollLeft += delta
}

/** Underline tab bar (active = primary text + primary indicator). Controlled. */
export function Tabs({ ariaLabel, tabs, active, onChange, linkAs, className, size = 'md', dense = false, idBase, overflow }: TabsProps) {
  const listRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const links = tabs.some((t) => t.href)
  const autoBase = useId()
  const base = idBase ?? autoBase
  // The tab ids in order, as one value: a tab added before the active one (a market chosen by itself) pushes it along.
  const tabKey = tabs.map((t) => t.id).join('\u0000')
  // Every strip, not only `overflow="scroll"`: a host may scroll it too (`.nds-workspace-subheader-tabs`, a page's own
  // `overflow-x: auto`). Only a strip that really scrolls is marked.
  useHorizontalOverflow(listRef)
  useEffect(() => {
    if (overflow !== 'scroll') return
    const list = listRef.current
    if (!list) return
    const reveal = () => {
      const tab = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`)
      if (tab) revealInStrip(list, tab)
    }
    reveal()
    // A label that grows after the tab was shown (a market's words arrive once it is checked) pushes the active tab
    // out again: follow every tab's size while these tabs are shown.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reveal)
    list.querySelectorAll<HTMLElement>('[data-tab-id]').forEach((tab) => observer.observe(tab))
    return () => observer.disconnect()
  }, [active, overflow, tabKey])

  // The overflow marker: each edge with more tabs beyond it is marked on the frame (`useStripEdges`), which the CSS
  // turns into a fade and an arrow.
  useStripEdges(listRef, frameRef, overflow === 'scroll', tabKey)

  const scrollStrip = useCallback((dir: -1 | 1) => {
    const list = listRef.current
    if (!list) return
    const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    list.scrollBy({ left: dir * stripStep(list.clientWidth), behavior: still ? 'auto' : 'smooth' })
  }, [])
  // A tab the KEYBOARD focuses comes wholly into view (`:focus-visible`, as the Tooltip reads it); when the focus leaves
  // the strip, the tab you are on comes back — unless a press inside the strip took it (`:active`: Safari and Firefox on
  // a Mac blur the focused tab without focusing the pressed one). A press scrolls nothing until its click lands.
  const onFocus = useCallback((e: FocusEvent<HTMLElement>) => {
    const list = listRef.current
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab-id]')
    if (overflow === 'scroll' && list && tab && tab.matches(':focus-visible')) revealInStrip(list, tab)
  }, [overflow])
  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    const list = listRef.current
    if (overflow !== 'scroll' || !list || list.contains(e.relatedTarget as Node | null) || list.matches(':active')) return
    const tab = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`)
    if (tab) revealInStrip(list, tab)
  }, [overflow, active])
  const onClick = useCallback((e: MouseEvent<HTMLElement>) => {
    const list = listRef.current
    const tab = (e.target as Element).closest<HTMLElement>('[data-tab-id]')
    if (overflow === 'scroll' && list && tab) revealInStrip(list, tab)
  }, [overflow])

  /**
   * Arrow-key selection, the ARIA tablist pattern.
   *
   * With a roving tabindex the whole bar is ONE tab stop and ←/→/Home/End move within it — which is
   * what a keyboard user expects of a tablist, and what this component did not do. Disabled tabs are
   * skipped rather than trapping focus on a control that cannot act.
   *
   * Link tabs: every link is a Tab stop, as links are; the arrows only MOVE the focus between them (Enter follows).
   */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
      if (links) {
        const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [])]
        if (items.length < 2) return
        e.preventDefault()
        const from = items.indexOf(document.activeElement as HTMLElement)
        const at = from < 0 ? Math.max(0, tabs.findIndex((t) => t.id === active)) : from
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
          : e.key === 'ArrowRight' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
        items[next]?.focus()
        return
      }
      const usable = tabs.filter((t) => !t.disabled)
      if (usable.length < 2) return
      e.preventDefault()
      const at = usable.findIndex((t) => t.id === active)
      const next =
        e.key === 'Home' ? 0
        : e.key === 'End' ? usable.length - 1
        : e.key === 'ArrowRight' ? (at + 1 + usable.length) % usable.length
        : (at - 1 + usable.length) % usable.length
      const target = usable[next]
      if (!target) return
      onChange?.(target.id)
      listRef.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(target.id)}"]`)?.focus()
    },
    [tabs, active, onChange, links],
  )

  const barClass = ['nds-tabs', size === 'md' ? '' : size, dense && size === 'lg' ? 'dense' : '', overflow === 'scroll' ? 'scrollable' : '', className ?? ''].filter(Boolean).join(' ')
  /** The arrows and the frame that holds them, for a strip that scrolls; any other strip renders exactly as before. */
  const framed = (bar: ReactNode) => overflow !== 'scroll' ? bar : (
    <div className="nds-tabs-scroller" ref={frameRef}>
      {bar}
      {([-1, 1] as const).map((dir) => (
        <button key={dir} type="button" className={`nds-tabs-more ${dir < 0 ? 'start' : 'end'}`} tabIndex={-1} aria-hidden="true"
          onMouseDown={(e) => e.preventDefault()} onClick={() => scrollStrip(dir)}>
          {dir < 0 ? <ChevronLeft size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        </button>
      ))}
    </div>
  )
  const inner = (t: TabItem) => (
    <>
      {t.icon ? <span className="nds-tab-ic" aria-hidden>{t.icon}</span> : null}
      {t.label}
      {t.badge ? <span className="nds-tab-badge">{t.badge}</span> : null}
      {t.count != null ? <span className="nds-tab-count">{t.count}</span> : null}
    </>
  )

  if (links) {
    const Link = linkAs ?? NextLink
    return framed(
      <nav className={barClass} aria-label={ariaLabel} ref={listRef} onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur} onClick={onClick}>
        {tabs.map((t) => {
          const on = t.id === active
          if (!t.href || t.disabled) {
            return <span key={t.id} data-tab-id={t.id} className="nds-tab" role="link" aria-disabled="true" tabIndex={0}>{inner(t)}</span>
          }
          return (
            <Link key={t.id} href={t.href} data-tab-id={t.id} className={on ? 'nds-tab on' : 'nds-tab'} aria-current={on ? 'page' : undefined}
              onClick={onChange ? () => onChange(t.id) : undefined}>
              {inner(t)}
            </Link>
          )
        })}
      </nav>,
    )
  }

  return framed(
    <div
      className={barClass}
      role="tablist"
      aria-label={ariaLabel}
      ref={listRef as RefObject<HTMLDivElement>}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={onClick}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          data-tab-id={t.id}
          id={idBase ? tabIds(base, t.id).tab : undefined}
          aria-controls={idBase ? tabIds(base, t.id).panel : undefined}
          aria-selected={t.id === active}
          // Roving tabindex: one stop for the bar, arrows move inside it.
          tabIndex={t.id === active && !t.disabled ? 0 : -1}
          className={['nds-tab', t.id === active ? 'on' : ''].filter(Boolean).join(' ')}
          disabled={t.disabled}
          aria-disabled={t.disabled || undefined}
          onClick={() => { if (!t.disabled) onChange?.(t.id) }}
        >
          {inner(t)}
        </button>
      ))}
    </div>,
  )
}
