'use client'

/**
 * THE five Helium 10 rule columns — **Bid Rule · Target ACoS · Min/Max Bid · Bid Automation ·
 * Budget Rule** — as one set of cells, used by every grid that shows them.
 *
 * 🔴 **Operator instruction, 2026-08-19:** *"a lot of it is actually missing here, and we must build
 * them as well … we also built them on the Ads Manager page. To make sure it is exactly the same
 * and there are no inconsistencies in the design and the UI, we can simply use shared components."*
 * So: one definition, imported by the Ad Manager grid and by Apply Rules. Change a cell here and
 * both change. Add a prop rather than forking.
 *
 * ── Each cell takes PRIMITIVES, not a row ──────────────────────────────────────────────────────
 * The two grids carry different row shapes (`Camp` on the Ad Manager, `CampaignRow` on Apply
 * Rules), so a cell that took a row would need one of them to adopt the other's type. Passing the
 * values means both feed the same component from whatever they happen to call the field.
 *
 * ── 🔴 What each column may HONESTLY show, measured on prod 2026-08-19 ─────────────────────────
 * · **Bid Rule** / **Budget Rule** — both sources cover ENABLED campaigns only (83 and 86 rows
 *   against 220), so both cells take a `known` flag; U14's note on each says what that fixed.
 * · **Bid Rule** — `/advertising/campaigns` returns **no `bidAlgorithm`**, so the Ad Manager's own
 *   Bid Rule cell falls through to its default and reads "Target ACOS" on every row; its editor is
 *   local-only and says so ("Amazon field pending").
 *   ⛔ **DO NOT REMOVE IT, and do not "fix" it by deleting the column.** Operator decision
 *   2026-08-19: *"whatever is missing, like the algorithm picker, I'll work on them later, so we
 *   must not make any changes or remove it from the view."* It is a placeholder for work that is
 *   planned, not dead code — see `feedback_keep_placeholder_controls` in memory. The truthful
 *   per-campaign source is
 *   `bidder` / `bidderName` from `/advertising/bid-grid?view=campaigns`, which really varies:
 *   **schedule 32 · none 45 · manual 6**, with names like "Rank plan — GALE EXACT DE". That is what
 *   this cell shows, and it is why Apply Rules' Bid Rule column is NOT the Ad Manager's.
 * · **Min/Max Bid** — set on **82 of 220**, from `minBidCents` / `maxBidCents`. (The Ad Manager
 *   derives the same pair client-side since ADX G2; this cell renders the cents directly.)
 * · **Target ACoS** (`targetAcos`, a FRACTION) is a real, writable field currently set on **0 of
 *   220**. Uniform is not the same as fake: Apply Rules' bulk verb writes it, so "—" is the honest
 *   reading of "nobody has set one", not a placeholder.
 * · **Bid Automation** (`bidAutomation`) is real and **false on all 220**. Same reasoning — and
 *   since U13 (2026-08-20) it is also WRITABLE from the cell, on both grids. See its own note.
 * · **Budget Rule** — `reachedByRuleIds` is **6 on every campaign**, because all six budget rules
 *   are account-wide (0 of 51 rules carry a campaign scope). A column printing "6" everywhere would
 *   be decorative, so the cell leads with what DOES vary: whether a rule has actually moved this
 *   campaign's budget (`lastMovedByKind === 'rule'` — true on 1 of 86), with the reach as context.
 */
import { useEffect, useState } from 'react'
import { utilBand, UTIL_CAPPED_PCT, UTIL_NEARLY_PCT, type UtilBand } from './utilBand'

// ADM-P6b — re-exported so the cells and their consumers have one import site for the band.
export { utilBand, UTIL_CAPPED_PCT, UTIL_NEARLY_PCT, type UtilBand } from './utilBand'
import { Shuffle, Sparkles, User, Wallet } from 'lucide-react'

