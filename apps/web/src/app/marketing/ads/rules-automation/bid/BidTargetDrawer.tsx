'use client'

/**
 * ⛔ PARKED 2026-08-16 (U1) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the per-target drawer: bid history, why this number, who decided.
 * Why it left: the Bid tab is now Helium 10's shape — one rules grid and nothing else
 *   (`BidRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.2, §7.2).
 * Candidate home: Analytics › Targets, or the Ad Manager target row.
 *
 * Nothing here was changed, no endpoint was retired, and the file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BID.S3 — one target, in full: the drawer `?target=` opens.
 *
 * The grid's first column is a real link now (S3 deleted the two CSS rules that un-blued it),
 * and this is where it lands.
 *
 * ── 🔴 One request, and it is `listChanges`, not `bid-history` ─────────────────────────────────
 *
 * An earlier cut of this drawer read the grid payload's `series` (and `bid-history` for a deep
 * link). That is enough to draw a line and nothing else: it carries `at / to / from / delivered`
 * and no actor, no reason, no evidence, no Amazon error and no undo state — which is most of what
 * "why is this bid this number" means.
 *
 * `GET /advertising/changes?entityType=AD_TARGET&entityId=…&field=bid` returns all of it in ONE
 * call, already resolved: `automation:rank-defend-cmr2697…` arrives as **"IT GALE JACKET"** via
 * `parseActor` + `resolveOrigins`. Verified on the fixture below: 56 rows, delivery APPLIED 22 /
 * FAILED 34, three origins, four reason strings, and undo blocked-reasons already written as
 * prose. Using it also collapses the two data paths into one — the deep-link case is no longer
 * special, because the call does not care whether the grid is showing the row.
 *
 * ── The story this has to tell, from the fixture ───────────────────────────────────────────────
 *
 * `cmr28mgl50019qq010p4nqnhg` (B072XH2LB2, GALE | IT | PAT): between 01 Jul and 02 Aug the rank
 * engine recorded **33 cuts of €0.38 → €0.02, one a night, and every one FAILED at Amazon.** The
 * bid never left €0.38. On 03 Aug `automation:dl-requeue` wrote 38→38 after the /sp/keywords
 * routing fix and every write since has landed.
 *
 * 🔴 So the two facts must be drawn apart, and NOT as two connected lines. In the failed phase
 * every write's `oldValue` is 38 while the previous write's `newValue` was 2 — because the
 * unaudited hourly resync put it back. A connected "intended" line would draw 38→2→38→2 and
 * assert the engine raised it each morning. It never did. So:
 *
 *   · **delivered** — a step line built from APPLIED writes only, held forward. Flat at €0.38 for
 *     all of July. This is the truthful spine.
 *   · **intended**  — one row per write in the log, each stating whether it landed. A cut that
 *     never reached Amazon reads as exactly that, and the line above it does not move.
 *
 * ── The dangling segment ───────────────────────────────────────────────────────────────────────
 *
 * When `row.unrecorded` is true the live bid disagrees with the last audited value, so the curve's
 * last point is NOT where the bid is now. That gap is drawn and named, never closed — closing it
 * would fabricate a change no table records, which is the failure this whole drawer exists to
 * prevent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DataGrid } from '@/design-system/components'
import Link from 'next/link'
import { AlertTriangle, ExternalLink, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { BidSpark, type SparkPoint } from './BidSpark'
import { resolveBidStates } from './bidState'
import type { BidTargetRow } from './types'
import { Checkbox } from '@/design-system/primitives'

/** The subset of `ChangeRow` this drawer reads. Mirrors `ads-changes.service.ts`. */
interface ChangeRow {
  id: string
  at: string
  source: string
  origin: { kind: string; id: string | null; name: string }
  field: string
  oldValue: string | null
  newValue: string | null
  reason: string | null
  evidence: Record<string, unknown> | null
  delivery: { state: string; attempts: number; lastError: string | null } | null
  undoable: boolean
  undoActionLogId: string | null
  undoBlockedReason?: string
}

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const num = (n: number) => n.toLocaleString('en-IE')
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })

/**
 * Two reason strings, one mechanism. "pause target → bids floored (no-pause)" is the pre-MB.1
 * wording for what is now "Min bid → bids floored to €0.02". Presenting them as two causes would
 * invent a second engine; they are grouped and the grouping is stated.
 */
const FLOOR_REASONS = ['pause target → bids floored', 'Min bid → bids floored']
const isFloorCycle = (r: ChangeRow) => {
  const s = r.reason ?? ''
  return FLOOR_REASONS.some((f) => s.includes(f)) || s.includes('serve target → restore prior bids')
}

/** APPLIED is the only state that moved the bid at Amazon. `null` is "no record", never success. */
const landed = (r: ChangeRow) => r.delivery?.state === 'APPLIED'

