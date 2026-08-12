'use client'

/**
 * NEG.2 — the term drawer: everywhere one term is blocked, and what it earns.
 *
 * The one question: **everywhere this term is blocked, what it costs, and what would still block
 * it if I removed the ones in front of me.**
 *
 * The grid can already group by term. What it cannot do is put the N negations of one term in
 * front of you with their per-row state, beside the traffic they may or may not be blocking. That
 * is this section, and nothing else.
 *
 * Read-only. It creates no negative, retires none, changes nothing at Amazon. Every write action
 * belongs to NEG.3, and `NegWriteActions.onRowAction` is deliberately untouched here — opening a
 * drawer is a read, and wiring it through the write seam would spend a seam NEG.3 needs.
 *
 * ── Three things it must never do ────────────────────────────────────────────────────────────
 *
 *   1. **Never collapse `negated in` / `runs in` / `overlap` into one number.** `overlap = 0`
 *      means the negative is *routing* traffic rather than blocking it — the difference between a
 *      funnel working and money being lost. The study's conclusion flipped twice on exactly this.
 *   2. **Never call a euro figure "lost revenue".** The loss is at most the overlap and usually a
 *      fraction of it.
 *   3. **Never let silence stand for "no remainder".** When the page is scoped, the drawer shows a
 *      subset; without §7's sentence, archiving that subset reads as "I have unblocked this term".
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Info, ShieldCheck, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { NegSlotProps, NegMatchType, NegAttribution } from './slot-contract'

interface Protection { term: string; mode: string; matchType: string; marketplace: string | null; campaignId: string | null; reason: string | null }
interface Negation {
  id: string
  level: 'AD_GROUP' | 'CAMPAIGN'
  campaignId: string; campaignName: string; campaignStatus: string
  adGroupId: string; adGroupName: string; externalAdGroupId: string | null
  market: string; status: string
  atAmazon: boolean; blockingNow: boolean
  addedAt: string
  attribution: NegAttribution; attributionLabel: string
  match: NegMatchType; matchRaw: string
  inScope: boolean; overlaps: boolean
}
interface Traffic {
  externalAdGroupId: string; adGroupName: string | null; campaignName: string | null
  impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number
  negated: boolean
}
interface TermContext {
  term: { key: string; display: string; protectedBy: Protection[] }
  spread: { rows: number; adGroups: number; campaigns: number; markets: string[] }
  comparable: { negatedAdGroups: number; campaignLevel: number; campaignLevelAtAmazon: number }
  negations: Negation[]
  window: { days: number; since: string }
  performance: { impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number; acos: number | null }
  runsIn: Traffic[]
  overlap: Traffic[]
  overlapRows: number
  history: { days: number; impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number }
  remainder: { inScope: number; total: number; remainderRows: number; remainderCampaigns: number; scopeIsWholeAccount: boolean }
}

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (v: number) => `${(v * 100).toFixed(0)}%`
const dayMonth = (iso: string) => {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`
}
const MATCH_LABEL: Record<NegMatchType, string> = { EXACT: 'Exact', PHRASE: 'Phrase', ASIN: 'ASIN', OTHER: 'Unrecognised' }

export function NegTermDrawer({ scope, push, focus, view }: NegSlotProps) {
  const [data, setData] = useState<TermContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** null = the term has no negation at all — a different fact from a failed read. */
  const [missing, setMissing] = useState(false)

  const close = useCallback(() => push({ focus: '' }), [push])

  // Escape closes. Bound on the document because the drawer is not focus-trapped — an operator
  // scrolling the list should be able to dismiss it without clicking into it first.
  useEffect(() => {
    if (!focus) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [focus, close])

  useEffect(() => {
    if (!focus) { setData(null); setErr(null); setMissing(false); return }
    let alive = true
    setLoading(true); setErr(null); setMissing(false)
    const p = new URLSearchParams({ term: focus, market: scope.market })
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, adGroup: scope.adGroup })) {
      if (v) p.set(k, v)
    }
    void fetch(`${getBackendUrl()}/api/advertising/negatives/term-context?${p.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        // 🔴 TWO different 404s reach here and they must not render the same sentence:
        //   · ours — "nothing negates this term", one of the four empty states, carrying
        //     `code: 'term_not_negated'`;
        //   · Fastify's — the route is not deployed yet, carrying `{message, error, statusCode}`
        //     and no `code` at all. A commit is two deploys, so during the window between the web
        //     deploy and the API deploy EVERY term would otherwise report "nothing negates this",
        //     which is both false and reassuring.
        // The discriminator is the code, never the status.
        if (r.status === 404) {
          const body = await r.json().catch(() => ({} as { code?: string }))
          if (alive) {
            if (body?.code === 'term_not_negated') { setMissing(true); setData(null) }
            else setErr('This view is not available yet — the term-context read is not deployed on this environment.')
          }
          return null
        }
        if (!r.ok) throw new Error(`Could not load this term (${r.status})`)
        return r.json()
      })
      .then((d) => { if (alive && d) { setData(d as TermContext); setErr(null) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [focus, scope.market, scope.line, scope.portfolio, scope.campaign, scope.adGroup])

  if (!focus) return null

  return (
    <>
      {/* The backdrop is a button so a click and a keyboard activation both close it, and so it
          carries an accessible name rather than being an unlabelled div that swallows clicks. */}
      <button type="button" className="h10-ngd-back" aria-label="Close term detail" onClick={close} />
      <aside className="h10-ngd" role="dialog" aria-modal="true" aria-label={`Everywhere “${focus}” is blocked`}>
        <header className="h10-ngd-head">
          <div className="h10-ngd-title">
            <h3>{data?.term.display ?? focus}</h3>
            {data && (
              <p>
                {num(data.spread.rows)} negation{data.spread.rows === 1 ? '' : 's'} ·{' '}
                {num(data.spread.adGroups)} ad group{data.spread.adGroups === 1 ? '' : 's'} ·{' '}
                {num(data.spread.campaigns)} campaign{data.spread.campaigns === 1 ? '' : 's'}
                {data.spread.markets.length > 0 && <> · {data.spread.markets.join(' ')}</>}
              </p>
            )}
          </div>
          <button type="button" className="h10-ngd-close" onClick={close} aria-label="Close"><X size={15} /></button>
        </header>

        {data && data.term.protectedBy.length > 0 && (
          <p className="h10-ngd-prot">
            <ShieldCheck size={13} />
            <span>
              <b>Protected.</b> No automation can negate this term
              {data.term.protectedBy.map((p) => (
                <span key={p.term}> — it {p.matchType === 'CONTAINS' ? 'contains' : p.matchType === 'PREFIX' ? 'starts with' : 'is'} “{p.term}”{p.reason ? ` (${p.reason})` : ''}</span>
              ))}
              . The negations below predate that rule; the protection stops new ones, it does not
              remove these.
            </span>
          </p>
        )}

        {loading && <p className="h10-ngd-msg">Loading…</p>}

        {/* 🔴 Four empty states, never one. "Broken", "not negated", "negated but silent" and "no
            search-term data for this market at all" are four different facts, and the operator's
            next action is different for each. */}
        {err && <p className="h10-ngd-bad"><AlertTriangle size={13} /><span>{err}</span></p>}
        {missing && (
          <p className="h10-ngd-msg">
            <b>Nothing negates “{focus}”.</b> No negation of this term exists anywhere in the account,
            so there is nothing to unblock.
          </p>
        )}

        {data && (
          <>
            {/* ── 1 · the three numbers, as three numbers ─────────────────────────────────── */}
            <section className="h10-ngd-sec">
              <div className="h10-ngd-three">
                <span className="cell">
                  <b>{num(data.comparable.negatedAdGroups)}</b>
                  <i>negated in</i>
                  <em>ad groups Amazon can match traffic to</em>
                </span>
                <span className="cell">
                  <b>{num(data.runsIn.length)}</b>
                  <i>runs in</i>
                  <em>ad groups that took impressions in {data.window.days}d</em>
                </span>
                <span className={`cell ${data.overlap.length > 0 ? 'hot' : 'cool'}`}>
                  <b>{num(data.overlap.length)}</b>
                  <i>overlap</i>
                  <em>{data.overlap.length === 0 ? 'nowhere it is negated took traffic' : `${num(data.overlapRows)} negation${data.overlapRows === 1 ? '' : 's'} to clear it`}</em>
                </span>
              </div>
              <p className="h10-ngd-lawnote">
                <Info size={12} />
                <span>
                  {data.overlap.length === 0
                    ? <>These are three separate numbers and stay that way. <b>Overlap 0</b> means every ad group that negates this term is a different one from every ad group taking its traffic — the negative is <b>routing</b> the term, not blocking it.</>
                    : <>These are three separate numbers and stay that way. <b>Overlap {num(data.overlap.length)}</b> means the term is negated in {data.overlap.length === 1 ? 'an ad group that is also' : 'ad groups that are also'} taking its traffic. Clearing that is <b>{num(data.overlapRows)} separate write{data.overlapRows === 1 ? '' : 's'}</b>, because one ad group can negate a term at more than one match type.</>}
                  {data.comparable.campaignLevel > 0 && (
                    <> {num(data.comparable.campaignLevel)} campaign-wide negation{data.comparable.campaignLevel === 1 ? '' : 's'} {data.comparable.campaignLevel === 1 ? 'is' : 'are'} excluded from the first number: {data.comparable.campaignLevel === 1 ? 'it blocks' : 'they block'} at the campaign, not in an ad group Amazon reports traffic for
                    {data.comparable.campaignLevelAtAmazon === 0 && <>, and {data.comparable.campaignLevel === 1 ? 'it has' : 'none has'} an Amazon id at all</>}.</>
                  )}
                </span>
              </p>
            </section>

            {/* ── 2 · what it earns ──────────────────────────────────────────────────────── */}
            <section className="h10-ngd-sec">
              <h4>What it earns</h4>
              <div className="h10-ngd-perf">
                {([
                  ['Impressions', num(data.performance.impressions)],
                  ['Clicks', num(data.performance.clicks)],
                  ['Spend', eur(data.performance.spendCents)],
                  ['Orders', num(data.performance.orders)],
                  ['Sales', eur(data.performance.salesCents)],
                  ['ACoS', data.performance.acos == null ? '—' : pct(data.performance.acos)],
                ] as const).map(([label, value]) => (
                  <span key={label} className="m"><b>{value}</b><i>{label}</i></span>
                ))}
              </div>
              <p className="h10-ngd-window">
                Account-wide over the last {data.window.days} days, from the search-term report — not
                scoped to the ad groups below, because a term earns wherever it runs.
              </p>

              {/* 🔴 The two windows disagreeing IS the finding. Only say "before that" when the
                  short window is genuinely empty; otherwise the 120d figure includes the 30d and
                  the phrasing would be double-counting in words. */}
              {data.performance.impressions === 0 && data.history.orders > 0 && (
                <p className="h10-ngd-hist">
                  <AlertTriangle size={13} />
                  <span>
                    <b>No impressions in the last {data.window.days} days.</b> {num(data.history.orders)} order
                    {data.history.orders === 1 ? '' : 's'} and {eur(data.history.salesCents)} in the {data.history.days} days
                    before that, on {eur(data.history.spendCents)} of spend.
                  </span>
                </p>
              )}
              {data.performance.impressions === 0 && data.history.orders === 0 && data.history.impressions === 0 && (
                <p className="h10-ngd-msg sm">
                  No search-term rows for this term in the last {data.history.days} days either. That is an
                  absence of data, not a measured zero — the term may simply never have been searched.
                </p>
              )}
            </section>

            {/* ── 3 · where it still runs ────────────────────────────────────────────────── */}
            <section className="h10-ngd-sec">
              <h4>Where it still runs <span className="ct">{num(data.runsIn.length)}</span></h4>
              {data.runsIn.length === 0 ? (
                <p className="h10-ngd-msg sm">No ad group took an impression for this term in the last {data.window.days} days.</p>
              ) : (
                <ul className="h10-ngd-runs">
                  {data.runsIn.map((r) => (
                    <li key={r.externalAdGroupId} className={r.negated ? 'on' : ''}>
                      <span className="nm">
                        <b>{r.adGroupName ?? r.externalAdGroupId}</b>
                        {r.campaignName && <i>{r.campaignName}</i>}
                        {!r.adGroupName && <em className="unk" title="This ad group is not in our mirror — the traffic is real, the name is missing">not in our mirror</em>}
                      </span>
                      {r.negated && <span className="ovl" title="This ad group both negates the term and took impressions for it — the actual finding">also negates it</span>}
                      <span className="mt">{num(r.impressions)} impr · {num(r.clicks)} clicks · {r.orders} order{r.orders === 1 ? '' : 's'} · {eur(r.salesCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── 4 · every negation ─────────────────────────────────────────────────────── */}
            <section className="h10-ngd-sec">
              <h4>
                Every negation <span className="ct">{num(data.negations.length)}</span>
                {!data.remainder.scopeIsWholeAccount && <span className="sub">{num(data.remainder.inScope)} in your scope, shown first</span>}
                {/* 🔴 Bulk is issued HERE, against N explicit negation ids — never from a grid
                    selection over a term row. A term is not an Amazon object; every bulk action is
                    N real writes reporting N outcomes. */}
                {data.negations.some((n) => n.status !== 'ARCHIVED') && (
                  <button type="button" className="h10-ngd-bulk" onClick={() => push({ retireTerm: data.term.key })}>
                    Remove several…
                  </button>
                )}
              </h4>
              <ul className="h10-ngd-negs">
                {data.negations.map((n) => (
                  <li key={n.id} className={`${n.inScope ? 'ins' : 'out'}${n.overlaps ? ' ovl' : ''}`}>
                    <span className="sc">
                      {n.level === 'CAMPAIGN'
                        ? <b className="camp">campaign-wide</b>
                        : <b title={n.adGroupName}>{n.adGroupName}</b>}
                      <i title={n.campaignName}>{n.campaignName}</i>
                    </span>
                    <span className="fl">
                      <span className="mt" title={`stored as “${n.matchRaw}”`}>{MATCH_LABEL[n.match]}</span>
                      <span className="mk">{n.market}</span>
                      <span className={`st ${n.campaignStatus.toLowerCase()}`}>{n.campaignStatus.toLowerCase()}</span>
                      {n.atAmazon
                        ? <span className="am yes">at Amazon</span>
                        : <span className="am no" title="Amazon has never confirmed this negation — it blocks nothing there">never confirmed</span>}
                      {n.blockingNow && <span className="bl">blocking</span>}
                      {n.overlaps && <span className="ov" title="This ad group also took impressions for the term in the window">overlaps</span>}
                    </span>
                    <span className="meta">
                      {dayMonth(n.addedAt)} · <span className={`by ${n.attribution}`}>{n.attributionLabel}</span>
                      {/* NEG.3b — the removal entry point. Already-archived rows get no action:
                          they were archived ON Amazon and mirrored in, so there is nothing to
                          remove and a no-op logged as a retirement would be a false record. */}
                      {n.status !== 'ARCHIVED' && (
                        <button type="button" className="h10-ngd-rm" onClick={() => push({ retire: n.id })} title={n.atAmazon ? 'Archive this negation at Amazon — cannot be undone' : 'Remove our record; Amazon never confirmed this one'}>
                          {n.atAmazon ? 'Archive' : 'Remove'}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {/* ── 5 · 🔴 the remainder sentence — the guard this section exists for ──────── */}
            {data.remainder.remainderRows > 0 ? (
              <p className="h10-ngd-rem">
                <AlertTriangle size={13} />
                <span>
                  <b>{num(data.remainder.inScope)} of {num(data.remainder.total)} negations are in your scope.</b>{' '}
                  Removing {data.remainder.inScope === 1 ? 'it' : 'them'} would leave{' '}
                  <b>{num(data.remainder.remainderRows)} still blocking this term</b> in{' '}
                  {num(data.remainder.remainderCampaigns)} campaign{data.remainder.remainderCampaigns === 1 ? '' : 's'} outside it.
                </span>
              </p>
            ) : (
              <p className="h10-ngd-rem ok">
                <Info size={13} />
                <span>
                  {data.remainder.scopeIsWholeAccount
                    ? <><b>Every negation of this term is listed above.</b> Your scope is the whole account, so there is no remainder.</>
                    : <><b>All {num(data.remainder.total)} negations of this term are inside your scope.</b> Nothing outside it blocks this term.</>}
                </span>
              </p>
            )}

            <p className="h10-ngd-foot">
              Read-only. Removing a negation lands in NEG.3; a term is not an Amazon object, so
              acting on one is always {num(data.spread.rows)} separate write{data.spread.rows === 1 ? '' : 's'} with
              {data.spread.rows === 1 ? ' its own outcome' : ' their own outcomes'}.
              {view === 'terms' && <> You are on the term grain — the grid behind this drawer groups; Amazon does not.</>}
            </p>
          </>
        )}
      </aside>
    </>
  )
}
