'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePathname, useSearchParams } from 'next/navigation'
import { ArrowLeft, Info, Keyboard, MoreHorizontal } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { useBandSlot } from '../../../../shell/office/band-slot'
import { usePrintMode } from '../../../../shell/print/print-mode'
import { FRAME_NS } from '../../../_shared/record-frame/RecordFrame'
import { FRAME_KEYS } from '../../../_shared/record-frame/model'
import '../../../_shared/record-frame/record-frame.css'
import { DETAILS_PARAM, RECORD_NS } from './model'
import './record.css'

/**
 * B-TH-249 — the project's own frame (PROJ.record-F01; O-PRD-PROJ-REC, the generic record page grown). A record page docks its
 * thread at 40 % on the right and hides it behind a button below 1280 px (RecordFrame); a project is the other way round: its
 * thread IS the page. So this frame keeps RecordFrame's band — in the shell's band row through the band slot, the DS dense
 * DetailHeader with the same look, ONE status pill, the ⋯ ending with "Keyboard" (PR-14), a phone's details behind a button — and
 * lays the body out as the thread ~2/3 on the left (sticky under the band, its own scroll, the box at its foot) and the side column
 * ~1/3 on the right (Details, People, Linked, news, Tasks, Files). Below 1280 px the thread takes the width and the side column
 * opens from the band's "Details" as a full-width view (`?details=open`; Back returns to the thread at its place); on a phone the
 * button is an "i". No tabs; one thread per page; no page max-width.
 */

export interface ProjectBand {
  /** The way back to the list, as a real link (⌘-click works). */
  readonly back: ReactElement
  readonly title: ReactNode
  /** The ONE status pill. */
  readonly status?: ReactNode
  /** The outside company, lead, target date, season. */
  readonly meta?: ReactNode
  /** The one primary step by state (Reopen on a closed project). */
  readonly primary?: ReactNode
  /** The ⋯ lines (the frame adds "Keyboard" at the end). */
  readonly more?: readonly MenuItemDef[]
  readonly moreLabel?: string
}

export interface ProjectFrameProps {
  readonly band: ProjectBand
  /** The thread, the page's main column; null where there is none (reading, not found, a problem: `children` then). */
  readonly thread: ReactNode | null
  readonly threadLabel: string
  /** Above the thread in its column: the closed banner, one notice. */
  readonly notices?: ReactNode
  /** The side column; null where there is none. */
  readonly side: ReactNode | null
  readonly sideLabel: string
  /** The keys the band's "Keyboard" line lists (default: the record frame's, less the dock's ⌘J and the band's step). */
  readonly keys?: readonly { readonly keys: readonly string[]; readonly words: string }[]
  /** What the print view (`?print=1`) shows of the thread under the details. */
  readonly printThread?: ReactNode
  /** The page without a thread (reading, not found, a problem). */
  readonly children?: ReactNode
  /** Design cases: the details view open as if below 1280 px. */
  readonly detailsOpen?: boolean
}

/** The record frame's keys that hold on a project page: J / K, R, N, Esc (no ⌘J: the thread is always on screen). */
export const PROJECT_KEYS = FRAME_KEYS.filter((entry) => entry.words !== 'keys.thread' && entry.words !== 'keys.step')

/** From this width the side column stands beside the thread. */
export const SIDE_FROM = 1280

function scrollerOf(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight >= node.clientHeight) return node
  }
  return null
}

export function ProjectFrame(props: ProjectFrameProps) {
  return (
    <WithMessages namespaces={[FRAME_NS, RECORD_NS]}>
      <Frame {...props} />
    </WithMessages>
  )
}

