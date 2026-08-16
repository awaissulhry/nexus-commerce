'use client'

/**
 * ⛔ PARKED 2026-08-17 (U2) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the per-campaign inspector rail (?row=): three lanes side by side, the owner, and the change ledger.
 * Why it left: the Placement tab is now Helium 10's shape — one rules grid and nothing else
 *   (`PlacementRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.8, §7.3).
 * Candidate home: Analytics › Campaigns, or the Ad Manager campaign row.
 *
 * Nothing here was changed and no endpoint was retired — the PLC.3 multiplier write path is still
 * served. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * PLC.P2 — the inspector rail: one campaign, its three lanes, and the ledger.
 *
 * Opened by `?row=<campaignId>` (`?campaign=` is taken — it is the scope grain). The identity and
 * lane facts come from the ALREADY-LOADED grid payload (no second fetch, no chance of disagreeing
 * with the rows behind the rail); the ledger is this page's one extra read —
 * `GET /advertising/bid-history?entityType=CAMPAIGN&campaignId=…` — CampaignBidHistory rendered
 * for the first time on this page, per changed lane, actor → old→new, with the reason.
 *
 * Honesty rules carried from the study:
 *   · The history is attributed since 2026-08-03 and the rail SAYS so — an empty ledger before
 *     that date is the record's youth, not a quiet campaign.
 *   · Fields are client-filtered to the PLACEMENT_* lanes; other campaign fields (budget, status)
 *     belong to their own pages and are counted, not shown.
 *   · A campaign outside the current filters still opens: lanes from the payload when present,
 *     the ledger always (it is fetched by id, not from the view).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ExternalLink, Loader2, Pin, PinOff, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const RECORD_STARTS = '2026-08-03'

interface LedgerRow {
  id: string
  field: string
  oldValue: string | null
  newValue: string | null
  changedBy: string | null
  reason: string | null
  changedAt: string
}

const LANE_WORD: Record<string, string> = {
  PLACEMENT_TOP: 'Top of search',
  PLACEMENT_REST_OF_SEARCH: 'Rest of search',
  PLACEMENT_PRODUCT_PAGE: 'Product pages',
}

/** The actor string, humanised the way the console resolves it — prefix, never a second parser. */
function who(actor: string | null): { word: string; title: string } {
  const a = actor ?? 'system'
  if (a.startsWith('automation:rank-defend-')) return { word: 'rank schedule', title: a }
  if (a.startsWith('automation:rank-plan-')) return { word: 'rank plan', title: a }
  if (a.startsWith('automation:dayparting-')) return { word: 'dayparting', title: a }
  if (a.startsWith('automation:')) return { word: a.slice('automation:'.length), title: a }
  if (a.startsWith('user:')) return { word: 'operator', title: a }
  return { word: 'system (unattributed)', title: 'A write from before actors were forwarded on this path — indistinguishable from legacy rows.' }
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })

