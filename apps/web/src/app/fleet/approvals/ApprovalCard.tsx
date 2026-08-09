'use client'

/**
 * NAF.AQ.3 — the decision card, rebuilt in this directory.
 *
 * The shipped `DecisionCard` (AP.3/AP.6/AP.8) got the hard parts right and is
 * the ancestor of this: risk-shaped depth, an honest fallback, the track
 * record, the read-and-understood gate. What it could not do, because a panel
 * had no room for it, is say **what the action touches and what it changes**.
 *
 * Four things are new here, each from the study's S6:
 *
 * 1. **Names, not ids.** `/agent/fleet/approvals` has always returned a
 *    `labels` map resolving campaign and target ids to names — and every
 *    client destructured it away, so no card has ever said WHICH campaign.
 * 2. **Before → after.** "bid €0.84" is unjudgeable; "€0.31 → €0.84 (+171%)"
 *    is. Every tool's preview already carries the starting value; nothing
 *    rendered it.
 * 3. **Reversibility as one class, stated once.** It used to be asserted in
 *    two places that could drift — a chip and a sentence. One source now.
 * 4. **The expiry clock**, which is stored on every row and was rendered
 *    nowhere, and an on-demand "is this still true?" that runs the same
 *    re-check the commit path runs.
 *
 * The tool VOCABULARY is still imported from the old card rather than copied.
 * Copying it would create two dictionaries that drift, which is the defect
 * AP.3 was written to fix. It moves here when the Overview stops rendering
 * the old card, and not before.
 */

import { useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Pencil,
  RotateCcw,
  X,
} from 'lucide-react'
import { toolCardFor } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'

export interface FleetLabels {
  campaigns: Record<string, { name: string; marketplace: string | null }>
  targets: Record<
    string,
    { text: string; matchType: string; campaignName: string; marketplace: string | null }
  >
}

export interface CardApproval {
  id: string
  toolName: string
  charterKey: string | null
  riskTier: string
  status: string
  args: Record<string, unknown>
  preview: Record<string, unknown> | null
  requestedAt: string
  expiresAt: string | null
  reason?: string | null
  trackRecord?: { approved: number; rejected: number; total: number } | null
}

/* ── reversibility, as ONE class ───────────────────────────────────────── */

/**
 * Three classes, and the wording is deliberate. "Reversible" on its own is
 * how an operator ends up believing a spend can be un-spent.
 */
type Reversibility = 'restore' | 'compensate' | 'never'

const REVERSIBILITY: Record<Reversibility, { chip: string; sentence: string }> = {
  restore: {
    chip: 'can be put back',
    sentence: 'We can put this back the way it was — the previous value is recorded.',
  },
  compensate: {
    chip: 'only compensated for',
    sentence:
      'This cannot be undone, only compensated for. The change can be reversed going forward, but whatever it already did — money spent, a listing seen — has happened.',
  },
  never: {
    chip: 'cannot be undone',
    sentence: 'This cannot be taken back once it runs, by any means.',
  },
}

/** Derived from the one vocabulary, so a chip and a sentence cannot disagree. */
function reversibilityOf(toolName: string): Reversibility {
  const undoable = toolCardFor(toolName).undoable
  if (undoable === 'yes') return 'restore'
  if (undoable === 'partial') return 'compensate'
  // `no` and `unknown` both land here: an unrecorded consequence is treated
  // as irreversible, which is the safe direction to be wrong in.
  return 'never'
}

/* ── AQ.4 · coded reasons, per action type ─────────────────────────────── */

/**
 * Why coded rather than free text, and why per-tool rather than one dropdown.
 *
 * The CPOE/CDS research is unusually specific here: coded override reasons
 * matched the reviewer's actual free-text reasoning in only 46% of 15,636
 * alerts, and free text alone is unanalysable — one study found 209 distinct
 * spellings of "will monitor as recommended". A randomised crossover trial
 * found a CUSTOMISED per-context list produced significantly more appropriate
 * reasons than a generic one (p < 0.001).
 *
 * So: a short list shaped to the action, plus an optional note. And every list
 * carries **"the suggestion itself is wrong"** — the option generic lists
 * suppress and free text reveals, and the highest-value signal for tuning a
 * worker, because it says the reasoning was bad rather than the timing.
 */
