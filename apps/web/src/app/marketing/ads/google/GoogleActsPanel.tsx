'use client'

/**
 * Google Ads step 1b — "Google acts on its own" (R12): where Google can change the account without asking, and what it
 * changed. Two surfaces over one read (shared through the read cache):
 *   - `GoogleActsCard`, the summary card at the top of the page: auto-apply, widening settings, changes by Google;
 *   - `GoogleActsPanel`, the tab: the auto-apply grid, the widening-settings grid (one row per campaign) and the grid of
 *     changes made outside Nexus.
 * A part Nexus has not read says "Not read yet", never "Off". Read only: every switch here is Google's, and the words
 * say where to change it in Google Ads.
 */
import { useMemo } from 'react'
import { Banner, Card, EmptyState, KeyValue } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { fetchGoogleActsOnItsOwn, type GoogleActsOnItsOwn, type GoogleCampaignAutomation } from '@/lib/google-ads/contract'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { campaignTypeLabel, formatDay, formatInt, formatMoment } from './googleAds'
import {
  ACTS_INTRO,
  AUTO_APPLY_NONE,
  AUTO_APPLY_TEXT,
  CHANGES_OUTSIDE_TEXT,
  EDITOR_NOTE,
  NOT_READ_YET,
  WIDENING_TEXT,
  actsSummary,
  autoApplyRows,
  outsideChangeRows,
  outsideChangesNote,
  readNote,
  wideningCampaigns,
  wideningCell,
  wideningOn,
  wideningTotal,
  type AutoApplyRow,
  type ChangeRowView,
} from './googleAttention'
import { ACTS_FLAGS } from './googleGrains'
import { googleReadKey, useGoogleRead } from './useGoogleRead'

/** R12 for one account, shared by the card and the tab. */
export function useGoogleActs(account: string | null, enabled = true) {
  return useGoogleRead<GoogleActsOnItsOwn>(enabled ? googleReadKey('acts-on-its-own', account) : null, () => fetchGoogleActsOnItsOwn({ account }), {
    fallbackError: 'Nexus could not load what Google changes by itself.',
  })
}

const CARD_LIST_MAX = 3

/** Up to three short lines under a summary line (the rest is on the tab), or nothing. */
function CardList({ lines, more }: { lines: string[]; more: number }) {
  if (!lines.length) return null
  return (
    <ul className="gads-acts-list">
      {lines.map((line, i) => <li key={i} className="gads-sub">{line}</li>)}
      {more > 0 && <li className="gads-sub">and {formatInt(more)} more on the tab</li>}
    </ul>
  )
}

/** What the card shows under each line: the auto-apply kinds that are on, the campaigns with a widening setting on, and
 * Google's own newest changes. */
function cardDetails(a: GoogleActsOnItsOwn) {
  const kinds = (a.autoApply?.enabled ?? []).map((k) => k.typeText)
  const widened = wideningCampaigns(a.campaigns).filter((c) => (wideningOn(c) ?? 0) > 0).map((c) => c.name)
  const byGoogle = a.outsideChanges.items.filter((c) => c.source === 'google_automatic')
    .map((c) => `${formatDay(c.changedAt)} · ${c.campaignName ?? 'The account'} · ${c.summary}`)
  const cut = (all: string[]) => ({ lines: all.slice(0, CARD_LIST_MAX), more: Math.max(0, all.length - CARD_LIST_MAX) })
  return { kinds: cut(kinds), widened: cut(widened), byGoogle: cut(byGoogle) }
}