export function PlcInspector({ campaignId, lanes, onClose, onChanged }: {
  campaignId: string
  /** This campaign's rows from the loaded payload — three lanes when in view, empty when not. */
  lanes: Array<{ lane: string; laneKey: string; multiplierPct: number; spendCents: number; roas: number | null; owner: string; ownerLabel: string | null; name: string; marketplace: string | null; status: string; pinPlacement?: boolean }>
  onClose: () => void
  /** PLC.3 — a pin change moves what the grid should show, so the page refetches from the server */
  onChanged?: () => void
}) {
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null)
  const [ledgerErr, setLedgerErr] = useState<string | null>(null)
  // PLC.3 — the placement pin. Substrate §4 gives THIS page `pinPlacement`; `pinBids` belongs to
  // Bid and `pinBudget` to Budget. The Control Room's three-dimension copy retires when all three
  // pages ship it — not in this session, and not as a side effect of building one of them.
  const [pinned, setPinned] = useState<boolean | null>(null)
  const [pinBusy, setPinBusy] = useState(false)
  const [pinErr, setPinErr] = useState<string | null>(null)

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/bid-history?entityType=CAMPAIGN&campaignId=${encodeURIComponent(campaignId)}&limit=200`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => { if (alive) { setLedger((j?.items as LedgerRow[]) ?? []); setLedgerErr(null) } })
      .catch((e) => { if (alive) setLedgerErr((e as Error).message) })
    return () => { alive = false }
  }, [campaignId])

  /**
   * The pin comes from the grid payload, NOT from `GET /advertising/campaigns`.
   *
   * That endpoint sits behind `cached(key, 300)`, so a pin toggled here would read back its old
   * value for up to five minutes — the worst possible behaviour for a control whose entire job is
   * to say "this campaign is held by hand". The page's own read is uncached and refetches on
   * `onChanged`, so the rail and the grid agree the moment the write lands.
   *
   * `null` only when the campaign is outside the current filters, and the control says so rather
   * than assuming `false` and offering to pin something already pinned.
   */
  useEffect(() => { setPinned(lanes[0]?.pinPlacement ?? null) }, [lanes])

  const togglePin = useCallback(async () => {
    if (pinned == null || pinBusy) return
    setPinBusy(true); setPinErr(null)
    try {
      // The route `GuardrailGrid.tsx:321` already drives, called with ONLY this page's dimension —
      // sending the other two would let a placement page silently change a campaign's bid pin.
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/pins`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinPlacement: !pinned }),
      })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!r.ok || j.ok === false) { setPinErr(j.error ?? `The pin did not save (${r.status})`); return }
      setPinned(!pinned)
      onChanged?.()
    } catch (e) { setPinErr((e as Error).message) } finally { setPinBusy(false) }
  }, [campaignId, pinned, pinBusy, onChanged])

  const head = lanes[0] ?? null
  const placementRows = useMemo(() => (ledger ?? []).filter((r) => r.field.startsWith('PLACEMENT')), [ledger])
  const otherCount = (ledger?.length ?? 0) - placementRows.length

  return (
    <div className="h10-au-back" onClick={onClose}>
      <div className="h10-au-drawer" role="dialog" aria-modal="true" aria-label={`Placement — ${head?.name ?? campaignId}`} onClick={(e) => e.stopPropagation()}>
        <div className="h10-au-dh">
          <div>
            <b>{head?.name ?? 'Campaign'}</b>
            <span>{head ? <>{head.marketplace ?? '—'} · {head.status.toLowerCase()} · placement</> : 'outside the current filters — lane facts not loaded; the ledger below is fetched by id'}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={18} aria-hidden /></button>
        </div>
        <div className="h10-au-db">
          {head != null && (
            <section className="h10-plc2-lanes">
              {lanes.map((l) => (
                <div key={l.laneKey} className="h10-plc2-lane">
                  {/* The payload's `lane` arrived as the raw enum on prod — map it through the
                      same words the ledger uses, falling back to whatever the payload said. */}
                  <span className="k">{LANE_WORD[l.lane] ?? l.lane}</span>
                  <b>+{l.multiplierPct}%</b>
                  <span className="v">€{(l.spendCents / 100).toFixed(2)} spent · ROAS {l.roas != null ? l.roas.toFixed(1) : '—'}</span>
                </div>
              ))}
              <p className="h10-plc2-owner">
                Steered by <b>{head.owner === 'none' ? 'nobody' : head.ownerLabel ?? head.owner}</b>
                {head.owner === 'none' && ' — no schedule and no plan writes these multipliers; they are whatever was last set.'}
                {' '}<Link href={`/marketing/ads/campaigns/${campaignId}`}>campaign page <ExternalLink size={11} aria-hidden /></Link>
              </p>
            </section>
          )}

          {/* PLC.3 — the placement pin, this page's dimension only. */}
          <div className={`h10-plc3-pin ${pinned ? 'on' : ''}`}>
            {pinned == null ? (
              <span>The pin state could not be read for this campaign.</span>
            ) : (
              <>
                <span>
                  {pinned
                    ? <><b>Placement is pinned</b> — held by hand. Every automation write to this campaign&rsquo;s multipliers is refused at the gate, and the refusal says so.</>
                    : <><b>Placement is not pinned.</b> Pinning it refuses every automation write to this campaign&rsquo;s multipliers — including the rank engine&rsquo;s — until it is cleared.</>}
                </span>
                <button type="button" className="h10-plc3-btn" onClick={togglePin} disabled={pinBusy}>
                  {pinBusy ? <Loader2 size={12} aria-hidden /> : pinned ? <PinOff size={12} aria-hidden /> : <Pin size={12} aria-hidden />}
                  {' '}{pinned ? 'Unpin placement' : 'Pin placement'}
                </button>
              </>
            )}
            {pinErr && <span role="alert" style={{ color: '#8f2828', fontWeight: 700 }}>{pinErr}</span>}
          </div>

          <section className="h10-plc2-ledger">
            <h4>The ledger — every recorded multiplier change on this campaign</h4>
            {ledgerErr != null ? (
              <p className="h10-plc2-err" role="alert"><AlertTriangle size={13} aria-hidden /> The ledger failed to load {ledgerErr} — a failed read, not an empty history.</p>
            ) : ledger == null ? (
              <p className="h10-plc2-muted">Loading…</p>
            ) : placementRows.length === 0 ? (
              <p className="h10-plc2-muted">No recorded multiplier change. The attributed record only starts {RECORD_STARTS} — silence before then is the record&rsquo;s youth, not this campaign&rsquo;s stillness.</p>
            ) : (
              <>
                <ul>
                  {placementRows.slice(0, 30).map((r) => {
                    const w = who(r.changedBy)
                    return (
                      <li key={r.id}>
                        <span className="nw">{when(r.changedAt)}</span>
                        <span className="lane">{LANE_WORD[r.field] ?? r.field}</span>
                        <span className="nw">{r.oldValue ?? '0'}% → <b>{r.newValue ?? '0'}%</b></span>
                        <span className="who" title={w.title}>{w.word}</span>
                        {r.reason && <span className="why" title={r.reason}>{r.reason}</span>}
                      </li>
                    )
                  })}
                  {placementRows.length > 30 && <li className="more">…and {placementRows.length - 30} more in the record</li>}
                </ul>
                <p className="h10-plc2-foot">
                  Attributed since {RECORD_STARTS} — the account did not begin then; the record did.
                  {otherCount > 0 && <> {otherCount} non-placement change{otherCount === 1 ? '' : 's'} (budget, status…) live on their own pages and the change log.</>}
                </p>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
