'use client'

/**
 * DetailModal — a row's detail in a centered dialog (bid page polish round 2, 2026-10-10; the Owner: no side drawer on
 * the Bid page). Built on the DS `Modal` (`size="detail"`): 1160px wide, CENTRED in the viewport (the Owner, 2026-10-11),
 * as tall as its content up to min(880px, the viewport); the header and the tab row fixed, the body scrolls beyond the
 * max and keeps the tallest height seen while open, so it never shrinks on a shorter tab or the next row — it only grows,
 * evenly around the centre; on a phone (below `breakpoint.sm`) a full-screen sheet. View rules: `detailModalModel.ts`.
 *
 *   header   title · subtitle · `meta` chips          `actions` · ▲ 3 of 12 ▼ · Close
 *   tabs     the DS `Tabs` — link tabs when a tab has an `href` (the host keeps `?rule=<id>&tab=<tab>` in the address,
 *            so Back closes it and a copied address opens it), button tabs with `onTabChange` otherwise
 *   body     `children`; `loading` → "Reading…"; `error` → a danger banner with Try again (`onRetry`)
 *
 * Prev / Next (`nav`): the host passes the ids of the table's rows in the order shown now (filtered, sorted) and the
 * current id; ▲ / ▼ and the keys K / J call `nav.onGo(id)`. At either end the button is held (focusable, says why), never
 * wraps. J / K never fire with a modifier held, nor while the focus is in a text field, a grid or a list.
 *
 * Stacking and focus come from `Modal`: a ReviewChangesModal opened from inside opens ABOVE this one, Esc closes only
 * the top dialog, and when the review closes the focus goes back to the control that opened it inside this detail (or
 * to this dialog when the save removed that control). When this closes, the focus goes back to what opened it — pass
 * `returnFocusTo` to name the row's cell instead (after Prev / Next moved on, or when it was opened from the address).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

import { Button, Spinner, Tooltip } from '../primitives'
import { Banner } from '../components/Banner'
import { Modal, isTopModal, type ModalProps } from '../components/Modal'
import { Tabs, tabPanelProps, type TabItem, type TabLinkComponent } from '../components/Tabs'
import {
  DETAIL_NAV_KEYS, KEY_TARGET_SELECTORS, detailBodyState, detailNavHeld, detailNavKey, detailNavLabel, detailPosition, nextTallest,
  onlyEmptyState, type DetailDirection, type KeyTargetKind,
} from './detailModalModel'

function keyTargetKind(target: EventTarget | null): KeyTargetKind {
  if (!(target instanceof Element)) return 'other'
  for (const [kind, selector] of KEY_TARGET_SELECTORS) if (target.closest(selector)) return kind
  return 'other'
}

export interface DetailNav {
  /** The ids of the table's rows in the order shown now (filtered, sorted). */
  ids: readonly string[]
  /** The row on show. */
  current: string
  /** Show that row: the host changes `current` (and its address). */
  onGo: (id: string) => void
  /** "rule", "keyword": names the buttons ("Next rule") and their reasons. Default "row". */
  noun?: string
}

export interface DetailModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** One short line under the title. */
  subtitle?: ReactNode
  /** Chips under the title (mode, owner, market). */
  meta?: ReactNode
  /** Buttons in the header, before Prev / Next ("Archive…"). */
  actions?: ReactNode
  tabs?: TabItem[]
  /** Default: the first tab. */
  activeTab?: string
  onTabChange?: (id: string) => void
  /** Link tabs: the host's link (the web app passes `@/lib/workspaces/Link`). */
  linkAs?: TabLinkComponent
  /** The tab row's accessible name. Default "Sections". */
  tabsLabel?: string
  nav?: DetailNav
  /** The row is being read: the body says "Reading…" instead of showing another row's content. */
  loading?: boolean
  /** The read failed: one sentence. Wins over `loading`. */
  error?: ReactNode
  onRetry?: () => void
  footer?: ReactNode
  /** See `Modal`: default the element that opened it. */
  returnFocusTo?: ModalProps['returnFocusTo']
  children?: ReactNode
}