/** The summary card: three lines, a few details under each, and the way to the tab. */
export function GoogleActsCard({ account, onSeeAll }: { account: string | null; onSeeAll: () => void }) {
  const acts = useGoogleActs(account)
  const s = acts.data ? actsSummary(acts.data) : null
  const d = acts.data ? cardDetails(acts.data) : null
  return (
    <Card header="Google acts on its own" description="Where Google can change your campaigns without asking." className="gads-card" headingLevel={2}
      headerAction={<Button size="sm" onClick={onSeeAll}>See all</Button>}>
      {acts.loading && <Skeleton height={96} radius="var(--nds-radius-lg)" />}
      {acts.error && (
        <Banner tone="danger" title="This could not be loaded" action={<Button size="sm" onClick={acts.reload}>Try again</Button>}>
          {acts.error}
        </Banner>
      )}
      {s && d && (
        <KeyValue dense labelCase="sentence" items={[
          { label: 'Auto-apply', value: <><Pill tone={s.autoApply.tone} size="sm">{s.autoApply.text}</Pill><CardList {...d.kinds} /></> },
          { label: 'Widening settings', value: <><Pill tone={s.widening.tone} size="sm">{s.widening.text}</Pill><CardList {...d.widened} /></> },
          { label: 'Changes by Google', value: <><Pill tone={s.changes.tone} size="sm">{s.changes.text}</Pill><CardList {...d.byGoogle} /></> },
        ]} />
      )}
    </Card>
  )
}

/** The tab: auto-apply, widening settings per campaign, and the changes made outside Nexus. */
export function GoogleActsPanel({ account, nextReadAt, onOpenCampaign }: {
  account: string | null
  nextReadAt: string | null
  /** Opens a campaign's window on one of its tabs. */
  onOpenCampaign: (campaignId: string, tab: string) => void
}) {
  const acts = useGoogleActs(account)
  const data = acts.data

  if (acts.loading) return <Skeleton height={260} radius="var(--nds-radius-lg)" />
  if (acts.error || !data) {
    return (
      <Banner tone="danger" title="This could not be loaded" action={<Button onClick={acts.reload}>Try again</Button>}>
        {acts.error ?? 'Nexus answered with nothing it could read.'}
      </Banner>
    )
  }
  return (
    <div className="gads-panel">
      <p className="gads-note">{ACTS_INTRO}</p>
      <AutoApplySection data={data} nextReadAt={nextReadAt} />
      <WideningSection data={data} nextReadAt={nextReadAt} onOpenCampaign={onOpenCampaign} />
      <ChangesSection data={data} />
    </div>
  )
}

function ReadState({ note }: { note: ReturnType<typeof readNote> }) {
  if (!note) return null
  return <Banner tone={note.tone === 'info' ? 'info' : note.tone} title={note.title}>{note.text}</Banner>
}

function AutoApplySection({ data, nextReadAt }: { data: GoogleActsOnItsOwn; nextReadAt: string | null }) {
  const rows = useMemo(() => autoApplyRows(data.autoApply), [data.autoApply])
  const columns = useMemo<GridColumn<AutoApplyRow>[]>(() => [
    { key: 'state', label: 'State', metric: false, sortValue: (r) => (r.on ? 0 : 1), render: (r) => <Pill tone={r.on ? 'warning' : 'neutral'} size="sm">{r.state}</Pill> },
    { key: 'since', label: 'Since', metric: false, sortValue: (r) => r.since, render: (r) => formatDay(r.since) },
    { key: 'changed', label: 'Last changed in Google Ads', metric: false, sortValue: (r) => r.changedAt, render: (r) => formatMoment(r.changedAt) ?? '—' },
  ], [])
  const note = readNote(data.read.autoApply, 'auto-apply', nextReadAt)
  return (
    <section className="gads-section" aria-labelledby="gads-autoapply-h">
      <h3 id="gads-autoapply-h">Auto-apply</h3>
      <p className="gads-meta">{AUTO_APPLY_TEXT}</p>
      {!data.autoApply ? (
        <Card padded><EmptyState title={note?.title ?? NOT_READ_YET} description={note?.text} /></Card>
      ) : (
        <>
          <ReadState note={note} />
          {data.autoApply.enabled.length === 0 && <p className="gads-note">{AUTO_APPLY_NONE}</p>}
          {rows.length > 0 && (
            <AdsDataGrid<AutoApplyRow>
              rows={rows}
              rowId={(r) => r.id}
              noun="Kind"
              firstColLabel="Kind of recommendation"
              renderFirst={(r) => <span className="gads-camp" title={r.kind}>{r.kind}</span>}
              firstSortValue={(r) => r.kind.toLowerCase()}
              columns={columns}
              defaultSort={{ key: '__first', dir: 'asc' }}
              enabledFirst={(r) => r.on}
              storageKey="h10-google-auto-apply-cols"
              selectable={false}
              emptyLabel={AUTO_APPLY_NONE}
            />
          )}
        </>
      )}
    </section>
  )
}

