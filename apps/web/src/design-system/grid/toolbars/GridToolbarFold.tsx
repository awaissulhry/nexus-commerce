'use client'

/**
 * GDS — the toolbar's OVERFLOW rule, in the ENGINE (LX.F2, ruling R-LX-18).
 *
 * ## Why it exists, with the numbers that decided it
 *
 * Measured on the real studio sheet through `scripts/studio-gate-session.mjs`, signed in, hydration
 * and the LOADED state verified first (the first reading of all was retracted because it caught the
 * bar mid-load, where every chip reads "Not counted yet" and is NARROWER than it really is):
 *
 *   amazon·DE — children sum **2150px**, `scrollWidth` **2266** against `clientWidth`
 *     1212 / 1372 / 1660 / 1980 at 1280 / 1440 / 1728 / 2048 → over by **950 · 790 · 502 · 182**,
 *     with **9 · 8 · 7 · 4** controls clipped off the right edge at those widths.
 *   ebay·IT  — children sum **1583.2px**, `scrollWidth` **1675** → over by **383.2 · 223.2** at
 *     1280 / 1440 and 1 control still clipped at 1728.
 *
 * A clipped control is not a cosmetic problem: `Customise`, `Export`, `Import` and `More` were
 * unreachable at 1280 on both coordinates, and `Requirements` too.
 *
 * The nine amazon·DE filter chips are **1345.4px** of that 2150 (ebay·IT's six are 786.6 of 1583.2), so
 * they fold first — R-LX-18's first priority. 🔴 **My arithmetic said that alone would be enough and the
 * MEASUREMENT said otherwise**, which is why the rule was re-measured before it was called done: the
 * folded trigger is 99.6px, the two preset chips (`Required` 146.1, `Languages` 157.7) are NOT part of
 * the chip group, and amazon·DE at 1280 was still **8px** over with `Import` and `More` clipped
 * (ebay·IT ~2px over, `More` clipped). Hence R-LX-18's SECOND priority is implemented too, through
 * `useToolbarOverflow` below: `Export` + `Import` (63.7 + 63.7 = 127.4px) move into the `⋯` menu the
 * toolbar already has. An estimate is not a measurement, even when it is your own.
 *
 * ## The rule, and why it cannot oscillate
 *
 * `GridToolbarFold` renders its children INLINE while they fit. When the toolbar overflows it
 * remembers the toolbar's `scrollWidth` at that moment — the width the bar NEEDS expanded — and
 * collapses to a single trigger. It expands again only once `clientWidth >= that remembered width`.
 * Both thresholds are the same number, so the state is monotone in the viewport width and the
 * fold/unfold loop that a naive "does it fit now?" check produces cannot happen.
 *
 * ## One definition, zero copies
 *
 * The folded panel hosts **the very same children**. Nothing is re-described as a menu item, so a
 * chip keeps its own component, its pressed state, its count and its glyph in both hosts — the
 * `feedback_shared_components_no_copy_props` rule, and the reason this is not built on the DS `Menu`
 * (which takes `MenuItemDef[]`, i.e. a second rendering of every control it shows).
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'

import { usePopoverPosition } from '../../components/usePopoverPosition'

/**
 * The same monotone overflow measurement, exposed for the SECOND priority R-LX-18 names: once the
 * chips have folded and the bar is STILL over, `Export` and `Import` move into the `⋯` menu the
 * toolbar already has. The engine decides WHETHER (this hook); the surface decides WHICH controls
 * move, because only it knows which verbs it owns.
 *
 * Measured need: after the chips fold, amazon·DE at 1280 was still **8px** over (`Import` and `More`
 * clipped) and ebay·IT ~2px over (`More` clipped). `Export` + `Import` are 63.7 + 63.7 = **127.4px**,
 * so moving them into the existing menu leaves ≈119px spare — the cheapest change that clears both.
 *
 * `anchor` is any element inside the toolbar; the hook walks up to `.nds-toolbar` itself.
 */
export function useToolbarOverflow(anchor: RefObject<HTMLElement | null>): boolean {
  return useMonotoneToolbarOverflow(anchor, true)
}

/**
 * THE monotone threshold rule, as a pure function — the one place it is written.
 *
 * `current` is the width the bar needed when this tier latched, or `null` while it has not. A tier
 * latches only on an overflow it is ARMED for, and releases only at the width that held the bar
 * EXPANDED: both thresholds are the same number, so the state is monotone in the viewport width and
 * the fold/unfold loop a naive "does it fit now?" check produces cannot happen. Extracted (CLOSE.1)
 * because there were about to be three copies of it and a copy of a threshold rule is a copy of a
 * threshold — and because a pure function is testable where `apps/web` vitest is node-only.
 *
 * The `+ 1` is a sub-pixel tolerance: a fractional layout reports `scrollWidth` one integer above
 * `clientWidth` on a bar that fits.
 */
