'use client'
import { Card } from '@/design-system/components/Card'
import { Banner } from '@/design-system/components/Banner'
import { Button } from '@/design-system/primitives/Button'
import { Tag } from '@/design-system/primitives/Tag'
import Link from '@/lib/workspaces/Link'
import { productWorkspaceHref } from '@/app/_shared/product-workspace-href'
import { listingIssueSeverityLabel, listingIssueSourceLabel } from './listingIssueSource'
import { useListingIssues } from './useListingIssues'
import './listing-issues.css'

const timestamp = (value: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC' }).format(new Date(value))

export function ListingIssuesCard({ connectionId, workspaceId }: { connectionId: string; workspaceId?: string | null }) {
  const { page, busy, error, reload, loadMore } = useListingIssues(connectionId, workspaceId)
  return (
    <Card header="Saved listing issues" headingLevel={2} role="region" aria-label="Saved listing issues"
      description="Open findings recorded for this account in this business profile. Channel changes may not be recorded yet."
      headerAction={<Button size="sm" aria-disabled={busy || undefined} onClick={() => !busy && void reload()}>Refresh saved issues</Button>}>
      <div className="cx-listing-issues" aria-busy={busy}>
        {error && <Banner tone="danger" title="Saved issues unavailable">{error}{page ? ' Previously loaded findings remain below.' : ''}</Banner>}
        <p role="status" aria-live="polite">
          {busy ? 'Loading saved issues…' : page ? `${page.items.length} open ${page.items.length === 1 ? 'issue' : 'issues'} shown.` : error ? 'No current reading available.' : 'Select a business profile to read saved issues.'}
        </p>
        {page && <p className="cx-listing-issues-meta">Read <time dateTime={page.readAt}>{timestamp(page.readAt)}</time>. Refresh to include findings added or updated during pagination.</p>}
        {page && !page.items.length && <p>No open issues are recorded for this account in this business profile. This does not confirm the channel’s current listing health.</p>}
        {!!page?.items.length && <ol className="cx-listing-issues-list">
          {page.items.map(issue => <li key={issue.id}>
            <div className="cx-listing-issues-labels">
              <strong><Button asChild inline wrap variant="link"><Link href={`/products/${encodeURIComponent(issue.productId)}/edit`}>{issue.productSku}</Link></Button></strong>
              <Tag>{issue.marketplace}</Tag>
              <Tag tone={issue.severity === 'ERROR' ? 'danger' : issue.severity === 'WARNING' ? 'warning' : 'neutral'}>{listingIssueSeverityLabel(issue.severity)}</Tag>
            </div>
            <p className="cx-listing-issues-message">{issue.message}</p>
            {!!issue.attributeNames.length && <p>Attributes: {issue.attributeNames.join(', ')}</p>}
            <p className="cx-listing-issues-meta">Reported by {listingIssueSourceLabel(issue.source)} <span className="cx-listing-issues-code">· issue code {issue.code}</span> · Last recorded <time dateTime={issue.lastSeenAt}>{timestamp(issue.lastSeenAt)}</time></p>
            <p className="cx-listing-issues-meta">{issue.occurredAt ? <>Channel time: <time dateTime={issue.occurredAt}>{timestamp(issue.occurredAt)}</time></> : 'Channel time was not supplied.'}</p>
            {/* The listing's own workspace: this account, channel and marketplace (the route the listings grid opens). */}
            <div><Button asChild inline variant="link"><Link aria-label={`Open listing ${issue.productSku} on ${issue.marketplace}`}
              href={productWorkspaceHref({ productId: issue.productId, id: issue.listingId, channel: page.channel, marketplace: issue.marketplace, channelConnectionId: page.connectionId })}>Open listing</Link></Button></div>
          </li>)}
        </ol>}
        {!!page?.items.length && <div><Button size="sm" aria-disabled={busy || !page.nextCursor || undefined} onClick={() => !busy && !!page.nextCursor && void loadMore()}>
          {page.nextCursor ? 'Load more saved issues' : 'All recorded issues loaded'}
        </Button></div>}
      </div>
    </Card>
  )
}
