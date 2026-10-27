'use client'

/**
 * Reviews Overview — "Needs you": the most urgent things across reviews that wait for a reply, open review alerts and
 * review requests that failed, each with one action (GET /api/reviews/area/needs-you). A filter tile narrows it to one
 * kind and shows a removable chip. The list is read again every 60 s, when a review arrives or turns negative (the
 * live review stream), and when another tab changes a review (OverviewClient). A reply needs "Manage reviews": without
 * it the Reply action is held and says so. An Etsy review is one of the reviews that need a reply (one count); when its
 * 100-day reply window closes soon it says so ("Etsy reply window closes in 4 days") and leads the list, and every Etsy
 * item also opens Etsy.com, where the one reply is posted (Etsy has no reply API).
 */
import { ExternalLink } from 'lucide-react'
import { Card, EmptyState } from '@/design-system/components'
import { Button, Pill, Skeleton, TokenChip } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { insightsHref, needsReplyHref, requestsHref } from '../_lib/reviewsLinks'
import {
  ageWords, NEEDS_WORDS, needsActionHeld, needsActionHref, needsEmptyWords, needsExternal, needsFooter, needsSubtitle,
  type NeedsYouResponse,
} from './overviewModel'
import type { NeedsFilter } from './overviewQuery'
import { SectionError } from './SectionError'
import s from './overview.module.css'

export interface NeedsYouCardProps {
  needs: NeedsYouResponse | null
  error: string | null
  loading: boolean
  show: NeedsFilter | null
  canManage: boolean
  now: number
  /** The Overview's scope: the "All …" links keep it. */
  channel?: string | null
  market?: string | null
  onClearShow: () => void
  onRetry: () => void
}

export function NeedsYouCard({ needs, error, loading, show, canManage, now, channel = null, market = null, onClearShow, onRetry }: NeedsYouCardProps) {
  const shown = needs?.items.length ?? 0
  const total = needs?.total ?? 0
  const footer = needs ? needsFooter(shown, total, show) : ''
  const empty = needsEmptyWords(show)

  return (
    <Card
      className={s.block}
      header="Needs you"
      headingLevel={2}
      description={needs ? needsSubtitle(shown, total, show) : 'Loading…'}
      headerAction={
        <Button asChild variant="link" size="sm">
          <Link href={needsReplyHref({ channel, market })}>Open Inbox</Link>
        </Button>
      }
      padded={false}
    >
      {show && (
        <div className={s.chips} role="group" aria-label="This list shows only">
          <TokenChip onRemove={onClearShow} removeLabel={`Show everything that needs you, not only ${NEEDS_WORDS[show].toLowerCase()}`}>
            {NEEDS_WORDS[show]}
          </TokenChip>
        </div>
      )}
      {error ? (
        <div className={s.pad}>
          <SectionError error={error} onRetry={onRetry} busy={loading} />
        </div>
      ) : !needs ? (
        <div className={s.pad} aria-hidden>
          {[0, 1, 2].map((i) => <Skeleton key={i} height={34} className={s.skeletonRow} />)}
        </div>
      ) : (
        <>
          {needs.items.length === 0 ? (
            <EmptyState title={empty.title} description={empty.description} />
          ) : (
            <ul className={s.needsList} aria-label="Things that need you, most urgent first">
              {needs.items.map((item) => {
                const held = needsActionHeld(item, canManage)
                const external = needsExternal(item)
                return (
                  <li key={`${item.kind}:${item.id}`} className={s.needsItem}>
                    <Pill tone={item.tone} className={s.needsPill}>{item.label}</Pill>
                    <span className={s.needsBody}>
                      <span className={s.needsTitle}>{item.title}</span>
                      <span className={s.needsDetail}>{item.detail}</span>
                    </span>
                    {external && (
                      <Button asChild variant="link" size="sm">
                        <a href={external.href} target="_blank" rel="noopener noreferrer" aria-label={`${external.label} (opens a new tab)`}>
                          {external.label} <ExternalLink size={11} aria-hidden />
                        </a>
                      </Button>
                    )}
                    <span className={s.needsAge}>{ageWords(item.at, now)}</span>
                    {held ? (
                      <Button size="sm" className={s.needsAction} heldReason={held}>{item.action.label}</Button>
                    ) : (
                      <Button asChild size="sm" className={s.needsAction}>
                        <Link href={needsActionHref(item.action)}>{item.action.label}</Link>
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <div className={s.needsFoot}>
            <span className={s.grow}>{footer}</span>
            <Button asChild variant="link" size="sm"><Link href={needsReplyHref({ channel, market })}>All reviews that need a reply</Link></Button>
            <Button asChild variant="link" size="sm"><Link href={insightsHref('alerts', { channel, market })}>All alerts</Link></Button>
            <Button asChild variant="link" size="sm"><Link href={requestsHref({ channel, market })}>All requests</Link></Button>
          </div>
        </>
      )}
    </Card>
  )
}
