'use client'

/**
 * ⛔ PARKED 2026-08-18 (U7) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: "Where these would go" — the destination panel opened by ?row=.
 * Why it left: the Keyword Harvest tab is now Helium 10's shape — the pill
 *   [ Rules View | Ad Group View ] over one card, and nothing else
 *   (`KeywordHarvestRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.3, §7.8).
 * Candidate home: travels with the candidates grid into Suggestions.
 *
 * ⚠ Nothing here was changed, no endpoint was retired, and the harvest engine's own arming is
 * untouched. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * HV.3 — the destination: where a graduated keyword would go, and what that decides.
 *
 * ── 🔴 The one sentence this section exists to print ──────────────────────────────────────────
 *
 * `applyHarvest` creates the keyword at `destinations?.[matchType] ?? sourceAdGroup` and fires the
 * H.3 isolation negative **only** when the destination differs from the source. So an absent
 * destination means the keyword goes back into the ad group that discovered it *and* the source is
 * never negated — one defect, not two. Measured on prod: with nothing stored, **7 of 8 candidates**
 * would not negate their source. That sentence, per row, is the most useful thing this page prints.
 *
 * ── Why there is a picker and not a proposal ──────────────────────────────────────────────────
 *
 * Measured across all 289 ad groups: the by-product resolver finds a destination for 287 of 287
 * sources and a **unique** one for 38 (13%) — median 5 candidates, max 21. Rendering one of nine as
 * "proposed" would be inventing certainty, so an ambiguous resolve is an explicit **undecided**
 * state with the shortlist behind it, ranked and each entry carrying its own reason.
 *
 * ── What this section does NOT do ─────────────────────────────────────────────────────────────
 *
 * No writes to Amazon, no keyword creation, no negative creation, no bid derivation. It stores a
 * choice in `AdsHarvestDestination` and shows what that choice would mean. **HV.4 does the writing**
 * and reads this table for the destination.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, Check, ExternalLink, Info, Layers, Trash2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { HvSlotProps, HarvestRow, DestinationCandidate, HvDestStatus } from './slot-contract'
import { emitAdsChange } from '../_shared/adsBus'

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

export const DEST_STATUS_LABEL: Record<HvDestStatus, string> = {
  'undecided': 'undecided',
  'no-destination': 'no destination',
  'will-create': 'will create',
  'already-at-destination': 'already there',
  'destination-local-only': 'there, not at Amazon',
  'would-duplicate': 'second exact keyword',
}
export const DEST_STATUS_TIP: Record<HvDestStatus, string> = {
  'undecided': 'More than one ad group could hold this keyword and nobody has chosen. Until one is picked, applyHarvest would create it back in the ad group that discovered it — and would not negate the source.',
  'no-destination': 'No manual keyword-targeted ad group advertises this product in this market, so there is nowhere to promote it to. Not permitted, rather than not measured.',
  'will-create': 'The destination holds no exact keyword for this term. Promoting creates something that does not exist.',
  'already-at-destination': 'The destination already holds this exact keyword and Amazon has confirmed it. Promoting would create nothing.',
  'destination-local-only': 'The destination holds this keyword but it never reached Amazon. Nexus thinks it is covered; the auction has never seen it.',
  'would-duplicate': 'The destination does not hold this term, but another ad group does. Promoting creates a SECOND exact keyword for one term — two of your own ad groups bidding against each other.',
}

/** Campaign › ad group, always. Ad group names repeat across campaigns in this account. */
export function DestName({ c }: { c: DestinationCandidate }) {
  return (
    <span className="h10-hv-dest">
      <span className="ag" title={c.adGroupName}>{c.adGroupName}</span>
      <i title={c.campaignName}>
        {c.campaignName}
        {c.role && <b className={`rl ${c.role.toLowerCase()}`}>{c.role.toLowerCase()}</b>}
      </i>
    </span>
  )
}

/**
 * The section below the grid: the account-wide picture, and the picker for the focused row.
 *
 * The per-row Destination column lives in the grid itself (KeywordHarvestClient) — this is the
 * detail surface `?row=` opens, plus the one-line census the whole page needs.
 */
