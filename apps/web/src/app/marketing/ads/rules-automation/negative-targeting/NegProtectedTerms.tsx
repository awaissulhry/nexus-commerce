'use client'

/**
 * ⛔ PARKED 2026-08-18 (U5) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the protected-terms EDITOR (the whitelist the write gate enforces server-side).
 * Why it left: the Negative Targeting tab is now Helium 10's shape — one rules grid and nothing
 *   else (`NegativeRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.4, §7.6).
 * Candidate home: **Control Room › Guardrails** — `ProtectedTermsPanel.tsx` already renders this list there.
 *
 * ⚠ Nothing here was changed, no endpoint was retired, and NO PROTECTION WAS REMOVED: the
 * protected-terms whitelist, the converting-term guard and the write gate live on the server and
 * are still armed. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * NEG.5 — protected terms: what can never be negated, and the 132 that already contradict it.
 *
 * Absorbs the legacy `ProtectedTermsPanel`, which this page used to render below the inventory.
 * 🔴 That file is NOT deleted: `control-room/GuardrailsTab.tsx:197` mounts it too, deliberately
 * ("a second MOUNT and not a second copy", its own comment). Deleting it is a build break on a
 * page NEG.5 does not own. This section replaces it *here*; the Control Room keeps its copy.
 *
 * ── The two halves ───────────────────────────────────────────────────────────────────────────
 *
 * **Forward** — the ten terms, their semantics in words, and their reach. Always been true.
 * **Backward** — the contradictions, triaged, with a mark so the count CONVERGES. Has never
 * existed: the gate is a going-forward check installed 2026-08-04 over a base written 2026-05-20.
 *
 * ── 🔴 132 and 128 are both correct, and both are on screen ──────────────────────────────────
 *
 * Four negations (all the phrase `xavia gale`) contradict two protected terms each. Grouped by
 * protected term — which is how an operator reads this — the group sizes sum to **132 pairs**. The
 * number of AdTarget rows an operator would have to remove is **128**. A headline of 128 over
 * groups summing to 132 reads as a bug, so the headline is the pair count and the negation count
 * sits beside it in words.
 *
 * ── The three defects of the panel this replaces ─────────────────────────────────────────────
 *
 * (a) An API failure rendered as an alarm: `.catch(() => setItems([]))` made an outage show
 *     "No protected terms yet" PLUS the red "Nothing is protected" banner. An empty whitelist and
 *     an offline API were the same pixels. Here they are three separate renderings.
 * (b) The panel could not create the protection the gate wants. All ten live rows are CONTAINS,
 *     seeded by SQL; the POST accepted only `isPrefix`, so every protection an operator added was
 *     strictly WEAKER than the ten already there. The three-way control below fixes it.
 * (c) A protection still cannot be EDITED, only deleted and re-added, which loses `createdBy` and
 *     `createdAt`. Not fixed — noted on screen, and the 409 now says what is already stored.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { useSearchParams } from 'next/navigation'
import {
  ShieldCheck, Ban, Trash2, Plus, AlertTriangle, Check, Info, WifiOff, ChevronRight,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { H10Select } from '../../campaigns/FilterDropdown'
import type { NegSlotProps } from './slot-contract'

type Mode = 'WHITELIST' | 'BLACKLIST'
type MatchType = 'CONTAINS' | 'PREFIX' | 'EXACT'
type Classification = 'own-line-brand' | 'other-line-brand' | 'non-brand'

interface ProtectionView {
  id: string; term: string; mode: string; matchType: string; semantics: string
  marketplace: string | null; campaignId: string | null; campaignName: string | null
  reason: string | null; createdBy: string | null; createdAt: string
  reachQueries: number; contradictions: number
}
interface ContradictionRow {
  id: string; term: string; termRaw: string; match: string; matchRaw: string
  level: 'AD_GROUP' | 'CAMPAIGN'
  campaignId: string; campaignName: string; campaignStatus: string
  adGroupId: string; adGroupName: string; market: string; status: string
  atAmazon: boolean; blockingNow: boolean; addedAt: string
  classification: Classification; inScope: boolean
  performance: { impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number } | null
  removable: boolean; newSinceDecision: boolean
}
interface CampaignGroup {
  campaignId: string; campaignName: string; campaignStatus: string; market: string
  classification: Classification; rows: ContradictionRow[]
  covers: number; blocking: number; newSinceDecision: number
  decision: { decision: string; reason: string | null; reviewedBy: string | null; reviewedAt: string } | null
  removable: boolean; removableReason: string | null
}
interface TermGroup {
  protectedTerm: string; matchType: string; semantics: string
  contradictions: number; blocking: number; reviewed: number; open: number
  campaigns: CampaignGroup[]
}
interface Payload {
  scope: { boundBy: string; market: string; campaignsInScope: number; campaignsInMarket: number }
  window: { days: number; since: string }
  forward: {
    protections: ProtectionView[]
    reach: { distinctQueries: number; searchTermRows: number }
    refusalHistoryAvailable: boolean
  }
  backward: {
    groups: TermGroup[]
    totals: {
      contradictions: number; negations: number; reviewed: number; open: number
      blocking: number; newSinceDecision: number; byClass: Record<Classification, number>
    }
    scoped: { contradictions: number; negations: number; reviewed: number; open: number }
  }
  coverage: { protectionRows: number; negationRows: number; reviewRows: number }
}

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dayMonth = (iso: string) => {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`
}

const CLASS_LABEL: Record<Classification, string> = {
  'own-line-brand': 'own line, brand campaign',
  'other-line-brand': 'another line, brand campaign',
  'non-brand': 'not a brand campaign',
}
/** 🔴 Triage, never a verdict. These sentences describe; none of them decides. */
const CLASS_NOTE: Record<Classification, string> = {
  'own-line-brand': 'A campaign whose name says it exists to capture this brand term is negating it. That leaves the traffic nowhere to go, and these read as accidents.',
  'other-line-brand': 'A different line’s term inside a brand campaign. Genuinely ambiguous — this is either sloppiness or deliberate routing of bare-brand queries, and only you know which.',
  'non-brand': 'An Auto or Category campaign pushing brand traffic out of the catch-all so it lands in the dedicated brand campaign at a lower CPC. Standard funnel architecture, and probably correct.',
}