export function nextToolbarOverflowWidth(
  current: number | null,
  bar: { scrollWidth: number; clientWidth: number },
  armed = true,
): number | null {
  if (current === null) return armed && bar.scrollWidth > bar.clientWidth + 1 ? bar.scrollWidth : null
  return bar.clientWidth >= current ? null : current
}

/** The shared measurement both tiers use: `armed` is the only difference between them. */
function useMonotoneToolbarOverflow(anchor: RefObject<HTMLElement | null>, armed: boolean): boolean {
  const [neededWidth, setNeededWidth] = useState<number | null>(null)
  useEffect(() => {
    const bar = anchor.current?.closest('.nds-toolbar') as HTMLElement | null
    if (!bar) return
    const measure = () => setNeededWidth((current) => nextToolbarOverflowWidth(current, bar, armed))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  })
  return neededWidth !== null
}

/**
 * R-LX-27 — the fold's LAST TIER: the bar is still over after the chips have folded AND the verbs
 * have moved into `⋯`, so the transient STATUS pills go icon-only.
 *
 * ## Why a third tier exists at all
 *
 * LX.FIN measured the state the two tiers above cannot reach, on the CHILDLESS family at 1440, in
 * BOTH themes (its DEFECT-2 heading names `IT-GALE-JACKET`, but its own child table reads `1 row ·
 * Parent · No children yet` and its census note says GALE-JACKET has NEITHER pill — the family is the
 * one its case 4 calls `master · NOT COMPUTED`): `scrollW 1444` against `clientW 1372` — **72px over, with `Customise` and the `⋯`
 * button clipped off the right edge, i.e. unreachable**. The chips HAD folded (`Filters 3`, 99.6px)
 * and `Export`/`Import` HAD moved. The arithmetic named every child, so the 72px is not an argument:
 * that toolbar has **11** children where every other coordinate has 9, and the two extras exist only
 * on a family with no children — `Setup incomplete` **138.5px** and `no children` **92.3px** =
 * **230.8px of status pills that belong to no fold group**. At 1728 the same coordinate is clean.
 *
 * ## Why it is a MEASUREMENT and not `@media (max-width: 1440px)`
 *
 * The ruling reads "at ≤1440", and a media query would have been one line. It would also compact the
 * pills on every family whose bar fits perfectly at 1440 — the common case — and it would say nothing
 * at 1280, where a bar with more chips can be over at any width. The bar's own `scrollWidth` is the
 * fact; 1440 was where LX.FIN happened to catch it.
 *
 * ## Why it takes `armed` instead of measuring on its own
 *
 * Tiers 1 and 2 latch on the same observation this one would (the bar overflows), so measuring
 * independently would fire all three in the same commit and compact the pills on a bar the earlier
 * tiers were about to fix. `armed` is the caller's tier-2 state (`useToolbarOverflow`): this tier can
 * only latch on a LATER render, once the cheaper folds have been applied and the bar is STILL over.
 * That is what makes "last tier" true of the behaviour and not just of the comment.
 *
 * Monotone like the others: it remembers the width the bar needed when it latched and releases only
 * at `clientWidth >= that width`, so the compact/expand loop a naive "does it fit now?" produces
 * cannot happen.
 *
 * The ENGINE decides WHETHER. The SURFACE decides WHICH nodes compact, because only it knows which
 * of its status nodes have a glyph that can stand alone — the same split `useToolbarOverflow` makes
 * for the verbs.
 */
export function useToolbarStatusCompaction(anchor: RefObject<HTMLElement | null>, armed: boolean): boolean {
  return useMonotoneToolbarOverflow(anchor, armed)
}

/**
 * SHEET-VIEWS (2026-09-26) — a fold tier that fires only once the tier before it has folded and the
 * bar is STILL over. The same monotone measurement and the same `armed` contract as
 * `useToolbarStatusCompaction`, named for what it is, so a surface can put a CHEAPER fold in front of
 * its verbs without borrowing the status tier's name.
 *
 * Why the sheet needed it, measured on master·IT at a 1728px viewport: the row-height control
 * (Compact · Cozy · Spacious) is **206px + 8px gap**. With it in the actions group the bar needed
 * **1430px**, so `useToolbarOverflow` latched below a ≈1498px viewport and moved `Export` and `Import`
 * into `⋯` along with it — where before they stayed on the bar down to ≈1284px. Folding the row height
 * FIRST (`useToolbarOverflow`) and the verbs only after (`useToolbarOverflowTier(anchor, thatFolded)`)
 * keeps both verbs on the bar across 1284–1498px again.
 */
export function useToolbarOverflowTier(anchor: RefObject<HTMLElement | null>, armed: boolean): boolean {
  return useMonotoneToolbarOverflow(anchor, armed)
}