export function HvDestination(props: HvSlotProps) {
  const { census, rows, row, push, reload, scope } = props
  const focused = useMemo(() => rows.find((r) => r.termKey === row || r.term === row) ?? null, [rows, row])

  if (!census) return null

  return (
    <>
      {/* ── the account-wide picture, and the coupling as two numbers ──────────────────────── */}
      <div className="h10-hv-destsum">
        <p className="hd"><Layers size={13} /> <b>Where these would go</b></p>
        <div className="cells">
          <Cell n={census.destinations.stored} label="chosen" tip="A destination has been stored for this scope. It wins over anything the resolver would suggest." on={false} apply={() => push({ dest: 'overridden' })} />
          <Cell n={census.destinations.resolvedUnique} label="one obvious match" tip="Exactly one manual ad group advertises this product at this match type in this market." on={false} apply={() => push({ dest: 'proposed' })} />
          <Cell n={census.destinations.ambiguous} label="more than one match" tone="warn" tip="Several ad groups could hold this keyword and nobody has chosen. Until one is picked, applyHarvest creates it back in the ad group that discovered it." on={false} apply={() => push({ dest: 'proposed' })} />
          <Cell n={census.destinations.none} label="nowhere to put it" tone="warn" tip="No manual keyword-targeted ad group advertises this product in this market." on={false} apply={() => push({ dest: 'none' })} />
        </div>

        {/* 🔴 The coupling, stated for the whole set. */}
        {census.destinations.wouldNotNegate > 0 && (
          <p className="couple">
            <AlertTriangle size={12} />
            <span>
              <b>{num(census.destinations.wouldNotNegate)} of {num(census.candidates)} would not negate their source.</b>{' '}
              `applyHarvest` adds the isolation negative only when the keyword lands in a different ad group. Until a
              destination is chosen it lands back where it was found, so the discovery ad group keeps competing for the
              same term — that is one defect, not two.
            </span>
          </p>
        )}
        {census.destinations.wouldDuplicate > 0 && (
          <p className="couple compete">
            <AlertTriangle size={12} />
            <span>
              <b>{num(census.destinations.wouldDuplicate)} would create a second exact keyword</b> for a term another ad
              group already holds — two of your own ad groups bidding on one term.{' '}
              <button type="button" className="lnk" onClick={() => push({ competing: '1' })}>Show only those</button>
            </span>
          </p>
        )}
      </div>

      {/* ── the picker, for the row the URL is focused on ──────────────────────────────────── */}
      {focused && <DestinationPicker row={focused} scope={scope} onClose={() => push({ row: '' })} reload={reload} />}
    </>
  )
}

function Cell({ n, label, tip, tone, on, apply }: { n: number; label: string; tip: string; tone?: string; on: boolean; apply: () => void }) {
  return (
    <button type="button" className={`h10-hv-dcell ${tone ?? ''} ${on ? 'on' : ''}`} title={tip} onClick={apply}>
      <b>{num(n)}</b><span>{label}</span>
    </button>
  )
}

/**
 * The per-row picker. Opens from `?row=<term>`, so "look at this one" is a link.
 *
 * Every option shows campaign › ad group, its own reason for being ranked there, and the clamp of
 * ITS campaign — the same term promoted to a different campaign gets a different ceiling, and two
 * of this account's candidates have observed CPCs above the IT one.
 */