const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`

/**
 * ── C1 (2026-08-20) — ONE Bid Rule cell, carrying BOTH facts, on both grids ─────────────────────
 *
 * 🔴 **Operator instruction:** *"I want one shared cell showing both, just as it does on the ad
 * manager page."* Before this, the same column name meant two unrelated things:
 *
 *   Ad Manager  → the Adtomic **bid-algorithm picker** (Target ACOS / Max Impressions / Max
 *                 Orders). Printed "Target ACOS" on 100 of 100 rows, and — measured 2026-08-20 —
 *                 `setCampaignBidAlgo` called **no API at all**, so a choice died on reload.
 *   Apply Rules → the bid **owner** from the bid grid: none 45 · schedule 32 · manual 6.
 *
 * On `DE_Auto_Close` that read **"Target ACOS"** on one page and **"None"** on the other, for the
 * same campaign, on the same day. Now one cell shows the algorithm, plus the owner **when there is
 * one** (C6 — see `ownerBits`): the picker stays and stays editable (operator decision 2026-08-19 —
 * it is a placeholder for planned work, not dead code), and the owner is the fact that varies.
 *
 * The algorithm now **persists**, in `dynamicBidding.bidAlgorithm` through the same
 * `PATCH /campaigns/:id/automation` route the other two settings use. Sharing a cell whose value
 * lived in one page's React state would have guaranteed the two pages disagreed the moment anyone
 * used it — the exact defect being fixed.
 */
export const BID_ALGOS: Array<{ value: string; label: string; desc: string }> = [
  { value: 'TARGET_ACOS', label: 'Target ACOS', desc: 'A bid algorithm for products in a performance stage that should target an ACoS for scalable advertising.' },
  { value: 'MAX_IMPRESSIONS', label: 'Max Impressions', desc: 'A bid algorithm for products in a launch stage that need to get as many impressions as possible.' },
  { value: 'MAX_ORDERS', label: 'Max Orders', desc: 'A bid algorithm for products in a liquidate stage that should target maximum orders to clear out inventory.' },
]
export const bidAlgoLabel = (v?: string | null): string =>
  BID_ALGOS.find((a) => a.value === (v ?? 'TARGET_ACOS'))?.label ?? 'Target ACOS'

/**
 * The owner half — or `null` when there is nothing to report.
 *
 * 🔴 **C6 (2026-08-20), operator: *"why do I have to see the owner next to it?"*** The first cut
 * put a chip on every row, and measured on prod that meant **182 of 220 read `— no owner` or
 * `unknown`** — a chip carrying nothing, on 83% of the grid. Only **38** campaigns have an owner
 * worth naming (32 held by a rank plan, 6 manual). A quiet row now says nothing at all, which is
 * both calmer and more honest than a chip announcing an absence; the reason moves into the
 * algorithm's own tooltip, where it costs no pixels.
 *
 * The owner half is NOT redundant with the campaign name, which is the other half of that
 * question. Measured: **4 rank plans own 32 campaigns** — `IT GALE JACKET` (11), `IT AIREON` (10),
 * `IT AIRMESH` (10) — and only **1 of 32** plan names restates its campaign's name (the single
 * -campaign plan `Rank plan — GALE EXACT DE`). The other 31 name a cross-campaign grouping that
 * appears nowhere else on the row.
 */
function ownerBits(bidder?: string | null, bidderName?: string | null, known?: boolean) {
  // Nothing to report: no data, or a real "nobody owns these bids". Both stay silent in the cell
  // and are explained in the algorithm tooltip — see `quietReason`.
  if (known === false || !bidder || bidder === 'none') return null
  if (bidder === 'schedule') {
    return {
      cls: 'h10-rc-owner auto', Icon: Sparkles, text: bidderName ?? 'a rank schedule',
      tip: `Bids here are held by a plan: ${bidderName ?? 'a rank schedule'}. It writes on its own cadence, and the plan usually covers several campaigns.`,
    }
  }
  if (bidder === 'manual') {
    return { cls: 'h10-rc-owner', Icon: User, text: 'manual', tip: 'Bids here were last set by hand — no rule or plan owns them.' }
  }
  return { cls: 'h10-rc-owner', Icon: Shuffle, text: bidderName ?? bidder, tip: `Owned by ${bidderName ?? bidder}.` }
}

/** What a silent owner half means, for the algorithm tooltip. */
function quietReason(bidder?: string | null, known?: boolean): string | null {
  if (known === false) return 'Bid owner unknown: the bid grid covers enabled campaigns that carry targets, and it returned no row for this one. Nothing here claims its bids are unowned.'
  if (!bidder || bidder === 'none') return "No bid rule, rank plan or schedule owns this campaign's bids — they move only when someone changes them by hand."
  return null
}

export function BidRuleCell({ algorithm, bidder, bidderName, known }: {
  /** `dynamicBidding.bidAlgorithm`. Null = nobody has chosen; the cell names the fallback itself. */
  algorithm?: string | null
  bidder?: string | null
  bidderName?: string | null
  /** false when the bid grid returned no row for this campaign (137 of 220 on 2026-08-20). */
  known?: boolean
}) {
  const algo = bidAlgoLabel(algorithm)
  const o = ownerBits(bidder, bidderName, known)
  const algoTip = [
    algorithm == null
      ? `No bid algorithm has been chosen for this campaign; ${algo} is the default the optimizer would use. Amazon exposes no per-campaign algorithm field, so this is stored locally.`
      : `Bid algorithm: ${algo}. Amazon exposes no per-campaign algorithm field, so this is stored locally.`,
    o ? null : quietReason(bidder, known),
  ].filter(Boolean).join('\n')
  return (
    <span className="h10-rc-bidrule2">
      <span className="h10-rc-bidrule algo" title={algoTip}>
        <Shuffle size={13} aria-hidden />
        <span className="t">{algo}</span>
      </span>
      {/* Only when something actually holds these bids. The CSS separator hangs off the second
          child, so it disappears with the chip rather than leaving a stray rule. */}
      {o && (
        <span className={o.cls} title={o.tip}>
          <o.Icon size={12} aria-hidden />
          <span className="t">{o.text}</span>
        </span>
      )}
    </span>
  )
}

/**
 * The bid-algorithm picker, anchored under the cell — extracted from the Ad Manager grid so both
 * pages open the SAME menu rather than one page having an editor and the other a read-only cell.
 */
export function BidAlgoMenu({ current, anchor, onPick, onClose }: {
  current?: string | null
  anchor: { x: number; y: number }
  onPick: (value: string) => void
  onClose: () => void
}) {
  const cur = current ?? 'TARGET_ACOS'
  return (
    <>
      <button type="button" className="h10-menu-back" aria-label="Close" onClick={onClose} />
      <div className="h10-algomenu" style={{ position: 'fixed', left: anchor.x, top: anchor.y }} role="menu">
        {BID_ALGOS.map((a) => (
          <button key={a.value} type="button" role="menuitem" className={cur === a.value ? 'on' : ''} onClick={() => onPick(a.value)}>
            <span className="t"><Shuffle size={12} /> {a.label}</span>
            <span className="d">{a.desc}</span>
          </button>
        ))}
      </div>
    </>
  )
}

/**
 * Target ACoS — stored as a FRACTION (0.3 = 30%).
 * 🔴 The 30-vs-0.3 trap: `PUT /campaigns/:id/goal` refuses the whole-number form, and one rule on
 * prod stores 30 where the rest store 0.3. A value above 1 is therefore already a percentage.
 */
export function TargetAcosCell({ fraction }: { fraction?: number | null }) {
  if (fraction == null) return <span className="h10-rc-none" title="No target ACoS is set on this campaign. Rules that bid to a target read the account default instead.">—</span>
  const pct = fraction > 1 ? fraction : fraction * 100
  return <span className="h10-rc-num">{pct.toFixed(2)}%</span>
}

/** Min/Max Bid — the two enforced guardrails, in cents. */
export function MinMaxBidCell({ minCents, maxCents }: { minCents?: number | null; maxCents?: number | null }) {
  if (minCents == null && maxCents == null) {
    return <span className="h10-rc-none" title="No bid band is set, so a rule may bid this campaign anywhere the write gate allows.">None</span>
  }
  return (
    <span className="h10-rc-num" title={`The write gate refuses any bid outside ${minCents != null ? eur(minCents) : 'no floor'} – ${maxCents != null ? eur(maxCents) : 'no ceiling'}.`}>
      {minCents != null ? eur(minCents) : '—'} – {maxCents != null ? eur(maxCents) : '—'}
    </span>
  )
}

/**
 * Bid Automation — H10's own switch for "let the bid algorithm act".
 * ⚠ NOT the write gate. Apply Rules' "Automations" column shows `liveBidWritesEnabled` (whether any
 * armed rule may write at all); this is `bidAutomation`, a different field on a different endpoint.
 * Showing one under the other's name is the confusion this comment exists to prevent.
 *
 * ── 🔴 U13 (2026-08-20) — it was drawn as a switch and it was not one ───────────────────────────
 * Until this unit the cell was `<span role="img">`: 34×18px of pill, a white knob, the exact
 * geometry of every other toggle in the product, and **no click handler on any of the 220 rows**.
 * Measured on prod before the change: 100 rendered, 0 interactive, 0 on. The operator's study
 * asks for this control "individually on each campaign row", and a painted switch is the
 * `disabled-control-cannot-explain-itself` class — it invites the click it cannot answer.
 * It is now a real `role="switch"` button, in BOTH grids, because this file is shared.
 *
 * ── 🔴 What it writes, and the one thing it does NOT yet do ─────────────────────────────────────
 * `PATCH /advertising/campaigns/:id/automation { bidAutomation }`, which stores
 * `dynamicBidding.bidAutomation` — H10's field, and the same field the Ad Manager's own bulk-action
 * modal has always written, so the row switch and that modal now agree.
 *
 * **No executor reads it yet.** Grepped across `apps/api/src` on 2026-08-20: the route writes it,
 * two study scripts count it, and nothing else mentions it. Its sibling on the very same route,
 * `targetAcos`, IS read by five services. The per-campaign field every executor honours today is
 * `liveBidWritesEnabled` (`ads-auto-bid`, `ads-autopilot.service.ts:140`), which is the Automations
 * column, not this one. So this switch records an operator's decision durably and changes no bid
 * until `ads-auto-bid` learns to partition AUTO by it — engine work, deliberately not smuggled in
 * here. The tooltip says exactly that rather than implying an effect the account does not have.
 */
export function BidAutomationCell({ on, onToggle, busy }: {
  on?: boolean | null
  /** Required: this cell is a control on every grid that mounts it, or it is a lie on all of them. */
  onToggle: (next: boolean) => void
  /** Transient only — the in-flight PATCH. Never a policy refusal; see `scripts/check-silent-disabled.mjs`. */
  busy?: boolean
}) {
  const isOn = !!on
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      // `busy` is transient and resolves itself, so it needs no explanation — but it carries
      // `aria-disabled` alongside so the element stays reachable and the ratchet's distinction
      // between "held" and "in flight" is answered rather than dodged.
      disabled={busy}
      aria-disabled={busy}
      className={`h10-rc-toggle ${isOn ? 'on' : 'off'}${busy ? ' busy' : ''}`}
      aria-label={isOn ? 'Bid automation on' : 'Bid automation off'}
      title={isOn
        ? 'Bid automation is ON for this campaign. Recorded on the campaign; no bid optimizer reads it yet, so it does not by itself apply anything. This is not the write gate — see the Automations column for that.'
        : 'Bid automation is OFF: bid suggestions stay proposals. Recorded on the campaign; no bid optimizer reads it yet. This is not the write gate — see the Automations column for that.'}
      onClick={() => { if (!busy) onToggle(!isOn) }}
    ><span /></button>
  )
}

/**
 * ── Budget Rule — D2 (2026-08-20) ───────────────────────────────────────────────────────────────
 *
 * The operator's corrected study: the cell shows the NAME of the budget rule assigned to this
 * campaign, or "None"; the name hyperlinks to that rule's configuration; a dropdown assigns and
 * unassigns. H10's chassis exactly — the same `h10-edcell` + hover-pencil shape as Bid Rule,
 * Target ACoS and Min/Max Bid.
 *
 * ── 🔴 Why it can show more than one name ───────────────────────────────────────────────────────
 * H10's dropdown holds one rule per campaign. Ours is `(campaignId, ruleId)`-unique, so a campaign
 * may carry several — an operator decision taken on measurement: **four enabled budget rules act
 * on every campaign** today, and a strict one-per-campaign key admitted no faithful backfill
 * (two live AUTO rules would have stopped cutting). So:
 *
 *   0 assigned → "None"          nothing may move this budget
 *   1 assigned → the rule's name, hyperlinked — H10's reading exactly
 *   N assigned → "N rules",      the tooltip names them
 *
 * As the operator thins assignments down, rows converge on H10's single name by themselves. The
 * cell does not pretend that has already happened.
 *
 * ⚠️ After D1's backfill every campaign carries all six, so this reads "6 rules" everywhere until
 * somebody uses the dropdown. That is the account's truth, not a placeholder — and D3 ships the
 * control that changes it.
 */
export function BudgetRuleCell({ assigned, staged, ruleHref }: {
  /** The rules assigned to this campaign, in the catalogue's order. */
  assigned?: Array<{ id: string; name: string; level?: string | null; percent?: number | null }>
  /** True when this campaign has an uncommitted staged change — see the Apply footer. */
  staged?: boolean
  /** Builds the link to a rule's configuration. Omitted where the caller has no router. */
  ruleHref?: (ruleId: string) => string
}) {
  const rules = assigned ?? []
  const pct = (r: { percent?: number | null }) => (r.percent == null ? '' : ` ${r.percent > 0 ? '+' : ''}${r.percent}%`)
  const tip = rules.length === 0
    ? 'No budget rule is assigned to this campaign, so none may move its budget. Assignment is the only reach: a budget rule does nothing until it is assigned.'
    : `${rules.length} budget rule${rules.length === 1 ? '' : 's'} assigned:\n${rules.map((r) => `· ${r.name} — ${r.level ?? 'PROPOSE'}${pct(r)}`).join('\n')}`

  let body: React.ReactNode
  if (rules.length === 0) {
    body = <span className="h10-rc-none" title={tip}>None</span>
  } else if (rules.length === 1) {
    const r = rules[0]
    const label = <><Wallet size={13} aria-hidden /><span className="t">{r.name}</span></>
    body = ruleHref
      // Its own click target, so following the link never opens the assignment dropdown.
      ? <a className="h10-rc-bud one" href={ruleHref(r.id)} title={tip} onClick={(e) => e.stopPropagation()}>{label}</a>
      : <span className="h10-rc-bud one" title={tip}>{label}</span>
  } else {
    body = (
      <span className="h10-rc-bud" title={tip}>
        <Wallet size={13} aria-hidden />
        <span className="t">{rules.length} rules</span>
      </span>
    )
  }
  return (
    <span className="h10-rc-bidrule2">
      {body}
      {/* An uncommitted change, so the row says so before the operator hits Apply. */}
      {staged && <span className="h10-rc-staged" title="Staged — not saved yet. Use Apply to commit, or Discard to revert.">staged</span>}
    </span>
  )
}

/**
 * Budget utilization — the bar the Ad Manager painted at a hard-coded zero on every row.
 *
 * 🔴 ADM-H P2 (2026-08-22). Both "Current Budget Utilization" and "Average Budget Utilization"
 * rendered one literal: `<span class="h10-util" aria-hidden><span class="uf" style="width:0%"/></span>`.
 * Measured in the deployed DOM: a 64×7px track, **0px of fill, no text, aria-hidden**, identical on
 * all 100 rows. That does not read as "no data" — it reads as an instrument pegged at zero, which
 * is a finding ("nothing here is budget-capped") the account never made. Same class as the
 * hard-coded `<b>0</b>` C2 removed from the Rules column two columns away.
 *
 * The bar is no longer `aria-hidden` on its own — it now carries a text value beside it, because a
 * gauge nobody can read is not a reading. The fill is capped at 100% of the TRACK while the number
 * keeps saying 288%: clamping the bar keeps the row legible, clamping the number would hide the
 * overspend that makes the column worth having.
 */
/**
 * ADM-P6 — the gauge itself, so the Average and Current columns are the SAME instrument.
 * Two utilization columns that drew their bars differently would be two instruments, and the
 * operator would have no way to tell a rendering difference from a real one.
 */
const BAND_NOTE: Record<UtilBand, string> = {
  capped: '\n🔴 At or above 100%: the budget is spent, and a campaign that has spent its budget stops serving for the rest of the day.',
  nearly: '\n⚠ Above 85%: on course to spend the budget before the day ends, after which the campaign stops serving.',
  normal: '',
}

/**
 * ADM-P6b — the printed number, and it must never contradict the colour beside it.
 *
 * 🔴 `toFixed(0)` rounds 99.9 to "100", so a cell one tenth of a point BELOW the capped
 * threshold printed **100%** while wearing the amber band — the number claiming the budget was
 * spent and the colour saying it was not. Measured in the harness, not reasoned about. Banding on
 * the rounded value instead would fix the contradiction the wrong way round: 99.6% would then
 * print 100% in red and assert that a still-serving campaign had stopped.
 *
 * So the value keeps one decimal whenever it sits within a point of either threshold, which is
 * the only place the rounding can lie. Everywhere else it stays a whole number.
 */
function utilLabel(pct: number): string {
  if (pct > 0 && pct < 0.1) return '<0.1%'
  const nearThreshold =
    Math.abs(pct - UTIL_NEARLY_PCT) < 1 || Math.abs(pct - UTIL_CAPPED_PCT) < 1
  return `${pct.toFixed(nearThreshold ? 1 : 0)}%`
}

function UtilGauge({ pct, title, suffix }: { pct: number; title: string; suffix?: string | null }) {
  const band = utilBand(pct)
  return (
    <span className={`h10-utilcell b-${band}`} title={title + BAND_NOTE[band]}>
      <span className="h10-util"><span className="uf" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></span>
      <span className="uv">{utilLabel(pct)}</span>
      {suffix ? <span className="h10-utilage">{suffix}</span> : null}
    </span>
  )
}

/**
 * ADM-P6 — an ISO instant as `2026-08-22 09:57 UTC`.
 *
 * A pure slice, deliberately not `toLocaleString`: that is locale-dependent (an en-US machine
 * renders `09:57 AM`) and would differ between the server render and the client's. The zone is
 * spelled out because the budget day this belongs to is UTC and the reader is not.
 */
function utcStamp(iso?: string | null): string {
  if (!iso || iso.length < 16) return 'unknown'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/** ADM-P6 — the five things the Current column's reading can be. Mirrors the API's own union. */
export type BudgetUsageState = 'live' | 'derived' | 'silent' | 'unsupported' | 'unknown'

/**
 * ADM-P6 — how old the reading is, in words, computed on the CLIENT only.
 *
 * Deliberately not rendered during SSR: `Date.now()` on the server and on the client are
 * different instants, and a mismatch there is a hydration error rather than a wrong number.
 * Returns null until mounted, and the cell simply shows no age until it knows one.
 */
function useAgeLabel(iso?: string | null): string | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => { setNow(Date.now()) }, [iso])
  if (!iso || now == null) return null
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const mins = Math.floor(ms / 60_000)
  // Under a quarter of an hour is what "now" means for a figure Amazon itself updates on
  // spend events; saying "3m" there is noise, and saying nothing is not a claim of freshness.
  if (mins < 15) return null
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function BudgetUtilCell({ fraction, days, measured, current }: {
  /** Average of per-day (spend ÷ that day's budget). A FRACTION: 0.5 = 50%. */
  fraction?: number | null
  /** Days in the window Amazon has actually reported — never the days the operator picked. */
  days?: number
  /** false when the campaign has no performance row in the window at all. */
  measured?: boolean
  /**
   * ADM-P6 — present ONLY for the Current column. Not a style switch: it carries a different
   * measurement with a different source, a different day, and its own age, so the cell needs
   * the data to say anything honest about it. Absent ⇒ this is the Average column, unchanged.
   */
  current?: {
    state: BudgetUsageState
    /** Amazon's usageUpdatedTimestamp — the age of the READING, not of the page. */
    asOf?: string | null
    /** The denominator this fraction actually used, in euros. */
    budget?: number | null
  }
}) {
  const age = useAgeLabel(current?.asOf)

  if (current) {
    if (current.state === 'unsupported') {
      return <span className="h10-rc-unknown" title="Amazon's budget-usage API covers Sponsored Products only, and this is a Sponsored Display or Sponsored Brands campaign. Not a gap in our sampling — a question this source does not answer.">n/a — SP</span>
    }
    if (current.state === 'unknown') {
      return <span className="h10-rc-unknown" title="No budget-usage reading has ever been sampled for this campaign. The sampler runs every five minutes; if this persists, the campaign has no external Amazon id or its profile has no active connection.">not measured</span>
    }
    if (current.state === 'silent' || fraction == null) {
      return (
        <span
          className="h10-rc-unknown"
          title={`Amazon has reported no consumption for this campaign since the budget reset at 00:00 UTC today, and the hourly stream shows no spend today either.
