'use client'

/**
 * RecordNav — Previous / Next record on a record PAGE (B-W2b-09, D13; design 00-page-anatomy §2.2 item 7): the
 * `DetailModal` `nav` rule for pages ("53 of 56", J / K, held at the ends).
 *
 *   <RecordNav ids={listIds} current={order.id} hrefOf={(id) => `/w/${co}/purchasing/orders/${id}`} noun="order"
 *     offset={50} total={56} labels={ds.detail} />
 *
 * - **Real links**: each control is an `<a>` to the other record (`hrefOf`), so ⌘-click opens it in a new tab and the
 *   address is shareable; `linkAs` is the host's link (default Next's `Link`). `onGo(id)` is called on a plain move
 *   (the app may remember the list), never instead of the link.
 * - **Held, not hidden**: at the first record Previous is held and says why ("This is the first order" / "… on this page"
 *   when the list has earlier pages); a record no longer in the list holds both. Never wraps.
 * - **Keys**: K previous, J next on the page — not with a modifier, not while typing, in a grid, a list or a menu, and
 *   not while a dialog is open; the move follows the link (client navigation through `linkAs`).
 * - The counter is a polite live region (the new record's place is heard after a move).
 * Its own entry point (`patterns/record-nav`), not in the patterns barrel. Words: `labels` (the same words as
 * `DetailModal`'s).
 */
import { useEffect, useRef, type ComponentType, type MouseEvent, type MouseEventHandler, type ReactNode } from 'react'
import NextLink from 'next/link'
import { ChevronDown, ChevronUp } from 'lucide-react'

import { Button } from '../../primitives/Button'
import { Tooltip } from '../../primitives/Tooltip'
import { mergeLabels } from '../../lib/labels'
import { RECORD_NAV_LABELS, type RecordNavLabels } from './RecordNavLabels'
import { RECORD_NAV_KEY_TARGETS, recordNavKey, recordNavView, type RecordNavDirection, type RecordNavStep } from './recordNavModel'
import type { KeyTargetKind } from '../detailModalModel'
import './record-nav.css'

/** The host's link (the web app's workspace `Link`; Next's `Link` by default). */
export type RecordNavLinkComponent = ComponentType<{
  href: string
  className?: string
  children?: ReactNode
  onClick?: MouseEventHandler<HTMLAnchorElement>
  'aria-label'?: string
  'aria-keyshortcuts'?: string
}>

export interface RecordNavProps {
  /** The list's ids in the order it showed them (filtered, sorted); one page of it with `offset` / `total`. */
  ids: readonly string[]
  /** The record on the page. */
  current: string
  /** The other record's address. */
  hrefOf: (id: string) => string
  /** Called on a move (click or key) before the link is followed. */
  onGo?: (id: string, dir: RecordNavDirection) => void
  /** "order", "work order": names the controls and their reasons, in the person's language. */
  noun?: string
  /** Rows before `ids` (earlier pages). */
  offset?: number
  /** Rows in the whole list. */
  total?: number | null
  /** J / K on the page. Default true; off when the page has its own J / K. */
  keys?: boolean
  linkAs?: RecordNavLinkComponent
  labels?: Partial<RecordNavLabels>
  className?: string
}

function keyTargetKind(target: EventTarget | null): KeyTargetKind {
  if (!(target instanceof Element)) return 'other'
  for (const [kind, selector] of RECORD_NAV_KEY_TARGETS) if (target.closest(selector)) return kind
  return 'other'
}

/** A dialog over the page (a Modal, a Drawer, a Builder): its keys win. */
const dialogOpen = () => typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null

export function RecordNav({ ids, current, hrefOf, onGo, noun, offset, total, keys = true, linkAs, labels, className }: RecordNavProps) {
  const words = mergeLabels(RECORD_NAV_LABELS, labels)
  const view = recordNavView(ids, current, { noun, place: { offset, total }, words })
  const links = useRef<Record<RecordNavDirection, HTMLAnchorElement | null>>({ prev: null, next: null })
  const latest = useRef({ view, onGo })
  latest.current = { view, onGo }

  useEffect(() => {
    if (!keys) return
    const onKey = (event: KeyboardEvent) => {
      const dir = recordNavKey(event, keyTargetKind(event.target), dialogOpen())
      if (!dir) return
      const step = latest.current.view[dir]
      if (!step.id) return
      event.preventDefault()
      // Follow the real link: the host's Link does the client navigation (and `onGo` runs in its click).
      links.current[dir]?.click()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [keys])

  const Link = linkAs ?? NextLink
  const control = (step: RecordNavStep) => {
    const icon = step.dir === 'prev' ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />
    if (!step.id) {
      return (
        <Button size="sm" variant="quiet" aria-label={step.label} aria-keyshortcuts={step.key} heldReason={step.held}>
          {icon}
        </Button>
      )
    }
    const id = step.id
    return (
      <Tooltip label={`${step.label} (${step.key})`} portal>
        <Button asChild size="sm" variant="quiet">
          <Link
            href={hrefOf(id)}
            aria-label={step.label}
            aria-keyshortcuts={step.key}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (!event.defaultPrevented) latest.current.onGo?.(id, step.dir)
            }}
          >
            <span ref={(span) => { links.current[step.dir] = span?.closest('a') ?? null }} className="nds-recnav-icon">{icon}</span>
          </Link>
        </Button>
      </Tooltip>
    )
  }

  return (
    <nav className={['nds-recnav', className ?? ''].filter(Boolean).join(' ')} aria-label={view.groupLabel}>
      {control(view.prev)}
      <span className="nds-recnav-pos" aria-live="polite">{view.counter ?? ''}</span>
      {control(view.next)}
    </nav>
  )
}