function DestinationPicker({ row, scope, onClose, reload }: {
  row: HarvestRow
  scope: HvSlotProps['scope']
  onClose: () => void
  reload: () => void
}) {
  const d = row.destination
  const [saving, setSaving] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [err, setErr] = useState<string | null>(null)
  const [negate, setNegate] = useState(true)
  useEffect(() => { if (saving === 'done') { const t = window.setTimeout(() => setSaving('idle'), 2200); return () => window.clearTimeout(t) } }, [saving])

  // The grain a Save writes to: the narrowest the operator has actually picked.
  const grain = scope.adGroup ? 'adGroup' : scope.campaign ? 'campaign' : scope.portfolio ? 'portfolio' : scope.line ? 'line' : (scope.market && scope.market !== 'all') ? 'market' : 'account'
  const scopeId = scope.adGroup || scope.campaign || scope.portfolio || scope.line || (scope.market !== 'all' ? scope.market : null)
  const grainLabel = grain === 'account' ? 'the whole account' : grain === 'market' ? `${scopeId}` : `this ${grain}`

  const write = useCallback(async (method: 'PUT' | 'DELETE', adGroupId?: string) => {
    setSaving('busy'); setErr(null)
    try {
      const base = `${getBackendUrl()}/api/advertising/harvest-destination`
      const res = method === 'PUT'
        ? await fetch(base, {
          method, headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ scopeGrain: grain, scopeId, matchType: d?.createType ?? 'EXACT', adGroupId, negateAtSource: negate }),
        })
        : await fetch(`${base}?scopeGrain=${grain}&scopeId=${encodeURIComponent(scopeId ?? '')}&matchType=${d?.createType ?? 'EXACT'}`, { method, credentials: 'include' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${res.status}`)
      setSaving('done'); reload()
      // RT.1 — a destination change re-routes where every future promotion lands.
      emitAdsChange('ads.keyword.changed')
    } catch (e) { setSaving('error'); setErr((e as Error).message) }
  }, [grain, scopeId, d?.createType, negate, reload])

  if (!d) return null

  return (
    <div className="h10-hv-picker">
      <div className="hd">
        <span>
          <b>{row.term}</b>
          <i>{row.market} · from {row.adGroup.name} · would create a <b>{d.createType.toLowerCase()}</b> target</i>
        </span>
        <button type="button" className="cls" onClick={onClose}>Close</button>
      </div>

      {/* 🔴 The coupling sentence, verbatim from the server so it cannot be phrased two ways. */}
      <p className={`negate ${d.wouldNegateAtSource ? 'yes' : 'no'}`}>
        <span className="tag">{d.wouldNegateAtSource ? 'Would negate at source' : 'Would NOT negate at source'}</span>
        <span>{d.negateReason}</span>
      </p>

      {d.competingAdGroups.length > 0 && (
        <p className="compete">
          <AlertTriangle size={12} />
          <span>
            This term already has an exact keyword in{' '}
            <b>{d.competingAdGroups.length} other ad group{d.competingAdGroups.length === 1 ? '' : 's'}</b>
            {' '}({d.competingAdGroups.slice(0, 3).map((c) => `${c.campaignName} › ${c.name}`).join(', ')}
            {d.competingAdGroups.length > 3 ? `, +${d.competingAdGroups.length - 3} more` : ''}).
            Promoting into a different one makes them compete with each other.
          </span>
        </p>
      )}

      {d.shortlist.length === 0 ? (
        // 🔴 "not permitted", not "not measured" — there is nowhere to put it, and the fix is to
        // build the structure. The funnel that builds it already exists and is linked, with the
        // product resolved, rather than asking the operator to paste a raw id into another section.
        <p className="none">
          <Info size={12} />
          <span>
            <b>No exact-match ad group exists for this product in {row.market}.</b> There is nowhere to promote this
            term to, so it is not promotable until one exists.{' '}
            <a className="lnk" href="/marketing/advertising/funnel" target="_blank" rel="noreferrer">
              The funnel builder creates the Auto + Exact/Phrase/Broad structure <ExternalLink size={10} />
            </a>
          </span>
        </p>
      ) : (
        <>
          <p className="lead">
            {d.source === 'stored'
              ? <>Stored for {grainLabel}. Choose another to change it, or remove the override to go back to the shortlist.</>
              : d.shortlist.length === 1
                ? <>One ad group matches. Choose it to store the decision — until then <code>applyHarvest</code> would still fall back to the source.</>
                : <><b>{d.shortlist.length} ad groups could hold this keyword</b> and none is obviously right, which is why nothing is proposed. Ranked by what they already hold.</>}
          </p>
          <ul className="opts">
            {d.shortlist.map((c) => {
              const isChosen = d.chosen?.adGroupId === c.adGroupId
              return (
                <li key={c.adGroupId} className={isChosen ? 'on' : ''}>
                  <button type="button" className="pick" onClick={() => void write('PUT', c.adGroupId)} disabled={saving === 'busy'}>
                    <DestName c={c} />
                    <span className="why">{c.why}</span>
                    <span className="clamp">
                      {c.maxBidCents != null ? `max ${eur(c.maxBidCents)}` : 'no max bid'}
                      {c.minBidCents != null ? ` · min ${eur(c.minBidCents)}` : ''}
                    </span>
                    {isChosen ? <span className="on-tag"><Check size={11} /> chosen</span> : <ArrowRight size={12} className="go" />}
                  </button>
                </li>
              )
            })}
          </ul>
          <label className="neg">
            <input type="checkbox" checked={negate} onChange={(e) => setNegate(e.target.checked)} />
            <span>Also add a negative-exact for this term in <b>{row.adGroup.name}</b> — the ad group that found it. Without this the two compete.</span>
          </label>
          {d.source === 'stored' && (
            <button type="button" className="rm" onClick={() => void write('DELETE')} disabled={saving === 'busy'}>
              <Trash2 size={12} /> Remove the {grain} destination
            </button>
          )}
        </>
      )}

      {saving === 'done' && <p className="ok"><Check size={12} /> Saved for {grainLabel}. Nothing was written to Amazon — HV.4 does that.</p>}
      {err && <p className="bad"><AlertTriangle size={12} /> {err}</p>}
    </div>
  )
}
