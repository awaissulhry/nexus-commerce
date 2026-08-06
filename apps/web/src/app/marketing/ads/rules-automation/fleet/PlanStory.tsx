'use client'

/**
 * FX.2 — one plan, told as a story a first-time reader can follow:
 * a four-stage pipeline stepper, per-item action cards in plain English
 * with named entities (FX.1 labels), the critic's twelve checks as an
 * explained checklist, the blast radius as a sentence, and the raw JSON
 * only behind an explicit disclosure (sentence → card → JSON).
 */

import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Minus, X } from 'lucide-react'

/* ── shapes (mirror the API; loose where the payload is Json) ─────────── */

export interface PlanLabels {
  campaigns: Record<string, { name: string; marketplace: string | null }>
  targets: Record<
    string,
    { text: string; matchType: string; campaignName: string; marketplace: string | null }
  >
}

interface PlanItem {
  findingId: string
  rank: number
  tool: string
  args: Record<string, unknown>
  expectedEffect?: {
    metric?: string
    direction?: string
    magnitudePct?: number
    horizonDays?: number
    basis?: string
  }
  reversible?: boolean
}

interface CriticCheck {
  check: string
  result: 'pass' | 'fail' | 'n/a' | string
  note?: string
  offendingItems?: string[]
}

export interface StoryPlan {
  id: string
  headline: string
  narrative: string
  status: string
  criticVerdict: string | null
  criticNotes: {
    summary?: string
    checks?: CriticCheck[]
    blockedItems?: string[]
    forcedBlocks?: Array<{ findingId: string; check: string; reason: string }>
    note?: string
  } | null
  blastRadius: {
    input?: Record<string, number>
    verdict?: { proceed?: boolean; summary?: string; breaches?: Array<{ message?: string }> }
  } | null
  items: PlanItem[]
  droppedItems: Array<{ findingId: string; reason: string }>
  approvalIds: string[]
  createdAt: string
}

/* ── plain-language vocabulary ────────────────────────────────────────── */

const CHECK_EXPLAINERS: Record<string, string> = {
  evidence_sufficient: 'Is there enough evidence to judge this plan?',
  data_fresh: 'Is the data recent enough to act on?',
  no_contradiction_with_recent_change: 'Does it contradict something that just changed?',
  no_double_counting: 'Is any of this already done?',
  blast_radius_ok: 'Is the change small enough to be safe unattended?',
  respects_pins: 'Does it keep hands off campaigns you hold by hand?',
  respects_protected_terms: 'Does it stay away from your protected brand terms?',
  respects_strategy_constraints: 'Does it fit the standing strategy?',
  effect_estimate_plausible: 'Are the predicted effects believable?',
  reversible: 'Can every change be undone?',
  no_self_competition: 'Would it make your own campaigns compete with each other?',
  inventory_supports_spend: 'Is there stock behind the spend?',
}

const eur = (cents: unknown) =>
  typeof cents === 'number' ? `€${(cents / 100).toFixed(2)}` : '—'

function campaignLabel(labels: PlanLabels, extId: unknown): string {
  if (typeof extId !== 'string') return 'a campaign'
  const c = labels.campaigns[extId]
  return c ? `${c.name}${c.marketplace ? ` (${c.marketplace})` : ''}` : `campaign ${extId}`
}

/** The action, as a person would say it. */
export function itemSentence(item: PlanItem, labels: PlanLabels): string {
  const a = item.args
  if (item.tool === 'create-negative-keyword') {
    const how =
      a.matchType === 'NEGATIVE_PHRASE'
        ? 'any search containing'
        : 'the exact search'
    return `Stop showing ads for ${how} “${String(a.keywordText ?? '?')}” in ${campaignLabel(labels, a.externalCampaignId)}`
  }
  if (item.tool === 'graduate-keyword') {
    return `Promote “${String(a.query ?? '?')}” to its own exact keyword (proven in ${campaignLabel(labels, a.sourceExternalCampaignId)}), starting bid ${eur(a.bidCents)}`
  }
  if (item.tool === 'set-target-bid') {
    const t = typeof a.targetId === 'string' ? labels.targets[a.targetId] : undefined
    return t
      ? `Change the bid on “${t.text}” in ${t.campaignName}${t.marketplace ? ` (${t.marketplace})` : ''} to ${eur(a.proposedBidCents)}`
      : `Change a keyword's bid to ${eur(a.proposedBidCents)}`
  }
  return `${item.tool}`
}

