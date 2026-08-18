'use client'

/**
 * ⛔ PARKED 2026-08-18 (U5) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the Attention section: contradictions, alerts and the negations that need review.
 * Why it left: the Negative Targeting tab is now Helium 10's shape — one rules grid and nothing
 *   else (`NegativeRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.4, §7.6).
 * Candidate home: **Suggestions** — every row is a proposal to act on.
 *
 * ⚠ Nothing here was changed, no endpoint was retired, and NO PROTECTION WAS REMOVED: the
 * protected-terms whitelist, the converting-term guard and the write gate live on the server and
 * are still armed. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * NEG.4 — attention: what is wrong right now.
 *
 * Read-only. It composes the two sections before it rather than rebuilding them: every row links
 * into NEG.2's drawer (`?focus=`) and offers NEG.3's removal (`?retire=`).
 *
 * ── 🔴 Zero has to be rendered well, because two of the three lists are at or near it ─────────
 *
 * A detector that finds nothing must state its own denominator — *"0 of 942 blocking negatives are
 * in conflict"* — and it must be distinguishable from a detector that never ran. An empty box says
 * "broken" to anyone who has been burned before, and it should.
 *
 * The payload carries two things that exist purely to make a zero legible:
 *   `conflicts.overlapsRelaxed`  — the same join without the blocking filter. Non-zero ⇒ the join
 *                                  works and the zero above it is a real policy result.
 *   `coverage.searchTermRows`    — a real count of rows read. Zero ⇒ the READ failed, and this
 *                                  component refuses to claim "nothing is wrong" in that case.
 *
 * ── The three numbers, never collapsed ────────────────────────────────────────────────────────
 *
 * `negated in` / `runs in` / `overlap` render as three separate figures. The study's conclusion
 * flipped twice on exactly this, and the page is built so it cannot flip a third time.
 */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, Check, Info, ShieldAlert } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { NegSlotProps } from './slot-contract'