const DEFAULT_REJECT_CODES = [
  'Not worth doing',
  'Wrong number, right idea',
  'I will handle this myself',
  'The suggestion itself is wrong',
]

const REJECT_CODES: Record<string, string[]> = {
  'set-target-bid': [
    'Wrong number, right idea',
    'Leave this bid alone',
    'Not worth the spend',
    'The suggestion itself is wrong',
  ],
  'create-negative-keyword': [
    'This term still converts',
    'Too broad — it would block good traffic',
    'I want to watch it longer',
    'The suggestion itself is wrong',
  ],
  'graduate-keyword': [
    'Not enough evidence yet',
    'Wrong bid for it',
    'Belongs in a different campaign',
    'The suggestion itself is wrong',
  ],
  'set-price': [
    'Margin does not work',
    'Wrong price',
    'Not now — bad timing',
    'The suggestion itself is wrong',
  ],
  'apply-content': [
    'Copy is wrong',
    'Not ready to change this listing',
    'I will edit it myself',
    'The suggestion itself is wrong',
  ],
  'publish-listing': [
    'Listing is not ready',
    'Wrong channel',
    'Not now — bad timing',
    'The suggestion itself is wrong',
  ],
  'send-customer-message': [
    'Do not contact this customer',
    'Wrong message',
    'I will reply myself',
    'The suggestion itself is wrong',
  ],
}

const rejectCodesFor = (toolName: string) => REJECT_CODES[toolName] ?? DEFAULT_REJECT_CODES

/* ── AQ.8 · what the operator may edit ─────────────────────────────────── */

/**
 * The editable field per action, declared rather than inferred.
 *
 * Deliberately NOT a generic "edit the args as JSON" box. The reference
 * implementation everyone copies renders one free-text textarea per argument
 * and stringifies every value — its own README admits the values come back as
 * strings — which over a money field is a hole straight through the bid rails:
 * an operator typing 4.2 for 0.42 gets a ten-times bid with nothing in the way.
 *
 * So each entry says what the field IS, and the input is typed to match. The
 * bound here is a courtesy that catches a typo before the round trip; the
 * REAL check is the server re-running the tool's own handler, which owns the
 * bid floor, the authority pins and the protected terms. This list can never
 * be more permissive than that — only kinder about saying so early.
 */
interface Editable {
  /** The key in `args` the server will patch. */
  arg: string
  label: string
  /** Money is entered in euros and sent in cents. */
  unit: 'euro-cents'
  min: number
  max: number
  /** Where to read the current proposal from, so the input starts populated. */
  fromPreview: string
}

const EDITABLE: Record<string, Editable> = {
  'set-target-bid': {
    arg: 'proposedBidCents',
    label: 'bid',
    unit: 'euro-cents',
    // 5c is BID_FLOOR_CENTS in the tool itself; the ceiling is a sanity bound
    // on a typo, not a policy — policy lives at the write gate.
    min: 5,
    max: 1000,
    fromPreview: 'proposedBidCents',
  },
  'graduate-keyword': {
    arg: 'bidCents',
    label: 'starting bid',
    unit: 'euro-cents',
    min: 5,
    max: 1000,
    fromPreview: 'suggestedBidCents',
  },
}

/* ── what it touches, and what it changes ──────────────────────────────── */

interface Delta {
  field: string
  from: string | null
  to: string
}

interface Described {
  /** The thing being acted on, named. Null when we genuinely cannot say. */
  entity: string | null
  marketplace: string | null
  deltas: Delta[]
  /** Named, decision-relevant signals — never a bare confidence score. */
  evidence: Array<{ label: string; value: string }>
}

const euro = (cents: unknown) =>
  typeof cents === 'number' ? `€${(cents / 100).toFixed(2)}` : null

const plain = (v: unknown): string => {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (Array.isArray(v)) return v.length === 0 ? '—' : `${v.length} items`
  return JSON.stringify(v)
}

