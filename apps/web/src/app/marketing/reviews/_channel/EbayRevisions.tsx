'use client'

/**
 * Reviews › eBay — feedback revision requests (PR G, eBay's REST Feedback API): the feedback whose eBay state is a
 * revision (waiting for the buyer, revised, said no or expired) and the neutral or negative feedback eBay says can still
 * be asked about, each opening the Inbox's review pop-up; eBay's rules and yearly allowance in words. eBay has no API to
 * ask for a revision, so "Ask in Seller Hub" opens eBay Seller Hub in a new tab, and the card says so.
 */
import { ExternalLink } from 'lucide-react'
import { Card, EmptyState } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { inboxHref } from '../_lib/reviewsLinks'
import { SectionError } from '../_overview/SectionError'
import { sectionData, sectionError, sellerHubHref, type EbaySections } from './channelModel'
import { revisionSummary, revisionView } from './ebayToolsModel'
import { lockParams, type ReviewsLock } from './reviewsScope'
import s from './channel.module.css'

export const REVISIONS_ID = 'ebay-revision-requests'

export function EbayRevisions({ lock, sections, busy, onRetry }: { lock: ReviewsLock; sections: EbaySections; busy: boolean; onRetry: () => void }) {
  const data = sectionData(sections.revisions)
  const error = sectionError(sections.revisions)
  const market = lockParams(lock).market
  const hub = sellerHubHref(market)

  return (
    <section id={REVISIONS_ID} aria-label="Feedback revision requests">
      <Card
        header="Feedback revision requests"
        headingLevel={2}
        description={data ? `${data.rule} ${revisionSummary(data)}.` : 'eBay’s revision requests, from eBay’s feedback read'}
        headerAction={(
          <Button asChild size="sm">
            <a href={hub} target="_blank" rel="noopener noreferrer">Open eBay Seller Hub <ExternalLink size={12} aria-hidden /></a>
          </Button>
        )}
      >
        {error ? (
          <SectionError error={error} onRetry={onRetry} busy={busy} />
        ) : !data ? (
          sections.revisions ? <Skeleton height={120} /> : <p className={s.note}>Revision requests show once the page is read again.</p>
        ) : (
          <div className={s.stackGap}>
            {data.words && <p className={s.note}>{data.words}</p>}
            {data.rows.length === 0 ? (
              <EmptyState title="No revision requests" description="Neutral or negative feedback under 30 days old that eBay lets you ask about shows here, and every request with the buyer’s answer." />
            ) : (
              <ul className={s.itemList} aria-label="Revision requests">
                {data.rows.map((row) => {
                  const v = revisionView(row)
                  return (
                    <li key={v.key} className={s.itemRow}>
                      <span className={s.stack}>
                        <Link className={s.cellLink} href={inboxHref({ channel: 'EBAY', market: row.market, review: row.id })}>{v.who}</Link>
                        <span className={s.sub}>{v.what}</span>
                        {v.note && <span className={s.sub}>{v.note}</span>}
                      </span>
                      <Pill tone={v.pill.tone}>{v.pill.words}</Pill>
                      {v.canAsk && (
                        <Button asChild size="sm">
                          <a href={hub} target="_blank" rel="noopener noreferrer" aria-label={`Ask ${v.who} for a revision in eBay Seller Hub (opens a new tab)`}>
                            Ask in Seller Hub <ExternalLink size={12} aria-hidden />
                          </a>
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            <p className={s.note}>{data.allowance.words}</p>
            <p className={s.note}>{data.noApi} {data.tip}</p>
          </div>
        )}
      </Card>
    </section>
  )
}
