'use client'

/**
 * Google Ads step 1b — "Disapprovals" (R15): the ads Google disapproved or shows only in part, and the products Google
 * will not show or limits, with Google's own reasons. Lists of words, so no totals. Each list is "Not read yet" until
 * Nexus read it; a list cut at its cap says so. Read only: the fix is made in Google Ads or Merchant Center.
 */
import { useMemo } from 'react'
import { Banner, Card, EmptyState } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { fetchGoogleDisapprovals, type GoogleAdIssue, type GoogleDisapprovals, type GoogleProductIssue } from '@/lib/google-ads/contract'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { formatDay } from './googleAds'
import {
  DISAPPROVALS_INTRO,
  DISAPPROVALS_TRUNCATED,
  NOT_READ_YET,
  adIssueStatus,
  codeWords,
  productIssueStatus,
  readNote,
  reasonsText,
} from './googleAttention'
import { productIssuesText } from './googleGrains'
import { googleReadKey, useGoogleRead } from './useGoogleRead'

/** R15 for one account, shared through the read cache. */
export function useGoogleDisapprovals(account: string | null, enabled = true) {
  return useGoogleRead<GoogleDisapprovals>(enabled ? googleReadKey('disapprovals', account) : null, () => fetchGoogleDisapprovals({ account }), {
    fallbackError: 'Nexus could not load the disapprovals.',
  })
}

export function GoogleDisapprovalsTab({ account, nextReadAt }: { account: string | null; nextReadAt: string | null }) {
  const res = useGoogleDisapprovals(account)
  const data = res.data

  if (res.loading) return <Skeleton height={260} radius="var(--nds-radius-lg)" />
  if (res.error || !data) {
    return (
      <Banner tone="danger" title="The disapprovals could not be loaded" action={<Button onClick={res.reload}>Try again</Button>}>
        {res.error ?? 'Nexus answered with nothing it could read.'}
      </Banner>
    )
  }
  return (
    <div className="gads-panel">
      <p className="gads-note">{DISAPPROVALS_INTRO}</p>
      {data.truncated && <Banner tone="warning">{DISAPPROVALS_TRUNCATED}</Banner>}
      <AdIssues data={data} nextReadAt={nextReadAt} />
      <ProductIssues data={data} nextReadAt={nextReadAt} />
    </div>
  )
}

function NotRead({ note }: { note: ReturnType<typeof readNote> }) {
  return <Card padded><EmptyState title={note?.title ?? NOT_READ_YET} description={note?.text} /></Card>
}

function AdIssues({ data, nextReadAt }: { data: GoogleDisapprovals; nextReadAt: string | null }) {
  const columns = useMemo<GridColumn<GoogleAdIssue>[]>(() => [
    { key: 'status', label: 'Status', metric: false, sortValue: (r) => (r.status === 'DISAPPROVED' ? 0 : 1), render: (r) => { const s = adIssueStatus(r.status); return <Pill tone={s.tone} size="sm">{s.text}</Pill> } },
    { key: 'campaign', label: 'Campaign', metric: false, sortValue: (r) => r.campaignName?.toLowerCase() ?? null, render: (r) => <span className="gads-camp" title={r.campaignName ?? undefined}>{r.campaignName ?? '—'}</span> },
    { key: 'adGroup', label: 'Ad group', metric: false, sortValue: (r) => r.adGroupName?.toLowerCase() ?? null, render: (r) => r.adGroupName ?? '—' },
    { key: 'reasons', label: 'Google’s reasons', metric: false, sortValue: (r) => reasonsText(r.reasons), render: (r) => <span className="gads-clip" title={reasonsText(r.reasons)}>{reasonsText(r.reasons)}</span> },
    { key: 'review', label: 'Review', metric: false, sortValue: (r) => r.reviewStatus, render: (r) => codeWords(r.reviewStatus) },
    { key: 'since', label: 'Seen since', metric: false, sortValue: (r) => r.since, render: (r) => formatDay(r.since) },
  ], [])
  const filters = useMemo<GridFilter[]>(() => [{
    key: 'status', label: 'Status', kind: 'select', placeholder: 'All',
    options: (['DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY'] as const).map((s) => ({ value: s, label: adIssueStatus(s).text })),
    value: (r) => (r as GoogleAdIssue).status,
  }], [])
  const note = readNote(data.read.ads, 'the ads’ review status', nextReadAt)
  return (
    <section className="gads-section" aria-labelledby="gads-adissues-h">
      <h3 id="gads-adissues-h">Ads</h3>
      {!data.read.ads.readAt ? <NotRead note={note} /> : (
        <>
          {note && <Banner tone={note.tone} title={note.title}>{note.text}</Banner>}
          <AdsDataGrid<GoogleAdIssue>
            rows={data.ads}
            rowId={(r) => r.adId}
            noun="Ad"
            firstColLabel="Ad"
            renderFirst={(r) => (
              <span className="gads-two" title={r.adType ? codeWords(r.adType) : 'Ad'}>
                <span>{r.adType ? codeWords(r.adType) : 'Ad'}</span>
                <span className="gads-sub">Ad ID {r.externalAdId}</span>
              </span>
            )}
            firstSortValue={(r) => (r.adType ?? '').toLowerCase()}
            columns={columns}
            filters={filters}
            filtersDefaultOpen={false}
            defaultSort={{ key: 'status', dir: 'asc' }}
            storageKey="h10-google-ad-issues-cols"
            rowHeight={56}
            selectable={false}
            emptyLabel="Google reported no disapproved or limited ads."
          />
        </>
      )}
    </section>
  )
}