/**
 * Pull the human facts out of a preview. Per-tool because the previews are
 * per-tool — a generic renderer here would produce exactly the JSON dump the
 * card exists to avoid.
 */
function describe(a: CardApproval, labels: FleetLabels): Described {
  const p = (a.preview ?? {}) as Record<string, any>
  const out: Described = { entity: null, marketplace: null, deltas: [], evidence: [] }

  // A `{field: {from, to}}` map — set-price and apply-content both use it.
  const changes = p.changes as Record<string, { from: unknown; to: unknown }> | undefined
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    for (const [field, ch] of Object.entries(changes)) {
      if (ch && typeof ch === 'object' && ('from' in ch || 'to' in ch)) {
        out.deltas.push({ field, from: plain(ch.from), to: plain(ch.to) })
      }
    }
  }

  switch (a.toolName) {
    case 'set-target-bid': {
      const t = p.target ?? {}
      const resolved = typeof a.args.targetId === 'string' ? labels.targets[a.args.targetId] : null
      out.entity = resolved
        ? `“${resolved.text}” (${resolved.matchType}) in ${resolved.campaignName}`
        : t.expression
          ? `“${t.expression}” (${t.matchType ?? '—'}) in ${p.campaign?.name ?? 'an unnamed campaign'}`
          : null
      out.marketplace = resolved?.marketplace ?? null
      if (typeof p.currentBidCents === 'number' && typeof p.proposedBidCents === 'number') {
        out.deltas.push({
          field: 'bid',
          from: euro(p.currentBidCents),
          to: euro(p.proposedBidCents) ?? '—',
        })
      }
      break
    }
    case 'create-negative-keyword': {
      const camp =
        (typeof a.args.externalCampaignId === 'string'
          ? labels.campaigns[a.args.externalCampaignId]
          : null) ?? null
      out.entity = `${camp?.name ?? p.campaign?.name ?? 'an unnamed campaign'}`
      out.marketplace = camp?.marketplace ?? p.campaign?.marketplace ?? null
      out.deltas.push({
        field: `negative keyword (${plain(p.matchType)}, ${plain(p.scope)})`,
        from: null,
        to: `“${plain(p.term)}”`,
      })
      if (p.metrics) {
        out.evidence.push({
          label: `spend on this term, last ${plain(p.metrics.windowDays)} days`,
          value: `${euro(p.metrics.costCents) ?? '—'} for ${plain(p.metrics.orders)} orders`,
        })
      }
      break
    }
    case 'graduate-keyword': {
      out.entity = plain(p.destination?.name) || null
      out.deltas.push({
        field: 'new exact keyword',
        from: null,
        to: `“${plain(p.query)}” at ${euro(p.suggestedBidCents) ?? '—'}`,
      })
      if (p.metrics) {
        out.evidence.push({
          label: `the term's own record, last ${plain(p.metrics.windowDays)} days`,
          value: `${plain(p.metrics.clicks)} clicks, ${plain(p.metrics.orders)} orders, ${euro(p.metrics.costCents) ?? '—'} spent`,
        })
      }
      break
    }
    case 'set-price': {
      out.entity = p.sku ? `SKU ${p.sku}` : null
      if (typeof p.deltaPct === 'number') {
        out.evidence.push({ label: 'change', value: `${p.deltaPct > 0 ? '+' : ''}${p.deltaPct}%` })
      }
      break
    }
    case 'publish-listing': {
      out.entity = p.title ? `${p.title} (${plain(p.channel)})` : plain(p.channel)
      out.deltas.push({
        field: 'published',
        from: p.currentlyPublished ? 'yes' : 'no',
        to: 'yes',
      })
      out.evidence.push({ label: 'publish mode for this channel', value: plain(p.publishMode) })
      break
    }
    case 'send-customer-message': {
      out.entity = p.to ? `${p.to} (${plain(p.marketplace)})` : null
      out.deltas.push({ field: 'message', from: null, to: plain(p.message) })
      out.evidence.push({
        label: 'has opted out of contact',
        value: p.suppressed ? 'YES — this will not be sent' : 'no',
      })
      break
    }
    default:
      break
  }
  return out
}

/* ── why a request came back ───────────────────────────────────────────── */