That is NOT 0%. Amazon does not zero its percentage at the reset — it stops updating it, so the absence of a reading and a reading of zero look identical from here, and only one of them is a fact.${current.asOf ? `\nIts last reading was ${utcStamp(current.asOf)}, which belongs to a previous budget day.` : ''}`}
        >not reported today</span>
      )
    }
    const pct = fraction * 100
    const denom = current.budget != null ? `€${current.budget.toFixed(2)}` : 'its daily budget'
    const title = current.state === 'derived'
      ? `Today's spend ÷ this campaign's stored daily budget (${denom}), from the hourly stream — Amazon itself has not reported a percentage since the 00:00 UTC reset.
Newest hourly row: ${utcStamp(current.asOf)}. A cross-check, not Amazon's own answer: our stored budget can differ from Amazon's.
The budget day runs 00:00–24:00 UTC. That was measured against 301 campaign-days, not assumed from the marketplace timezone.`
      : `Amazon's own budget-usage reading: ${pct.toFixed(2)}% of ${denom}, the budget Amazon held for this campaign at that moment.
As of ${utcStamp(current.asOf)} — the age of the READING, not of this page. Amazon updates it when the campaign spends, so a quiet campaign carries an older stamp without being wrong.
The budget day runs 00:00–24:00 UTC, measured against 301 campaign-days rather than assumed from the marketplace timezone.
Above 100% is real, not an error: Amazon may overspend a daily budget, and the budget itself can move during the day.`
    return <UtilGauge pct={pct} title={title} suffix={age} />
  }

  if (fraction == null) {
    return measured === false
      ? <span className="h10-rc-unknown" title="No performance row for this campaign in the window — it was not served, which is not the same as spending none of its budget.">not served</span>
      : <span className="h10-rc-unknown" title="Amazon reported no daily budget for this campaign on any day in the window, so there is no denominator to divide by.">unknown</span>
  }
  const pct = fraction * 100
  const dayNote = days ? `${days} day${days === 1 ? '' : 's'} of reported data` : 'the reported days'
  return (
    <UtilGauge
      pct={pct}
      title={`Average of each day's spend ÷ that day's budget, over ${dayNote} in the selected window.