const MARKETS = ['', 'IT', 'DE', 'FR', 'ES']
const MATCH_OPTIONS: Array<{ value: MatchType; label: string; blurb: (t: string) => string }> = [
  { value: 'CONTAINS', label: 'Contains', blurb: (t) => `Blocks any negation whose phrase contains “${t || 'xavia'}” anywhere — including “giacca moto ${t || 'xavia'}”. This is what the ten live protections use.` },
  { value: 'PREFIX', label: 'Starts with', blurb: (t) => `Blocks a negation whose phrase starts with “${t || 'xavia'}” — but NOT “giacca moto ${t || 'xavia'}”.` },
  { value: 'EXACT', label: 'Exactly', blurb: (t) => `Blocks a negation of exactly “${t || 'xavia'}” — nothing longer, not even “${t || 'xavia'} moto”.` },
]

export function NegProtectedTerms({ scope, push }: NegSlotProps) {
  // 🔴 `useSearchParams`, never `window.location.search` — the latter is not reactive under soft
  // navigation, which is exactly how NEG.3b's confirm dialog silently never opened.
  const params = useSearchParams()
  // 🔴 'yes', NOT 'all'. `push` in the client DELETES any param whose value is 'all'
  // (NegativeTargetingClient.tsx:129, so that `?market=all` never appears in a URL), so a
  // `reviewed=all` toggle could never have been set and would have looked like a dead button.
  const showReviewed = params.get('reviewed') === 'yes'
  const classFilter = (params.get('class') ?? '') as Classification | ''

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  // the create form
  const [term, setTerm] = useState('')
  const [mode, setMode] = useState<Mode>('WHITELIST')
  const [matchType, setMatchType] = useState<MatchType>('CONTAINS')
  const [marketplace, setMarketplace] = useState('')
  const [reason, setReason] = useState('')
  const [formErr, setFormErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const p = new URLSearchParams({ market: scope.market })
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, adGroup: scope.adGroup })) if (v) p.set(k, v)
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/negatives/protections?${p.toString()}`, { cache: 'no-store' })
      if (r.status === 404) {
        const b = await r.json().catch(() => ({} as { code?: string; error?: string }))
        // Our 404 and Fastify's route-missing 404 are different facts. Discriminate on the code.
        throw new Error(b?.code ? String(b.error) : 'This view is not available yet — the protections read is not deployed on this environment.')
      }
      if (!r.ok) throw new Error(`Could not load protected terms (${r.status})`)
      setData((await r.json()) as Payload)
      setErr(null)
    } catch (e) {
      // 🔴 Defect (a). NEVER `setData({empty})` on a failure: an outage would render as
      // "nothing contradicts the whitelist", which is the most reassuring possible lie.
      setErr((e as Error).message)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [scope.market, scope.line, scope.portfolio, scope.campaign, scope.adGroup])

  useEffect(() => { void load() }, [load])

  const addProtection = async () => {
    const t = term.trim()
    if (!t || busy) return
    setBusy(true); setFormErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-protections`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, term: t, matchType, marketplace: marketplace || null, reason: reason.trim() || null }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) { setFormErr(j?.error ?? `HTTP ${r.status}`); return }
      setTerm(''); setReason('')
      await load()
    } catch (e) { setFormErr((e as Error).message) } finally { setBusy(false) }
  }

  const removeProtection = async (p: ProtectionView) => {
    if (busy) return
    setBusy(true); setFormErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-protections/${p.id}`, { method: 'DELETE' })
      if (!r.ok) { setFormErr(`Could not delete (${r.status})`); return }
      await load()
    } catch (e) { setFormErr((e as Error).message) } finally { setBusy(false) }
  }

  const mark = async (protectedTerm: string, g: CampaignGroup) => {
    if (busy) return
    setBusy(true); setFormErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/negatives/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protectedTerm, campaignId: g.campaignId }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) { setFormErr(j?.error ?? `HTTP ${r.status}`); return }
      await load()
    } catch (e) { setFormErr((e as Error).message) } finally { setBusy(false) }
  }

  const unmark = async (protectedTerm: string, g: CampaignGroup) => {
    if (busy) return
    setBusy(true); setFormErr(null)
    try {
      const q = new URLSearchParams({ protectedTerm, campaignId: g.campaignId })
      const r = await fetch(`${getBackendUrl()}/api/advertising/negatives/review?${q.toString()}`, { method: 'DELETE' })
      if (!r.ok) { setFormErr(`Could not undo (${r.status})`); return }
      await load()
    } catch (e) { setFormErr((e as Error).message) } finally { setBusy(false) }
  }

  // ── state 1 of 3: loading ────────────────────────────────────────────────────────────────────
  if (loading && !data) {
    return (
      <section id="protected-terms" className="h10-ngp">
        <header className="h10-ngp-head"><h3>Protected terms</h3></header>
        <p className="h10-ngp-msg">Loading the whitelist and auditing it against every negation…</p>
      </section>
    )
  }

  // ── state 2 of 3: the read FAILED. Deliberately not an empty list. ───────────────────────────
  if (err || !data) {
    return (
      <section id="protected-terms" className="h10-ngp">
        <header className="h10-ngp-head"><h3>Protected terms</h3></header>
        <p className="h10-ngp-bad">
          <WifiOff size={13} />
          <span>
            <b>Could not read the whitelist.</b> {err ?? 'The request returned nothing.'} This is a
            failed read, not an empty whitelist — nothing below is shown, because “no protected
            terms” and “we could not ask” are different facts and this panel used to render them
            identically.
          </span>
        </p>
      </section>
    )
  }

  const t = data.backward.totals
  const s = data.backward.scoped
  const scoped = data.scope.boundBy !== 'market' || (scope.market !== 'all' && scope.market !== '')
  const whitelist = data.forward.protections.filter((p) => p.mode === 'WHITELIST')
  const blacklist = data.forward.protections.filter((p) => p.mode === 'BLACKLIST')
  // 🔴 A real count of what was read. Zero means the query failed, and "nothing contradicts the
  // whitelist" would be a lie by empty set.
  const readFailed = data.coverage.negationRows === 0

  // Which groups the operator is looking at. Reviewed ones leave the open list by default —
  // that is the whole point of the mark.
  const visibleGroups = data.backward.groups
    .map((g) => ({
      ...g,
      campaigns: g.campaigns
        .filter((c) => (showReviewed ? true : c.decision === null))
        .filter((c) => (classFilter ? c.classification === classFilter : true))
        .filter((c) => (scoped ? c.rows.some((r) => r.inScope) : true)),
    }))
    .filter((g) => g.campaigns.length > 0)

  const key = (term: string, id: string) => `${term}|${id}`

  return (
    <section id="protected-terms" className="h10-ngp">
      <header className="h10-ngp-head">
        <h3>Protected terms</h3>
        <p>
          The opposite of the rules below: those decide what gets negated, this decides what never
          can be. Enforced on every write to Amazon, so no engine can bypass it.
        </p>
      </header>

      {/* ── The forward half ──────────────────────────────────────────────────────────────── */}
      <div className="h10-ngp-fwd">
        <div className="h10-ngp-subhd">
          <b>Never negate</b>
          <span>{whitelist.length} {whitelist.length === 1 ? 'term' : 'terms'}</span>
        </div>

        {/* ── state 3 of 3: read fine, whitelist genuinely empty. Empty state #1 of 4. ─────── */}
        {whitelist.length === 0 ? (
          <p className="h10-ngp-bad">
            <AlertTriangle size={13} />
            <span>
              <b>Nothing is protected.</b> The read succeeded and returned an empty whitelist, so
              any automation may negate any term, including your brand. Add your brand and core
              terms below.
            </span>
          </p>
        ) : (
          <ul className="h10-ngp-plist">
            {whitelist.map((p) => (
              <li key={p.id}>
                <span className="tm"><ShieldCheck size={13} /><b>{p.term}</b></span>
                <span className="sem">{p.semantics}</span>
                <span className="meta">
                  <em>{p.marketplace ?? 'all markets'}</em>
                  <em>{p.campaignName ? p.campaignName : 'all campaigns'}</em>
                  <em>{p.createdBy ?? 'creator not recorded'} · {dayMonth(p.createdAt)}</em>
                </span>
                <span className={`reach ${p.reachQueries === 0 ? 'nil' : ''}`}>
                  {p.reachQueries === 0
                    ? <>reaches <b>no</b> query</>
                    : <>reaches <b>{num(p.reachQueries)}</b> {p.reachQueries === 1 ? 'query' : 'queries'}</>}
                </span>
                <span className={`cx ${p.contradictions > 0 ? 'hot' : ''}`}>
                  {p.contradictions > 0 ? <><b>{num(p.contradictions)}</b> contradicted</> : <>none contradicted</>}
                </span>
                <Button
 variant="ghost" disabled={busy}
 aria-label={`Remove protection for ${p.term}`} onClick={() => void removeProtection(p)}
 ><Trash2 size={12} /></Button>
              </li>
            ))}
          </ul>
        )}

        {blacklist.length > 0 && (
          <>
            <div className="h10-ngp-subhd"><b>Always negate</b><span>{blacklist.length}</span></div>
            <ul className="h10-ngp-plist">
              {blacklist.map((p) => (
                <li key={p.id}>
                  <span className="tm"><Ban size={13} /><b>{p.term}</b></span>
                  <span className="sem">{p.semantics}</span>
                  <span className="meta"><em>{p.marketplace ?? 'all markets'}</em></span>
                  <span className="reach" />
                  <span className="cx" />
                  <Button
 variant="ghost" disabled={busy}
 aria-label={`Remove rule for ${p.term}`} onClick={() => void removeProtection(p)}
 ><Trash2 size={12} /></Button>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="h10-ngp-note">
          <Info size={13} />
          <span>
            Reach is measured against the <b>{num(data.forward.reach.distinctQueries)}</b> distinct
            search-term queries Amazon reported in the last {data.window.days} days — a protection’s
            blast radius, rather than a theoretical one. 🔴 <b>There is no history of refusals.</b>{' '}
            Every refusal is logged as it happens but nothing persists it, so this half shows what{' '}
            <b>will</b> be refused, never what has been. A count would have to be invented.
          </span>
        </p>

        {/* ── Add a protection — defect (b) fixed ───────────────────────────────────────────── */}
        <div className="h10-ngp-add">
          <input
            className="h10-ngp-input" value={term} placeholder="Term to protect, e.g. xavia"
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addProtection() }}
            aria-label="Term"
          />
          <H10Select
            ariaLabel="Protection mode" width={150} value={mode}
            onChange={(v) => setMode(v as Mode)}
            options={[{ value: 'WHITELIST', label: 'Never negate' }, { value: 'BLACKLIST', label: 'Always negate' }]}
          />
          <H10Select
            ariaLabel="Match type" width={140} value={matchType}
            onChange={(v) => setMatchType(v as MatchType)}
            options={MATCH_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <H10Select
            ariaLabel="Marketplace" width={130} value={marketplace}
            onChange={(v) => setMarketplace(v)}
            options={MARKETS.map((m) => ({ value: m, label: m || 'All markets' }))}
          />
          <input
            className="h10-ngp-input reason" value={reason} placeholder="Why (optional)"
            onChange={(e) => setReason(e.target.value)} aria-label="Reason"
          />
          <Button variant="primary" disabled={busy || !term.trim()} onClick={() => void addProtection()}>
            <Plus size={13} /> Protect
          </Button>
        </div>
        <p className="h10-ngp-blurb">{MATCH_OPTIONS.find((o) => o.value === matchType)!.blurb(term.trim().toLowerCase())}</p>
        <p className="h10-ngp-note sm">
          <Info size={13} />
          <span>A protection cannot be edited once created — to change its matching you have to delete it and add it again, which loses who created it and when.</span>
        </p>
        {formErr && <p className="h10-ngp-bad"><AlertTriangle size={13} /><span>{formErr}</span></p>}
      </div>

      {/* ── The backward half ─────────────────────────────────────────────────────────────── */}
      <div className="h10-ngp-bwd">
        <div className="h10-ngp-subhd">
          <b>What already contradicts them</b>
          <span>{data.window.days}d performance</span>
        </div>

        {readFailed ? (
          <p className="h10-ngp-bad">
            <WifiOff size={13} />
            <span>
              <b>No negations were read, so nothing can be audited.</b> That is a failed read, not a
              clean account — an empty audit and a broken one look identical, and only one of them
              is good news.
            </span>
          </p>
        ) : t.contradictions === 0 ? (
          /* Empty state #2 of 4 — the goal state, and the only green one. */
          <p className="h10-ngp-good">
            <Check size={13} />
            <span>
              <b>Nothing contradicts the whitelist.</b> All {num(data.coverage.negationRows)}{' '}
              negations were checked against {whitelist.length}{' '}
              {whitelist.length === 1 ? 'protected term' : 'protected terms'} and none of them
              blocks one.
            </span>
          </p>
        ) : (
          <>
            {/* The converging counter. Unreviewed, never total. */}
            <div className="h10-ngp-count">
              <span className={`n ${t.open > 0 ? 'hot' : 'ok'}`}>{num(t.contradictions)}</span>
              <span className="l">
                <b>contradictions</b>
                <em>across {num(t.negations)} negations{t.contradictions !== t.negations && <> — {num(t.contradictions - t.negations)} of them contradict two protected terms at once</>}</em>
              </span>
              <span className="sep" />
              <span className="n ok">{num(t.reviewed)}</span>
              <span className="l"><b>reviewed</b><em>marked as intended</em></span>
              <span className="sep" />
              <span className={`n ${t.open > 0 ? 'hot' : 'ok'}`}>{num(t.open)}</span>
              <span className="l"><b>open</b><em>{t.open === 0 ? 'nothing left to decide' : 'awaiting your decision'}</em></span>
            </div>

            <p className="h10-ngp-thresh">
              <AlertTriangle size={13} />
              <span>
                🔴 <b>All {num(t.blocking)} of them are blocking right now</b> — every one is
                ENABLED, confirmed at Amazon, and in an ENABLED campaign. This is not a historical
                list. The whitelist is a going-forward gate installed <b>4 Aug</b>; the base it
                governs was written from <b>20 May</b>, and nothing has ever compared the two.
              </span>
            </p>

            {/* Triage — a sort order and a filter, never a verdict. */}
            <div className="h10-ngp-tabs" role="group" aria-label="Triage">
              {(['own-line-brand', 'other-line-brand', 'non-brand'] as Classification[]).map((c) => (
                <button
                  key={c} type="button"
                  className={`h10-ngp-tab ${classFilter === c ? 'on' : ''}`}
                  aria-pressed={classFilter === c}
                  onClick={() => push({ class: classFilter === c ? '' : c })}
                >
                  <b>{num(t.byClass[c])}</b><span>{CLASS_LABEL[c]}</span>
                </button>
              ))}
              <button
                type="button" className={`h10-ngp-tab wide ${showReviewed ? 'on' : ''}`}
                aria-pressed={showReviewed}
                onClick={() => push({ reviewed: showReviewed ? '' : 'yes' })}
              >
                <b>{num(t.reviewed)}</b><span>reviewed{showReviewed ? ' — shown' : ' — hidden'}</span>
              </button>
            </div>
            {classFilter && <p className="h10-ngp-note"><Info size={13} /><span>{CLASS_NOTE[classFilter]}</span></p>}

            {scoped && (
              <p className="h10-ngp-note">
                <Info size={13} />
                <span>
                  <b>{num(s.contradictions)} of {num(t.contradictions)}</b> contradictions are in the
                  scope you are looking at{s.contradictions === 0 && <>, so the list below is empty for a reason that is not “nothing is wrong”</>}.
                </span>
              </p>
            )}

            {/* Empty state #3 of 4 — nothing HERE, but N elsewhere. */}
            {visibleGroups.length === 0 ? (
              <p className="h10-ngp-msg neutral">
                {scoped && s.contradictions === 0 ? (
                  <>
                    <b>No contradiction in this scope.</b> The account has {num(t.contradictions)}{' '}
                    elsewhere — widen the scope to see them. Nothing was checked here, which is a
                    different fact from nothing being found.
                  </>
                ) : t.open === 0 ? (
                  /* Zero is the success state, and it states its denominator. */
                  <>
                    <b>All {num(t.contradictions)} contradictions reviewed.</b> Every one has been
                    marked as intended by an operator. Turn on “reviewed” above to see the
                    decisions and who made them.
                  </>
                ) : (
                  <>
                    <b>Nothing matches this filter.</b> {num(t.open)} contradictions are still open
                    under a different one.
                  </>
                )}
              </p>
            ) : (
              <div className="h10-ngp-groups">
                {visibleGroups.map((g) => (
                  <div key={g.protectedTerm} className="h10-ngp-g">
                    <div className="gh">
                      <button type="button" className="lnk" onClick={() => push({ focus: g.protectedTerm })}>
                        <ShieldCheck size={13} /> {g.protectedTerm}
                      </button>
                      <span className="gs">
                        negated in <b>{num(g.contradictions)}</b> {g.contradictions === 1 ? 'place' : 'places'}
                        {g.reviewed > 0 && <>, {num(g.reviewed)} reviewed</>}
                        {' · '}across {g.campaigns.length} {g.campaigns.length === 1 ? 'campaign' : 'campaigns'}
                      </span>
                      <span className="gm">{g.semantics}</span>
                    </div>

                    {g.campaigns.map((c) => {
                      const k = key(g.protectedTerm, c.campaignId)
                      const isOpen = open[k] === true
                      return (
                        <div key={c.campaignId} className={`cg ${c.decision ? 'done' : ''}`}>
                          <div className="ch">
                            <button
                              type="button" className="tw" aria-expanded={isOpen}
                              onClick={() => setOpen((o) => ({ ...o, [k]: !isOpen }))}
                            >
                              <ChevronRight size={13} className={isOpen ? 'rot' : ''} />
                              <b>{c.campaignName}</b>
                            </button>
                            <span className={`cls ${c.classification}`}>{CLASS_LABEL[c.classification]}</span>
                            <span className="cn">
                              <b>{num(c.covers)}</b> {c.covers === 1 ? 'negation' : 'negations'}
                              {c.blocking === c.covers ? ', all blocking' : `, ${num(c.blocking)} blocking`}
                            </span>
                            <span className="ca">
                              {c.decision ? (
                                <button type="button" className="h10-ngp-act undo" disabled={busy} onClick={() => void unmark(g.protectedTerm, c)}>Undo</button>
                              ) : (
                                <button type="button" className="h10-ngp-act" disabled={busy} onClick={() => void mark(g.protectedTerm, c)}>Mark intended</button>
                              )}
                            </span>
                          </div>

                          {c.decision && (
                            <p className="dec">
                              <Check size={12} />
                              <span>
                                Marked <b>intended funnel</b> by {c.decision.reviewedBy ?? 'someone'} on{' '}
                                {dayMonth(c.decision.reviewedAt)} — covering <b>{num(c.covers)}</b>{' '}
                                {c.covers === 1 ? 'negation' : 'negations'} of “{g.protectedTerm}” in this
                                campaign, <b>and every future one</b>.
                                {c.newSinceDecision > 0 && (
                                  <>
                                    {' '}🔴 <b>{num(c.newSinceDecision)} new since that decision</b> — surfaced
                                    here rather than absorbed by it.
                                  </>
                                )}
                              </span>
                            </p>
                          )}

                          {!c.removable && (
                            <p className="hidnote"><Info size={12} /><span>{c.removableReason}</span></p>
                          )}

                          {isOpen && (
                            <ul className="rows">
                              {c.rows.map((r) => (
                                <li key={r.id} className={r.inScope || !scoped ? '' : 'oos'}>
                                  <button type="button" className="lnk" onClick={() => push({ focus: r.term })}>{r.termRaw}</button>
                                  <span className="mt">{r.match}</span>
                                  <span className="ag">{r.adGroupName}</span>
                                  <span className="mk">{r.market}</span>
                                  <span className={`st ${r.blockingNow ? 'on' : ''}`}>{r.blockingNow ? 'blocking' : r.atAmazon ? r.status.toLowerCase() : 'not at Amazon'}</span>
                                  <span className="pf">
                                    {r.performance
                                      ? <>{num(r.performance.impressions)} impr · {eur(r.performance.spendCents)}{r.performance.orders > 0 && <> · <b>{r.performance.orders} {r.performance.orders === 1 ? 'order' : 'orders'}</b></>}</>
                                      : <em>no traffic in {data.window.days}d</em>}
                                  </span>
                                  <span className="ac">
                                    {/* 🔴 Hidden, not disabled, when the campaign is not on the write allowlist. */}
                                    {r.removable && <button type="button" className="h10-ngp-act sm" onClick={() => push({ retire: r.id, retireTerm: r.term })}>Remove…</button>}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}

            <p className="h10-ngp-note">
              <Info size={13} />
              <span>
                A decision is recorded per <b>protected term × campaign</b>, not per negation — the
                call you are making is architectural, and 132 separate answers is not a review.
                Nothing infers it: no campaign name resolves a contradiction on its own, and the
                three groupings above are a sort order rather than a judgement.
                {' '}Removal is irreversible at Amazon and goes through the same confirmation as the
                inventory’s.
              </span>
            </p>
          </>
        )}
      </div>
    </section>
  )
}