function countText(v: number | null, read: boolean): string {
  if (v == null) return read ? '—' : NOT_READ_YET
  return formatInt(v)
}

function WideningSection({ data, nextReadAt, onOpenCampaign }: { data: GoogleActsOnItsOwn; nextReadAt: string | null; onOpenCampaign: (campaignId: string, tab: string) => void }) {
  const rows = useMemo(() => wideningCampaigns(data.campaigns), [data.campaigns])
  const adGroupsRead = data.read.adGroups.readAt != null
  const negativesRead = data.read.campaignNegatives.readAt != null
  const columns = useMemo<GridColumn<GoogleCampaignAutomation>[]>(() => [
    { key: 'type', label: 'Type', metric: false, sortValue: (r) => campaignTypeLabel(r.type), render: (r) => campaignTypeLabel(r.type) },
    {
      key: 'on', label: 'Settings on', tip: 'How many of the settings to the right are on for this campaign.',
      sortValue: (r) => wideningOn(r),
      render: (r) => { const n = wideningOn(r); return n == null ? NOT_READ_YET : formatInt(n) },
      total: (vr) => `On in ${formatInt(vr.filter((r) => (wideningOn(r) ?? 0) > 0).length)}`,
    },
    ...ACTS_FLAGS.map((f): GridColumn<GoogleCampaignAutomation> => ({
      key: f.key, label: f.label, tip: f.tip, metric: false,
      sortValue: (r) => (!r.flagsReadAt || r[f.key] == null ? null : r[f.key] === 'on' ? 0 : r[f.key] === 'off' ? 1 : 2),
      render: (r) => { const w = wideningCell(r, f.key); return w.tone === 'warning' ? <Pill tone={w.tone} size="sm">{w.text}</Pill> : w.text },
      total: (vr) => wideningTotal(vr, f.key),
    })),
    {
      key: 'searchTermMatching', label: 'Ad groups without search term matching',
      tip: 'With AI Max on, the ad groups where Google does not look for new searches.',
      sortValue: (r) => r.adGroupsWithoutSearchTermMatching,
      render: (r) => countText(r.adGroupsWithoutSearchTermMatching, adGroupsRead),
    },
    {
      key: 'brandExclusions', label: 'Brand exclusions',
      tip: 'Brand lists this campaign keeps its ads away from (Performance Max).',
      sortValue: (r) => r.brandExclusions,
      render: (r) => countText(r.brandExclusions, negativesRead),
    },
    { key: 'movedToAiMax', label: 'Moved to AI Max', metric: false, sortValue: (r) => r.movedToAiMaxAt, render: (r) => (r.movedToAiMaxAt ? formatDay(r.movedToAiMaxAt) : '—') },
    { key: 'read', label: 'Settings read', metric: false, sortValue: (r) => r.flagsReadAt, render: (r) => formatMoment(r.flagsReadAt) ?? NOT_READ_YET },
  ], [adGroupsRead, negativesRead])
  const note = readNote(data.read.settings, 'the campaign settings', nextReadAt)
  const neverRead = !data.read.settings.readAt && rows.every((r) => !r.flagsReadAt)
  return (
    <section className="gads-section" aria-labelledby="gads-widening-h">
      <h3 id="gads-widening-h">Widening settings</h3>
      <p className="gads-meta">{WIDENING_TEXT} Open a campaign to see it in full.</p>
      {neverRead ? (
        <Card padded><EmptyState title={note?.title ?? NOT_READ_YET} description={note?.text} /></Card>
      ) : (
        <>
          <ReadState note={note} />
          <AdsDataGrid<GoogleCampaignAutomation>
            rows={rows}
            rowId={(r) => r.campaignId}
            noun="Campaign"
            firstColLabel="Campaign"
            renderFirst={(r) => <span className="gads-camp" title={r.name}>{r.name}</span>}
            firstSortValue={(r) => r.name.toLowerCase()}
            columns={columns}
            searchable
            searchPlaceholder="Search campaigns…"
            searchValue={(r) => r.name}
            showTotal
            totalFirst="Campaigns shown"
            defaultSort={{ key: 'on', dir: 'desc' }}
            storageKey="h10-google-widening-cols"
            onRowClick={(r) => onOpenCampaign(r.campaignId, 'on-its-own')}
            selectable={false}
            keyboardNav
            emptyLabel="Google reported no campaigns for this account."
          />
        </>
      )}
    </section>
  )
}

