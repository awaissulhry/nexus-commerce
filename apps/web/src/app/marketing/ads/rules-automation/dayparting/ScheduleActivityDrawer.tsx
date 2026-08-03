'use client'

/**
 * RDX/A4 — what a rank schedule actually DID, hour by hour.
 *
 * The page could previously tell you a schedule was "Active" and nothing else. This drawer is the
 * receipt: every bid/placement change the schedule asked for, and — separately — whether that
 * change reached Amazon. Those are two different facts, and conflating them is exactly how a
 * schedule looks healthy while its writes dead-letter.
 *
 * Data comes from GET /advertising/rank-schedule-groups/:id/activity, which joins the intent
 * (CampaignBidHistory) to the delivery (AdMutation) on the actor string rank-defend already
 * stamps. No new logging was added anywhere to make this work.
 *
 * Chrome deliberately reuses the h10-hist-* shell from RuleListTab's execution-history drawer, so
 * the two read as the same object in the same console.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'
import { ScheduleVersions, type TargetPalette } from './ScheduleVersions'
import { getBackendUrl } from '@/lib/backend-url'

interface Delivery { state: string; attempts: number; lastError: string | null }
interface ActRow {
  id: string; at: string; campaignId: string | null; campaignName: string | null
  entityType: string; entityId: string; field: string
  oldValue: string | null; newValue: string | null; reason: string | null
  delivery: Delivery | null
}
interface Member { campaignId: string; name: string }

// Delivery, not intent. APPLIED is the only state that means Amazon took the change.
const DELIVERY_TONE: Record<string, string> = {
  APPLIED: 'ok', FAILED: 'bad', PENDING: 'dry', IN_FLIGHT: 'dry', CANCELLED: 'muted', SUPERSEDED: 'muted',
}
const DELIVERY_LABEL: Record<string, string> = {
  APPLIED: 'Applied', FAILED: 'Failed', PENDING: 'Queued', IN_FLIGHT: 'Sending', CANCELLED: 'Cancelled', SUPERSEDED: 'Superseded',
}

// Field names as the write path stores them → what an operator calls them.
// HX.2 — the PLACEMENT_* keys are the ones that matter here: holding a rank IS moving the
// placement bias, and until HX.2 those changes were written to no table this drawer could read.
// Values are percentages, so they render as "100 → 115" and the suffix makes that unambiguous.
const FIELD_LABEL: Record<string, string> = {
  PLACEMENT_TOP: 'Top-of-search bias', PLACEMENT_REST_OF_SEARCH: 'Rest-of-search bias', PLACEMENT_PRODUCT_PAGE: 'Product-page bias',
  bid: 'Bid', defaultBid: 'Ad-group bid', dailyBudget: 'Daily budget', status: 'Status',
  placementBidding: 'Placement bias',
}
const PCT_FIELDS = new Set(['PLACEMENT_TOP', 'PLACEMENT_REST_OF_SEARCH', 'PLACEMENT_PRODUCT_PAGE'])
const fmtValue = (v: string | null, field: string) => (v == null ? '—' : PCT_FIELDS.has(field) ? `${v}%` : v)
const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}
// Grouping header: the local hour a batch of changes landed in, which is the grain the schedule
// itself thinks in ("what did it do at 22:00 last night").
const hourKey = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: undefined, hour12: false })
}

export function ScheduleActivityDrawer({ group, palette, onClose }: { group: { id: string; name: string }; palette: TargetPalette; onClose: () => void }) {
  // HX.8 — two tabs, because these are two different histories: what the ENGINE did to Amazon
  // (Activity) versus what the OPERATOR did to the plan (Changes). Merging them would bury a
  // handful of plan edits under thousands of automated bid moves.
  const [tab, setTab] = useState<'activity' | 'changes'>('activity')
  const [items, setItems] = useState<ActRow[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [campaignId, setCampaignId] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const qs = new URLSearchParams({ limit: '80' })
    if (campaignId) qs.set('campaignId', campaignId)
    void fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${group.id}/activity?${qs.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        setItems(Array.isArray(j?.items) ? j.items : [])
        // Members come from the unfiltered member list, so narrowing to one campaign never
        // empties the picker you'd need to widen it again.
        if (Array.isArray(j?.members) && j.members.length) setMembers(j.members)
      })
      .catch(() => { if (alive) setItems([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [group.id, campaignId])

  const esc = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }, [onClose])
  useEffect(() => { document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc) }, [esc])

  const campOptions = useMemo(
    () => [{ value: '', label: `All ${members.length} campaign${members.length === 1 ? '' : 's'}` }, ...members.map((m) => ({ value: m.campaignId, label: m.name }))],
    [members],
  )

  // Failed writes are the headline, not a detail buried 40 rows down.
  const failed = useMemo(() => items.filter((i) => i.delivery?.state === 'FAILED').length, [items])

  // Rows carry an hour header when they open a new hour bucket.
  const withHeaders = useMemo(() => {
    let last = ''
    return items.map((i) => { const h = hourKey(i.at); const first = h !== last; last = h; return { row: i, header: first ? h : null } })
  }, [items])

  return (
    <div className="h10-hist-back" onClick={onClose}>
      <div className="h10-hist wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Activity — ${group.name}`}>
        <div className="h10-hist-h">
          <div><b>Activity</b><span title={group.name}>{group.name}</span></div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="h10-act-tabs" role="tablist" aria-label="History type">
          <button type="button" role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
          <button type="button" role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>Changes</button>
        </div>

        {tab === 'changes' ? (
          <div className="h10-hist-b"><ScheduleVersions groupId={group.id} palette={palette} /></div>
        ) : (<>
        <div className="h10-act-bar">
          <H10Select
            width={260}
            options={campOptions}
            value={campaignId}
            onChange={setCampaignId}
            ariaLabel="Filter activity by campaign"
            searchable
            searchPlaceholder="Search campaigns…"
          />
          {failed > 0 && <span className="h10-act-alert">{failed} write{failed === 1 ? '' : 's'} failed to reach Amazon</span>}
          {/* HX.5 — the contextual way into the account-wide log. Deliberately quiet and in a new
              tab: this drawer shows one schedule's slice of the same feed, and you shouldn't lose
              the schedule you were reading to see the rest. No sidebar entry exists by design. */}
          <a className="h10-act-all" href="/marketing/ads/changelog" target="_blank" rel="noopener noreferrer">View all changes →</a>
        </div>

        <div className="h10-hist-b">
          {loading ? (
            <div className="h10-hist-msg">Loading…</div>
          ) : items.length === 0 ? (
            <div className="h10-hist-msg">
              No changes recorded yet. This schedule writes an entry whenever the rank loop moves a bid
              or placement bias — a schedule holding a rank it has already reached makes no changes at all.
            </div>
          ) : (
            withHeaders.map(({ row, header }) => (
              <div key={row.id}>
                {header && <div className="h10-act-hr">{header}</div>}
                <div className="h10-act-r">
                  <span className="fld">{fieldLabel(row.field)}</span>
                  <span className="chg">
                    <b>{fmtValue(row.oldValue, row.field)}</b> → <b>{fmtValue(row.newValue, row.field)}</b>
                    {row.campaignName && <i title={row.campaignName}>{row.campaignName}</i>}
                    {row.reason && <em title={row.reason}>{row.reason}</em>}
                  </span>
                  {/* Intent and delivery are separate columns on purpose: a change we asked for is
                      not a change Amazon took, and the old UI implied it was. */}
                  <span
                    className={`dlv ${row.delivery ? (DELIVERY_TONE[row.delivery.state] ?? 'muted') : 'none'}`}
                    title={row.delivery?.lastError ?? (row.delivery ? `${row.delivery.attempts} attempt${row.delivery.attempts === 1 ? '' : 's'}` : 'No delivery record for this change')}
                  >
                    {row.delivery ? (DELIVERY_LABEL[row.delivery.state] ?? row.delivery.state) : 'no record'}
                    {row.delivery && row.delivery.attempts > 1 && <span className="att">×{row.delivery.attempts}</span>}
                  </span>
                  <span className="when" title={new Date(row.at).toLocaleString()}>{ago(row.at)}</span>
                </div>
              </div>
            ))
          )}
        </div>
        </>)}
      </div>
    </div>
  )
}