function Frame({ band, thread, threadLabel, notices, side, sideLabel, keys: keyList = PROJECT_KEYS, printThread, children, detailsOpen = false }: ProjectFrameProps) {
  const t = useT(FRAME_NS)
  const tr = useT(RECORD_NS)
  const slot = useBandSlot()
  const printing = usePrintMode()
  const pathname = usePathname()
  const params = useSearchParams()
  const root = useRef<HTMLDivElement>(null)
  const sideId = useId()
  const [keysOpen, setKeysOpen] = useState(false)
  const scrollKept = useRef<number | null>(null)
  const open = detailsOpen || params?.get(DETAILS_PARAM) === 'open'
  const hasSide = side !== null
  const hasThread = thread !== null

  // The band row of the shell: claimed while this project is on screen (before paint: no flash of the crumbs).
  useLayoutEffect(() => slot.claim(), [slot.claim])

  // The details view (below 1280 px): opened on the browser's history, so Back closes it and the thread comes back at its place.
  const openDetails = useCallback(() => {
    scrollKept.current = scrollerOf(root.current)?.scrollTop ?? null
    const next = new URLSearchParams(window.location.search)
    next.set(DETAILS_PARAM, 'open')
    window.history.pushState(null, '', `${pathname}?${next.toString()}`)
  }, [pathname])
  const closeDetails = useCallback(() => {
    if (!new URLSearchParams(window.location.search).has(DETAILS_PARAM)) return
    if (scrollKept.current !== null) window.history.back()
    else {
      const next = new URLSearchParams(window.location.search)
      next.delete(DETAILS_PARAM)
      window.history.replaceState(null, '', `${pathname}${next.size > 0 ? `?${next.toString()}` : ''}`)
    }
  }, [pathname])
  useLayoutEffect(() => {
    const scroller = scrollerOf(root.current)
    if (!scroller) return
    if (open) scroller.scrollTop = 0
    else if (scrollKept.current !== null) {
      scroller.scrollTop = scrollKept.current
      scrollKept.current = null
    }
  }, [open])
  // From 1280 px the side column stands beside the thread: an open details view has nothing left to hide.
  useEffect(() => {
    if (!open || detailsOpen) return
    const wide = window.matchMedia(`(min-width: ${SIDE_FROM}px)`)
    const onChange = () => wide.matches && closeDetails()
    onChange()
    wide.addEventListener('change', onChange)
    return () => wide.removeEventListener('change', onChange)
  }, [open, detailsOpen, closeDetails])

  // The thread column's top and height: under the sticky band, down to the window's foot (above a phone's bottom bar).
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => {
      const scroller = scrollerOf(element)
      const subheader = scroller?.querySelector<HTMLElement>(':scope > .fw-office-subheader') ?? null
      const bar = document.querySelector<HTMLElement>('.nds-bottombar')
      const barHeight = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().height : 0
      const top = (subheader?.getBoundingClientRect().height ?? 0) + 16
      const room = (scroller?.clientHeight ?? window.innerHeight) - top - 16 - barHeight
      element.style.setProperty('--fw-prjr-top', `${Math.round(top)}px`)
      element.style.setProperty('--fw-prjr-h', `${Math.max(420, Math.round(room))}px`)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    const scroller = scrollerOf(element)
    if (scroller) observer?.observe(scroller)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [hasThread])

  const detailsButton = hasSide ? (
    <Button
      size="sm"
      variant={open ? 'tonal' : 'secondary'}
      className="fw-prjr-details-btn"
      aria-pressed={open}
      aria-controls={sideId}
      aria-label={t('details.open')}
      onClick={() => (open ? closeDetails() : openDetails())}
    >
      <Info size={14} aria-hidden /> <span className="fw-prjr-details-word">{t('details.open')}</span>
    </Button>
  ) : null
  const header = (
    <DetailHeader
      dense
      className={open ? 'fw-rcf-hdr fw-prjr-hdr is-details' : 'fw-rcf-hdr fw-prjr-hdr'}
      backAsChild
      backLabel={band.back}
      title={band.title}
      meta={
        band.status || band.meta ? (
          <span className="fw-rcf-meta">
            {band.status}
            {band.meta && <span className="fw-rcf-meta-more">{band.meta}</span>}
          </span>
        ) : undefined
      }
      status={slot.status ? <span className="fw-rcf-live">{slot.status}</span> : undefined}
      actions={
        <span className="fw-rcf-actions">
          {band.primary && <span className="fw-rcf-primary">{band.primary}</span>}
          {detailsButton}
          <Menu
            label={<MoreHorizontal size={16} aria-label={band.moreLabel ?? t('more')} />}
            items={[...(band.more ?? []), ...(band.more?.length ? [{ id: 'sep-keys', separator: true }] : []), { id: 'keys', label: t('keys.line'), icon: <Keyboard size={15} aria-hidden />, description: t('keys.lineHint'), onSelect: () => setKeysOpen(true) }]}
            align="right"
            triggerProps={{ 'aria-label': band.moreLabel ?? t('more') }}
          />
          {slot.actions}
        </span>
      }
    />
  )

  // The print view: the band, the details, then what the thread prints.
  if (printing) {
    return (
      <div className="fw-prjr-print">
        {header}
        {side}
        {printThread}
      </div>
    )
  }

  const body =
    !hasThread ? (
      <div className="fw-prjr-alone">{children}</div>
    ) : (
      <div ref={root} className={`fw-prjr${hasSide ? ' has-side' : ''}`} data-view={open ? 'details' : 'thread'}>
        <div className="fw-prjr-main">
          {notices}
          <section className="fw-prjr-thread" aria-label={threadLabel}>
            {thread}
          </section>
        </div>
        {hasSide && (
          <aside id={sideId} className="fw-prjr-side" aria-label={sideLabel}>
            {open && (
              <div className="fw-prjr-back">
                <Button size="sm" variant="quiet" onClick={closeDetails}>
                  <ArrowLeft size={14} aria-hidden /> {tr('frame.backToThread')}
                </Button>
              </div>
            )}
            {side}
          </aside>
        )}
      </div>
    )

  return (
    <>
      {slot.element ? createPortal(header, slot.element) : <div className="fw-rcf-band">{header}</div>}
      {body}
      {keysOpen && (
        <Modal open size="sm" title={t('keys.title')} onClose={() => setKeysOpen(false)}>
          <dl className="fw-rcf-keylist">
            {keyList.map((entry) => (
              <div key={entry.words} className="fw-rcf-keyrow">
                <dt>
                  {entry.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </dt>
                <dd>{t(entry.words)}</dd>
              </div>
            ))}
          </dl>
        </Modal>
      )}
    </>
  )
}