function ChangesSection({ data }: { data: GoogleActsOnItsOwn }) {
  const o = data.outsideChanges
  const rows = useMemo(() => outsideChangeRows(o.items), [o.items])
  const columns = useMemo<GridColumn<ChangeRowView>[]>(() => [
    { key: 'campaign', label: 'Campaign', metric: false, sortValue: (r) => r.campaign.toLowerCase(), render: (r) => <span className="gads-camp" title={r.campaign}>{r.campaign}</span> },
    { key: 'who', label: 'Made by', metric: false, sortValue: (r) => r.who, render: (r) => r.who },
    { key: 'madeIn', label: 'Made in', metric: false, sortValue: (r) => r.madeIn, render: (r) => r.madeIn },
    {
      key: 'what', label: 'What changed', metric: false, sortValue: (r) => r.what,
      render: (r) => (
        <span className="gads-status">
          <span>{r.what}</span>
          {r.watched && <Pill tone="info" size="sm">Watched setting</Pill>}
        </span>
      ),
    },
  ], [])
  const filters = useMemo<GridFilter[]>(() => {
    const opts = (values: string[]) => [...new Set(values)].sort().map((v) => ({ value: v, label: v }))
    return [
      { key: 'who', label: 'Made by', kind: 'select', options: opts(rows.map((r) => r.who)), placeholder: 'All', value: (r) => (r as ChangeRowView).who },
      { key: 'madeIn', label: 'Made in', kind: 'select', options: opts(rows.map((r) => r.madeIn)), placeholder: 'All', value: (r) => (r as ChangeRowView).madeIn },
    ]
  }, [rows])
  return (
    <section className="gads-section" aria-labelledby="gads-outside-h">
      <h3 id="gads-outside-h">Changes made outside Nexus</h3>
      <p className="gads-meta">{CHANGES_OUTSIDE_TEXT} {EDITOR_NOTE}</p>
      <p className="gads-meta">{outsideChangesNote(o)}</p>
      {o.coveredThrough && (
        <AdsDataGrid<ChangeRowView>
          rows={rows}
          rowId={(r) => r.id}
          noun="Change"
          firstColLabel="When"
          renderFirst={(r) => r.when}
          firstSortValue={(r) => r.at}
          columns={columns}
          filters={filters}
          filtersDefaultOpen={false}
          searchable
          searchPlaceholder="Search changes…"
          searchValue={(r) => `${r.campaign} ${r.what}`}
          defaultSort={{ key: '__first', dir: 'desc' }}
          storageKey="h10-google-outside-changes-cols"
          selectable={false}
          emptyLabel="No changes outside Nexus in the span Nexus has read."
        />
      )}
    </section>
  )
}