interface ConflictRow {
  adTargetId: string; term: string; termKey: string; match: string
  campaignName: string; adGroupName: string; market: string
  adGroupTraffic: { impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number }
  overlapRows: number; negatedIn: number; runsIn: number; actionable: boolean
}
interface SuppressedRow {
  termKey: string; term: string; negations: number; blocking: number; markets: string[]
  history: { days: number; impressions: number; orders: number; salesCents: number; spendCents: number }
  windowImpressions: number; thin: boolean; explained: boolean; actionable: boolean
}
interface SplitRow {
  adTargetId: string; term: string; termKey: string; level: 'AD_GROUP' | 'CAMPAIGN'
  campaignName: string; campaignStatus: string; adGroupName: string; market: string
  addedAt: string; reason: string; actionable: boolean
}
interface Payload {
  scope: { market: string; boundBy: string; resolved: { campaigns: number } }
  window: { days: number }
  thresholds: { windowDays: number; historyDays: number; minHistoryOrders: number; blockingDefinition: string; conflictDefinition: string }
  denominators: { blockingNegations: number; blockingNegationsUnscoped: number; negations: number; terms: number }
  conflicts: { rows: ConflictRow[]; total: number; totalUnscoped: number; overlapsRelaxed: number; overlapsRelaxedUnscoped: number; relaxedExplained: Array<{ termKey: string; externalAdGroupId: string; rows: number; reason: string }> }
  suppressed: { rows: SuppressedRow[]; total: number; totalUnscoped: number; explained: number }
  splitBrain: { rows: SplitRow[]; total: number; totalUnscoped: number; byReason: Record<string, number> }
  /** NEG.9 — optional, because web and API deploy separately and this field is newer than the panel. */
  inbound?: {
    rows: InboundRow[]
    total: number
    totalUnscoped: number
    candidates: number
    ungatedNegations: number
    ungatedShare: number
    lookbackDays: number
  }
  coverage: { searchTermRows: number; termsWithTraffic: number; termsTotal: number }
}

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dayMonth = (iso: string) => {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`
}
interface InboundRow {
  adTargetId: string; term: string; termKey: string; match: string
  campaignId: string; campaignName: string; campaignTargetingType: string | null
  adGroupName: string; market: string; negatedAt: string
  orders: number; salesCents: number; spendCents: number; impressions: number
  negatedIn: number; runsIn: number; reviewed: boolean; actionable: boolean
}
type Alert = 'conflict' | 'suppressed' | 'splitbrain' | 'inbound'

export function NegAttention({ scope, push }: NegSlotProps) {
  // 🔴 `useSearchParams`, never `window.location.search`. The latter is not reactive under soft
  // navigation — exactly how NEG.3b's confirm dialog silently never opened.
  const params = useSearchParams()
  const alert = (params.get('alert') ?? '') as Alert | ''
  const windowDays = params.get('window') ?? ''

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const p = new URLSearchParams({ market: scope.market })
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, adGroup: scope.adGroup, window: windowDays })) if (v) p.set(k, v)
    void fetch(`${getBackendUrl()}/api/advertising/negatives/attention?${p.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 404) {
          const b = await r.json().catch(() => ({} as { code?: string }))
          // NEG.2's fifth empty state: discriminate on the code, never the status.
          throw new Error(b?.code ? String(b.error) : 'This view is not available yet — the attention read is not deployed on this environment.')
        }
        if (!r.ok) throw new Error(`Could not load attention (${r.status})`)
        return r.json()
      })
      .then((d) => { if (alive) { setData(d as Payload); setErr(null) } })
      .catch((e) => { if (alive) { setErr((e as Error).message); setData(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [scope.market, scope.line, scope.portfolio, scope.campaign, scope.adGroup, windowDays])

  if (loading && !data) return <section className="h10-nga"><p className="h10-nga-msg">Checking for conflicts…</p></section>
  if (err) return <section className="h10-nga"><p className="h10-nga-bad"><AlertTriangle size={13} /><span>{err}</span></p></section>
  if (!data) return null

  // 🔴 The read failed if no traffic rows came back. That is NOT a clean account, and this
  // component must never report "nothing is wrong" on the strength of an empty read.
  const readFailed = data.coverage.searchTermRows === 0
  const d = data.denominators
  const show = (a: Alert) => alert === '' || alert === a

  const tabs: Array<{ key: Alert; n: number; label: string; tone: string }> = [
    { key: 'conflict', n: data.conflicts.total, label: data.conflicts.total === 1 ? 'blocking conflict' : 'blocking conflicts', tone: data.conflicts.total > 0 ? 'hot' : 'ok' },
    { key: 'suppressed', n: data.suppressed.total, label: data.suppressed.total === 1 ? 'suppressed earner' : 'suppressed earners', tone: data.suppressed.total > 0 ? 'warn' : 'ok' },
    { key: 'splitbrain', n: data.splitBrain.total, label: 'never confirmed at Amazon', tone: data.splitBrain.total > 0 ? 'warn' : 'ok' },
  ]
  // NEG.9's detector is newer than this panel; an older API build simply has no chip.
  if (data.inbound) {
    tabs.push({
      key: 'inbound',
      n: data.inbound.total,
      label: data.inbound.total === 1 ? 'to review — negated outside Nexus' : 'to review — negated outside Nexus',
      tone: data.inbound.total > 0 ? 'warn' : 'ok',
    })
  }

  return (
    <section className="h10-nga">
      <header className="h10-nga-head">
        <h3>Attention</h3>
        <p>
          What is wrong right now, in the last <b>{data.window.days} days</b>.{' '}
          {([30, 60, 120] as const).map((w) => (
            <button key={w} type="button" className={`h10-nga-win ${data.window.days === w ? 'on' : ''}`} onClick={() => push({ window: String(w) })}>{w}d</button>
          ))}
        </p>
      </header>

      {readFailed ? (
        // 🔴 The single most dangerous confusion in this section, refused outright.
        <p className="h10-nga-bad">
          <AlertTriangle size={13} />
          <span>
            <b>No search-term rows were read, so nothing can be checked.</b> That is a failed read,
            not a quiet account — the detectors below would report zero either way, so they are not
            shown.
          </span>
        </p>
      ) : (
        <>
          <div className="h10-nga-tabs" role="group" aria-label="Alert classes">
            {tabs.map((t) => (
              <button
                key={t.key} type="button"
                className={`cell ${t.tone} ${alert === t.key ? 'on' : ''}`}
                onClick={() => push({ alert: alert === t.key ? '' : t.key })}
              >
                <b>{num(t.n)}</b><span>{t.label}</span>
              </button>
            ))}
          </div>

          {/* ── Detector A ──────────────────────────────────────────────────────────────────── */}
          {show('conflict') && (
            <div className="h10-nga-list">
              <h4>Blocking conflicts <span className="ct">{num(data.conflicts.total)}</span></h4>
              {data.conflicts.total === 0 ? (
                <p className={`h10-nga-zero${d.blockingNegations === 0 ? ' none' : ''}`}>
                  {d.blockingNegations === 0 ? <Info size={13} /> : <Check size={13} />}
                  <span>
                    {/* 🔴 Four empty states, and "0 of 0" is one of them. A denominator of zero
                        means there was NOTHING TO CHECK — a different fact from "we checked and
                        found nothing", and framing it as a clean result would be a lie by
                        arithmetic. Found on production under a campaign scope whose negations are
                        all local-only, so none of them blocks. */}
                    {d.blockingNegations === 0 ? (
                      <>
                        <b>Nothing to check here.</b> This scope holds no blocking negation at all
                        {d.negations > 0 && <> — its {num(d.negations)} negation{d.negations === 1 ? '' : 's'} {d.negations === 1 ? 'is' : 'are'} archived, unconfirmed at Amazon, or in a campaign that is not enabled</>}
                        , so there is nothing a conflict could be found against.
                        {d.blockingNegationsUnscoped > 0 && <> The account has {num(d.blockingNegationsUnscoped)} blocking negations elsewhere.</>}
                      </>
                    ) : (
                      <>
                        {/* A detector that finds nothing states its own denominator. */}
                        <b>0 of {num(d.blockingNegations)} blocking negatives are in conflict</b> in the
                        last {data.window.days} days.{' '}
                        {data.conflicts.overlapsRelaxed > 0
                          ? <>The check ran: {num(data.conflicts.overlapsRelaxed)} ad group{data.conflicts.overlapsRelaxed === 1 ? '' : 's'} in this scope did overlap a negation of the same term, and {data.conflicts.overlapsRelaxed === 1 ? 'it was' : 'each was'} excluded for a stated reason.</>
                          : data.conflicts.overlapsRelaxedUnscoped > 0
                            ? <>The check ran — {num(data.conflicts.overlapsRelaxedUnscoped)} overlap{data.conflicts.overlapsRelaxedUnscoped === 1 ? '' : 's'} exist account-wide, none of them in this scope.</>
                            : <>🔴 No overlap was found at any strictness, which usually means the join found nothing rather than that there is nothing to find.</>}
                        {data.conflicts.totalUnscoped > data.conflicts.total && <> <b>{num(data.conflicts.totalUnscoped)} elsewhere</b> outside this scope.</>}
                      </>
                    )}
                  </span>
                </p>
              ) : (
                <ul className="h10-nga-rows">
                  {data.conflicts.rows.map((c) => (
                    <li key={c.adTargetId}>
                      <span className="t">
                        <button type="button" className="lnk" onClick={() => push({ focus: c.termKey })}>{c.term}</button>
                        <em>{c.match}</em><em className="mk">{c.market}</em>
                      </span>
                      <span className="sc">{c.campaignName} › {c.adGroupName}</span>
                      {/* 🔴 THIS ad group's own numbers, never the term's account-wide total, and
                          never labelled "lost revenue" — the loss is at most the overlap. */}
                      <span className="m">
                        this ad group took {num(c.adGroupTraffic.impressions)} impressions ·{' '}
                        {num(c.adGroupTraffic.clicks)} clicks · {c.adGroupTraffic.orders} order{c.adGroupTraffic.orders === 1 ? '' : 's'} ·{' '}
                        {eur(c.adGroupTraffic.salesCents)} while negating the term here
                      </span>
                      {/* 🔴 three numbers, never one */}
                      <span className="three">negated in <b>{num(c.negatedIn)}</b> · runs in <b>{num(c.runsIn)}</b> · <b>{num(c.overlapRows)}</b> negation{c.overlapRows === 1 ? '' : 's'} to clear it here</span>
                      <span className="q">Would removing it here recover that traffic?</span>
                      {c.actionable
                        ? <button type="button" className="h10-nga-act" onClick={() => push({ retire: c.adTargetId })}>Remove…</button>
                        : <span className="h10-nga-locked">not removable — its campaign is not on the live-write allowlist</span>}
                    </li>
                  ))}
                </ul>
              )}
              <p className="h10-nga-thresh">
                <Info size={12} />
                <span>A conflict is {data.thresholds.conflictDefinition}. Blocking means: {data.thresholds.blockingDefinition}.</span>
              </p>
            </div>
          )}

          {/* ── Detector B ──────────────────────────────────────────────────────────────────── */}
          {show('suppressed') && (
            <div className="h10-nga-list">
              <h4>
                Suppressed earners <span className="ct">{num(data.suppressed.total)}</span>
                {data.suppressed.explained > 0 && <span className="sub">{num(data.suppressed.explained)} explained and not listed</span>}
              </h4>
              {data.suppressed.total === 0 ? (
                <p className="h10-nga-zero">
                  <Check size={13} />
                  <span>
                    <b>No term that earned in the last {data.thresholds.historyDays} days is being blocked</b> while taking no traffic in the last {data.window.days}.
                    {data.suppressed.totalUnscoped > 0 && <> <b>{num(data.suppressed.totalUnscoped)} elsewhere</b> outside this scope.</>}
                  </span>
                </p>
              ) : (
                <ul className="h10-nga-rows">
                  {data.suppressed.rows.map((s) => (
                    <li key={s.termKey}>
                      <span className="t">
                        <button type="button" className="lnk" onClick={() => push({ focus: s.termKey })}>{s.term}</button>
                        {s.markets.map((m) => <em key={m} className="mk">{m}</em>)}
                        {/* 🔴 One order is a signal worth surfacing, not a proven loss. */}
                        {s.thin && <em className="thin" title="One order over 120 days — a signal, not a proven loss">thin evidence</em>}
                      </span>
                      <span className="m">
                        no impressions in {data.window.days}d · {s.history.orders} order{s.history.orders === 1 ? '' : 's'} and{' '}
                        {eur(s.history.salesCents)} in the {s.history.days} days before that, on {eur(s.history.spendCents)} of spend
                      </span>
                      <span className="three">negated in <b>{num(s.negations)}</b> place{s.negations === 1 ? '' : 's'} · <b>{num(s.blocking)}</b> of them actually blocking</span>
                      <span className="q">Is the negative the reason this stopped?</span>
                    </li>
                  ))}
                </ul>
              )}
              {data.suppressed.explained > 0 && (
                <p className="h10-nga-note">
                  <Info size={12} />
                  {/* A detector that lists these makes the operator do the elimination it exists to do. */}
                  <span>
                    {num(data.suppressed.explained)} more term{data.suppressed.explained === 1 ? '' : 's'} earned and went quiet, but{' '}
                    <b>nothing is blocking {data.suppressed.explained === 1 ? 'it' : 'them'} — the campaigns are paused</b>, so the negative is not the cause. Not listed.
                  </span>
                </p>
              )}
              <p className="h10-nga-thresh">
                <Info size={12} />
                <span>Fires on: 0 impressions in {data.window.days} days, at least {data.thresholds.minHistoryOrders} order in {data.thresholds.historyDays}, and still blocking somewhere.</span>
              </p>
            </div>
          )}

          {/* ── split-brain ─────────────────────────────────────────────────────────────────── */}
          {show('inbound') && data.inbound && (
            <div className="h10-nga-list">
              <h4>Negated outside Nexus, on a term that converted <span className="ct">{num(data.inbound.total)}</span></h4>
              <p className="h10-nga-note">
                <Info size={12} />
                <span>
                  🔴 <b>The converting-term protection only binds writes we make.</b>{' '}
                  <b>{num(data.inbound.ungatedNegations)}</b>{' '}of this account&apos;s negatives
                  ({(data.inbound.ungatedShare * 100).toFixed(0)}%) arrived from Amazon by sync and
                  passed no gate at all. This lists the ones created in the last{' '}
                  {data.inbound.lookbackDays} days that block a term with an order behind it.
                </span>
              </p>
              {data.inbound.total === 0 ? (
                /* 🔴 The zero states its own denominator AND its window, because it is
                   window-dependent: 0 at 30 days and 1 at 60 on this data. */
                <p className="h10-nga-zero">
                  <Check size={13} />
                  <span>
                    <b>Nothing to review in the last {data.inbound.lookbackDays} days.</b>{' '}
                    {data.inbound.candidates > 0
                      ? <><b>{num(data.inbound.candidates)}</b>{' '}negation{data.inbound.candidates === 1 ? '' : 's'} arrived
                        from Amazon in that time and none of their terms took an order in the last{' '}
                        {data.window.days} days — so this is a checked result, not an unread one.
                        This count moves with the window.</>
                      : <>No negation arrived from Amazon in that time at all.</>}
                    {data.inbound.totalUnscoped > 0 && <> <b>{num(data.inbound.totalUnscoped)}</b>{' '}elsewhere outside this scope.</>}
                  </span>
                </p>
              ) : (
                <>
                  <p className="h10-nga-note">
                    <ShieldAlert size={12} />
                    <span>
                      🔴 <b>This is a review queue, not a list of errors.</b> Negating a converting
                      term inside an <b>AUTO</b> campaign is standard funnel routing — you push it to
                      its exact campaign so it stops competing with itself. The honest question is
                      only whether each one was intended.
                    </span>
                  </p>
                  <ul className="h10-nga-rows">
                    {data.inbound.rows.slice(0, 50).map((r) => (
                      <li key={r.adTargetId}>
                        <span className="t">
                          <button type="button" className="lnk" onClick={() => push({ focus: r.termKey })}>{r.term}</button>
                          <em className="mk">{r.market}</em>
                          {r.campaignTargetingType && <em className={r.campaignTargetingType === 'AUTO' ? 'ok' : ''}>{r.campaignTargetingType}</em>}
                          {r.reviewed && <em className="ok">reviewed</em>}
                        </span>
                        <span className="sc">
                          {r.campaignName} › {r.adGroupName} · negated {dayMonth(r.negatedAt)} ·{' '}
                          <b>negated in {num(r.negatedIn)}</b>, runs in {num(r.runsIn)}
                        </span>
                        <span className="m">
                          {r.orders} {r.orders === 1 ? 'order' : 'orders'} · {eur(r.salesCents)} ·{' '}
                          {num(r.impressions)} impr · {eur(r.spendCents)} in {data.window.days}d —
                          created outside Nexus, so the converting-term protection did not apply;
                          check it was intended.
                        </span>
                        <button type="button" className="h10-nga-act" onClick={() => push({ focus: r.termKey })}>Open the term…</button>
                      </li>
                    ))}
                  </ul>
                  {data.inbound.rows.length > 50 && <p className="h10-nga-note"><Info size={12} /><span>Showing 50 of {num(data.inbound.rows.length)}.</span></p>}
                </>
              )}
            </div>
          )}

          {show('splitbrain') && (
            <div className="h10-nga-list">
              <h4>Never confirmed at Amazon <span className="ct">{num(data.splitBrain.total)}</span></h4>
              {data.splitBrain.total === 0 ? (
                <p className="h10-nga-zero">
                  <Check size={13} />
                  <span>
                    <b>Every negation in this scope is confirmed at Amazon.</b>
                    {data.splitBrain.totalUnscoped > 0 && <> <b>{num(data.splitBrain.totalUnscoped)} elsewhere</b> outside it.</>}
                  </span>
                </p>
              ) : (
                <>
                  <p className="h10-nga-note">
                    <ShieldAlert size={12} />
                    <span>
                      These are counted by every screen and honoured by no auction. They block nothing.
                      {Object.entries(data.splitBrain.byReason).map(([k, v]) => <span key={k}> · {num(v)} {k}</span>)}
                    </span>
                  </p>
                  <ul className="h10-nga-rows">
                    {data.splitBrain.rows.slice(0, 50).map((r) => (
                      <li key={r.adTargetId}>
                        <span className="t">
                          <button type="button" className="lnk" onClick={() => push({ focus: r.termKey })}>{r.term}</button>
                          <em className="mk">{r.market}</em>
                          {r.level === 'CAMPAIGN' && <em>campaign-wide</em>}
                        </span>
                        <span className="sc">{r.campaignName} › {r.adGroupName} · added {dayMonth(r.addedAt)}</span>
                        <span className="m">{r.reason}</span>
                        <button type="button" className="h10-nga-act" onClick={() => push({ retire: r.adTargetId })}>Remove our record…</button>
                      </li>
                    ))}
                  </ul>
                  {data.splitBrain.rows.length > 50 && <p className="h10-nga-note"><Info size={12} /><span>Showing 50 of {num(data.splitBrain.rows.length)}.</span></p>}
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