/** A product row: Google can report one item id in several feeds or countries, so the row id is its place in the list. */
type ProductRow = GoogleProductIssue & { rowKey: string }

function ProductIssues({ data, nextReadAt }: { data: GoogleDisapprovals; nextReadAt: string | null }) {
  const rows = useMemo<ProductRow[]>(() => data.products.map((p) => ({ ...p, rowKey: p.productKey })), [data.products])
  const columns = useMemo<GridColumn<ProductRow>[]>(() => [
    { key: 'status', label: 'Status', metric: false, sortValue: (r) => (r.status === 'not_eligible' ? 0 : 1), render: (r) => { const s = productIssueStatus(r.status); return <Pill tone={s.tone} size="sm">{s.text}</Pill> } },
    {
      key: 'issues', label: 'Google’s reasons', metric: false, sortValue: (r) => productIssuesText(r),
      render: (r) => {
        const lines = productIssuesText(r)?.split('\n') ?? []
        const help = r.issues.find((i) => i.helpUrl)?.helpUrl
        return (
          <span className="gads-status" title={lines.join('\n') || undefined}>
            <span className="gads-clip">{lines[0] ?? '—'}</span>
            {lines.length > 1 && <span className="gads-dim">+{lines.length - 1} more</span>}
            {help && <Button asChild variant="link" inline><a href={help} target="_blank" rel="noopener noreferrer">Google’s help</a></Button>}
          </span>
        )
      },
    },
    { key: 'since', label: 'Seen since', metric: false, sortValue: (r) => r.since, render: (r) => formatDay(r.since) },
  ], [])
  const note = readNote(data.read.products, 'the products’ status in Merchant Center', nextReadAt)
  return (
    <section className="gads-section" aria-labelledby="gads-productissues-h">
      <h3 id="gads-productissues-h">Products</h3>
      {!data.read.products.readAt ? <NotRead note={note} /> : (
        <>
          {note && <Banner tone={note.tone} title={note.title}>{note.text}</Banner>}
          <AdsDataGrid<ProductRow>
            rows={rows}
            rowId={(r) => r.rowKey}
            noun="Product"
            firstColLabel="Product"
            renderFirst={(r) => (
              <span className="gads-two" title={r.title ?? r.itemId}>
                <span>{r.title?.trim() || r.itemId}</span>
                <span className="gads-sub">Item ID {r.itemId}</span>
              </span>
            )}
            firstSortValue={(r) => (r.title ?? r.itemId).toLowerCase()}
            searchable
            searchPlaceholder="Search products…"
            searchValue={(r) => `${r.title ?? ''} ${r.itemId}`}
            columns={columns}
            defaultSort={{ key: 'status', dir: 'asc' }}
            storageKey="h10-google-product-issues-cols"
            rowHeight={56}
            selectable={false}
            emptyLabel="Google reported no products it will not show."
          />
        </>
      )}
    </section>
  )
}
