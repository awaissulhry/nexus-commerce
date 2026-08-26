'use client'

/**
 * ⛔ PARKED 2026-08-16 (U1) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: "Activity — the last 30 days of bid writes in this scope", with delivery truth per write.
 * Why it left: the Bid tab is now Helium 10's shape — one rules grid and nothing else
 *   (`BidRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.2, §7.2).
 * Candidate home: Change Log / Analytics — an audit surface, not a rule surface.
 *
 * Nothing here was changed, no endpoint was retired, and the file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BID.S8 — activity: what moved a bid, what refused, what failed.
 *
 * Two blocks, two different records, never mixed into one health figure:
 *
 *   · The CHANGE FEED — `GET /advertising/changes?entityType=AD_TARGET&field=bid`, the same
 *     audit read the S3 drawer plots per target, account-wide. Every row carries who (resolved
 *     origin), old→new, and DELIVERY truth: an enqueued write is not a landed write, and the
 *     2026-07 lesson (nineteen recorded "cuts" on a bid that never moved) is why the Failed chip
 *     exists. Chips count and filter through one predicate on one array, so a chip always
 *     reproduces its own number.
 *
 *   · REFUSALS — `GET /advertising/write-refusals?entityType=AD_TARGET`: writes the gate stopped
 *     BEFORE they became changes. A refusal is not a failure (Amazon never saw it) and not
 *     quiet (it is the brake working); the durable record starts 2026-08-15 and the block says
 *     so, because a zero over a two-day-old record is not evidence of health. The limits that
 *     refuse are OWNED by Automations → Limits — this block links, it does not edit.
 *
 * Scope: the feed is filtered to the page's scoped campaigns client-side (the API's single
 * `campaignId` param cannot express market/portfolio/line), and the count line names the window.
 */
import { useEffect, useMemo, useState } from 'react'
import { FilterChip } from '@/design-system/primitives'
import { DataGrid } from '@/design-system/components'
import Link from 'next/link'
import { Activity, AlertTriangle, ExternalLink, ShieldAlert } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { BidSlotProps } from './slot-contract'

