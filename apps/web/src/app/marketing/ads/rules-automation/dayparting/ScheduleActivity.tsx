'use client'

/**
 * The Amazon-change history for ONE SCOPE — a rank schedule, or a campaign.
 *
 * Every bid and placement-percentage move the engine made within that scope, and separately
 * whether Amazon actually took it.
 *
 * One implementation serves every place a change history is shown: the schedule drawer, the
 * builder, and the campaign detail page. A second copy would drift, and two views would quietly
 * disagree about what actually happened — which is the failure this whole series exists to remove.
 *
 * NOT to be confused with ScheduleVersions, which records what the OPERATOR changed about the plan
 * ("you moved the Friday window"). This one is what the ENGINE changed on Amazon.
 *
 * Data: GET /advertising/changes?groupId= — the UNIFIED feed (HX.4), the same one the account-wide
 * Change Log reads. It used to have its own endpoint doing the same joins; two implementations of
 * "join intent to delivery" would drift, and a fix to one would silently miss the other. The feed
 * resolves a group to its member schedules' actor strings server-side, because a group has N member
 * AdSchedule rows and therefore N actors.
 */
import { useEffect, useMemo, useState } from 'react'
import { H10Select } from '../../campaigns/FilterDropdown'
import { getBackendUrl } from '@/lib/backend-url'

export interface Delivery { state: string; attempts: number; lastError: string | null }
export interface ActRow {
  id: string; at: string
  campaign: { id: string; name: string | null } | null
  entity: { type: string; id: string; name: string | null }
  field: string
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

// The PLACEMENT_* keys are the ones that matter: holding a rank IS moving the placement percentage.
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
// Hour buckets — the grain the schedule itself thinks in ("what did it do at 22:00 last night").
const hourKey = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', hour12: false })

export function ChangeList({ groupId, campaignId, showAllLink = true }: {
  /** Scope to a rank schedule — resolved server-side to its member schedules' actors. */
  groupId?: string
  /** Scope to a single campaign. */
  campaignId?: string
  showAllLink?: boolean
}) {
  const [items, setItems] = useState<ActRow[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [memberFilter, setMemberFilter] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const qs = new URLSearchParams({ limit: '80' })
    if (groupId) qs.set('groupId', groupId)
    // A campaign scope needs no member picker — there is only one campaign — so the filter below
    // is driven by `members`, which the feed returns only for a group scope.
    if (campaignId ?? memberFilter) qs.set('campaignId', (campaignId ?? memberFilter) as string)
    void fetch(`${getBackendUrl()}/api/advertising/changes?${qs.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        setItems(Array.isArray(j?.items) ? j.items : [])
        // The feed returns the group's FULL membership on a group scope, not just the campaigns
        // present in this page of rows — so narrowing to one campaign never empties the picker you
        // would need to widen it again.
        if (Array.isArray(j?.members) && j.members.length) setMembers(j.members)
      })
      .catch(() => { if (alive) setItems([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [groupId, campaignId, memberFilter])

  const campOptions = useMemo(
    () => [{ value: '', label: `All ${members.length} campaign${members.length === 1 ? '' : 's'}` }, ...members.map((m) => ({ value: m.campaignId, label: m.name }))],
    [members],
  )
  // Failed writes are the headline, not a detail buried 40 rows down.
  const failed = useMemo(() => items.filter((i) => i.delivery?.state === 'FAILED').length, [items])
  const withHeaders = useMemo(() => {
    let last = ''
    return items.map((i) => { const h = hourKey(i.at); const first = h !== last; last = h; return { row: i, header: first ? h : null } })
  }, [items])

  return (
    <>
      <div className="h10-act-bar">
        {members.length > 1 && <H10Select
          width={260}
          options={campOptions}
          value={memberFilter}
          onChange={setMemberFilter}
          ariaLabel="Filter activity by campaign"
          searchable
          searchPlaceholder="Search campaigns…"
        />}
        {failed > 0 && <span className="h10-act-alert">{failed} write{failed === 1 ? '' : 's'} failed to reach Amazon</span>}
        {showAllLink && (
          <a className="h10-act-all" href="/marketing/ads/changelog" target="_blank" rel="noopener noreferrer">View all changes →</a>
        )}
      </div>

      <div className="h10-act-list">
        {loading ? (
          <div className="h10-hist-msg">Loading…</div>
        ) : items.length === 0 ? (
          <div className="h10-hist-msg">
            No Amazon changes recorded yet. An entry appears whenever the rank loop moves a bid or a
            placement percentage — a schedule already holding its target rank makes no changes at all.
          </div>
        ) : (
          withHeaders.map(({ row, header }) => (
            <div key={row.id}>
              {header && <div className="h10-act-hr">{header}</div>}
              <div className="h10-act-r">
                <span className="fld">{fieldLabel(row.field)}</span>
                <span className="chg">
                  <b>{fmtValue(row.oldValue, row.field)}</b> → <b>{fmtValue(row.newValue, row.field)}</b>
                  {row.campaign?.name && <i title={row.campaign.name}>{row.campaign.name}</i>}
                  {row.reason && <em title={row.reason}>{row.reason}</em>}
                </span>
                {/* Intent and delivery stay separate: a change we asked for is not a change Amazon took. */}
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
    </>
  )
}
