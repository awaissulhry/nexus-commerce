'use client'

/**
 * KT.6 / KT.7 — the one control on this page that spends money.
 *
 * It lives inside the KT.4 drawer, which already lists the campaigns bidding the term and the ASINs
 * holding it — exactly what a bid write touches — so the confirmation can name them without fetching
 * anything new. There is no grid-level bulk control: a single row is already 100 targets across 53
 * campaigns, which is the hard case, and a bulk control would multiply it before anyone has used this
 * once.
 *
 * ── D4, at full strength, because this spends ───────────────────────────────────────────────────
 *
 * Everything read-only on this page is dense and quiet. This is the opposite: the confirmation is
 * composed SERVER-SIDE (`kt6-bid-action.ts`) and rendered verbatim, so the sentence the operator reads
 * is the same string the proposal records. That is deliberate — a client that re-phrased it could
 * describe one thing while the ledger stored another, and the ledger is what a later undo and change
 * log are built on.
 *
 * ── What it will not do ────────────────────────────────────────────────────────────────────────
 *
 * · 🔴 **KT.7 gave it an apply, and this note used to say it had none.** `Apply this proposal` calls
 *   `POST /apply`, which writes real bids through the account's write gate. It is offered ONLY after a
 *   proposal exists, it sends nothing but the proposal id — every guard is re-decided server-side,
 *   because the numbers in this component are already seconds old and bids here move thousands of
 *   times a day — and it carries its own confirm naming what will be re-checked.
 * · **It does not offer to create a keyword** for an unbid term. Measured: 70 writable IT campaigns
 *   hold 70 MANUAL ad groups, so a new keyword could go in 70 places and none is derivable. It says
 *   so and points at Keyword Harvest, which already owns destination choice.
 * · **It does not raise a suppressed bid** unless the operator ticks the box. 12 of `giacca moto`'s 42
 *   writable targets are suppressed and only 9 carry the flag; raising them would switch delivery back
 *   on for traffic somebody switched off.
 *
 * 🔴 Drawer traps this pays for (KT.4 found them all): the drawer portals to `document.body` and
 * escapes the page's light pin, so every colour here is declared rather than inherited; a confirm
 * inside a drawer needs its own stacking context, so the panel is positioned within the drawer's flow
 * rather than fixed; and no CSS transition is used on anything a probe might measure.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Info, Loader2, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface PreviewResponse {
  term: string
  marketplace: string
  requestedBidCents: number
  floorCents: number
  matched: { targets: number; campaigns: number }
  changing: { targets: number; campaigns: number }
  excludedByReason: Record<string, number>
  blockedCampaignNames: string[]
  highestUniformAllowedCents: number | null
  commitmentCents: number
  ceiling: {
    verdict: 'ALLOWED' | 'REFUSED' | 'NO_CEILING'
    message: string
    grain: string | null
    label: string | null
    capCents: number | null
    remainingCents: number | null
  }
  committed: {
    committedCents: number
    pendingCents: number
    pendingCount: number
    amazonSpendCents: number | null
    amazonSpendDate: string | null
  }
  shareAgeDays: number | null
  confirmationText: string
  canPropose: boolean
  byCampaign: Array<{ campaignId: string; campaignName: string; changing: number; excluded: number; maxBidCents: number | null }>
  sampleTargets: Array<{ id: string; campaignName: string; matchType: string; fromCents: number | null; toCents: number; maxBidCents: number | null }>
  sampleTargetsTruncated: boolean
}

const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toFixed(2)}`)

/** The reason labels, in the order the sentence names them. Each is a different problem. */
const REASON_LABEL: Record<string, string> = {
  not_write_enabled: 'not write-enabled',
  suppressed_flag: 'deliberately suppressed',
  suppressed_by_bid: 'bids ≤€0.03, unflagged',
  over_campaign_ceiling: 'over the campaign’s bid ceiling',
  below_floor: 'below KT.6’s floor',
  no_change: 'already at this bid',
}

