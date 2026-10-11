'use client'

import type { ComponentType, MouseEventHandler, ReactNode } from 'react'
import NextLink from 'next/link'

import { DetailPopover } from './DetailPopover'
import { entityLinksView, entityMoreWords, type EntityNoun, type EntityRef } from './entityLinksModel'

/** The host's link. The web app passes its workspace `Link` (it keeps the `/w/<id>` prefix); default Next's `Link`. */
export type EntityLinkComponent = ComponentType<{
  href: string
  className?: string
  title?: string
  children?: ReactNode
  onClick?: MouseEventHandler<HTMLAnchorElement>
}>

export interface EntityLinksProps {
  items: ReadonlyArray<EntityRef> | null | undefined
  /** The true count when `items` is capped (polish round 2): the chip says "153 campaigns" over 100 links, and the list
   *  ends "53 more not listed". Default: how many `items` there are. */
  total?: number | null
  /** `{ one: 'campaign', many: 'campaigns' }`. */
  noun: EntityNoun
  linkAs?: EntityLinkComponent
  /** The list's accessible name: "Campaigns of Rule A". Default the count ("3 campaigns"). */
  listLabel?: string
  /** Where focus goes when Esc closes the list. Default the count; a grid passes its cell. */
  returnFocus?: () => void
  className?: string
}

/**
 * What a row works on, as links (bid page DS lane, 2026-10-10): none → a muted dash named "No campaigns"; one → its name,
 * a real link (open in a new tab works); several → a count chip ("3 campaigns") that opens a small list of links — the
 * DS `DetailPopover`, so click, Enter and Space open it, Tab stays inside, Esc closes it and gives the focus back. A thing
 * without an `href` is its name without a link. Words: `entityLinksModel.ts`.
 */
export function EntityLinks({ items, total, noun, linkAs, listLabel, returnFocus, className }: EntityLinksProps) {
  const Link = linkAs ?? NextLink
  const view = entityLinksView(items, noun, total)
  const cls = ['nds-entitylinks', className ?? ''].filter(Boolean).join(' ')
  if (view.kind === 'none') return <span className={`${cls} is-none`} role="img" aria-label={view.label}>—</span>
  if (view.kind === 'one') {
    const { item } = view
    return (
      <span className={cls}>
        {item.href
          ? <Link href={item.href} className="nds-entitylink" title={item.name}>{item.name}</Link>
          : <span className="nds-entitylink is-plain" title={item.name}>{item.name}</span>}
      </span>
    )
  }
  return (
    <span className={cls}>
      <DetailPopover
        trigger={view.words}
        triggerLabel={`${view.words}: show the list`}
        triggerClassName="nds-entitylinks-count"
        label={listLabel ?? view.words}
        hoverDelay={0}
        returnFocus={returnFocus}
        panelClassName="nds-detailpop-scroll"
      >
        {({ close }) => (
          <ul className="nds-entitylinks-list">
            {view.items.map((item) => (
              <li key={item.id}>
                {item.href
                  ? <Link href={item.href} className="nds-entitylink" title={item.name} onClick={() => close()}>{item.name}</Link>
                  : <span className="nds-entitylink is-plain" title={item.name}>{item.name}</span>}
              </li>
            ))}
            {view.more > 0 && <li className="nds-entitylinks-more">{entityMoreWords(view.more)}</li>}
          </ul>
        )}
      </DetailPopover>
    </span>
  )
}