interface Comeback {
  headline: string
  detail: string
  tail: string
  /** True when it reached Amazon and failed, rather than never being tried. */
  attempted: boolean
}

/**
 * `reason` carries the prefix the server wrote. Three shapes exist today, and
 * conflating them is what made a failed execution indistinguishable from a
 * fresh proposal:
 *
 *   `not run — …`         AP.6 staleness. Nothing was attempted.
 *   `execution failed: …` the tool ran and returned an error.
 *   `execution error: …`  the tool threw.
 */
function classifyComeback(reason: string | null | undefined): Comeback | null {
  if (!reason) return null
  if (reason.startsWith('not run —')) {
    return {
      headline: 'You approved this before, and it did not run.',
      detail: reason.replace(/^not run — /, ''),
      tail: '— it is back here so you can decide again with the facts as they are now.',
      attempted: false,
    }
  }
  const failed = /^execution (failed|error):\s*/.exec(reason)
  if (failed) {
    return {
      headline: 'You approved this, it was attempted, and it failed.',
      detail: reason.replace(/^execution (failed|error):\s*/, ''),
      // The distinction that matters: something was actually sent. Whether it
      // half-landed is not knowable from here, which is worth saying rather
      // than implying a clean no-op.
      tail:
        '— nothing here can tell you whether any part of it took effect, so check before deciding again.',
      attempted: true,
    }
  }
  return null
}

/* ── the clock ─────────────────────────────────────────────────────────── */

function timeLeft(iso: string | null): { text: string; urgent: boolean } | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return { text: 'out of time', urgent: true }
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return { text: `${mins} min left`, urgent: true }
  const hrs = Math.round(mins / 60)
  return { text: `${hrs}h left`, urgent: hrs <= 2 }
}

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/* ── the card ──────────────────────────────────────────────────────────── */

