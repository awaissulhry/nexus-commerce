'use client'

/**
 * BottomBar — the phone's main navigation (Office and Portal): up to four tabs and More, which opens the More sheet.
 *
 * The phone form of the main sidebar. It reads the view's area-navigation manifest (`patterns/shell/area-nav.ts`,
 * filtered for the person with `areaNavForPerson`): the areas and rows marked `phone: 'tab'` are the tabs, every other
 * area and the rows marked `phone: 'more'` are in the sheet (`bottomBarModel.ts` has the rules). Like `AppRail` it knows no
 * router: the app passes its link (`LinkComponent`), the workspace-free address (`pathname`) and, optionally, `href` to
 * add its prefix.
 *
 * Fixed to the bottom of the screen under 720 px and not drawn above it (the rail takes over). It pads itself by the
 * device's safe area (`env(safe-area-inset-bottom)`, the home indicator); the page keeps its last content clear of the
 * bar with `padding-bottom: calc(64px + env(safe-area-inset-bottom))` on its scroll area under 720 px. `inline` draws it in
 * the page flow at every width, for a preview or a phone frame.
 *
 * Keyboard and screen reader: a `<nav>` landmark named by `labels.navigation`, tabs are links in a list (Tab moves
 * between them, the current one has `aria-current="page"`), More is a button that says it opens a dialog and whether
 * the current page is inside it. The sheet is the DS `Modal` (focus moves in, Tab stays in, Esc and the backdrop close it,
 * the focus goes back to More); a link in it closes it.
 */
import { useState, type ComponentType, type ReactNode } from 'react'
import { Circle, MoreHorizontal } from 'lucide-react'
import type { AreaNav } from '../../patterns/shell/area-nav'
import { Modal } from '../Modal'
import { badgeText, bottomBarLayout, type BottomBarEntry } from './bottomBarModel'
import './bottom-bar.css'

/** What the bar passes to the app's link. It must render an `<a>` with these props. */
export interface BottomBarLinkProps {
  href: string
  className?: string
  'aria-current'?: 'page'
  'aria-label'?: string
  onClick?: () => void
  children?: ReactNode
}

export type BottomBarLinkComponent = ComponentType<BottomBarLinkProps>

/** The words the bar says. English by default; an app passes its own. */
export interface BottomBarLabels {
  /** The navigation landmark's name. */
  navigation: string
  /** The More slot, and the sheet's title. */
  more: string
  /** Said after a name when it has a count: `Approvals, 3 waiting`. */
  count: (n: number) => string
  /** Said with More when the current page is in the sheet. */
  currentInside: string
}

export const BOTTOM_BAR_LABELS: BottomBarLabels = {
  navigation: 'Main',
  more: 'More',
  count: (n) => `${n.toLocaleString('en')} waiting`,
  currentInside: 'current page is here',
}

interface SharedProps {
  LinkComponent: BottomBarLinkComponent
  /** Turns an app address into the link's href, e.g. adds the workspace prefix. Default: unchanged. */
  href?: (address: string) => string
  /** The count for an entry's badge key; shown when above 0. */
  count?: (badge: string) => number | undefined
  labels?: Partial<BottomBarLabels>
}

export interface BottomBarProps extends SharedProps {
  /** The view's navigation, already filtered for the person (`areaNavForPerson`). */
  nav: AreaNav
  /** The current address without the workspace prefix: decides the one current slot. */
  pathname: string
  /** Tabs before More (1–4, default 4). */
  maxTabs?: number
  /** In the page flow and at every width (a preview, a phone frame), instead of fixed to a phone's bottom edge. */
  inline?: boolean
  className?: string
}

export interface MoreSheetProps extends SharedProps {
  open: boolean
  onClose: () => void
  /** What the sheet lists, in order (`bottomBarLayout(...).more`). */
  entries: readonly BottomBarEntry[]
  /** The id of the entry that owns the current page. */
  current?: string | null
}

const countOf = (entry: BottomBarEntry, count?: (badge: string) => number | undefined): number => {
  const n = entry.badge ? count?.(entry.badge) : undefined
  return typeof n === 'number' && n > 0 ? n : 0
}

function EntryIcon({ entry }: { entry: BottomBarEntry }) {
  const Icon = entry.icon ?? Circle
  return <Icon size={22} strokeWidth={1.75} aria-hidden="true" focusable="false" />
}