export function BidTargetDrawer({ targetId, row, loading = false, onClose }: {
  targetId: string
  row: BidTargetRow | null
  /** True while the GRID is still fetching — a missing row then means "not loaded yet", and the
   *  drawer must not claim "not in this view" about a view that has not answered (seen live on a
   *  full page load with ?target=: the banner accused the filters while the grid showed skeletons). */
  loading?: boolean
  onClose: () => void
}) {
  const [changes, setChanges] = useState<ChangeRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [structuralOnly, setStructuralOnly] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  /**
   * Focus: remember where we came from, move in, trap, and put it back on close.
   *
   * 🔴 Not verifiable by script — a synthetic `.focus()` fires no focus event and a synthetic
   * Escape never reaches a real listener, so this was checked by hand on production. The DS
   * `Drawer` solves the same problem, and is deliberately not used here: it portals to `<body>`
   * and this section pins `color-scheme: light` on `.h10-shell`, which a portaled panel escapes
   * (KT.4 hit exactly that and hand-rolled its own for the same reason).
   */
  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    panel?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
      if (e.key !== 'Tab' || !panel) return
      const f = [...panel.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')]
        .filter((el) => el.offsetParent !== null)
      if (f.length === 0) return
      const first = f[0], last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Only restore if focus is still inside the drawer — otherwise we would yank it away from
      // wherever the operator has since deliberately put it.
      if (!panel || panel.contains(document.activeElement)) returnTo.current?.focus?.()
    }
  }, [onClose])

  // One request. Sixty days, not the metric window: `?window=` is the METRIC window (S0's contract
  // says so), and tying the history to it would shorten the curve when someone changed a column.
  useEffect(() => {
    let alive = true
    setChanges(null); setErr(null)
    const from = new Date(Date.now() - 60 * 86400_000).toISOString()
    const qs = new URLSearchParams({ entityType: 'AD_TARGET', entityId: targetId, field: 'bid', from, limit: '500' })
    fetch(`${getBackendUrl()}/api/advertising/changes?${qs}`, { cache: 'no-store' })
      .then(async (r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => { if (alive) setChanges((j?.items ?? []) as ChangeRow[]) })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [targetId])

  // `listChanges` returns newest-first and includes operation rows with no value at all — the
  // `create_target` row on the fixture is one. A point needs a number; a log row does not.
  //
  // 🔴 The null check is NOT redundant with `Number.isFinite`. `Number(null)` is **0**, which is
  // finite, so filtering on `isFinite` alone admits every valueless row and renders it as a change
  // to €0.00. Seen on production: the fixture's create row showed as "1 Jul 17:35 · €0.00 ·
  // System · not recorded", and it also put a phantom zero at the left end of the delivered line
  // and inflated the tally by one.
  const writes = useMemo(
    () => (changes ?? []).filter((c) => c.newValue != null && Number.isFinite(Number(c.newValue))).slice().reverse(),
    [changes],
  )
  const shown = useMemo(
    () => (structuralOnly ? writes.filter((w) => !isFloorCycle(w)) : writes),
    [writes, structuralOnly],
  )
  const cycleCount = writes.length - writes.filter((w) => !isFloorCycle(w)).length

  /** The delivered spine: APPLIED writes only, held forward. */
  const deliveredPoints: SparkPoint[] = useMemo(
    () => writes.filter(landed).map((w) => ({ at: w.at, to: Number(w.newValue), from: w.oldValue == null ? null : Number(w.oldValue), delivered: 'SUCCESS' })),
    [writes],
  )
  const failedCount = writes.filter((w) => w.delivery?.state === 'FAILED').length
  const noRecordCount = writes.filter((w) => w.delivery == null).length
  const lastAudited = writes.length ? Number(writes[writes.length - 1].newValue) : null

  const chips = row ? resolveBidStates(row, 99) : []
  const close = useCallback(() => onClose(), [onClose])

  return (
    <div className="h10-au-back" onClick={close}>
      <div
        ref={panelRef}
        className="h10-au-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Target — ${row?.label ?? targetId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h10-au-dh">
          <div>
            <b>{row ? row.label : 'Target'}</b>
            <span>
              {row
                ? <>{row.kind.replace(/_/g, ' ').toLowerCase()} · {row.match.replace(/_/g, ' ').toLowerCase()} · {row.market}{row.derived && ' · name derived from its targeting group'}</>
                : loading ? 'loading…' : 'outside the current view'}
            </span>
          </div>
          <button type="button" data-autofocus onClick={close} aria-label="Close"><X size={18} aria-hidden /></button>
        </div>

        <div className="h10-au-db">
          {!row && !loading && (
            <p className="h10-au-conf" role="note">
              <AlertTriangle size={13} aria-hidden />
              This target is not in the current view&rsquo;s scope or filters, so its identity, bid and
              metrics are not loaded — only its write history below. Clear the filters to see the row.
            </p>
          )}

          {row && (
            <section className="h10-au-def">
              <div className="h10-au-defrow">
                <span className="k">Where</span>
                <span className="v">
                  <Link href={`/marketing/ads/campaigns/${row.campaignId}`}>{row.campaignName} <ExternalLink size={11} aria-hidden /></Link>
                  {' '}› {row.adGroupName}
                  {!row.liveNow && <em className="h10-bd3-off"> — not in any auction (target or campaign not enabled)</em>}
                </span>
              </div>

              <div className="h10-au-defrow">
                <span className="k">Bid</span>
                <span className="v">
                  <b>{eur(row.bidCents)}</b>
                  {row.minBidCents != null || row.maxBidCents != null
                    ? <> · band {row.minBidCents != null ? eur(row.minBidCents) : 'no floor declared'} – {row.maxBidCents != null ? eur(row.maxBidCents) : 'no ceiling declared'}</>
                    : <> · <em className="h10-bd3-mut">no band declared</em></>}
                </span>
              </div>

              {/* 🔴 A sample, not a ceiling. The rank engine steps the placement multiplier +25%
                  every 15 minutes and snaps it to 0 when the lane goes above plan, so this number
                  expires at the next tick. Saying "at most" without saying "right now" is the
                  reading that would send someone into S5 with a stale bound. */}
              {row.effectiveMaxCpcCents != null && (
                <div className="h10-au-defrow">
                  <span className="k">Most a click can cost</span>
                  <span className="v">
                    <b>{eur(row.effectiveMaxCpcCents)}</b>{' '}
                    <em className="h10-bd3-mut">
                      right now — {eur(row.bidCents)}
                      {row.placementPct > 0 && ` × +${row.placementPct}% placement`}
                      {row.biddingStrategy === 'AUTO_FOR_SALES' && ' × up-and-down bidding'}.
                      The multiplier moves every 15 minutes, so this is a reading, not a ceiling.
                    </em>
                  </span>
                </div>
              )}

              <div className="h10-au-defrow">
                <span className="k">Bidder</span>
                <span className="v">
                  {row.bidder === 'none'
                    ? <em className="h10-bd3-off">Nobody. No schedule, no goal, and no operator has moved a bid in this campaign in 60 days.</em>
                    : row.bidder === 'schedule'
                      ? <><b>{row.bidderName}</b> · <Link href="/marketing/ads/rules-automation/dayparting">rank schedule <ExternalLink size={11} aria-hidden /></Link></>
                      : row.bidder === 'goal' ? <b>Target-ACoS goal</b> : <b>An operator, in the last 60 days</b>}
                </span>
              </div>

              {/* What this bid will go back to, if anything remembers. Two different fields, and a
                  bid at €0.02 with neither is the third floor state S2 named. */}
              {(row.suppressedFromBidCents != null || row.inMinBidWindow) && (
                <div className="h10-au-defrow">
                  <span className="k">Memory</span>
                  <span className="v">
                    {row.suppressedFromBidCents != null
                      ? <>Suppressed — restores to <b>{eur(row.suppressedFromBidCents)}</b>.</>
                      : <>In a Min-bid window; the schedule restores it when the window ends.</>}
                  </span>
                </div>
              )}

              {chips.length > 0 && (
                <div className="h10-au-defrow">
                  <span className="k">States</span>
                  <span className="v h10-bd3-chips">
                    {chips.map((c) => <i key={c.key} className={`h10-bd3-chip ${c.tone}`} title={c.title}>{c.label}</i>)}
                  </span>
                </div>
              )}

              <div className="h10-au-defrow">
                <span className="k">Window</span>
                <span className="v">
                  {row.measured
                    ? <>{num(row.impressions)} impressions · {num(row.clicks)} clicks · {eur(row.spendCents)} spent · {eur(row.salesCents)} sales · {row.orders} orders · ACOS {row.acos != null ? `${(row.acos * 100).toFixed(0)}%` : '—'}</>
                    : <em className="h10-bd3-mut">not served in this window — which is not the same as spending nothing</em>}
                </span>
              </div>
            </section>
          )}

          <section className="h10-bd3-curve">
            <h4>The bid, over 60 days</h4>

            {err && <p className="h10-au-limiterr" role="alert"><AlertTriangle size={13} aria-hidden /> Could not load the change history: {err}</p>}
            {changes === null && !err && <p className="h10-bd3-mut">Loading…</p>}

            {changes !== null && writes.length === 0 && (
              <p className="h10-bd3-mut">
                No recorded change in 60 days — nobody and nothing has written this bid in the
                window{row ? <>, so it has been {eur(row.bidCents)} for at least that long</> : null}. That
                is a fact about the bid, not a gap in the record: 2,336 of the 2,944 enabled targets
                are in the same position.
              </p>
            )}

            {changes !== null && writes.length > 0 && (
              <>
                {/* The delivered spine. Drawn from APPLIED writes only — on the fixture that is a
                    flat line at €0.38 through all of July while 33 recorded cuts sit in the log
                    below, none of which moved it. */}
                <div className="h10-bd3-spark">
                  {deliveredPoints.length > 0
                    ? <BidSpark points={deliveredPoints} label={row?.label ?? targetId} format={eur} />
                    : <em className="h10-bd3-mut">No write reached Amazon in 60 days, so there is no delivered line to draw.</em>}
                </div>

                <p className="h10-bd3-sum">
                  <b>{num(writes.length)}</b> recorded {writes.length === 1 ? 'change' : 'changes'} ·{' '}
                  <b>{num(deliveredPoints.length)}</b> landed
                  {failedCount > 0 && <> · <b className="bad">{num(failedCount)} never reached Amazon</b></>}
                  {noRecordCount > 0 && <> · {num(noRecordCount)} with no delivery record</>}
                </p>

                {/* 🔴 The dangling segment. The curve ends at the last AUDITED value; the bid is
                    somewhere else. Named, never closed. */}
                {row?.unrecorded && lastAudited != null && (
                  <p className="h10-bd3-dangle">
                    <AlertTriangle size={13} aria-hidden />
                    <span>
                      The last recorded change left this at <b>{eur(lastAudited)}</b>; it is now{' '}
                      <b>{eur(row.bidCents)}</b>, and <b>nothing recorded the difference</b>. Usually
                      the nightly restore, which is audited on most campaigns and not on this one —
                      in the last 24 hours 483 floors were audited and 359 restores were. A Seller
                      Central edit looks identical from here, and the hourly inbound sync overwrites
                      the local value either way without leaving a row.
                    </span>
                  </p>
                )}

                {cycleCount > 0 && (
                  <Checkbox
                    className="h10-bd3-toggle"
                    checked={structuralOnly} onChange={(e) => setStructuralOnly(e.target.checked)}
                    label={<>Hide the nightly floor/restore cycle ({num(cycleCount)} of {num(writes.length)})</>}
                  />
                )}

                <DataGrid
                  className="h10-bd3-writes"
                  rows={[...shown].reverse()}
                  rowKey={(w) => w.id}
                  rowClassName={(w) => (w.delivery?.state === 'FAILED' ? 'failed' : undefined)}
                  columns={[
                    { key: 'when', label: 'When', render: (w) => <>{when(w.at)}</> },
                    { key: 'change', label: 'Change', align: 'right', render: (w) => (<>
                      {w.oldValue != null && Number.isFinite(Number(w.oldValue)) ? `${eur(Number(w.oldValue))} → ` : ''}
                      {eur(Number(w.newValue))}
                    </>) },
                    { key: 'who', label: 'Who', render: (w) => <span title={`${w.origin.kind} · ${w.source}`}>{w.origin.name}</span> },
                    { key: 'why', label: 'Why', render: (w) => (<>
                      {w.reason ?? <em className="h10-bd3-mut">not recorded</em>}
                      {/* Evidence sits on 81 of 23,705 rows account-wide. Absent is NORMAL and must
                          not render as an error; present, sampleSize matters most. */}
                      {w.evidence && (
                        <i className="h10-bd3-ev" title={JSON.stringify(w.evidence)}>
                          {Object.entries(w.evidence).slice(0, 3).map(([k, v]) => `${k} ${String(v)}`).join(' · ')}
                        </i>
                      )}
                    </>) },
                    { key: 'landed', label: 'Landed', render: (w) => (<>
                      {w.delivery == null
                        ? <span className="h10-bd3-mut" title="No delivery row was recorded for this change. That is not the same as success.">no record</span>
                        : w.delivery.state === 'APPLIED' ? 'yes'
                          : w.delivery.state === 'FAILED'
                            ? <b className="bad" title={w.delivery.lastError ?? 'Recorded here and never accepted by Amazon — the bid did not move.'}>no</b>
                            : w.delivery.state.toLowerCase()}
                      {/* §7 — the STATE, not a button. A disabled control would be its own kind of lie. */}
                      {w.undoable
                        ? <i className="h10-bd3-undo ok" title="This change can still be reversed. The control arrives with the staged tray in S4.">undoable</i>
                        : w.undoBlockedReason
                          ? <i className="h10-bd3-undo" title={w.undoBlockedReason}>not undoable</i>
                          : null}
                    </>) },
                  ]}
                />
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