Above 100% is real, not an error: Amazon may overspend a daily budget, and the budget itself can change mid-window.
⚠ An average cannot see WHEN the money went: a campaign that exhausts by 10am and one that paces evenly across 24 hours produce the identical number.`}
    />
  )
}

/**
 * ADM-P6 — Out-of-Budget Hours and Actively Bidding Hours.
 *
 * ONE component for both, because they are one instrument read two ways: the same observation
 * spans, the same denominator, the same sampling start. `kind` picks which of the two facts the
 * cell states — it is not a style flag, and forking this would let the two columns disagree about
 * a day they were counted from together.
 *
 * 🔴 Both are bounded by when sampling began. Amazon's stream is never backfilled and its pull API
 * has no history, so the hours before the first sample are not zero — they are unwatched, and
 * unrecoverable. The cell says how many hours it actually watched, every time.
 */
export function UsageHoursCell({ kind, hours, observed, since }: {
  kind: 'oob' | 'actbid'
  /** Hours of the current budget day in this state, or null when the source cannot answer. */
  hours?: number | null
  /** Hours of the current budget day in which ANY reading was observed. The denominator. */
  observed?: number | null
  /** ISO instant sampling began — what bounds both columns. */
  since?: string | null
}) {
  if (hours == null || observed == null) {
    return <span className="h10-rc-unknown" title="Amazon's budget-usage API covers Sponsored Products only, and this is a Sponsored Display or Sponsored Brands campaign. Hours cannot be counted from a source that does not answer for it.">n/a — SP</span>
  }
  if (observed === 0) {
    return (
      <span
        className="h10-rc-unknown"
        title={`No budget-usage reading has been observed for this campaign during today's budget day (00:00 UTC onwards), so there are no hours to count.${since ? `\nSampling began ${utcStamp(since)}; hours before that were never watched and cannot be recovered.` : ''}`}
      >not measured</span>
    )
  }
  const why = kind === 'oob'
    ? `Hours of today's budget day in which this campaign was observed at or above 100% of its budget.
Counted from ${observed} hour${observed === 1 ? '' : 's'} actually watched, not from 24: the day is still running, and hours nobody sampled are unwatched rather than clear.
🔴 The exact instant of exhaustion is unobservable — Amazon reports consumption in steps, and this is sampled every five minutes. The honest unit is the hour.`
    : `Hours of today's budget day in which this campaign was observed BELOW 100% of its budget — watched, and not budget-capped.
Counted from ${observed} hour${observed === 1 ? '' : 's'} actually watched, not from 24. An hour with no reading is not counted either way.`
  const tail = since ? `\nSampling began ${utcStamp(since)}; nothing before that was watched, and neither Amazon feed can be backfilled.` : ''
  // ADM-P6b — an hour out of budget is the same fact the gauge turns red for, so it wears the
  // same red. ActBid hours never colour: "the campaign was bidding" is not an exception.
  const capped = kind === 'oob' && hours > 0
  return (
    <span className={capped ? 'h10-rc-word b-capped' : 'h10-rc-word'} title={why + tail}>
      {hours}h <span className="h10-utilage">of {observed}h watched</span>
    </span>
  )
}