interface FeedRow {
  id: string
  at: string
  source: string
  origin: { kind: string; id: string | null; name: string | null } | null
  entity: { type: string; id: string; name: string | null }
  campaign: { id: string; name: string | null } | null
  oldValue: string | null
  newValue: string | null
  reason: string | null
  delivery: { state: string; attempts: number; lastError: string | null } | null
}
interface RefusalRow {
  id: string; deniedAt: string; reason: string; campaignId: string | null
  entityType: string | null; payloadValueCents: number; createdAt: string
}
interface RefusalsResp {
  recordStarts: string; windowDays: number
  byKind: Array<{ deniedAt: string; count: number }>
  recent: RefusalRow[]
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
const eurFromCents = (v: string | null): string => {
  if (v == null || v === '') return '—'
  const n = Number(v)
  return Number.isFinite(n) ? `€${(n / 100).toFixed(2)}` : v
}

type DeliveryChip = 'all' | 'applied' | 'failed' | 'norecord'
// One vocabulary over two spellings: the changes feed says APPLIED, the per-target history says
// SUCCESS. Anything else with a delivery record is still in flight and stays out of both.
const isApplied = (s: string | undefined) => s === 'APPLIED' || s === 'SUCCESS'
const chipMatch = (r: FeedRow, c: DeliveryChip): boolean =>
  c === 'all' ? true
    : c === 'applied' ? isApplied(r.delivery?.state)
      : c === 'failed' ? r.delivery?.state === 'FAILED'
        : r.delivery == null

const CHIP_LABEL: Record<DeliveryChip, string> = { all: 'All', applied: 'Delivered', failed: 'Failed', norecord: 'No delivery record' }
const CHIP_TITLE: Record<DeliveryChip, string> = {
  all: 'Every audited bid change in the window.',
  applied: 'Amazon confirmed the write.',
  failed: 'Recorded here and never accepted by Amazon — the bid did not move.',
  norecord: 'The audit row has no delivery record — mostly historical writers that never reported back. Unknown, not healthy.',
}

export function BidActivity({ scope, campaigns, loading }: BidSlotProps) {
  const [feed, setFeed] = useState<FeedRow[] | null>(null)
  const [feedErr, setFeedErr] = useState<string | null>(null)
  const [refusals, setRefusals] = useState<RefusalsResp | null>(null)
  const [refErr, setRefErr] = useState<string | null>(null)
  const [chip, setChip] = useState<DeliveryChip>('all')

  useEffect(() => {
    let alive = true
    const qs = new URLSearchParams({ entityType: 'AD_TARGET', field: 'bid', limit: '80' })
    if (scope.campaign) qs.set('campaignId', scope.campaign)
    fetch(`${getBackendUrl()}/api/advertising/changes?${qs}`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => { if (alive) { setFeed((j?.items as FeedRow[]) ?? []); setFeedErr(null) } })
      .catch((e) => { if (alive) setFeedErr((e as Error).message) })
    return () => { alive = false }
  }, [scope.campaign])

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/write-refusals?days=7&entityType=AD_TARGET`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => { if (alive) { setRefusals(j as RefusalsResp); setRefErr(null) } })
      .catch((e) => { if (alive) setRefErr((e as Error).message) })
    return () => { alive = false }
  }, [])

  const narrowed = scope.market !== 'all' || !!scope.portfolio || !!scope.line || !!scope.campaign
  const scopedIds = useMemo(() => new Set(campaigns.map((c) => c.id)), [campaigns])
  const campName = useMemo(() => new Map(campaigns.map((c) => [c.id, c.name])), [campaigns])

  const inScope = useMemo(() => {
    if (feed == null) return null
    // Account-wide scope keeps rows with an unresolvable campaign; a narrowed scope cannot place
    // them and must drop them rather than show another scope's writes under this one's heading.
    return narrowed ? feed.filter((r) => r.campaign != null && scopedIds.has(r.campaign.id)) : feed
  }, [feed, narrowed, scopedIds])

  const counts = useMemo(() => {
    const src = inScope ?? []
    return Object.fromEntries((['all', 'applied', 'failed', 'norecord'] as DeliveryChip[]).map((c) => [c, src.filter((r) => chipMatch(r, c)).length])) as Record<DeliveryChip, number>
  }, [inScope])
  const visible = useMemo(() => (inScope ?? []).filter((r) => chipMatch(r, chip)), [inScope, chip])

  if (loading && feed == null) return null

  return (
    <section id="bid-activity" className="h10-bd8">
      <h3><Activity size={14} aria-hidden /> Activity — the last 30 days of bid writes in this scope</h3>

      {feedErr != null ? (
        <p className="h10-bd8-err" role="alert"><AlertTriangle size={13} aria-hidden /> The change feed failed to load {feedErr} — this is a failed read, not an empty history.</p>
      ) : inScope == null ? (
        <p className="h10-bd8-muted">Loading the change feed…</p>
      ) : inScope.length === 0 ? (
        <p className="h10-bd8-muted">No audited bid write in 30 days in this scope. The nightly floor/restore writes on suppressed targets land outside this scope or this window — an empty feed here says nothing about them.</p>
      ) : (
        <>
          <div className="h10-bd8-chips" role="group" aria-label="Delivery state">
            {(['all', 'applied', 'failed', 'norecord'] as DeliveryChip[]).map((c) => (
              // The count is the DS `count` prop rather than a `<b>` inside the label, so it
              // lands in the chip's own count slot and reads as a facet size, not as part of
              // the words. It moves to the right of the label, which is where every other chip
              // in the console puts it.
              <FilterChip key={c} pressed={chip === c} count={counts[c]} title={CHIP_TITLE[c]} onClick={() => setChip(c)}>
                {CHIP_LABEL[c]}
              </FilterChip>
            ))}
            {feed != null && feed.length >= 80 && <span className="h10-bd8-cap">showing the latest 80 — older writes are in the change log</span>}
          </div>
          <div className="h10-bd8-scroll">
            <DataGrid
              className="h10-bd8-tbl"
              rows={visible.slice(0, 25)}
              rowKey={(r) => r.id}
              rowClassName={(r) => (r.delivery?.state === 'FAILED' ? 'failed' : undefined)}
              columns={[
                { key: 'when', label: 'When', render: (r) => <>{when(r.at)}</> },
                {
                  // A null name is a product/audience target with no text expression — a raw
                  // cuid tells the operator nothing, so say what it IS and keep the id in the
                  // title for correlation.
                  key: 'target', label: 'Target',
                  render: (r) => <span className={r.entity.name ? 't' : 't unnamed'} title={r.entity.id}>{r.entity.name ?? 'unnamed target'}</span>,
                },
                { key: 'campaign', label: 'Campaign', render: (r) => <span className="t">{r.campaign?.name ?? campName.get(r.campaign?.id ?? '') ?? '—'}</span> },
                { key: 'change', label: 'Change', render: (r) => <>{eurFromCents(r.oldValue)} → <b>{eurFromCents(r.newValue)}</b></> },
                { key: 'who', label: 'Who', render: (r) => <span className="t" title={r.reason ?? undefined}>{r.origin?.name ?? (r.source === 'external' ? 'outside Nexus' : r.source)}</span> },
                {
                  key: 'delivered', label: 'Delivered',
                  render: (r) => (r.delivery == null ? <>—</>
                    : isApplied(r.delivery.state) ? <>yes</>
                      : r.delivery.state === 'FAILED' ? <b title={r.delivery.lastError ?? 'Never accepted by Amazon — the bid did not move.'}>no</b>
                        : <>{r.delivery.state.toLowerCase()}</>),
                },
              ]}
            />
          </div>
          {visible.length > 25 && <p className="h10-bd8-muted">…and {visible.length - 25} more in this window — the full feed is on the change log.</p>}
        </>
      )}

      <div className="h10-bd8-ref">
        <h4><ShieldAlert size={13} aria-hidden /> Refusals — writes the gate stopped before Amazon saw them</h4>
        {refErr != null ? (
          <p className="h10-bd8-err" role="alert"><AlertTriangle size={13} aria-hidden /> The refusal record failed to load {refErr}.</p>
        ) : refusals == null ? (
          <p className="h10-bd8-muted">Loading…</p>
        ) : refusals.byKind.length === 0 ? (
          <p className="h10-bd8-muted">No bid write refused in the last {refusals.windowDays} days. The durable record starts {refusals.recordStarts} — a zero here says nothing about before then.</p>
        ) : (
          <>
            <p className="h10-bd8-refline">
              Last {refusals.windowDays} days: {refusals.byKind.map((k) => `${k.count.toLocaleString('en-IE')} × ${k.deniedAt}`).join(' · ')}.
              {' '}A refusal is the brake working, not a failure — nothing reached Amazon.
            </p>
            <ul className="h10-bd8-reflist">
              {refusals.recent.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <span className="nw">{when(r.createdAt)}</span> · <b>{r.deniedAt}</b> · {campName.get(r.campaignId ?? '') ?? r.campaignId ?? 'account'} — <span className="t" title={r.reason}>{r.reason}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="h10-bd8-foot">
          The bounds and ceilings that refuse are set on{' '}
          <Link href="/marketing/ads/rules-automation/automations?view=limits">Automations → Limits <ExternalLink size={11} aria-hidden /></Link>{' '}
          and per campaign in Bounds above — one owner each; this block only reports.
        </p>
        {/* S9 — the between-visits half: this page's failure and refusal events also notify. */}
        <p className="h10-bd8-foot">
          Refusals and terminal write failures also reach the notification bell as they happen —
          identical failures collapse to one unread notice per 6&nbsp;hours, so a storm reads as one line, not a thousand.
        </p>
      </div>
    </section>
  )
}
