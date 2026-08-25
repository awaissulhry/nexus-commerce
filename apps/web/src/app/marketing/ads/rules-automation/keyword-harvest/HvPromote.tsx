'use client'

/**
 * ⛔ PARKED 2026-08-18 (U7) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the promote dialog (?confirm=) — preview then write.
 * Why it left: the Keyword Harvest tab is now Helium 10's shape — the pill
 *   [ Rules View | Ad Group View ] over one card, and nothing else
 *   (`KeywordHarvestRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.3, §7.8).
 * Candidate home: **Suggestions** — the approve action.
 *
 * ⚠ Nothing here was changed, no endpoint was retired, and the harvest engine's own arming is
 * untouched. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * HV.4 — the paired write: promote a candidate and negate it at its source, as one action.
 *
 * 🔴 **The first control on this page that spends money.**
 *
 * ── What it does not do ───────────────────────────────────────────────────────────────────────
 *
 * It arms no automation. Harvest rules are capped at PROPOSE by `ads-graduation.ts` — it caps
 * *automations* because structural actions have no retirement path. An operator pressing a button
 * is a different actor, and the dialog says so rather than leaving anyone to read this as
 * arming something.
 *
 * ── D4, in full ───────────────────────────────────────────────────────────────────────────────
 *
 * Every write states **what, how many, where, at what cost, and whether it can be undone**, in a
 * sentence, before it happens. Every value in that sentence is computed server-side by
 * `planPromotion` — the same function the write executes — so the number shown and the number
 * written cannot diverge. That is defect ② closed in the architecture rather than by discipline.
 *
 * ── The reversal is asymmetric, and the dialog refuses to pretend otherwise ────────────────────
 *
 * There is **no Undo**, because there is no honest one. The keyword can be archived from here; the
 * negative is retired on Negative Targeting (NEG.3b shipped that path) and **archiving is
 * irreversible at Amazon** — re-negating later creates a NEW negative, not a toggle. An "Undo" that
 * reversed only the keyword would be the most expensive kind of half-truth, so it is not offered.
 *
 * ── Three outcomes, never one "done" ──────────────────────────────────────────────────────────
 *
 * C7: **acted · refused · failed**, counted separately and readable back to a term. A bulk write is
 * N independent writes with N outcomes; a single success message would be a fourth lie.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { AlertTriangle, ArrowRight, ExternalLink, Loader2, ShieldAlert, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { HvSlotProps } from './slot-contract'
import { emitAdsChange } from '../_shared/adsBus'

interface PlanRow {
  candidateId: string
  term: string
  market: string
  sourceAdGroupName: string
  destinationAdGroupName: string
  destinationCampaignName: string
  matchType: string
  observedCpcCents: number | null
  bidCents: number
  clamped: null | { from: number; to: number; ceilingCents: number; campaignName: string }
  wouldNegateAtSource: boolean
  negateReason: string
  blocked: null | { deniedAt: string; reason: string; half: 'keyword' | 'negative' }
  promotable: boolean
  evidence: { note?: string }
}
interface Plan { rows: PlanRow[]; reach: { campaigns: number; ofTotal: number }; promotable: number; blocked: number }
interface Outcome {
  candidateId: string; query: string; bidCents: number
  destinationAdGroupId: string | null; targetId: string | null; externalTargetId: string | null
  reachedAmazon: boolean
  negative: { attempted: boolean; scope: string; externalTargetId: string | null; reachedAmazon: boolean; refusal?: { deniedAt: string; reason: string }; error?: string } | null
  negateReason: string
  outcome: 'acted' | 'refused' | 'failed'
  refusal?: { deniedAt: string; reason: string }
  error?: string
}
interface WriteResult { batchId: string; acted: number; refused: number; failed: number; outcomes: Outcome[] }

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const num = (n: number) => n.toLocaleString('en-IE')

export function HvPromote({ scope, push, reload, confirm }: HvSlotProps) {
  // The queued candidates live in the URL, so a confirm is reviewable before it is acted on.
  const ids = confirm.length ? confirm : null
  const [plan, setPlan] = useState<Plan | null>(null)
  const [result, setResult] = useState<WriteResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const close = useCallback(() => { setPlan(null); setResult(null); setErr(null); push({ confirm: '' }) }, [push])

  // Fetch the plan whenever a selection opens the dialog. `no-store`: these routes serve up to 60s
  // stale otherwise, and a stale plan would show a bid that is not the one about to be written.
  useEffect(() => {
    if (!ids?.length) return
    let alive = true
    setBusy(true); setErr(null)
    const p = new URLSearchParams({ market: scope.market })
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, adGroup: scope.adGroup })) if (v) p.set(k, v)
    for (const id of ids) p.append('ids', id)
    void fetch(`${getBackendUrl()}/api/advertising/harvest-promote?${p.toString()}`, { cache: 'no-store', credentials: 'include' })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`); return r.json() })
      .then((d) => { if (alive) setPlan(d as Plan) })
      .catch((e) => { if (alive) setErr((e as Error).message) })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [ids, scope.market, scope.line, scope.portfolio, scope.campaign, scope.adGroup])

  const write = useCallback(async () => {
    if (!ids?.length) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/harvest-promote`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ market: scope.market, ids, confirm: true, line: scope.line || null, portfolio: scope.portfolio || null, campaign: scope.campaign || null, adGroup: scope.adGroup || null }),
      })
      const j = await res.json()
      if (!res.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${res.status}`)
      setResult(j as WriteResult)
      reload()
      // RT.1 — a promotion creates a keyword AND negates it at source — two subjects, one operation.
      emitAdsChange('ads.keyword.changed')
      emitAdsChange('ads.negative.changed')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }, [ids, scope, reload])

  if (!ids?.length) return null

  return (
    <div className="h10-hv-wmodal" role="dialog" aria-modal="true" aria-label="Promote candidates">
      <div className="card">
        <div className="hd">
          <b>{result ? 'What happened' : `Promote ${num(ids.length)} candidate${ids.length === 1 ? '' : 's'}`}</b>
          <button type="button" className="x" onClick={close} aria-label="Close"><X size={14} /></button>
        </div>

        {busy && !plan && <p className="load"><Loader2 size={14} className="spin" /> Working out exactly what this would do…</p>}
        {err && <p className="bad"><AlertTriangle size={13} /> {err}</p>}

        {/* ── the outcome, three ways ─────────────────────────────────────────────────────── */}
        {result ? (
          <>
            <p className="sum">
              <b className="ok">{num(result.acted)} acted</b>
              {result.refused > 0 && <b className="ref">{num(result.refused)} refused</b>}
              {result.failed > 0 && <b className="fail">{num(result.failed)} failed</b>}
              <i>batch {result.batchId}</i>
            </p>
            <ul className="outs">
              {result.outcomes.map((o) => (
                <li key={o.candidateId} className={o.outcome}>
                  <span className="t">{o.query}</span>
                  <span className="d">
                    {o.outcome === 'acted' ? (
                      <>
                        {/* 🔴 reachedAmazon, never "created". 209 of the engine's 218 graduations
                            reported success and do not exist at Amazon. */}
                        {o.reachedAmazon
                          ? <b className="ok">keyword live at Amazon</b>
                          : <b className="warn">keyword created here but NOT at Amazon</b>}
                        {o.externalTargetId && <i>id {o.externalTargetId}</i>}
                        {' · '}
                        {o.negative?.attempted
                          ? (o.negative.refusal
                            ? <b className="warn">negative refused: {o.negative.refusal.deniedAt}</b>
                            : o.negative.reachedAmazon
                              ? <b className="ok">negative live at source</b>
                              : <b className="warn">negative created here but NOT at Amazon</b>)
                          : <b className="muted">no negative — {o.negateReason}</b>}
                      </>
                    ) : o.outcome === 'refused' ? (
                      <b className="ref">{o.refusal?.deniedAt}: {o.refusal?.reason}</b>
                    ) : (
                      <b className="fail">{o.error}</b>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="rev">
              <ShieldAlert size={12} />
              <span>
                <b>There is no undo.</b> A keyword can be archived from this page; a negative is retired on{' '}
                <a className="lnk" href="/marketing/ads/rules-automation/negative-targeting">Negative Targeting <ExternalLink size={10} /></a>,
                and archiving is <b>irreversible at Amazon</b> — re-negating later creates a new negative, not a toggle.
              </span>
            </p>
            <button type="button" className="go" onClick={close}>Done</button>
          </>
        ) : plan ? (
          <>
            {/* ── D4 — the full sentence, before anything happens ──────────────────────── */}
            {plan.promotable > 0 && (
              <div className="say">
                <p>
                  <b>Create {num(plan.promotable)} exact keyword{plan.promotable === 1 ? '' : 's'}</b>
                  {plan.rows.filter((r) => r.promotable).length === 1 && (
                    <> in <b>{plan.rows.find((r) => r.promotable)!.destinationCampaignName} › {plan.rows.find((r) => r.promotable)!.destinationAdGroupName}</b></>
                  )}
                  {' at '}
                  <b>{(() => {
                    const bs = plan.rows.filter((r) => r.promotable).map((r) => r.bidCents)
                    const lo = Math.min(...bs), hi = Math.max(...bs)
                    return lo === hi ? eur(lo) : `${eur(lo)}–${eur(hi)}`
                  })()}</b>
                  {' '}(each bid is that term's own observed CPC
                  {plan.rows.some((r) => r.promotable && r.clamped) && <>; {num(plan.rows.filter((r) => r.promotable && r.clamped).length)} clamped by the destination campaign's ceiling</>}
                  ), and <b>add {num(plan.rows.filter((r) => r.promotable && r.wouldNegateAtSource).length)} negative exact{plan.rows.filter((r) => r.promotable && r.wouldNegateAtSource).length === 1 ? '' : 's'}</b>{' '}
                  in the ad group{plan.rows.filter((r) => r.promotable && r.wouldNegateAtSource).length === 1 ? '' : 's'} that found them.
                  {' '}This reaches <b>{num(plan.reach.campaigns)} of {num(plan.reach.ofTotal)} campaigns</b>.
                </p>
                <p className="rev">
                  <ShieldAlert size={12} />
                  <span>
                    The keywords can be archived from this page. <b>The negatives cannot be un-archived at Amazon</b> —
                    re-negating later creates a new negative. <b>There is no undo for the pair.</b>
                  </span>
                </p>
                <p className="note">
                  This does not arm any automation. Harvest rules stay capped at Propose —
                  that ceiling governs automations, not you.
                </p>
              </div>
            )}

            <ul className="rowlist">
              {plan.rows.map((r) => (
                <li key={r.candidateId} className={r.promotable ? 'ok' : 'no'}>
                  <span className="t">
                    {r.term}
                    <i>{r.market} · {r.sourceAdGroupName}</i>
                  </span>
                  {r.promotable ? (
                    <>
                      <span className="arrow"><ArrowRight size={13} /></span>
                      <span className="dest">
                        {r.destinationAdGroupName}
                        <i>{r.destinationCampaignName}</i>
                      </span>
                      <span className="bid">
                        <b>{eur(r.bidCents)}</b>
                        {r.clamped
                          ? <i className="clamp" title={`Its own CPC is ${eur(r.clamped.from)}; ${r.clamped.campaignName} caps bids at ${eur(r.clamped.ceilingCents)}`}>clamped from {eur(r.clamped.from)}</i>
                          : <i>its own CPC</i>}
                      </span>
                      <span className={`neg ${r.wouldNegateAtSource ? 'yes' : 'no'}`} title={r.negateReason}>
                        {r.wouldNegateAtSource ? '+ negative at source' : 'no negative'}
                      </span>
                    </>
                  ) : (
                    // 🔴 Two different not-permitted reasons need two different sentences.
                    <span className="why">
                      {r.blocked
                        ? <><ShieldAlert size={12} /> <b>{r.blocked.half === 'negative' ? 'The negative half is refused' : 'The keyword half is refused'}</b> — {r.blocked.reason} <i>({r.blocked.deniedAt})</i>{r.blocked.half === 'negative' && <> Promoting without it would leave the source competing, so the pair is refused.</>}</>
                        : <><AlertTriangle size={12} /> <b>No destination chosen.</b> Promoting now would create the keyword back in <b>{r.sourceAdGroupName}</b> and would not negate it. <button type="button" className="lnk" onClick={() => { close(); push({ row: r.term }) }}>Choose a destination</button></>}
                    </span>
                  )}
                </li>
              ))}
            </ul>

            <div className="act">
              <Button size="sm" onClick={close}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => void write()} disabled={busy || plan.promotable === 0}>
                {busy ? <><Loader2 size={13} className="spin" /> Writing…</> : plan.promotable === 0 ? 'Nothing can be promoted' : `Promote ${num(plan.promotable)} and negate at source`}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The grid's selection bar. It writes the selection into the URL rather than into state, so the
 * confirm dialog it opens is a link — reviewable before anyone spends money (§4.11).
 */
export function promoteSelectionActions(queue: (ids: string[]) => void) {
  return (ids: string[], clear: () => void) => (
    <button type="button" className="h10-hv-promote" onClick={() => { queue(ids); clear() }}>
      Promote {ids.length} &amp; negate at source
    </button>
  )
}
