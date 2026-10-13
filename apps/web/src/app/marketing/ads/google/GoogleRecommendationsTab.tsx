'use client'

/**
 * Google Ads step 1b — "Google's recommendations" (R13): Google's suggestions as Google last gave them, with Google's
 * own estimate of what each would add. No totals: two suggestions can promise the same extra conversions, so a sum
 * would count them twice. Nexus applies none of them (`writes.mode` is 'none'); the words say to use Google Ads.
 */
import { useMemo } from 'react'
import { Banner, Card, EmptyState } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { fetchGoogleRecommendations, type GoogleRecommendation, type GoogleRecommendations } from '@/lib/google-ads/contract'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { formatConversions, formatInt, formatMoney, sortable } from './googleAds'
import { NOT_READ_YET, RECOMMENDATIONS_NO_TOTAL, autoAppliedText, impactExtra, readNote, recommendationsNote, signedText } from './googleAttention'
import { googleReadKey, useGoogleRead } from './useGoogleRead'

export function GoogleRecommendationsTab({ account, currency, nextReadAt }: {
  account: string | null
  currency: string | null
  nextReadAt: string | null
}) {
  const recs = useGoogleRead<GoogleRecommendations>(googleReadKey('recommendations', account), () => fetchGoogleRecommendations({ account }), {
    fallbackError: 'Nexus could not load Google’s recommendations.',
  })
  const data = recs.data
  const ccy = data?.currency ?? currency

  const columns = useMemo<GridColumn<GoogleRecommendation>[]>(() => {
    const extra = (r: GoogleRecommendation, key: Parameters<typeof impactExtra>[1]) => impactExtra(r.impact, key)
    return [
      { key: 'campaign', label: 'Campaign', metric: false, sortValue: (r) => r.campaignName?.toLowerCase() ?? null, render: (r) => <span className="gads-camp" title={r.campaignName ?? undefined}>{r.campaignName ?? (r.campaignId ? 'Unnamed campaign' : 'The account')}</span> },
      { key: 'adGroup', label: 'Ad group', metric: false, sortValue: (r) => r.adGroupName?.toLowerCase() ?? null, render: (r) => r.adGroupName ?? '—' },
      {
        key: 'auto', label: 'Applies by itself', metric: false, tip: 'Yes when auto-apply is on for this kind: Google makes the change without asking.',
        sortValue: (r) => (r.autoApplied ? 0 : 1),
        render: (r) => { const a = autoAppliedText(r.autoApplied); return r.autoApplied ? <Pill tone={a.tone} size="sm">{a.text}</Pill> : a.text },
      },
      { key: 'conversions', label: 'Extra conversions', tip: 'Google’s estimate of what this would add.', sortValue: (r) => sortable(extra(r, 'conversions')), render: (r) => signedText(extra(r, 'conversions'), formatConversions) },
      { key: 'value', label: 'Extra conversion value', tip: 'Google’s estimate of what this would add.', sortValue: (r) => sortable(extra(r, 'conversionValueCents')), render: (r) => signedText(extra(r, 'conversionValueCents'), (n) => formatMoney(n, ccy)) },
      { key: 'cost', label: 'Extra cost', tip: 'Google’s estimate of what this would add to the cost.', sortValue: (r) => sortable(extra(r, 'spendCents')), render: (r) => signedText(extra(r, 'spendCents'), (n) => formatMoney(n, ccy)) },
      { key: 'clicks', label: 'Extra clicks', tip: 'Google’s estimate of what this would add.', sortValue: (r) => sortable(extra(r, 'clicks')), render: (r) => signedText(extra(r, 'clicks'), formatInt) },
    ]
  }, [ccy])

  const filters = useMemo<GridFilter[]>(() => [{
    key: 'type', label: 'Recommendation', kind: 'select', placeholder: 'All',
    options: (data?.byType ?? []).map((t) => ({ value: t.type, label: `${t.typeText} (${formatInt(t.count)})` })),
    value: (r) => (r as GoogleRecommendation).type,
  }], [data?.byType])

  if (recs.loading) return <Skeleton height={260} radius="var(--nds-radius-lg)" />
  if (recs.error || !data) {
    return (
      <Banner tone="danger" title="Google’s recommendations could not be loaded" action={<Button onClick={recs.reload}>Try again</Button>}>
        {recs.error ?? 'Nexus answered with nothing it could read.'}
      </Banner>
    )
  }
  const note = readNote(data.read, 'Google’s recommendations', nextReadAt)
  if (!data.read.readAt) {
    return <Card padded><EmptyState title={note?.title ?? NOT_READ_YET} description={note?.text} /></Card>
  }
  return (
    <div className="gads-panel">
      <p className="gads-note">{recommendationsNote(data.read)} {RECOMMENDATIONS_NO_TOTAL}</p>
      {note && <Banner tone={note.tone} title={note.title}>{note.text}</Banner>}
      <AdsDataGrid<GoogleRecommendation>
        rows={data.items}
        rowId={(r) => r.recommendationId}
        noun="Recommendation"
        firstColLabel="Recommendation"
        renderFirst={(r) => (
          <span className="gads-two" title={r.explanation ? `${r.typeText}: ${r.explanation}` : r.typeText}>
            <span>{r.typeText}</span>
            {r.explanation && <span className="gads-sub">{r.explanation}</span>}
          </span>
        )}
        firstSortValue={(r) => r.typeText.toLowerCase()}
        columns={columns}
        filters={filters}
        filtersDefaultOpen={false}
        searchable
        searchPlaceholder="Search recommendations…"
        searchValue={(r) => `${r.typeText} ${r.campaignName ?? ''} ${r.adGroupName ?? ''}`}
        defaultSort={{ key: 'conversions', dir: 'desc' }}
        storageKey="h10-google-recommendations-cols"
        rowHeight={56}
        selectable={false}
        emptyLabel="Google has no recommendations for this account right now."
      />
    </div>
  )
}