function NavButton({ dir, noun, held, onGo }: { dir: DetailDirection; noun: string; held: string | null; onGo: () => void }) {
  const label = detailNavLabel(dir, noun)
  const key = DETAIL_NAV_KEYS[dir]
  return (
    <Tooltip label={held ?? `${label} (${key})`} portal>
      <Button
        size="sm"
        variant="quiet"
        aria-label={label}
        aria-keyshortcuts={key}
        aria-disabled={held ? true : undefined}
        aria-description={held ?? undefined}
        onClick={held ? undefined : onGo}
      >
        {dir === 'prev' ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
      </Button>
    </Tooltip>
  )
}

export function DetailModal({
  open, onClose, title, subtitle, meta, actions, tabs, activeTab, onTabChange, linkAs, tabsLabel = 'Sections', nav,
  loading = false, error, onRetry, footer, returnFocusTo, children,
}: DetailModalProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const idBase = useId()
  const noun = nav?.noun ?? 'row'
  const pos = detailPosition(nav?.ids ?? [], nav?.current)
  const held = detailNavHeld(pos, noun)
  const latest = useRef({ nav, pos })
  latest.current = { nav, pos }
  const go = (dir: DetailDirection) => {
    const { nav: n, pos: p } = latest.current
    const id = dir === 'prev' ? p.prevId : p.nextId
    if (n && id != null) n.onGo(id)
  }
  const goRef = useRef(go)
  goRef.current = go

  const hasNav = !!nav
  useEffect(() => {
    if (!open || !hasNav) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const dialog = bodyRef.current?.closest<HTMLElement>('[role="dialog"]')
      // Only the dialog on top: under a stacked review these keys belong to the review.
      if (!dialog || !isTopModal(dialog)) return
      const target = event.target
      if (target instanceof Node && target !== document.body && !dialog.contains(target)) return
      const dir = detailNavKey(event, keyTargetKind(target))
      if (!dir) return
      event.preventDefault()
      const p = latest.current.pos
      if ((dir === 'prev' ? p.prevId : p.nextId) == null) return
      goRef.current(dir)
      // The row's content is replaced; if the focus was in it, keep it in this dialog rather than on <body>.
      requestAnimationFrame(() => { if (dialog.isConnected && !dialog.contains(document.activeElement)) dialog.focus() })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, hasNav])

  // Run 3: the dialog's height follows its content (up to its max), and the body keeps the tallest height seen while it
  // is open — a shorter tab, a "Reading…" or the next row never shrinks it, so nothing jumps; it starts fresh next time.
  // Measured after EVERY render (a tab or a row swaps the content) and whenever the content or the body resizes. The
  // observer follows the content element itself (a callback ref): attached once on open, it stopped following when the
  // dialog was opened from the address, and the floor stayed at the "Reading…" height (20 px) so every tab shrank it.
  const [innerEl, setInnerEl] = useState<HTMLDivElement | null>(null)
  const [tallest, setTallest] = useState(0)
  const measure = useRef<() => void>(() => {})
  measure.current = () => {
    const body = innerEl?.closest<HTMLElement>('.nds-modal-b')
    if (!innerEl || !body) return
    const cs = getComputedStyle(body)
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const room = body.scrollHeight > body.clientHeight + 1 ? body.clientHeight - pad : Infinity
    setTallest((t) => nextTallest(t, innerEl.offsetHeight, room))
  }
  useEffect(() => { if (!open) setTallest(0) }, [open])
  useEffect(() => {
    if (!open || !innerEl || typeof ResizeObserver === 'undefined') return
    const sizes = new ResizeObserver(() => measure.current())
    sizes.observe(innerEl)
    const body = innerEl.closest<HTMLElement>('.nds-modal-b')
    if (body) sizes.observe(body)
    return () => sizes.disconnect()
  }, [open, innerEl])

  // Audit M12: content that is only an EmptyState sits in the middle of the kept-tall body, not under the tabs. Checked
  // after every render (a tab or a row changes the content) and marked on the body for the stylesheet.
  useLayoutEffect(() => {
    if (open) measure.current()
    const body = bodyRef.current
    if (!body) return
    if (onlyEmptyState(innerEl)) body.setAttribute('data-only-empty', '')
    else body.removeAttribute('data-only-empty')
  })

  const state = detailBodyState({ loading, error })
  const tabList = tabs && tabs.length > 0 ? tabs : null
  const active = activeTab ?? tabList?.[0]?.id ?? ''
  const linkTabs = !!tabList?.some((t) => t.href)

  const sub = subtitle != null || meta != null ? (
    <>
      {subtitle != null && <span className="nds-detail-subtitle">{subtitle}</span>}
      {meta != null && <span className="nds-detail-meta">{meta}</span>}
    </>
  ) : undefined

  const headerActions = actions != null || nav ? (
    <>
      {actions != null && <div className="nds-detail-actions">{actions}</div>}
      {nav && (
        <div className="nds-detail-nav" role="group" aria-label={`Move between ${noun}s`}>
          <NavButton dir="prev" noun={noun} held={held.prev} onGo={() => go('prev')} />
          {pos.words && <span className="nds-detail-pos" aria-live="polite">{pos.words}</span>}
          <NavButton dir="next" noun={noun} held={held.next} onGo={() => go('next')} />
        </div>
      )}
    </>
  ) : undefined

  const subheader = tabList ? (
    <Tabs
      ariaLabel={tabsLabel}
      tabs={tabList}
      active={active}
      onChange={onTabChange}
      linkAs={linkAs}
      overflow="scroll"
      idBase={linkTabs ? undefined : idBase}
    />
  ) : undefined

  const panelProps = tabList && !linkTabs ? tabPanelProps(idBase, active) : {}

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="detail"
      title={title}
      subtitle={sub}
      headerActions={headerActions}
      subheader={subheader}
      footer={footer}
      returnFocusTo={returnFocusTo}
      initialFocus="dialog"
      busy={state === 'loading'}
    >
      <div ref={bodyRef} className="nds-detail-body" {...panelProps} style={tallest ? { minHeight: tallest } : undefined}>
        <div ref={setInnerEl}>
        {state === 'error' ? (
          <Banner tone="danger" action={onRetry ? <Button size="sm" onClick={onRetry}>Try again</Button> : undefined}>{error}</Banner>
        ) : state === 'loading' ? (
          <p className="nds-detail-loading"><Spinner size={14} /><span aria-hidden="true">Reading…</span></p>
        ) : children}
        </div>
      </div>
    </Modal>
  )
}