export function BidAction({
  term, market, unbid, onWrite,
}: {
  term: string
  market: string
  /** true when no campaign bids this term at all — the control changes shape entirely */
  unbid: boolean
  /** called when a write lands, so the change log beside this can show it without a reload */
  onWrite?: () => void
}) {
  const [bidEuros, setBidEuros] = useState('0.55')
  const [includeSuppressed, setIncludeSuppressed] = useState(false)
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  /** KT.7 — the proposal just raised, and whether the operator is confirming the APPLY of it. */
  const [proposalId, setProposalId] = useState<string | null>(null)
  const [applyConfirm, setApplyConfirm] = useState(false)
  const [applied, setApplied] = useState<{ ok: boolean; text: string; rows?: Array<{ outcome: string; campaignName: string; fromCents: number | null; toCents: number; reason?: string }> } | null>(null)

  const bidCents = useMemo(() => {
    const n = Math.round(Number(bidEuros.replace(',', '.')) * 100)
    return Number.isFinite(n) ? n : NaN
  }, [bidEuros])
  const bidValid = Number.isFinite(bidCents) && bidCents > 0 && bidCents <= 10_000

  const load = useCallback(async () => {
    if (!bidValid) { setPreview(null); return }
    setLoading(true); setErr(null)
    const q = new URLSearchParams({ market, term, bidCents: String(bidCents) })
    if (includeSuppressed) q.set('includeSuppressed', '1')
    try {
      // no-store: the ads read routes set Cache-Control private max-age=60, and a cached preview
      // would show a blast radius from a minute ago on a control that spends money (HV.2's trap).
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-actions/preview?${q}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`Could not work out what this would do (${r.status})`)
      setPreview(await r.json())
    } catch (e) { setErr((e as Error).message); setPreview(null) } finally { setLoading(false) }
  }, [market, term, bidCents, bidValid, includeSuppressed])

  // Debounced, because this runs on every keystroke in the bid box and each run is a real query
  // across every keyword target in the marketplace.
  useEffect(() => {
    if (unbid) return
    const t = setTimeout(() => { void load() }, 350)
    return () => clearTimeout(t)
  }, [load, unbid])

  const propose = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-actions/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market, term, bidCents, includeSuppressed }),
      })
      const body = await r.json().catch(() => ({}))
      if (r.status === 201) {
        // "1 targets" shipped in the first build and was caught by reading the rendered string.
        const n = Number(body.changing?.targets ?? 0)
        setResult({ ok: true, text: `Proposal raised for ${n} target${n === 1 ? '' : 's'}. Nothing has changed on Amazon yet.` })
        setProposalId(String(body.id ?? '') || null)
        setApplied(null)
        setConfirming(false)
        void load()
      } else {
        // 409 is a refusal, not a malformed request, and its message is already operator-ready.
        setResult({ ok: false, text: String(body.error ?? `Could not raise the proposal (${r.status})`) })
        setConfirming(false)
      }
    } catch (e) { setResult({ ok: false, text: (e as Error).message }); setConfirming(false) } finally { setLoading(false) }
  }, [market, term, bidCents, includeSuppressed, load])

  /**
   * KT.7 — apply the proposal. 🔴 This is the call that writes to Amazon.
   *
   * It sends only the proposal id: every guard is re-decided server-side from current state, because
   * the numbers in this component are already seconds to minutes old and bids on this account move
   * thousands of times a day. A client that posted its own radius would be asking the server to
   * write a set the server has not checked.
   */
  const apply = useCallback(async () => {
    if (!proposalId) return
    setLoading(true); setApplied(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-actions/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, includeSuppressed }),
      })
      const b = await r.json().catch(() => ({}))
      if (r.ok) {
        setApplied({ ok: true, text: String(b.summary ?? 'Applied.'), rows: b.rows })
        setProposalId(null)
        onWrite?.()
      } else {
        // 409 is a refusal, and its message already names what stopped it.
        setApplied({ ok: false, text: String(b.error ?? `The write was refused (${r.status})`), rows: b.rows })
      }
      setApplyConfirm(false)
      void load()
    } catch (e) { setApplied({ ok: false, text: (e as Error).message }); setApplyConfirm(false) } finally { setLoading(false) }
  }, [proposalId, includeSuppressed, load, onWrite])

  // ── the unbid case: no bid to change, and no destination to invent ─────────────────────────────
  if (unbid) {
    return (
      <section className="h10-kt-drsec">
        <h3>Act on this term</h3>
        <p className="h10-kt6-none">
          <Info size={13} />
          <span>
            <b>No campaign bids “{term}” in {market}, so there is no bid to change.</b> The action here
            is to start bidding it, and this page deliberately does not offer that: a new keyword needs
            a destination ad group, and there are 70 writable candidates in {market} with nothing to
            single one out. Choosing a destination is Keyword Harvest’s job, which already ranks
            candidates and states its reason for each.
          </span>
        </p>
      </section>
    )
  }

  const p = preview
  const refused = p?.ceiling.verdict === 'REFUSED'
  const reasons = p ? Object.entries(p.excludedByReason).filter(([, v]) => v > 0) : []

  return (
    <section className="h10-kt-drsec">
      <h3>Act on this term</h3>

      <div className="h10-kt6-row">
        <label className="h10-kt6-lab" htmlFor="kt6-bid">Set every bid to</label>
        <span className="h10-kt6-cur">€</span>
        <input
          id="kt6-bid" className="h10-kt6-in" inputMode="decimal" value={bidEuros}
          onChange={(e) => { setBidEuros(e.target.value); setResult(null) }}
          aria-label={`Bid in euros for ${term}`}
        />
        {loading && <Loader2 size={13} className="h10-kt6-spin" />}
      </div>
      {!bidValid && <p className="h10-kt6-warn">Enter a bid between €0.01 and €100.00.</p>}

      <label className="h10-kt6-check">
        <input type="checkbox" checked={includeSuppressed} onChange={(e) => { setIncludeSuppressed(e.target.checked); setResult(null) }} />
        <span>
          Include suppressed targets.{' '}
          <i>Off by default: a suppressed bid is delivery somebody switched off on purpose, and raising it switches it back on.</i>
        </span>
      </label>

      {err && <p className="h10-kt6-blind"><AlertTriangle size={13} /><span>{err}</span></p>}

      {p && (
        <>
          {/* ── the blast radius, both numbers, before anything can be clicked ───────────────── */}
          <div className="h10-kt6-radius">
            <div className="h10-kt6-nums">
              <span className="h10-kt6-big">{p.changing.targets}</span>
              <span className="h10-kt6-of">of {p.matched.targets} targets</span>
              <span className="h10-kt6-sep">·</span>
              <span className="h10-kt6-big">{p.changing.campaigns}</span>
              <span className="h10-kt6-of">of {p.matched.campaigns} campaigns</span>
              <span className="h10-kt6-commit">commits up to {eur(p.commitmentCents)}</span>
            </div>
            {/* verbatim from the server — see the header note on why this is not re-phrased here */}
            <p className="h10-kt6-say">{p.confirmationText}</p>
          </div>

          {reasons.length > 0 && (
            <ul className="h10-kt6-reasons">
              {reasons.map(([why, n]) => (
                <li key={why}>
                  <b>{n}</b> {REASON_LABEL[why] ?? why}
                </li>
              ))}
            </ul>
          )}

          {p.highestUniformAllowedCents != null && p.excludedByReason.over_campaign_ceiling > 0 && (
            <p className="h10-kt6-hint">
              <button type="button" onClick={() => setBidEuros((p.highestUniformAllowedCents! / 100).toFixed(2))}>
                Use {eur(p.highestUniformAllowedCents)} instead
              </button>{' '}
              — the highest bid every campaign here would accept.
            </p>
          )}

          {/* ── the ceiling ──────────────────────────────────────────────────────────────────── */}
          <p className={refused ? 'h10-kt6-blind' : p.ceiling.verdict === 'NO_CEILING' ? 'h10-kt6-note' : 'h10-kt6-ok'}>
            {refused ? <AlertTriangle size={13} /> : <Info size={13} />}
            <span>{p.ceiling.message}</span>
          </p>
          {p.committed.pendingCount > 0 && (
            <p className="h10-kt6-note">
              <Info size={13} />
              <span>
                {p.committed.pendingCount === 1
                  ? `1 other proposal for ${market} is already waiting, committing up to ${eur(p.committed.pendingCents)} if it is approved.`
                  : `${p.committed.pendingCount} other proposals for ${market} are already waiting, committing up to ${eur(p.committed.pendingCents)} between them if they are all approved.`}
                {' '}Pending proposals are not counted against the ceiling, because a proposal spends nothing until it is applied.
              </span>
            </p>
          )}

          {/* ── what would change, named ─────────────────────────────────────────────────────── */}
          {p.sampleTargets.length > 0 && (
            <details className="h10-kt6-det">
              <summary>
                Show the {p.changing.targets} target{p.changing.targets === 1 ? '' : 's'} that would change
              </summary>
              <table className="h10-kt6-tbl">
                <thead><tr><th>Campaign</th><th>Match</th><th className="n">Now</th><th className="n">Proposed</th><th className="n">Cap</th></tr></thead>
                <tbody>
                  {p.sampleTargets.map((t) => (
                    <tr key={t.id}>
                      <td title={t.campaignName}>{t.campaignName}</td>
                      <td>{t.matchType.toLowerCase()}</td>
                      <td className="n">{eur(t.fromCents)}</td>
                      <td className="n"><b>{eur(t.toCents)}</b></td>
                      <td className="n">{eur(t.maxBidCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {p.sampleTargetsTruncated && (
                <p className="h10-kt6-trunc">
                  The first 25 are listed; all {p.changing.targets} are recorded on the proposal itself.
                </p>
              )}
            </details>
          )}

          {/* ── the act ──────────────────────────────────────────────────────────────────────── */}
          {result && (
            <p className={result.ok ? 'h10-kt6-ok' : 'h10-kt6-blind'}>
              {result.ok ? <Check size={13} /> : <AlertTriangle size={13} />}<span>{result.text}</span>
            </p>
          )}

          {/* ── KT.7 · the apply step, offered only once a proposal exists ──────────────────── */}
          {applied && (
            <div className={applied.ok ? 'h10-kt7-done' : 'h10-kt6-blind'}>
              {applied.ok ? <Check size={13} /> : <AlertTriangle size={13} />}
              <div>
                <p>{applied.text}</p>
                {applied.rows && applied.rows.some((x) => x.outcome !== 'APPLIED') && (
                  <ul className="h10-kt7-rows">
                    {applied.rows.filter((x) => x.outcome !== 'APPLIED').slice(0, 10).map((x, i) => (
                      <li key={i}><b>{x.outcome.toLowerCase()}</b> · {x.campaignName} · {x.reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {proposalId && !applied?.ok && (
            applyConfirm ? (
              <div className="h10-kt7-apply">
                <p>
                  <b>Write this to Amazon?</b> Everything is re-checked against the account as it is
                  right now — the targets, the allowlist, the ceiling, the suppressions, and whether any
                  campaign is currently bid-suppressed. If any of it has moved since the proposal was
                  raised, the write is refused rather than partly applied. It can be undone in one
                  action for 24 hours afterwards.
                </p>
                <div className="h10-kt6-cbtns">
                  <button type="button" className="yes" onClick={() => void apply()} disabled={loading}>
                    {loading ? 'Writing…' : 'Yes, write it'}
                  </button>
                  <button type="button" className="no" onClick={() => setApplyConfirm(false)}>
                    <X size={12} /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="h10-kt7-go" onClick={() => setApplyConfirm(true)} disabled={loading}>
                Apply this proposal — writes to Amazon
              </button>
            )
          )}

          {!confirming ? (
            <button
              type="button" className="h10-kt6-go"
              disabled={!p.canPropose || loading}
              onClick={() => { setConfirming(true); setResult(null) }}
            >
              {refused ? 'Refused by the ceiling' : p.changing.targets === 0 ? 'Nothing to propose' : `Propose this change to ${p.changing.targets} target${p.changing.targets === 1 ? '' : 's'}`}
            </button>
          ) : (
            /* A confirm step, positioned INSIDE the drawer's own flow rather than fixed — KT.4 paid
               for this: a fixed overlay inside a portalled drawer renders behind it. */
            <div className="h10-kt6-confirm">
              <p>
                <b>Raise this proposal?</b> It will change nothing on Amazon. {p.changing.targets} target
                {p.changing.targets === 1 ? '' : 's'} in {p.changing.campaigns} campaign
                {p.changing.campaigns === 1 ? '' : 's'} would be set to {eur(p.requestedBidCents)},
                committing up to {eur(p.commitmentCents)}, and the proposal waits for approval before
                anything is written.
              </p>
              <div className="h10-kt6-cbtns">
                <button type="button" className="yes" onClick={() => void propose()} disabled={loading}>
                  {loading ? 'Raising…' : 'Yes, raise the proposal'}
                </button>
                <button type="button" className="no" onClick={() => setConfirming(false)}>
                  <X size={12} /> Cancel
                </button>
              </div>
            </div>
          )}

          {/* 🔴 The allowlist clause is CONDITIONAL. It read "the 0 targets in campaigns that are not
              on the live-write allowlist could not be changed" on a row where every target is
              writable — a true sentence about nothing, which is how a reader learns to skip the
              whole paragraph. Found by clicking a one-target DE row. */}
          <p className="h10-kt6-foot">
            A proposal changes nothing by itself. Applying one is a live bid write and goes through the
            account’s write gate, and it is undoable in one action for 24 hours.
            {(p.excludedByReason.not_write_enabled ?? 0) > 0 && (
              <>
                {' '}That gate is also why the {p.excludedByReason.not_write_enabled} target
                {p.excludedByReason.not_write_enabled === 1 ? '' : 's'} in campaigns that are not on the
                live-write allowlist cannot be changed from here even after approval.
              </>
            )}
          </p>
        </>
      )}
    </section>
  )
}