/** The sheet's list: one link per entry; a row also names its area; the current one is marked. */
export function MoreSheetList({ entries, current, LinkComponent, href, count, labels, onPick }: Omit<MoreSheetProps, 'open' | 'onClose'> & { onPick?: () => void }) {
  const words = { ...BOTTOM_BAR_LABELS, ...labels }
  const toHref = href ?? ((address: string) => address)
  return (
    <ul className="nds-moresheet-list">
      {entries.map((entry) => {
        const n = countOf(entry, count)
        const isCurrent = entry.id === current
        const name = [entry.ariaLabel ?? entry.label, entry.kind === 'row' ? entry.areaLabel : null, n ? words.count(n) : null].filter(Boolean).join(', ')
        return (
          <li key={entry.id}>
            <LinkComponent
              href={toHref(entry.href)}
              className={isCurrent ? 'nds-moresheet-row on' : 'nds-moresheet-row'}
              aria-current={isCurrent ? 'page' : undefined}
              aria-label={name}
              onClick={onPick}
            >
              <span className="nds-moresheet-ico">
                <EntryIcon entry={entry} />
              </span>
              <span className="nds-moresheet-text">
                <span className="nds-moresheet-lbl">{entry.label}</span>
                {entry.kind === 'row' && <span className="nds-moresheet-area">{entry.areaLabel}</span>}
              </span>
              {n > 0 && (
                <span className="nds-bottombar-badge in-row" aria-hidden="true">
                  {badgeText(n)}
                </span>
              )}
            </LinkComponent>
          </li>
        )
      })}
    </ul>
  )
}

/** The More sheet: every place that is not a tab. A bottom sheet on a phone, the DS dialog elsewhere; a link closes it. */
export function MoreSheet({ open, onClose, labels, ...list }: MoreSheetProps) {
  const words = { ...BOTTOM_BAR_LABELS, ...labels }
  return (
    <Modal open={open} onClose={onClose} title={words.more} className="nds-moresheet">
      <MoreSheetList {...list} labels={labels} onPick={onClose} />
    </Modal>
  )
}

export function BottomBar({ nav, pathname, LinkComponent, href, count, maxTabs, labels, inline = false, className }: BottomBarProps) {
  const [open, setOpen] = useState(false)
  const words = { ...BOTTOM_BAR_LABELS, ...labels }
  const toHref = href ?? ((address: string) => address)
  const layout = bottomBarLayout(nav, pathname, { maxTabs })
  if (layout.tabs.length === 0 && layout.more.length === 0) return null
  const moreCount = layout.more.reduce((sum, entry) => sum + countOf(entry, count), 0)
  const moreCurrent = layout.current === 'more'
  const moreName = [words.more, moreCurrent ? words.currentInside : null, moreCount ? words.count(moreCount) : null].filter(Boolean).join(', ')
  return (
    <>
      <nav className={['nds-bottombar', inline ? 'inline' : '', className ?? ''].filter(Boolean).join(' ')} aria-label={words.navigation}>
        <ul className="nds-bottombar-list">
          {layout.tabs.map((tab) => {
            const n = countOf(tab, count)
            const isCurrent = layout.current === tab.id
            return (
              <li key={tab.id} className="nds-bottombar-slot">
                <LinkComponent
                  href={toHref(tab.href)}
                  className={isCurrent ? 'nds-bottombar-tab on' : 'nds-bottombar-tab'}
                  aria-current={isCurrent ? 'page' : undefined}
                  aria-label={[tab.ariaLabel ?? tab.label, n ? words.count(n) : null].filter(Boolean).join(', ')}
                >
                  <span className="nds-bottombar-ico">
                    <EntryIcon entry={tab} />
                    {n > 0 && (
                      <span className="nds-bottombar-badge" aria-hidden="true">
                        {badgeText(n)}
                      </span>
                    )}
                  </span>
                  <span className="nds-bottombar-lbl">{tab.label}</span>
                </LinkComponent>
              </li>
            )
          })}
          {layout.more.length > 0 && (
            <li className="nds-bottombar-slot">
              <button
                type="button"
                className={moreCurrent ? 'nds-bottombar-tab on' : 'nds-bottombar-tab'}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={moreName}
                onClick={() => setOpen(true)}
              >
                <span className="nds-bottombar-ico">
                  <MoreHorizontal size={22} strokeWidth={1.75} aria-hidden="true" focusable="false" />
                  {moreCount > 0 && (
                    <span className="nds-bottombar-badge" aria-hidden="true">
                      {badgeText(moreCount)}
                    </span>
                  )}
                </span>
                <span className="nds-bottombar-lbl">{words.more}</span>
              </button>
            </li>
          )}
        </ul>
      </nav>
      {layout.more.length > 0 && (
        <MoreSheet
          open={open}
          onClose={() => setOpen(false)}
          entries={layout.more}
          current={layout.currentInMore}
          LinkComponent={LinkComponent}
          href={toHref}
          count={count}
          labels={labels}
        />
      )}
    </>
  )
}