export interface GridToolbarFoldProps {
  /** The trigger's word when folded, e.g. `Filters`. */
  label: string
  /**
   * The number kept ON the trigger when folded (R-LX-18: "count kept on the trigger"), so folding
   * never hides how many filters exist. Omit for a group that has nothing to count.
   */
  count?: number
  /**
   * `'overflow'` (default) folds only when the bar is full — R-LX-18, unchanged. `'always'` keeps
   * the group folded at every width (Step 4.3 #2, R-52): one trigger, the same children in its panel.
   * An EMPTY group (`count === 0`) still never becomes a trigger, in either mode.
   */
  mode?: 'overflow' | 'always'
  /**
   * The label of the ACTIVE control in the group, when one is (R-52: the filters are single-select,
   * so "how many are active" would only ever read 0 or 1). Shown ON the trigger instead of the count —
   * `Filters · Missing images` — and styled as pressed, so a folded filter never hides that it is on.
   */
  activeLabel?: string
  /** The controls. Rendered inline when they fit and inside the panel when they do not — same nodes. */
  children: ReactNode
}

export function GridToolbarFold({ label, count, mode = 'overflow', activeLabel, children }: GridToolbarFoldProps) {
  const [open, setOpen] = useState(false)
  const host = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  /**
   * 🔴 SHEET-VIEWS (2026-09-26, Owner: "it opens the dropdown under the table, but it should be layered
   * above"). The panel was `position: absolute` inside `.nds-toolbar`, which is `overflow: auto` (it
   * scrolls sideways at narrow widths), inside `.nds-gridcard`, which is `overflow: hidden`. An
   * overflow box clips an absolutely-positioned descendant whatever its z-index, so the open panel
   * (measured: `aria-expanded="true"`, 190×190 at 1113,186) was cut off at the toolbar's bottom edge
   * and `elementFromPoint` inside it returned an AG cell — the Filters button did nothing visible.
   * Now the panel is portaled to `<body>` and placed by `usePopoverPosition`, the DS's one answer to
   * exactly this clipping (its header names the modal and grid cases) and what `GridViewsMenu` uses.
   * It stays MOUNTED once portaled, so a chip's own state still survives closing the panel.
   */
  const { popRef: panel, style: panelStyle } = usePopoverPosition(open, trigger, { width: 'auto', align: 'start', offset: 6 })
  const [portalReady, setPortalReady] = useState(false)
  useEffect(() => { setPortalReady(true) }, [])
  /** `null` = not measured yet; render inline so the first measurement sees the real widths. */
  const [neededWidth, setNeededWidth] = useState<number | null>(null)
  const panelId = useId()
  /**
   * 🔴 A group with NOTHING in it must never fold: a trigger where there were no controls ADDS width
   * instead of saving it. Measured by the census on the first run of this rule — `master · sheet at
   * 320px: Toolbar overflows horizontally`, because the master scope registers no view chips and the
   * empty group still produced a `Filters 0` button. `count === 0` is the group saying it is empty.
   */
  const foldable = count !== 0
  const folded = foldable && (mode === 'always' || neededWidth !== null)

  const measure = useCallback(() => {
    const el = host.current
    const bar = el?.closest('.nds-toolbar') as HTMLElement | null
    if (!el || !bar || !foldable) return
    // The same rule the two hooks above use — `nextToolbarOverflowWidth`, one definition.
    setNeededWidth((current) => nextToolbarOverflowWidth(current, bar))
  }, [foldable])

  useEffect(() => {
    const el = host.current
    const bar = el?.closest('.nds-toolbar') as HTMLElement | null
    if (!el || !bar) return
    measure()
    // The bar, not the window: `GridCard` is a size container, so a card can narrow without the
    // viewport moving (a drawer opening beside it) and a window listener would miss it.
    const observer = new ResizeObserver(() => measure())
    observer.observe(bar)
    return () => observer.disconnect()
  })

  /** Esc and an outside click close the panel; focus returns to the trigger, never to nowhere. */
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [open])

  if (!folded) return <span className="nds-toolbar-fold" ref={host}>{children}</span>

  return (
    <span className="nds-toolbar-fold is-folded" ref={host}>
      <button
        type="button"
        ref={trigger}
        className={['nds-btn sm nds-toolbar-fold-trigger', activeLabel ? 'is-active' : ''].filter(Boolean).join(' ')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        {activeLabel
          ? <span className="nds-toolbar-fold-active">· {activeLabel}</span>
          : count !== undefined && <span className="nds-toolbar-fold-count">{count}</span>}
        <ChevronDown size={11} />
      </button>
      {/* Kept MOUNTED and hidden, so a chip's own state survives closing the panel. Portaled after the
          first client render (a server render has no `<body>` to portal into). `dark` follows the
          trigger's scope, as `GridViewsMenu`'s prompt does, because `<body>` may sit outside it. */}
      {portalReady && createPortal(
        <div id={panelId} ref={panel} style={panelStyle}
          className={`nds-toolbar-fold-panel${trigger.current?.closest('.dark') ? ' dark' : ''}`}
          role="group" aria-label={label} hidden={!open}>
          {children}
        </div>,
        document.body,
      )}
    </span>
  )
}
