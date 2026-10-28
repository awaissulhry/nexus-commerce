'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '../primitives'
import { useHydrated } from '../components/useHydrated'
import { builderSectionId, scrolledToEnd, spyActiveSection } from './builderSpy'

export interface BuilderSection {
  id: string
  label: ReactNode
  title?: ReactNode
  content: ReactNode
  /** After the label in the section strip: a count or a Pill ("1 problem"). */
  badge?: ReactNode
}

export interface BuilderProps {
  /** Overlay: shown while true. Page mode is always shown. */
  open?: boolean
  /** Overlay: the X and Esc. */
  onClose?: () => void
  /** Overlay: the top bar's title. */
  title?: ReactNode
  sections: BuilderSection[]
  primaryLabel?: ReactNode
  onPrimary?: () => void
  busy?: boolean
  className?: string
  /**
   * `overlay` (default, as before): full screen over the page, portaled, `role="dialog"`, Esc closes.
   * `page` (Reviews parts, 2026-10-26): part of the page — no portal, no dialog, no Esc, no top bar. The section list
   * is a sticky strip across the top (the area's own navigation already takes the left), the sections fill the main
   * column, `aside` is a live column on the right from 1200 px (under the main column below that) and `footer` ends it
   * (an `EditModeBar`). The strip marks the section on screen as the PAGE scrolls (`IntersectionObserver`).
   */
  mode?: 'overlay' | 'page'
  /** Page mode: the live column ("When it sends", a test run). */
  aside?: ReactNode
  /** Page mode: the aside's landmark name. Default "Live preview". */
  asideLabel?: string
  /** Page mode: under the sections (an `EditModeBar`). */
  footer?: ReactNode
  /** The section list's name. Default "Sections". */
  navLabel?: string
}

/** The nearest scrolling ancestor — the page scroller in page mode — or null for the viewport. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const { overflowY } = window.getComputedStyle(p)
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return p
  }
  return null
}

/**
 * Full-screen builder (H10 RuleBuilder / AiGoalBuilder): top bar (close + title
 * + primary action), a scroll-spy left nav, and a scrolling section body.
 * Portaled to <body>; Esc closes. The spine for the rule/goal/campaign builders.
 * `mode="page"` puts the same sections in the page itself; see the prop.
 */
export function Builder({
  open, onClose, title, sections, primaryLabel = 'Save', onPrimary, busy, className,
  mode = 'overlay', aside, asideLabel = 'Live preview', footer, navLabel = 'Sections',
}: BuilderProps) {
  const page = mode === 'page'
  const hydrated = useHydrated()
  const [active, setActive] = useState<string | undefined>(sections[0]?.id)
  const contentRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLElement>(null)
  const [stripHeight, setStripHeight] = useState(48)
  const spyPausedUntil = useRef(0)
  const sectionKey = sections.map(s => s.id).join('|')

  useEffect(() => {
    if (page || !open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [page, open, onClose])

  useEffect(() => {
    if (page || !open || !hydrated) return
    const el = contentRef.current
    if (!el) return
    const onScroll = () => {
      const threshold = el.scrollTop + 80
      let current = sections[0]?.id
      for (const s of sections) {
        const node = el.querySelector<HTMLElement>(`#bsec-${s.id}`)
        if (node && node.offsetTop <= threshold) current = s.id
      }
      setActive(current)
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [page, open, hydrated, sections])

  // Page mode: the strip's height places the sections under it when they are scrolled to, and the live column.
  useLayoutEffect(() => {
    if (!page) return
    const strip = stripRef.current
    if (!strip) return
    const measure = () => setStripHeight(Math.round(strip.getBoundingClientRect().height))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [page])

  // Page mode: the page scrolls, so the spy watches the sections in a band under the strip.
  useEffect(() => {
    if (!page) return
    const root = pageRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const ids = sectionKey ? sectionKey.split('|') : []
    const scroller = scrollParent(root)
    const visible = new Map<string, number>()
    const update = () => {
      if (Date.now() < spyPausedUntil.current) return
      const box = scroller ?? document.scrollingElement
      const atEnd = box ? scrolledToEnd(box.scrollTop, box.clientHeight, box.scrollHeight) : false
      setActive(previous => spyActiveSection(ids, visible, previous, atEnd))
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.builderSection
        if (id) visible.set(id, entry.isIntersecting ? entry.intersectionRect.height : 0)
      }
      update()
    }, { root: scroller, rootMargin: `-${stripHeight + 8}px 0px -45% 0px`, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] })
    for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-builder-section]'))) observer.observe(node)
    const target: HTMLElement | Window = scroller ?? window
    target.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      target.removeEventListener('scroll', update)
    }
  }, [page, sectionKey, stripHeight])

  const goToPageSection = useCallback((id: string) => {
    const node = pageRef.current?.querySelector<HTMLElement>(`[data-builder-section="${CSS.escape(id)}"]`)
    if (!node) return
    // The strip marks the chosen section at once; the spy waits until the scroll has settled.
    spyPausedUntil.current = Date.now() + 800
    setActive(id)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    node.focus({ preventScroll: true })
  }, [])

  const goTo = (id: string) => {
    if (page) return goToPageSection(id)
    const el = contentRef.current
    const node = el?.querySelector<HTMLElement>(`#bsec-${id}`)
    if (el && node) el.scrollTo({ top: node.offsetTop - 24, behavior: 'smooth' })
    setActive(id)
  }

  const strip = (
    <nav className="nds-builder-nav" aria-label={navLabel} ref={stripRef}>
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          className={['nds-builder-navitem', s.id === active ? 'on' : ''].filter(Boolean).join(' ')}
          aria-current={s.id === active ? 'location' : undefined}
          onClick={() => goTo(s.id)}
        >
          {s.label}
          {s.badge != null && <span className="nds-builder-navbadge">{s.badge}</span>}
        </button>
      ))}
    </nav>
  )

  if (page) {
    return (
      <div
        ref={pageRef}
        className={`nds-builder page${aside != null ? ' has-aside' : ''}${className ? ` ${className}` : ''}`}
        style={{ '--nds-builder-strip-h': `${stripHeight}px` } as CSSProperties}
      >
        {strip}
        <div className="nds-builder-main">
          {sections.map((s) => (
            <section key={s.id} id={builderSectionId(s.id)} data-builder-section={s.id} className="nds-builder-section" tabIndex={-1}>
              {s.title != null && <h3>{s.title}</h3>}
              {s.content}
            </section>
          ))}
        </div>
        {aside != null && <aside className="nds-builder-aside" aria-label={asideLabel}>{aside}</aside>}
        {footer != null && <div className="nds-builder-footer">{footer}</div>}
      </div>
    )
  }

  if (!open || !hydrated) return null

  return createPortal(
    <div className={`nds-builder${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true">
      <div className="nds-builder-top">
        <button type="button" className="x" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <span className="ttl">{title}</span>
        <span className="grow" />
        {onPrimary && (
          <Button variant="primary" onClick={onPrimary} disabled={busy}>
            {primaryLabel}
          </Button>
        )}
      </div>
      <div className="nds-builder-body">
        {strip}
        <div className="nds-builder-content" ref={contentRef}>
          {sections.map((s) => (
            <section key={s.id} id={builderSectionId(s.id)} className="nds-builder-section">
              {s.title != null && <h3>{s.title}</h3>}
              {s.content}
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