export function ApprovalCard({
  approval,
  labels,
  workerName,
  busy,
  canExecute,
  onDecide,
  onRecheck,
  onAmend,
  onSnooze,
}: {
  approval: CardApproval
  labels: FleetLabels
  workerName: string
  busy: boolean
  /** False for the fleet's preview-only tools — a yes changes nothing. */
  canExecute: boolean
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  onRecheck: (id: string) => Promise<{ stale: boolean; why: string | null }>
  /** AQ.8 — supersede this proposal with the operator's own number. */
  onAmend: (id: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
  /** NAF.AQ — "not now". Null `until` brings it straight back. */
  onSnooze: (id: string, until: Date | null) => void
}) {
  const vocab = toolCardFor(approval.toolName)
  const rev = reversibilityOf(approval.toolName)
  const d = describe(approval, labels)
  const left = timeLeft(approval.expiresAt)
  const comeback = classifyComeback(approval.reason)

  // Depth scales with CONSEQUENCE, not with riskTier alone. Every fleet tool
  // is riskTier 'high', so a tier-only rule made 100% of cards heavy and the
  // ack gate blanket friction — precisely what AP.8 said it was avoiding.
  const heavy = rev !== 'restore' || approval.riskTier === 'high'
  // Default CLOSED: the facts that decide the decision are always visible now,
  // so this holds only the supporting detail.
  const [showWhy, setShowWhy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [acked, setAcked] = useState(false)
  const [recheck, setRecheck] = useState<{ stale: boolean; why: string | null } | null>(null)
  const [rechecking, setRechecking] = useState(false)

  // AQ.8 — editing. `editable` is null for actions with no safe numeric field;
  // the affordance simply does not appear rather than offering a box that
  // cannot be validated.
  const editable = EDITABLE[approval.toolName] ?? null
  const proposedNow =
    editable && typeof (approval.preview as any)?.[editable.fromPreview] === 'number'
      ? ((approval.preview as any)[editable.fromPreview] as number)
      : null
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(
    proposedNow != null ? (proposedNow / 100).toFixed(2) : '',
  )
  const [amendErr, setAmendErr] = useState<string | null>(null)
  const [amending, setAmending] = useState(false)

  const draftCents = Math.round(Number(draft) * 100)
  const draftValid =
    Number.isFinite(draftCents) &&
    editable != null &&
    draftCents >= editable.min &&
    draftCents <= editable.max &&
    draftCents !== proposedNow

  const needsAck = heavy && canExecute
  const approveBlocked = needsAck && !acked

  /**
   * The button states the CONSEQUENCE, not the verb. "Approve" tells a
   * first-time operator nothing; "Apply — bid €0.31 → €0.84" is a decision
   * they can make from the button alone, and it makes a screenshot
   * self-documenting. Falls back to the tool vocabulary when there is no
   * delta worth naming.
   */
  /**
   * Snooze presets, and every one is checked against the expiry.
   *
   * A request lives 24 hours. Offering "next week" would be offering to hide
   * something until well after it has been refused — the operator would come
   * back to an empty queue believing they had deferred a decision when they had
   * actually forfeited it. So the options are filtered, and if none survive the
   * control does not render at all.
   */
  const snoozeOptions = (() => {
    const expiry = approval.expiresAt ? new Date(approval.expiresAt).getTime() : Infinity
    const now = Date.now()
    return [
      { label: '2 hours', ms: 2 * 3600_000 },
      { label: '6 hours', ms: 6 * 3600_000 },
      { label: 'tomorrow morning', ms: 16 * 3600_000 },
    ].filter((o) => now + o.ms < expiry - 5 * 60_000)
  })()

  const primaryDelta = d.deltas[0]
  const approveLabel = primaryDelta
    ? primaryDelta.from
      ? `Apply — ${primaryDelta.field} ${primaryDelta.from} → ${primaryDelta.to}`
      : `Apply — ${primaryDelta.field}: ${primaryDelta.to}`
    : vocab.approveLabel

  return (
    <div className={`aq-card r-${approval.riskTier}${heavy ? ' heavy' : ''}`}>
      <div className="aq-cardhead">
        <strong>{workerName}</strong> {vocab.wants}
        <span className="aq-chips">
          <Term k="risk-tier">
            <span className={`aq-risk r-${approval.riskTier}`}>{approval.riskTier} risk</span>
          </Term>
          <span className={`aq-rev v-${rev}`}>{REVERSIBILITY[rev].chip}</span>
          {left ? (
            <span className={`aq-clock${left.urgent ? ' urgent' : ''}`}>
              <Clock size={11} aria-hidden /> {left.text}
            </span>
          ) : null}
        </span>
        <span className="aq-age">{ago(approval.requestedAt)}</span>
      </div>

      {/*
        S6.a (study Part 15) — THE READING ORDER.
        1 the delta · 2 what it acts on · 3 what it costs if wrong · 4 the verbs
        · 5 everything else. Measured before the change: ten blocks spanning a
        1.8x visual-weight range, with the ENTITY heaviest, the "changes nothing
        on Amazon" notice second, and the delta — the decision — only third.
        `aq-facts` was 212px of a 671px card while the delta got 43px.
      */}

      {/* A request that came back sits ABOVE the delta: it changes how the
          number below should be read, so it cannot come after it. */}
      {comeback ? (
        <p className={`aq-cameback${comeback.attempted ? ' attempted' : ''}`}>
          <RotateCcw size={12} aria-hidden />
          <span>
            <strong>{comeback.headline}</strong> {comeback.detail} {comeback.tail}
          </span>
        </p>
      ) : null}

      {/* 1 — THE DELTA. First, and the only large type on the card. */}
      {d.deltas.length > 0 ? (
        <ul className="aq-deltas">
          {d.deltas.map((x, i) => (
            <li key={i}>
              <span className="aq-dfield">{x.field}</span>
              {x.from != null ? (
                <>
                  <span className="aq-dfrom">{x.from}</span>
                  <ArrowRight size={14} aria-hidden />
                </>
              ) : (
                <span className="aq-dnew">new</span>
              )}
              <span className="aq-dto">{x.to}</span>
            </li>
          ))}
        </ul>
      ) : (
        /* (h) the honest fallback — it takes the DELTA slot, at delta size,
           because an action that cannot describe itself is the most important
           fact on the card, not a footnote to it. */
        <p className="aq-nodelta">
          {typeof approval.preview?.effect === 'string'
            ? (approval.preview.effect as string)
            : 'This action did not describe itself.'}
        </p>
      )}

      {/* 2 — what it acts on, beneath the number rather than above it */}
      {d.entity ? (
        <p className="aq-entity">
          on <strong>{d.entity}</strong>
          {d.marketplace ? ` · ${d.marketplace}` : ''}
        </p>
      ) : null}

      {/*
        3 — WHAT IT COSTS IF WRONG, and whether it can be undone.

        Two of the three questions this card exists to answer, promoted out of a
        collapsed 212px <dl> where they were the 2nd and 3rd items. The 72px
        "changes nothing on Amazon" banner collapses INTO this slot rather than
        competing with it: it IS a consequence statement. One slot, one voice,
        whether the action can execute or not — which is also the ONLY place an
        S5 card (one that can really reach Amazon) differs from a fleet one.
      */}
      <p className={`aq-consequence${!canExecute ? ' inert' : ''}`}>
        {!canExecute ? (
          <>
            Approving records your decision and teaches the fleet — it{' '}
            <strong>changes nothing on Amazon</strong>, because this action has no way to run
            yet.
          </>
        ) : (
          <>
            {vocab.wrongCost} {REVERSIBILITY[rev].sentence}
          </>
        )}
      </p>

      {/*
        5 — everything else, behind ONE control. Stripe Radar's "Show all
        insights": a few named signals, the rest one click away rather than
        fifteen blocks down. The dead `!heavy` toggle is gone — `heavy` was true
        for every fleet tool, so the compact lane never rendered, and Pajamas'
        lowest tier says the answer is NO friction rather than hidden content.
      */}
      <button
        className="aq-why"
        aria-expanded={showWhy}
        onClick={() => setShowWhy(!showWhy)}
      >
        {showWhy ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {showWhy ? 'Hide the detail' : 'Why this was proposed'}
      </button>

      {showWhy ? (
        <dl className="aq-facts">
          {d.deltas.length > 0 && typeof approval.preview?.effect === 'string' ? (
            <div>
              <dt>What it does</dt>
              <dd>{approval.preview.effect as string}</dd>
            </div>
          ) : null}
          {d.evidence.length > 0 ? (
            <div>
              <dt>What it is going on</dt>
              <dd>
                <ul className="aq-evidence">
                  {d.evidence.map((e, i) => (
                    <li key={i}>
                      <span>{e.label}</span>
                      <strong>{e.value}</strong>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {approval.trackRecord && approval.trackRecord.total > 0 ? (
            <div>
              <dt>How this worker has fared with you</dt>
              <dd>
                You have answered {approval.trackRecord.total} of these before —{' '}
                {approval.trackRecord.approved} approved, {approval.trackRecord.rejected}{' '}
                rejected.
                {approval.trackRecord.rejected > approval.trackRecord.approved
                  ? ' You have said no more often than yes.'
                  : ''}
              </dd>
            </div>
          ) : null}
          {approval.expiresAt ? (
            <div>
              <dt>If you do nothing</dt>
              <dd>
                It expires {new Date(approval.expiresAt).toLocaleString()} and is recorded as
                refused. Expiry never means approved.
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {/* AQ.3 — ask, on demand, whether the facts still hold */}
      <div className="aq-recheck">
        <button
          className="acr-btn"
          disabled={busy || rechecking}
          onClick={async () => {
            setRechecking(true)
            try {
              setRecheck(await onRecheck(approval.id))
            } finally {
              setRechecking(false)
            }
          }}
        >
          <FileText size={12} /> {rechecking ? 'Checking…' : 'Check this is still true'}
        </button>
        {recheck ? (
          <span className={recheck.stale ? 'aq-rc-stale' : 'aq-rc-ok'}>
            {recheck.stale
              ? `The facts have moved — ${recheck.why ?? 'this no longer applies'}`
              : 'Still true as of just now.'}
          </span>
        ) : null}
      </div>

      {needsAck ? (
        <label className="aq-ack">
          <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
          <span>
            I have read what this does
            {rev === 'never' ? ' — and that it cannot be undone' : ''}.
          </span>
        </label>
      ) : null}

      {/* AQ.8 — right idea, wrong number. */}
      {editable && proposedNow != null ? (
        editing ? (
          <div className="aq-edit">
            <label className="aq-editrow">
              <span>Your {editable.label}</span>
              <span className="aq-editeuro">
                €
                <input
                  autoFocus
                  inputMode="decimal"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    setAmendErr(null)
                  }}
                />
              </span>
              <span className="aq-editwas">
                the worker proposed €{(proposedNow / 100).toFixed(2)}
              </span>
            </label>
            <p className="aq-editnote">
              Between €{(editable.min / 100).toFixed(2)} and €
              {(editable.max / 100).toFixed(2)}. Your number is re-checked against the same rules
              the worker had to pass — the bid floor, the pins, the protected terms — and the
              worker&apos;s original proposal is kept on the record beside yours.
            </p>
            {amendErr ? <p className="aq-editerr">{amendErr}</p> : null}
            <div className="aq-editactions">
              <button
                className="acr-btn go"
                disabled={busy || amending || !draftValid}
                onClick={async () => {
                  setAmending(true)
                  setAmendErr(null)
                  try {
                    const r = await onAmend(approval.id, { [editable.arg]: draftCents })
                    if (!r.ok) setAmendErr(r.error ?? 'that change was refused')
                    else setEditing(false)
                  } finally {
                    setAmending(false)
                  }
                }}
              >
                {amending ? 'Checking…' : `Use €${(Number(draft) || 0).toFixed(2)} instead`}
              </button>
              <button className="acr-btn" disabled={busy || amending} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="aq-editopen" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil size={12} /> Right idea, wrong number? Edit the {editable.label}
          </button>
        )
      ) : null}

      {/*
        AQ.4 — symmetric friction.

        Reject used to demand a typed sentence while approve was one click.
        That asymmetry is the documented mechanism by which decision support
        becomes a decision engine: if disagreeing costs an essay and agreeing
        costs a click, a tired operator agrees. Both verbs are one click now,
        and the note is optional on either.

        Note the direction of the fix. The instruction is "make rejecting no
        harder than approving" — NOT "make approving harder". Friction is added
        only where a yes is irreversible (the tick above), never to the safe
        path.
      */}
      <div className="aq-actions">
        <button
          className="acr-btn go"
          disabled={busy || approveBlocked}
          title={approveBlocked ? 'Tick the box above first.' : undefined}
          onClick={() => onDecide(approval.id, 'approve', note.trim() || undefined)}
        >
          <Check size={13} /> {approveLabel}
        </button>
        {!rejecting ? (
          <button className="acr-btn" disabled={busy} onClick={() => setRejecting(true)}>
            <X size={13} /> Reject
          </button>
        ) : (
          <button className="acr-btn" disabled={busy} onClick={() => setRejecting(false)}>
            Cancel
          </button>
        )}

        {/* "Not now" — the third answer. Without it the only way to clear a
            badge is to approve, which is the one thing a spend queue must not
            teach. Quiet and last: it is an escape, not a verb. */}
        {snoozeOptions.length > 0 && !rejecting ? (
          <span className="aq-snooze">
            <Clock size={12} aria-hidden /> Not now —
            {snoozeOptions.map((o) => (
              <button
                key={o.label}
                className="aq-snoozeopt"
                disabled={busy}
                onClick={() => onSnooze(approval.id, new Date(Date.now() + o.ms))}
              >
                {o.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>

      {rejecting ? (
        <div className="aq-reject">
          <p className="aq-rejectq">Why not? One click — this is what teaches the fleet.</p>
          <div className="aq-codes">
            {rejectCodesFor(approval.toolName).map((code) => (
              <button
                key={code}
                className="aq-code"
                disabled={busy}
                onClick={() =>
                  onDecide(
                    approval.id,
                    'reject',
                    note.trim() ? `${code} — ${note.trim()}` : code,
                  )
                }
              >
                {code}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* One optional note, shared by both verbs — never required by either. */}
      <input
        className="aq-note"
        placeholder="Add a note (optional) — it is recorded either way"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
    </div>
  )
}