interface ItemVerdict {
  kind: 'queued' | 'blocked' | 'cleared' | 'held'
  label: string
  reason?: string
}

function itemVerdict(plan: StoryPlan, item: PlanItem): ItemVerdict {
  const forced = plan.criticNotes?.forcedBlocks?.find((f) => f.findingId === item.findingId)
  if (forced) return { kind: 'blocked', label: 'blocked by a safety check', reason: forced.reason }
  if (plan.criticNotes?.blockedItems?.includes(item.findingId)) {
    const check = plan.criticNotes?.checks?.find((c) =>
      c.offendingItems?.includes(item.findingId),
    )
    return {
      kind: 'blocked',
      label: 'blocked by the critic',
      reason: check ? (CHECK_EXPLAINERS[check.check] ?? check.check) : undefined,
    }
  }
  if (plan.status === 'queued') return { kind: 'queued', label: 'waiting for your approval' }
  if (plan.criticVerdict === 'block') {
    return { kind: 'held', label: 'held — the plan as a whole was blocked' }
  }
  return { kind: 'cleared', label: 'cleared' }
}

/* ── the component ────────────────────────────────────────────────────── */

export function PlanStory({ plan, labels }: { plan: StoryPlan; labels: PlanLabels }) {
  const [openChecks, setOpenChecks] = useState(false)
  const [openNarrative, setOpenNarrative] = useState(false)
  const [openRaw, setOpenRaw] = useState(false)

  const considered = plan.items.length + plan.droppedItems.length
  const verdict = plan.criticVerdict
  const queued = plan.approvalIds?.length ?? 0

  const stages = [
    {
      key: 'found',
      title: 'Workers found',
      detail: `${considered} finding${considered === 1 ? '' : 's'} on the desk`,
      state: 'done' as const,
    },
    {
      key: 'planned',
      title: 'Director planned',
      detail: `chose ${plan.items.length}, set aside ${plan.droppedItems.length}`,
      state: 'done' as const,
    },
    {
      key: 'critic',
      title: 'Critic ruled',
      detail:
        verdict === 'pass'
          ? 'passed every live check'
          : verdict === 'block'
            ? 'BLOCKED the plan'
            : verdict === 'revise'
              ? 'asked for a revision'
              : 'not reviewed yet',
      state: verdict ? ('done' as const) : ('waiting' as const),
    },
    {
      key: 'outcome',
      title: 'What happened',
      detail:
        plan.status === 'queued'
          ? `${queued} action${queued === 1 ? '' : 's'} waiting for you`
          : verdict === 'block'
            ? 'nothing queued — blocked plans go nowhere'
            : plan.status === 'draft'
              ? 'waiting for the critic'
              : plan.status,
      state:
        plan.status === 'queued'
          ? ('attention' as const)
          : verdict === 'block'
            ? ('stopped' as const)
            : ('waiting' as const),
    },
  ]

  const checks = plan.criticNotes?.checks ?? []
  const failed = checks.filter((c) => c.result === 'fail')
  const blast = plan.blastRadius
  const blastBits: string[] = []
  if (blast?.input) {
    const i = blast.input
    if (i.campaignsTouched != null) blastBits.push(`touches ${i.campaignsTouched} campaigns`)
    if (i.bidChanges != null) blastBits.push(`${i.bidChanges} bid changes`)
    if (i.conflicts != null) blastBits.push(`${i.conflicts} conflicts`)
  }

  // Narrative split into its priorities when the director wrote them.
  const narrativeParts = plan.narrative
    ? plan.narrative.split(/(?=Priority \d+:)/g).filter((s) => s.trim())
    : []

  return (
    <div className="acr-fl-story">
      {/* the stepper */}
      <div className="acr-fl-stepper" title={new Date(plan.createdAt).toLocaleString()}>
        {stages.map((s, i) => (
          <div key={s.key} className={`acr-fl-stage st-${s.state}`}>
            <span className="acr-fl-stagedot" aria-hidden />
            <span className="acr-fl-stagetitle">{s.title}</span>
            <span className="acr-fl-stagedetail">{s.detail}</span>
            {i < stages.length - 1 ? <span className="acr-fl-stagearrow" aria-hidden /> : null}
          </div>
        ))}
      </div>

      {/* the critic's headline, in words */}
      {verdict === 'block' && plan.criticNotes?.summary ? (
        <div className="acr-fl-criticbox">
          <AlertTriangle size={14} />
          <div>
            <strong>Why the critic said no:</strong> {plan.criticNotes.summary}
          </div>
        </div>
      ) : null}

      {/* blast radius as a sentence */}
      {blast?.verdict ? (
        <p className={`acr-fl-blast ${blast.verdict.proceed ? '' : 'bad'}`}>
          Scale of this plan: {blastBits.join(' · ') || 'small'} —{' '}
          {blast.verdict.proceed
            ? 'within the limits for unattended changes.'
            : blast.verdict.breaches?.map((b) => b.message).join(' ') || blast.verdict.summary}
        </p>
      ) : null}

      {/* the actions, grouped: blocked first is noise — attention first */}
      <ul className="acr-fl-actions">
        {plan.items.map((item) => {
          const v = itemVerdict(plan, item)
          return (
            <li key={item.findingId} className={`acr-fl-action v-${v.kind}`}>
              <span className={`acr-fl-vchip v-${v.kind}`}>
                {v.kind === 'blocked' ? <X size={11} /> : v.kind === 'queued' ? <AlertTriangle size={11} /> : <Check size={11} />}
                {v.label}
              </span>
              <span className="acr-fl-actiontext">{itemSentence(item, labels)}</span>
              {item.expectedEffect?.basis ? (
                <span className="acr-fl-actionwhy">Why: {item.expectedEffect.basis}</span>
              ) : null}
              {v.reason ? <span className="acr-fl-actionreason">{v.reason}</span> : null}
            </li>
          )
        })}
      </ul>

      {/* set aside */}
      {plan.droppedItems.length > 0 ? (
        <details className="acr-fl-dropped">
          <summary>
            {plan.droppedItems.length} set aside by the director — with reasons
          </summary>
          <ul>
            {plan.droppedItems.map((d) => (
              <li key={d.findingId}>{d.reason}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* the twelve checks */}
      {checks.length > 0 ? (
        <div className="acr-fl-checks">
          <button className="acr-fl-checkstoggle" onClick={() => setOpenChecks(!openChecks)}>
            {openChecks ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            The critic ran {checks.length} checks — {failed.length} failed
          </button>
          {openChecks ? (
            <ul>
              {checks.map((c) => (
                <li key={c.check} className={`ck-${c.result.replace('/', '')}`}>
                  {c.result === 'pass' ? <Check size={12} /> : c.result === 'fail' ? <X size={12} /> : <Minus size={12} />}
                  <span className="acr-fl-checkq">
                    {CHECK_EXPLAINERS[c.check] ?? c.check}
                  </span>
                  {c.note ? <span className="acr-fl-checknote">{c.note}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* the director's own words */}
      {narrativeParts.length > 0 ? (
        <div className="acr-fl-narrative">
          <button className="acr-fl-checkstoggle" onClick={() => setOpenNarrative(!openNarrative)}>
            {openNarrative ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            The director&apos;s reasoning, in its own words
          </button>
          {openNarrative ? narrativeParts.map((p, i) => <p key={i}>{p}</p>) : null}
        </div>
      ) : null}

      {/* depth 3 — the raw row */}
      <button className="acr-fl-rawtoggle" onClick={() => setOpenRaw(!openRaw)}>
        {openRaw ? 'hide' : 'show'} raw data
      </button>
      {openRaw ? (
        <pre className="acr-fl-raw">{JSON.stringify(plan, null, 2)}</pre>
      ) : null}
    </div>
  )
}
